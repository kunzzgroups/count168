/**
 * 生物识别解锁的**唯一权威状态**与**唯一决策点**。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 *
 * 改造前有两个互相独立的来源：
 *   · 「是否开启」是**推导值** — Boolean(await loadToken())，有没有凭据
 *   · 「用哪种方式」是另一个键 — ec_biometric_modality
 * 两者可以对不上，而规格 §2 明确禁止这种状态：
 *     enabled = true 且 method = NONE            ← 不允许
 *     fingerprintEnabled 与 faceEnabled 同时为真 ← 不允许
 *
 * 现在整个应用只有下面这一个对象，并且**一次 JSON 写入**，不存在中间态：
 *     { v: 1, enabled: boolean, method: "NONE" | "FINGERPRINT" | "FACE" }
 *
 * ── 为什么本模块是纯的 ────────────────────────────────────────────────
 *
 * 不引用 window / localStorage（读写集中在最下面两个函数里），
 * 所以 normalizeSettings / resolveBiometric / migrateSettings 都能在 CI 里
 * 直接跑断言，不需要手机、不需要浏览器。规格 §17 里可自动化的那几个用例
 * 就是靠这一点落地的。
 */

export const METHOD = {
  NONE: "NONE",
  FINGERPRINT: "FINGERPRINT",
  FACE: "FACE",
};

/** 运行时**能力**状态 —— 只活在内存里，从不持久化 */
export const CAP = {
  /** 探测没给出答案。注意：它**不等于**「不可用」 */
  UNKNOWN: "UNKNOWN",
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_ENROLLED: "NOT_ENROLLED",
  TEMPORARILY_LOCKED: "TEMPORARILY_LOCKED",
  SECURITY_REQUIREMENT_FAILED: "SECURITY_REQUIREMENT_FAILED",
};

export const SETTINGS_KEY = "ec_biometric";
/** 旧键，迁移后删除 */
export const LEGACY_MODALITY_KEY = "ec_biometric_modality";
const VERSION = 1;

/** 关闭态。任何时候都通过它构造，避免手写对象漏字段。 */
export function disabledSettings() {
  return { v: VERSION, enabled: false, method: METHOD.NONE };
}

/**
 * 唯一的构造入口，强制不变量。
 *
 * 任何非法组合都被收敛成合法状态 ——
 * **绝不**产生 `enabled = true` 且 `method = NONE`。
 */
export function normalizeSettings(raw) {
  const enabled = raw?.enabled === true;
  const method =
    raw?.method === METHOD.FACE
      ? METHOD.FACE
      : raw?.method === METHOD.FINGERPRINT
        ? METHOD.FINGERPRINT
        : METHOD.NONE;

  // 不变量：开启必须有具体方式；没有方式就是关闭
  if (!enabled || method === METHOD.NONE) return disabledSettings();
  return { v: VERSION, enabled: true, method };
}

/**
 * 迁移旧数据 → 新模型。
 *
 * ⚠️ 规格 §15：不得把旧值**未经校验**当成新模型的真值。所以：
 *   · 旧方式值不认识（空 / 脏数据）→ **不猜**，直接 DISABLED
 *   · 有方式但**没有凭据** → 不是真的开启 → DISABLED
 *
 * ⚠️ 已知的模型缺口（需要产品确认，见 docs/biometric-unlock-architecture.md）：
 * 旧版本在没有任何方式键时，实际行为是「让系统决定」（plugins 默认 WEAK），
 * 而新模型只有 NONE / FINGERPRINT / FACE 三个值，**表达不了 ANY**。
 * 因此这里选择 DISABLED（让用户显式重选），而不是擅自写成 FINGERPRINT ——
 * 那正是用户报过的「不知不觉又变回指纹」。
 */
export function migrateSettings(legacyModality, credentialPresent) {
  const method =
    legacyModality === "face"
      ? METHOD.FACE
      : legacyModality === "fingerprint"
        ? METHOD.FINGERPRINT
        : METHOD.NONE;

  if (method === METHOD.NONE) return disabledSettings();
  if (credentialPresent !== true) return disabledSettings();
  return { v: VERSION, enabled: true, method };
}

