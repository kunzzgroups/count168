/**
 * 生物识别模型 + resolver 的单元测试。
 *
 * 跑法：node scripts/test-biometric-resolver.mjs
 *
 * 为什么要有它：规格 §17 的 12 个用例里，有一半无法在没有真机时验证；
 * 但「偏好不会被静默改写」「能力未知不等于不可用」「不变量成立」这几条
 * 是**纯逻辑**，必须在这里被钉死。之前几轮之所以反复翻车，就是因为
 * 决策逻辑散在四个组件里、没有任何断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CAP,
  METHOD,
  disabledSettings,
  migrateSettings,
  normalizeSettings,
  resolveBiometric,
} from "../src/lib/biometricSettings.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

const fp = { v: 1, enabled: true, method: METHOD.FINGERPRINT };
const face = { v: 1, enabled: true, method: METHOD.FACE };
const available = { state: CAP.AVAILABLE };

/* ── 不变量（规格 §2）───────────────────────────────────────────────── */

test("不变量：永远不会出现 enabled=true 且 method=NONE", () => {
  const junk = [
    { enabled: true, method: METHOD.NONE },
    { enabled: true },
    { enabled: true, method: "garbage" },
    { enabled: true, method: null },
    { enabled: "true", method: METHOD.FACE },
  ];
  for (const raw of junk) {
    const s = normalizeSettings(raw);
    assert.equal(s.enabled && s.method === METHOD.NONE, false, JSON.stringify(raw));
  }
});

test("不变量：enabled=false 时 method 一律归零，不存在残留", () => {
  const s = normalizeSettings({ enabled: false, method: METHOD.FACE });
  assert.deepEqual(s, disabledSettings());
});

test("normalize 幂等：再跑一次结果不变", () => {
  for (const s of [disabledSettings(), fp, face]) {
    assert.deepEqual(normalizeSettings(normalizeSettings(s)), normalizeSettings(s));
  }
});

/* ── 用例 3/4/9/10/11：偏好必须活过重启 ────────────────────────────── */

