/**
 * PIN 解锁（lib/pinStore.js）的单元测试。
 *
 * 跑法：node scripts/test-pin-unlock.mjs
 *
 * 为什么要有它：PIN 这条路径上**没有任何服务端校验**——服务端只看到
 * device_login。所以「PIN 不对就不给令牌」这件事，只能在这里钉死。
 * 下面每条断言对应一个真机上很难复现的失败：
 *
 *   · 残缺记录 → 当成“没设过”（不是当“开着但解不开”）
 *   · 错码 → 不给令牌、并累计次数
 *   · 错满 → 清掉 PIN（不是只锁一段时间：客户端时间能改）
 *   · 记录被改过 → 解不开就清掉，不要每次启动都白跑一次 PBKDF2
 *
 * node 22 自带 WebCrypto / btoa / TextEncoder，所以这层能在 CI 里直接跑。
 */
import assert from "node:assert/strict";

/** 最小 localStorage：模块内部是**惰性读** globalThis.localStorage，所以可以先定义再 import */
class MemoryStorage {
  #map = new Map();

  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }

  setItem(key, value) {
    this.#map.set(key, String(value));
  }

  removeItem(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  get length() {
    return this.#map.size;
  }
}

globalThis.localStorage = new MemoryStorage();

const {
  PIN_KEY,
  PIN_MAX_ATTEMPTS,
  createPin,
  isPinSupported,
  isTooSimplePin,
  isValidPinFormat,
  normalizePinSettings,
  pinAttemptsLeft,
  pinEnabled,
  pinLockedOut,
  readPinSettings,
  clearPin,
  unlockWithPin,
} = await import("../src/lib/pinStore.js");

const TOKEN = "a".repeat(63) + "b"; // 64 位 hex，形状与 device_token 一致

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      console.error(`  FAIL ${name}\n       ${error?.message || error}`);
      process.exitCode = 1;
    });
}

function reset() {
  globalThis.localStorage.clear();
}

console.log("pinStore");

await check("运行环境支持 WebCrypto（否则功能应当整个关掉）", () => {
  assert.equal(isPinSupported(), true);
});

await check("位数只接受 4 / 6", () => {
  assert.equal(isValidPinFormat("1234", 4), true);
  assert.equal(isValidPinFormat("123456", 6), true);
  assert.equal(isValidPinFormat("123", 4), false);
  assert.equal(isValidPinFormat("12345", 4), false);
  assert.equal(isValidPinFormat("12a4", 4), false);
  assert.equal(isValidPinFormat("123456", 4), false);
});

await check("太简单的组合被拒（全同号 / 顺子 / 常见组合）", () => {
  for (const pin of ["0000", "1111", "1234", "4321", "123456", "654321", "112233"]) {
    assert.equal(isTooSimplePin(pin), true, `${pin} 应被拒`);
  }
  for (const pin of ["4821", "908172"]) {
    assert.equal(isTooSimplePin(pin), false, `${pin} 应被接受`);
  }
});

await check("残缺记录一律当成“没设过”（绝不猜）", () => {
  assert.equal(normalizePinSettings(null).enabled, false);
  assert.equal(normalizePinSettings({}).enabled, false);
  assert.equal(normalizePinSettings({ len: 4 }).enabled, false);
  assert.equal(normalizePinSettings({ len: 4, salt: "x", iv: "y" }).enabled, false);
  assert.equal(normalizePinSettings({ len: 5, salt: "x", iv: "y", ct: "z" }).enabled, false);
  assert.equal(normalizePinSettings({ len: 6, salt: "x", iv: "y", ct: "z" }).enabled, true);
});

await check("没有记录时读出来是关闭状态", () => {
  reset();
  assert.deepEqual(readPinSettings(), { v: 1, enabled: false, len: 4 });
  assert.equal(pinEnabled(), false);
});

await check("创建 + 正确 PIN 解出同一张令牌（校验与取令牌是同一个动作）", async () => {
  reset();
  const created = await createPin({ pin: "4821", len: 4, token: TOKEN });
  assert.deepEqual(created, { ok: true });
  assert.equal(pinEnabled(), true);
  assert.equal(readPinSettings().len, 4);

  const opened = await unlockWithPin({ pin: "4821" });
  assert.equal(opened.ok, true);
  assert.equal(opened.token, TOKEN);
  // 解出来的令牌一定是规范化的小写 hex（服务端比较时不分大小写这里先统一）
  assert.match(opened.token, /^[0-9a-f]{64}$/);
});

await check("PIN 不落地成明文（记录里找不到那串数字）", async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });
  const raw = globalThis.localStorage.getItem(PIN_KEY);
  assert.ok(raw, "应当有一条记录");
  assert.equal(raw.includes("4821"), false, "记录里不能出现 PIN 本身");
  assert.equal(raw.includes(TOKEN), false, "记录里不能出现明文令牌");
});