/**
 * 唯一的决策点。锁屏、登录页、设置页、引导弹窗都**不许**自己判断用哪种方式。
 *
 * ── expectedModality 与 guaranteedModality 必须分开 ──────────────────
 *
 * 安卓没有「只用指纹 / 只用人脸」这个开关，App 只能选生物识别的**强度**，
 * 由系统决定最终弹哪一种（证据见 docs/biometric-unlock-architecture.md §G）。
 *
 *   FINGERPRINT → strong → 真的能排除人脸 → guaranteed = FINGERPRINT ✓
 *   FACE        → weak   → 系统可能仍给指纹 → guaranteed = ANY         ✗
 *
 * 界面只允许在 guaranteed 的范围内描述自己。否则就会出现实机报过的
 * 「文案说人脸、弹出来的却是指纹」。
 *
 * @param {{enabled:boolean, method:string}} settings 持久化的用户偏好
 * @param {{state?:string, fingerprintAvailable?:boolean|null, faceAvailable?:boolean|null}} capability 运行时能力
 */
export function resolveBiometric(settings, capability) {
  const s = normalizeSettings(settings);
  const cap = capability || {};
  const state = cap.state || CAP.UNKNOWN;

  const idle = {
    enabled: s.enabled,
    method: s.method,
    strategy: "NONE",
    startable: false,
    reason: "",
    promptStrength: "weak",
    expectedModality: "ANY",
    guaranteedModality: "ANY",
  };

  if (!s.enabled) return idle;

  const isFingerprint = s.method === METHOD.FINGERPRINT;
  const intent = {
    ...idle,
    strategy: isFingerprint ? "NATIVE_FINGERPRINT" : "NATIVE_FACE",
    promptStrength: isFingerprint ? "strong" : "weak",
    expectedModality: s.method,
    // 只有指纹能被真正保证
    guaranteedModality: isFingerprint ? METHOD.FINGERPRINT : "ANY",
  };

  // 设备层面明确不可用 → 给出原因，但**绝不改写用户的 method**（规格 §7）
  switch (state) {
    case CAP.NOT_ENROLLED:
      return { ...intent, reason: "NOT_ENROLLED" };
    case CAP.TEMPORARILY_LOCKED:
      return { ...intent, reason: "LOCKED" };
    case CAP.SECURITY_REQUIREMENT_FAILED:
      return { ...intent, reason: "SECURITY_REQUIREMENT_FAILED" };
    case CAP.UNAVAILABLE:
      return {
        ...intent,
        reason: isFingerprint ? "FINGERPRINT_UNAVAILABLE" : "FACE_UNAVAILABLE",
      };
    default:
      break;
  }

  // 凭据（device_token / passkey）是**运行时前提**，不是用户偏好：
  // 没有它 → 启动不了，但**绝不改写 method**（规格 §7）。
  // 注意 `undefined` 代表**未知**（例如 iOS 的凭据在服务端）→ 允许启动。
  //
  // 为何需要它：实机出现过模型里 enabled=1 而 Keystore 里 token=no
  // —— 模型说开着、凭据却不在，那个状态不可能登录成功，必须被说出来。
  if (cap.credentialPresent === false) {
    return { ...intent, reason: "NO_CREDENTIAL" };
  }

  // 能力「已知可用」时，再按具体模态过滤。
  // 注意只认 `=== false`：null / undefined 代表**未知**，
  // 不能当成不可用 —— 把未知塌缩成 false 正是之前两次功能全瞎的原因。
  if (cap.faceAvailable === false && s.method === METHOD.FACE) {
    return { ...intent, reason: "FACE_UNAVAILABLE" };
  }
  if (cap.fingerprintAvailable === false && isFingerprint) {
    return { ...intent, reason: "FINGERPRINT_UNAVAILABLE" };
  }

  // 能力未知（探测没应答）→ **仍然允许启动**。
  // 绝不因为探测失败就把功能关掉：唯一可信的证据是 authenticate() 的真实结果。
  return { ...intent, startable: true };
}

