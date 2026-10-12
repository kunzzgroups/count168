/**
 * App 自带 PIN 解锁（4 位 / 6 位）——**唯一权威状态** + 加解密 + 失败计数。
 *
 * 存在的原因：生物识别不是人人都有（没录指纹 / 没录人脸 / 硬件没有），
 * 而这些用户今天每次冷启动都只能重输账号密码。PIN 给他们一条本地快速入口。
 *
 * ── 为什么是「加密那张设备令牌」而不是「存 PIN 的哈希」────────────────
 *
 * 如果只存 `hash(PIN)` 并放行，那么**绕过前端校验**就能拿到令牌：
 * 令牌本身在 Keystore 里是可以被 JS 读出来的（插件没有
 * `setUserAuthenticationRequired`，见 lib/biometricStore.js 顶部说明），
 * 谁能在页面里跑一行 JS，谁的 PIN 就形同不存在。
 *
 * 所以这里把**设备令牌本身**用 PIN 派生的密钥加密后存起来，
 * 明文令牌在任何地方都不落地：
 *
 *     PIN ──PBKDF2-SHA256(salt, iter)──► AES-256-GCM key
 *                                          │
 *     device_token ─────────────────────────┴──► ct  （只有它能换会话）
 *
 * 校验 PIN 与「拿到令牌」是**同一个动作**：GCM 认证标签对不上就解不开。
 * 因此不存在「校验通过但凭据没取到」这种中间态（规格里不允许的状态）。
 *
 * ── 安全上限（必须诚实写下来）──────────────────────────────────────
 *
 * 4 位 PIN 只有 1 万种组合，而密文就在本机（localStorage）。
 * 因此本方案的真实强度是：
 *
 *   · 对上「捡到手机随便点」的人：够用（错 5 次直接清掉，见 PIN_MAX_ATTEMPTS）
 *   · 对上「能读本机文件 + 有算力」的人：**不够**（可离线穷举 PBKDF2；
 *     250k 次迭代能拖慢，但拖不死）。真正的上限来自服务端：
 *     每次猜对都要走 device_login_api.php 换会话，那里应当限流。
 *
 * 想把这个上限也补掉，只能上原生 Keystore 的
 * `setUserAuthenticationRequired(true)` + 设备凭据 —— 那需要重新打 APK，
 * 不在本次（纯 Web）改动范围内，见 docs/mobile-pin-unlock.md。
 *
 * ── 为什么状态判断不另存一个 enabled 字段 ────────────────────────────
 *
 * 与 lib/biometricSettings.js 同一条原则：**不存可以互相矛盾的量**。
 * 这里「开着」= 一份**完整可解密的记录存在**（salt / iv / ct 都在）。
 * 任何残缺记录一律当成关闭，绝不猜。
 */

export const PIN_KEY = "ec_pin_unlock";
/** 失败计数（单独一个键：它属于“这一次猜的过程”，不属于 PIN 本身） */
export const PIN_FAIL_KEY = "ec_pin_fails";

/**
 * 允许的位数，由用户在设置时自选。
 *
 * ⚠️ **顺序即默认**（第一项是设置界面的初始选中值）：产品定为 **6 位**。
 * 理由不是“好看”：4 位只有 1 万种组合，密文在本机、PBKDF2 拖不住有算力的
 * 攻击者（量级是秒），6 位把穷举成本拉到 100 倍 —— 仍然不是质变，
 * 但这是不改原生代码就能拿到的最便宜的一档（见 docs/mobile-pin-unlock.md §7）。
 * 4 位仍**可选**：老用户习惯、以及顺手就能改的场合不该被堵死。
 */
export const PIN_LENGTHS = [6, 4];

/**
 * 连错到这个次数就**清掉 PIN**，强制回密码登录。
 *
 * 为何是「清掉」而不是「锁定一段时间」：
 * 锁一段时间的做法在客户端可以靠改本机时间绕过（时间由客户端给），
 * 而清掉之后就算绕过那一步，也没有密文可解了。
 */
export const PIN_MAX_ATTEMPTS = 5;

const VERSION = 1;

/**
 * PBKDF2 迭代次数。写进记录里 —— 以后调大不会让老 PIN 解不开。
 *
 * 取值权衡：250k 在安卓 WebView 上约 200~500ms（配界面上的转圈），
 * 而它把离线穷举 1 万种 PIN 的代价抬到分钟级。**别为了“更快”调小**。
 */