await check("位数不符 / 太简单 / 令牌形状不对 → 拒绝创建", async () => {
  reset();
  assert.equal((await createPin({ pin: "482", len: 4, token: TOKEN })).code, "BAD_FORMAT");
  assert.equal((await createPin({ pin: "1234", len: 4, token: TOKEN })).code, "TOO_SIMPLE");
  assert.equal((await createPin({ pin: "4821", len: 4, token: "nope" })).code, "BAD_TOKEN");
  assert.equal(pinEnabled(), false);
});

await check("错 PIN 不给令牌，并且累计次数", async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });

  const first = await unlockWithPin({ pin: "4822" });
  assert.equal(first.ok, false);
  assert.equal(first.code, "WRONG_PIN");
  assert.equal(first.attempts, 1);
  assert.equal(pinAttemptsLeft(), PIN_MAX_ATTEMPTS - 1);
  // 错了之后 PIN 仍然在（用户还可以再试）
  assert.equal(pinEnabled(), true);
});

await check(`错满 ${PIN_MAX_ATTEMPTS} 次 → PIN 被清掉，必须回密码登录`, async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });

  for (let i = 1; i < PIN_MAX_ATTEMPTS; i += 1) {
    const attempt = await unlockWithPin({ pin: "0001" });
    assert.equal(attempt.code, "WRONG_PIN", `第 ${i} 次应当只是错码`);
    assert.equal(attempt.attempts, i);
  }

  const last = await unlockWithPin({ pin: "0001" });
  assert.equal(last.code, "LOCKED_OUT");
  assert.equal(pinEnabled(), false, "错满必须清掉 PIN");
  assert.equal(pinLockedOut(), false, "清掉之后连“锁定”状态也不该留着");
  assert.equal(pinAttemptsLeft(), PIN_MAX_ATTEMPTS);
  assert.equal(globalThis.localStorage.getItem(PIN_KEY), null);
});

await check("错几次后用正确 PIN 仍然能开，且计数清零", async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });
  await unlockWithPin({ pin: "9999" });
  await unlockWithPin({ pin: "8888" });
  assert.equal(pinAttemptsLeft(), PIN_MAX_ATTEMPTS - 2);

  const opened = await unlockWithPin({ pin: "4821" });
  assert.equal(opened.ok, true);
  assert.equal(pinAttemptsLeft(), PIN_MAX_ATTEMPTS, "成功一次就要把计数清干净");
});

await check("记录被篡改（ct 换掉）→ 解不开，绝不放行", async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });
  const record = JSON.parse(globalThis.localStorage.getItem(PIN_KEY));
  record.ct = `${record.ct.slice(0, -4)}AAAA`;
  globalThis.localStorage.setItem(PIN_KEY, JSON.stringify(record));

  const opened = await unlockWithPin({ pin: "4821" });
  assert.equal(opened.ok, false);
  // 篡改后 GCM 认证标签对不上 → 与错码同样是 WRONG_PIN（这正是我们要的：不泄露差异）
  assert.equal(opened.code, "WRONG_PIN");
});

/** 用与 pinStore 相同的算法手工伪造一条记录（用来覆盖 CORRUPT 那一条分支） */
async function forgeRecord(pin, plaintext) {
  const enc = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const base = await globalThis.crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, [
    "deriveKey",
  ]);
  const key = await globalThis.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  const b64 = (bytes) => Buffer.from(new Uint8Array(bytes)).toString("base64");
  return JSON.stringify({
    v: 1,
    len: 4,
    iterations: 250000,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  });
}

await check("能解开但内容不是令牌（记录已损坏）→ 清掉并让用户重设", async () => {
  reset();
  globalThis.localStorage.setItem(PIN_KEY, await forgeRecord("4821", "this-is-not-a-device-token"));
  assert.equal(pinEnabled(), true, "形状完整 → 先当成“开着”");

  const opened = await unlockWithPin({ pin: "4821" });
  assert.equal(opened.ok, false);
  assert.equal(opened.code, "CORRUPT");
  assert.equal(pinEnabled(), false, "坏记录必须被清掉");
});

await check("6 位 PIN 同样能开；4 位的记录不会被 6 位输入误开", async () => {
  reset();
  await createPin({ pin: "908172", len: 6, token: TOKEN });
  const wrongLength = await unlockWithPin({ pin: "9081" });
  assert.equal(wrongLength.ok, false);
  const opened = await unlockWithPin({ pin: "908172" });
  assert.equal(opened.ok, true);
  assert.equal(opened.token, TOKEN);
});

await check("没设过 PIN 时解锁返回 NO_PIN（不是崩、也不是当成错码）", async () => {
  reset();
  const opened = await unlockWithPin({ pin: "4821" });
  assert.equal(opened.ok, false);
  assert.equal(opened.code, "NO_PIN");
});

await check("clearPin 清掉记录与计数", async () => {
  reset();
  await createPin({ pin: "4821", len: 4, token: TOKEN });
  await unlockWithPin({ pin: "1112" });
  await clearPin();
  assert.equal(pinEnabled(), false);
  assert.equal(pinAttemptsLeft(), PIN_MAX_ATTEMPTS);
  assert.equal(globalThis.localStorage.getItem(PIN_KEY), null);
});

console.log(`\n${passed} checks passed`);