/**
 * 把插件探测结果翻译成**运行时能力**。
 *
 * ⚠️ 关键在于用**录入**状态，而不是**硬件**类型。
 *
 * `biometryTypes` 是「硬件支持哪些类型」—— 手机带指纹传感器它就永远包含指纹，
 * 用户把指纹从系统里删掉后它**不会变**。实机就是这么踩的：
 * 指纹已删、人脸还在，App 以仍为可以用指纹，于是拿 strong 去认证必然失败，
 * 用户看到的就是「指纹没了却也不转去刷脸，只掉回密码登录」。
 *
 * 可靠信号只有插件给的两个（都是“已录入”语义）：
 *   strongBiometryIsAvailable  强生物识别已录入 ≈ 指纹（指纹几乎都是 Class 3）
 *   isAvailable                弱及以上已录入
 *
 * @returns {{state:string, fingerprintAvailable?:boolean, faceAvailable?:boolean}}
 */
export function capabilityFromProbe(info) {
  if (!info || info.ok !== true) return { state: CAP.UNKNOWN };

  // 这两个错误码要先于“没有录入”判断：系统给的原因比我们的推断具体。
  if (info.code === "biometryLockout") return { state: CAP.TEMPORARILY_LOCKED };
  if (info.code === "biometryNotEnrolled") return { state: CAP.NOT_ENROLLED };

  if (info.isAvailable !== true && info.strongAvailable !== true) {
    return { state: CAP.NOT_ENROLLED };
  }

  return {
    state: CAP.AVAILABLE,
    // 指纹：只认「强生物识别已录入」。硬件有传感器 ≠ 用户录了指纹。
    fingerprintAvailable: info.strongAvailable === true,
    // 人脸：弱及以上可用即可（人脸通常是弱）。
    // 无法与「只录了指纹」区分，但那种情况下 weak 认证依然能成，不会误报。
    faceAvailable: info.isAvailable === true,
  };
}

/**
 * 自动换方式的**目标**（不能换时返回 ""）。
 *
 * 产品要求：用户选的那种方式在这台设备上没了（比如在系统里删了指纹），
 * **自动换成另一种、不询问**。
 *
 * ⚠️ 但只在探测**明确**说目标可用（=== true）时才返回目标：
 * unknown / null / undefined 一律返回 ""。
 *
 * 为何这么保守：把“探测失败”当成“不可用”是之前两次功能全瞎的原因；
 * 反过来把“探测失败”当成“可用”同样会乱改用户的偏好。
 * 宁愿退化成手动按钮，也不要在不确定的时候改设置。
 */
export function autoSwitchTarget(method, capability) {
  if (method !== METHOD.FINGERPRINT && method !== METHOD.FACE) return "";
  const other = method === METHOD.FINGERPRINT ? METHOD.FACE : METHOD.FINGERPRINT;
  const available =
    other === METHOD.FACE
      ? capability?.faceAvailable === true
      : capability?.fingerprintAvailable === true;
  return available ? other : "";
}

/* ── 持久化（唯一碰 localStorage 的地方）────────────────────────────── */

export function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // 解析失败当成「还没有设置」，让迁移流程去决定，不要瞎猜
    return null;
  }
}

export function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
  } catch {
    /* 存不下就下次再说，不阻断流程 */
  }
  return clean;
}

export function clearSettings() {
  try {
    window.localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* 忽略 */
  }
}

export function readLegacyModality() {
  try {
    return window.localStorage.getItem(LEGACY_MODALITY_KEY);
  } catch {
    return null;
  }
}

export function clearLegacyModality() {
  try {
    window.localStorage.removeItem(LEGACY_MODALITY_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 读出权威设置：优先新模型；没有就按迁移规则从旧键推导并落盘。
 * 迁移成功后才删旧键（规格 §H：先读回再删，避免部分迁移后两个键都没了）。
 *
 * @param {boolean} credentialPresent 本机 Keystore 里是否真有凭据
 */
export function ensureSettings(credentialPresent) {
  const existing = loadSettings();
  if (existing) return existing;

  const legacy = readLegacyModality();
  if (legacy === null) return disabledSettings();

  const migrated = migrateSettings(legacy, credentialPresent);
  const saved = saveSettings(migrated);
  // 只有确认写回成功后，才删旧键
  if (loadSettings()) clearLegacyModality();
  return saved;
}