const DEFAULT_ITERATIONS = 250000;

/** 设备令牌的形状：32 字节随机数的 hex（见 includes/device_token.php） */
const TOKEN_RE = /^[0-9a-f]{64}$/i;

/** 过于简单的组合：4 位 / 6 位各一小张黑名单，外加全同号与顺子 */
const BLOCKLIST = new Set([
  "0000",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "1234",
  "4321",
  "0123",
  "1212",
  "2121",
  "1122",
  "000000",
  "111111",
  "222222",
  "333333",
  "123456",
  "654321",
  "121212",
  "112233",
]);

/** localStorage 读取口。单独抽出来是为了能在 node 里跑单测（见 scripts/test-pin-unlock.mjs）。 */
function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readKey(key) {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    store()?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function dropKey(key) {
  try {
    store()?.removeItem(key);
  } catch {
    /* 已经是空的了 */
  }
}

function b64(bytes) {
  let out = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
  return btoa(out);
}

function unb64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function encoder() {
  return new TextEncoder();
}

/** WebCrypto 是否可用。不可用时**不允许开启 PIN** —— 宁可没有功能，也不降级成弱存储。 */
export function isPinSupported() {
  const c = globalThis.crypto;
  return Boolean(c?.subtle && typeof c.getRandomValues === "function" && store());
}

/** 位数是否合法（用户自选，只接受 4 / 6） */
export function normalizePinLength(value) {
  const n = Number(value);
  return PIN_LENGTHS.includes(n) ? n : 0;
}

/** 形如 4/6 位纯数字 */
export function isValidPinFormat(pin, len) {
  const wanted = normalizePinLength(len);
  if (!wanted) return false;
  const text = String(pin ?? "");
  return new RegExp(`^\\d{${wanted}}$`).test(text);
}

/**
 * 太简单的 PIN 直接拒绝（全同号 / 顺子 / 常见组合）。
 *
 * 为什么值得拒绝：4 位 PIN 的搜索空间本来就只有 1 万，
 * 「0000 / 1234」这类占了真实敲出来的 PIN 的相当大的比例。
 * 这不是安全审查，只是别让用户一眼就选中那几十个。
 */
export function isTooSimplePin(pin) {
  const text = String(pin ?? "");
  if (!/^\d+$/.test(text)) return true;
  if (BLOCKLIST.has(text)) return true;
  // 4 位以上出现明显顺子（12345 / 987654）也拒绝
  let asc = true;
  let desc = true;
  for (let i = 1; i < text.length; i += 1) {
    const diff = text.charCodeAt(i) - text.charCodeAt(i - 1);
    if (diff !== 1) asc = false;
    if (diff !== -1) desc = false;
  }
  return asc || desc;
}

/**
 * 读原始记录。返回 null 表示「没有 PIN」。
 * **不抛**：启动路径上任何抛错都会把门禁卡住。
 */
function readRecord() {
  const raw = readKey(PIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 归一化：**只有一个判据** —— 一份完整记录（salt/iv/ct + 合法位数）才算开着。
 */
export function normalizePinSettings(raw) {
  const len = normalizePinLength(raw?.len);
  const complete =
    typeof raw?.salt === "string" &&
    raw.salt.length > 0 &&
    typeof raw?.iv === "string" &&
    raw.iv.length > 0 &&
    typeof raw?.ct === "string" &&
    raw.ct.length > 0;

  // 残缺记录：enabled=false，位数给默认值（反正界面只会用它当“没设过”的展示）
  if (!complete || !len) return { v: VERSION, enabled: false, len: len || PIN_LENGTHS[0] };

  return {
    v: VERSION,
    enabled: true,
    len,
    iterations: Number(raw?.iterations) > 0 ? Number(raw.iterations) : DEFAULT_ITERATIONS,
  };
}

/** 给界面读的设置（不含任何密钥材料） */
export function readPinSettings() {
  const settings = normalizePinSettings(readRecord());
  return { v: settings.v, enabled: settings.enabled, len: settings.len };
}

export function pinEnabled() {
  return readPinSettings().enabled;
}

/** 由 PIN 派生 AES-GCM 密钥。pbkdf2 每次解锁都要跑，慢是设计的一部分。 */
async function deriveKey(pin, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", encoder().encode(String(pin)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * 设置 / 重设 PIN：把设备令牌加密后存起来。
 *
 * @param {{pin: string, len: number, token: string}} params
 * @returns {Promise<{ok: true} | {ok: false, code: string}>}
 */
export async function createPin({ pin, len, token }) {
  if (!isPinSupported()) return { ok: false, code: "NO_CRYPTO" };
  if (!isValidPinFormat(pin, len)) return { ok: false, code: "BAD_FORMAT" };
  if (isTooSimplePin(pin)) return { ok: false, code: "TOO_SIMPLE" };
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, code: "BAD_TOKEN" };

  try {
    const wanted = normalizePinLength(len);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt, DEFAULT_ITERATIONS);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder().encode(token),
    );

    const record = {
      v: VERSION,
      len: wanted,
      iterations: DEFAULT_ITERATIONS,
      salt: b64(salt),
      iv: b64(iv),
      ct: b64(ct),
      updated: new Date().toISOString(),
    };

    // 一次写入（不存在 enabled 与实际记录不一致的中间态）
    if (!writeKey(PIN_KEY, JSON.stringify(record))) return { ok: false, code: "STORE_FAILED" };
    clearPinFailures();
    return { ok: true };
  } catch {
    return { ok: false, code: "CRYPTO_FAILED" };
  }
}

/**
 * 用 PIN 换出设备令牌。**校验 PIN 与取令牌是同一个动作**。
 *
 * @param {{pin: string}} params
 * @returns {Promise<{ok: true, token: string} | {ok: false, code: string, attempts?: number}>}
 *   code: NO_PIN（没设过） | LOCKED_OUT（错太多，PIN 已被清）|
 *         WRONG_PIN（还能再试，attempts 是已错次数）| CORRUPT（记录坏了，已清）
 */
export async function unlockWithPin({ pin }) {
  if (!isPinSupported()) return { ok: false, code: "NO_CRYPTO" };

  const settings = normalizePinSettings(readRecord());
  if (!settings.enabled) return { ok: false, code: "NO_PIN" };

  if (pinLockedOut()) {
    await clearPin();
    return { ok: false, code: "LOCKED_OUT", attempts: PIN_MAX_ATTEMPTS };
  }

  try {
    const record = readRecord();
    const key = await deriveKey(
      pin,
      unb64(record.salt),
      Number(record.iterations) > 0 ? Number(record.iterations) : DEFAULT_ITERATIONS,
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(record.iv) },
      key,
      unb64(record.ct),
    );
    const token = new TextDecoder().decode(plain);
    if (!TOKEN_RE.test(token)) {
      // 解开了但内容不是令牌 → 记录坏了。留着只会每次解锁都白跑一趟。
      await clearPin();
      return { ok: false, code: "CORRUPT" };
    }
    clearPinFailures();
    return { ok: true, token: token.toLowerCase() };
  } catch {
    // 解不开 = PIN 不对（GCM 认证标签对不上）
    const attempts = recordPinFailure();
    if (attempts >= PIN_MAX_ATTEMPTS) {
      await clearPin();
      return { ok: false, code: "LOCKED_OUT", attempts };
    }
    return { ok: false, code: "WRONG_PIN", attempts };
  }
}

/** 只要「对不对」的场景（例如设置页改 PIN 前验旧的） */
export async function verifyPin(pin) {
  const result = await unlockWithPin({ pin });
  return result.ok === true;
}

/** 已连错次数 */
export function readPinFailures() {
  const raw = readKey(PIN_FAIL_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 记一次失败，返回累计次数 */
export function recordPinFailure() {
  const next = readPinFailures() + 1;
  writeKey(PIN_FAIL_KEY, String(next));
  return next;
}

export function clearPinFailures() {
  dropKey(PIN_FAIL_KEY);
}

export function pinLockedOut() {
  return readPinFailures() >= PIN_MAX_ATTEMPTS;
}

/** 还能试几次（界面用；不暴露“已经错了几次”这种让人焦虑的数字） */
export function pinAttemptsLeft() {
  return Math.max(0, PIN_MAX_ATTEMPTS - readPinFailures());
}

/**
 * 清掉 PIN（关掉开关 / 令牌已废 / 错太多次）。
 * **只清 PIN 记录与失败计数**，绝不碰 Keystore —— 那属于生物识别，两者互不代偿。
 */
export async function clearPin() {
  dropKey(PIN_KEY);
  dropKey(PIN_FAIL_KEY);
}