test("用例3/4：FINGERPRINT 与 FACE 序列化后读回完全一致（等价于杀进程重开）", () => {
  for (const s of [fp, face]) {
    const roundTrip = normalizeSettings(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(roundTrip, s);
  }
});

test("用例9/10/11：切换方式后再读回，得到的是**新**方式（不会被重置成指纹）", () => {
  const switched = normalizeSettings({ enabled: true, method: METHOD.FACE });
  assert.equal(switched.method, METHOD.FACE);
  assert.notEqual(switched.method, METHOD.FINGERPRINT);
});

/* ── 用例 5/6/12：能力变化绝不改写偏好（规格 §7）────────────────────── */

test("用例5：选 FACE 后人脸不可用 → 不改写偏好，只报原因", () => {
  const r = resolveBiometric(face, { state: CAP.UNAVAILABLE, faceAvailable: false });
  assert.equal(r.method, METHOD.FACE, "偏好被改写了");
  assert.equal(r.startable, false);
  assert.equal(r.reason, "FACE_UNAVAILABLE");
});

test("用例6：选 FINGERPRINT 后指纹不可用 → 同样不改写", () => {
  const r = resolveBiometric(fp, { state: CAP.UNAVAILABLE, fingerprintAvailable: false });
  assert.equal(r.method, METHOD.FINGERPRINT);
  assert.equal(r.reason, "FINGERPRINT_UNAVAILABLE");
});

test("用例12：能力从可用变不可用时，偏好一个字节都不能动", () => {
  for (const s of [fp, face]) {
    const before = JSON.stringify(s);
    resolveBiometric(s, { state: CAP.UNAVAILABLE });
    resolveBiometric(s, { state: CAP.NOT_ENROLLED });
    resolveBiometric(s, { state: CAP.TEMPORARILY_LOCKED });
    assert.equal(JSON.stringify(s), before, "resolver 改了入参");
  }
});

test("能力未知 ≠ 不可用：探测失败时仍然允许启动（BUG-3 的教训）", () => {
  const r = resolveBiometric(face, { state: CAP.UNKNOWN, faceAvailable: null });
  assert.equal(r.startable, true);
  assert.equal(r.reason, "");
});

test("能力为 null/undefined 时也允许启动，不能因为缺少探测就把功能关掉", () => {
  assert.equal(resolveBiometric(face, null).startable, true);
  assert.equal(resolveBiometric(face, undefined).startable, true);
  assert.equal(resolveBiometric(face, {}).startable, true);
});

/* ── 用例 7：关闭后只走密码 ────────────────────────────────────────── */

test("用例7：DISABLED → 不可启动、无原因、策略 NONE", () => {
  const r = resolveBiometric(disabledSettings(), available);
  assert.equal(r.startable, false);
  assert.equal(r.strategy, "NONE");
  assert.equal(r.reason, "");
});

/* ── 诚实性：UI 只能在被保证的范围内描述自己（规格 §9）────────────── */

test("FINGERPRINT 是被保证的：strong 强度能真正排除人脸", () => {
  const r = resolveBiometric(fp, available);
  assert.equal(r.promptStrength, "strong");
  assert.equal(r.guaranteedModality, METHOD.FINGERPRINT);
});

test("FACE 不被保证：必须体现为 guaranteed=ANY，不得声称人脸", () => {
  const r = resolveBiometric(face, available);
  assert.equal(r.promptStrength, "weak");
  assert.equal(r.expectedModality, METHOD.FACE);
  assert.equal(r.guaranteedModality, "ANY", "不得把 FACE 标成被保证");
});

/* ── 迁移（规格 §15）──────────────────────────────────────────────── */

test("迁移：旧 face + 有凭据 → FACE", () => {
  assert.deepEqual(migrateSettings("face", true), { v: 1, enabled: true, method: METHOD.FACE });
});

test("迁移：旧 fingerprint + 有凭据 → FINGERPRINT", () => {
  assert.deepEqual(migrateSettings("fingerprint", true), {
    v: 1,
    enabled: true,
    method: METHOD.FINGERPRINT,
  });
});

test("迁移：旧值是脏数据 → 不猜，直接 DISABLED", () => {
  for (const bad of [null, undefined, "", "finger", "FACE", 0, "any"]) {
    assert.deepEqual(migrateSettings(bad, true), disabledSettings(), `bad=${String(bad)}`);
  }
});

test("迁移：有方式但**没有凭据** → 不算开启（不得凭旧布尔值当权威）", () => {
  assert.deepEqual(migrateSettings("face", false), disabledSettings());
  assert.deepEqual(migrateSettings("face", undefined), disabledSettings());
});

/* ── 用例 8：选 FACE 时任何地方都不许声称指纹 ─────────────────────── */

test("用例8：锁屏的失败文案不再硬编码「指纹」", () => {
  const gate = src("components", "lock", "BiometricLockGate.jsx");
  const offending = gate
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /指纹/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(
    offending,
    [],
    `锁屏仍硬编码指纹文案：\n${offending.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n")}`,
  );
});

test("用例8：锁屏的指纹图标只能出现在 method 条件分支里", () => {
  const gate = src("components", "lock", "BiometricLockGate.jsx");
  const offenders = gate
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => line.includes("fa-fingerprint") && !line.includes("FINGERPRINT"));
  assert.deepEqual(
    offenders,
    [],
    `指纹图标是写死的，没跟着方式走：\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n")}`,
  );
});

/* ── 运行 ─────────────────────────────────────────────────────────── */

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split("\n").join("\n       ")}`);
  }
}

console.log(`\n${passed}/${cases.length} 通过${failed ? `，${failed} 失败` : ""}`);
process.exit(failed === 0 ? 0 : 1);
