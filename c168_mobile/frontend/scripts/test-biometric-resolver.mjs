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
  autoSwitchTarget,
  canOfferMethodSwitch,
  capabilityFromProbe,
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

test("用例8：锁屏里提到「指纹」的文案必须是方法专属的", () => {
  const gate = src("components", "lock", "BiometricLockGate.jsx");
  // 无条件渲染的文案（lockedHint / bioFailed / byCode.*）绝不能点名某种方式；
  // 只有键名里带 Fingerprint 的方法专属文案（比如 methodGoneFingerprint、
  // switchToFingerprint）才允许提到指纹 —— 它们只在用户真的选了指纹时出现。
  const offenders = gate
    .split("\n")
    .map((line, i) => [i + 1, line])
    // 注释里提到指纹是用来解释设计的，不算违规
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(([, line]) => /指纹/.test(line))
    // 方法专属的键名（methodGoneFingerprint / switchToFingerprint）允许点名指纹，
    // 它们只在用户真的选了指纹时才会渲染
    .filter(([, line]) => !/Fingerprint/.test(line))
    // 中性表述（同时点名指纹与人脸）也是允许的 —— 只点名一种才是“声称”
    .filter(([, line]) => !/人脸/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `锁屏仍硬编码指纹文案：\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n")}`,
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

test("凭据缺失：说得出来，且不改写偏好（实机出过 enabled=1 而 token=no）", () => {
  const r = resolveBiometric(face, { state: CAP.AVAILABLE, credentialPresent: false });
  assert.equal(r.method, METHOD.FACE, "偏好被改写");
  assert.equal(r.startable, false);
  assert.equal(r.reason, "NO_CREDENTIAL");
});

test("凭据未知（如 iOS 凭据在服务端）不得当成缺失", () => {
  assert.equal(resolveBiometric(face, { state: CAP.AVAILABLE }).startable, true);
  assert.equal(
    resolveBiometric(face, { state: CAP.AVAILABLE, credentialPresent: undefined }).startable,
    true,
  );
});

test("「用密码登录」不得清掉凭据（否则每次密码登录都会重复弹开启引导）", () => {
  const hook = src("hooks", "useBiometricUnlock.js");
  const body = hook.slice(hook.indexOf("const usePasswordInstead"), hook.indexOf("const usePasswordInstead") + 320);
  assert.equal(
    /goDisabled\(true\)/.test(body),
    false,
    "usePasswordInstead 仍在清凭据 —— 会让 enabled=1 与 token=no 对不上，并反复弹引导",
  );
});

/* ── 能力翻译：必须看“录入”，不能看“硬件”（实机踩过）───────────── */

test("删掉指纹但人脸还在 → 不得再说指纹可用", () => {
  // 真实上报的场景：strongAvailable=false，isAvailable=true
  const cap = capabilityFromProbe({ ok: true, isAvailable: true, strongAvailable: false });
  assert.equal(cap.state, CAP.AVAILABLE);
  assert.equal(cap.fingerprintAvailable, false, "指纹已删却仍报可用（这就是那个 bug）");
  assert.equal(cap.faceAvailable, true);
});

test("上面的能力下：选指纹 → 说出原因且不改写；选人脸 → 可启动", () => {
  const cap = capabilityFromProbe({ ok: true, isAvailable: true, strongAvailable: false });

  const fpPlan = resolveBiometric(fp, cap);
  assert.equal(fpPlan.method, METHOD.FINGERPRINT, "偏好被改写了");
  assert.equal(fpPlan.startable, false);
  assert.equal(fpPlan.reason, "FINGERPRINT_UNAVAILABLE");

  const facePlan = resolveBiometric(face, cap);
  assert.equal(facePlan.startable, true, "人脸还能用，却不让启动");
});

test("什么都没录 → NOT_ENROLLED；探测失败 → UNKNOWN（不是“不可用”）", () => {
  assert.equal(
    capabilityFromProbe({ ok: true, isAvailable: false, strongAvailable: false }).state,
    CAP.NOT_ENROLLED,
  );
  assert.equal(capabilityFromProbe({ ok: false, why: "timeout" }).state, CAP.UNKNOWN);
  assert.equal(capabilityFromProbe(null).state, CAP.UNKNOWN);
});

test("系统临时锁定 → TEMPORARILY_LOCKED（不得当成没录入而清凭据）", () => {
  assert.equal(
    capabilityFromProbe({ ok: true, code: "biometryLockout", isAvailable: true, strongAvailable: true })
      .state,
    CAP.TEMPORARILY_LOCKED,
  );
});

/* ── 自动换方式（产品要求：不询问；但未知时绝不换）──────────────── */

const fpGone = capabilityFromProbe({ ok: true, isAvailable: true, strongAvailable: false });

test("删了指纹、人脸还在 → 自动换成 FACE", () => {
  assert.equal(autoSwitchTarget(METHOD.FINGERPRINT, fpGone), METHOD.FACE);
});

test("反向也成立：人脸没了、指纹还在 → 自动换成 FINGERPRINT", () => {
  const faceGone = capabilityFromProbe({ ok: true, isAvailable: true, strongAvailable: true });
  faceGone.faceAvailable = false;
  assert.equal(autoSwitchTarget(METHOD.FACE, faceGone), METHOD.FINGERPRINT);
});

test("能力**未知**时绝不自动换（探测失败不能当成事实）", () => {
  for (const cap of [
    null,
    undefined,
    {},
    { state: CAP.UNKNOWN },
    { state: CAP.UNKNOWN, faceAvailable: null },
  ]) {
    assert.equal(autoSwitchTarget(METHOD.FINGERPRINT, cap), "", JSON.stringify(cap));
  }
});

test("哪一种都没了 → 不换（应交给手动提示）", () => {
  const none = capabilityFromProbe({ ok: true, isAvailable: false, strongAvailable: false });
  assert.equal(autoSwitchTarget(METHOD.FINGERPRINT, none), "");
  assert.equal(autoSwitchTarget(METHOD.FACE, none), "");
});

test("DISABLED / 非法 method → 没有可换的目标", () => {
  assert.equal(autoSwitchTarget(METHOD.NONE, fpGone), "");
  assert.equal(autoSwitchTarget("garbage", fpGone), "");
});

/* ── React 规则（实机白屏就是这么来的）────────────────────────── */

test("锁屏：hook 不得出现在提前 return 之后（否则解锁瞬间白屏）", () => {
  const lines = src("components", "lock", "BiometricLockGate.jsx").split("\n");
  const firstEarlyReturn = lines.findIndex((l) => /^\s*return children;/.test(l));
  assert.notEqual(firstEarlyReturn, -1, "没找到提前 return，测试需要更新");

  // 本组件在已解锁/已关闭时会 `return children`，而 React 要求每次渲染的
  // hook 调用顺序完全一致；hook 一旦落在它后面，解锁时数量就会变 → 抛错 → 整个 App 白屏。
  const offenders = lines
    .map((line, i) => [i + 1, line])
    .slice(firstEarlyReturn)
    .filter(([, l]) => /\buse(State|Ref|Effect|Callback|Memo|Context)\s*\(/.test(l));

  assert.deepEqual(
    offenders,
    [],
    `hook 落在提前 return 之后：\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n")}`,
  );
});

test("有二级密码的身份也必须能开启生物识别（二级密码页要过一遍引导）", () => {
  const page = src("pages", "login", "SecondaryPasswordPage.jsx");
  // owner 在后端是**无条件**需要二级密码的，这一页是它唯一的落地路径；
  // 曾经这里直接 navigate 走，于是引导从头到尾不出现 → “有二级密码的 owner 开不了”。
  assert.match(page, /useBiometricEnrol\(/, "二级密码页没接开启引导");
  assert.match(page, /enrol\.offer\(/, "二级密码页没调用 offer");
  assert.match(page, /BiometricEnrolModal/, "二级密码页没有渲染引导弹窗");
});

test("引导只在两个入口共用一个实现（不得再各自写一份）", () => {
  const shared = src("components", "lock", "BiometricEnrolModal.jsx");
  assert.match(shared, /export function useBiometricEnrol/);
  assert.match(shared, /export function BiometricEnrolModal/);
  // 密码登录页不得再自己实现一遍启用逻辑
  const login = src("pages", "login", "LoginPage.jsx");
  assert.equal(
    /registerDeviceToken\(/.test(login),
    false,
    "LoginPage 又自己调了 registerDeviceToken —— 启用逻辑应只在共用模块里",
  );
});

test("设备什么都没有时**不给**「改用另一种」按钮（否则是死循环）", () => {
  const none = capabilityFromProbe({ ok: true, isAvailable: false, strongAvailable: false });
  assert.equal(none.state, CAP.NOT_ENROLLED);
  assert.equal(canOfferMethodSwitch(none), false, "会陷入 指纹→人脸→指纹 的死循环");
});

test("其他情况仍然给按钮（未知时让用户自己决定）", () => {
  assert.equal(canOfferMethodSwitch({ state: CAP.UNKNOWN }), true);
  assert.equal(canOfferMethodSwitch(null), true);
  assert.equal(canOfferMethodSwitch({ state: CAP.TEMPORARILY_LOCKED }), true);
  assert.equal(
    canOfferMethodSwitch(capabilityFromProbe({ ok: true, isAvailable: true, strongAvailable: false })),
    true,
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
