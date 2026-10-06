/**
 * 指纹 / 人脸解锁的原生适配层。
 *
 * ⚠️ 为什么必须 `import` 插件，而不是走 `window.Capacitor.Plugins.*`：
 *
 *   @capacitor/core 的 `registerPlugin()` 会把「通用代理」写进
 *   `Capacitor.Plugins[name]`，但它 **return** 的是 JS 实现类。
 *   而本插件的 `authenticate()` 是 **JS 侧包装方法**（原生侧只实现了
 *   `internalAuthenticate`），它负责把 CapacitorException 转成带 code 的
 *   BiometryError。走 `Capacitor.Plugins.BiometricAuthNative.authenticate()`
 *   会去调一个原生不存在的 `authenticate` → **真机上运行时失败**。
 *   所以只能 import。见 @capacitor/core/dist/index.js 的 registerPlugin 实现。
 *
 * 插件注册名是 `BiometricAuthNative`（不是 BiometricAuth），`SecureStorage`。
 *
 * 依赖（均明确针对 Capacitor 8，各自 dependencies 里带 @capacitor/android ^8.0.2）：
 *   @aparajita/capacitor-biometric-auth  生物识别可用性 + 弹窗
 *   @aparajita/capacitor-secure-storage  Android Keystore / iOS Keychain 存取令牌
 */

import { Capacitor } from "@capacitor/core";
import { BiometricAuth, BiometryType } from "@aparajita/capacitor-biometric-auth";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { readLoginLang } from "./loginLang.js";

/**
 * 安全存储的 key 前缀，必须与其它插件隔离。
 * 绝不能留空 —— 空前缀会清掉整个 App 的安全存储（含其它插件的数据）。
 */
/**
 * 存储键。
 *
 * ⚠️ 名字前缀直接烤进**键名**，而不是用 SecureStorage.setKeyPrefix()。
 *
 * 为何改成这样：setKeyPrefix 会改插件的**全局可变状态**，而 set / get / remove
 * 都要先 await 它。一旦它失败（或调用时序不一致），就会**用不同前缀存取同一个键**
 * —— 存进去的取不出来。
 * 实机上报过“登录页已开启指纹，但设置里 Biometric Unlock 显示关闭”。
 * 用带命名空间的键名能达到同样的隔离效果，而且没有全局状态依赖。
 */
const TOKEN_KEY = "count168_biometric_device_token";
const DEVICE_ID_KEY = "count168_biometric_device_id";

/** 明文 device_id 不敏感，放 localStorage 即可；令牌绝不能放这里。 */
const DEVICE_ID_LS_KEY = "ec_biometric_device_id";

/** 是否已经设置过安全存储的命名空间（已废弃，仅为兼容保留空实现） */
function ensurePrefix() {
  // 已废弃：不再用 setKeyPrefix（见 TOKEN_KEY 的注释）。
  // 保留空实现以避免触及调用点导致漏改。
  return Promise.resolve();
}

/** 是否跑在 Capacitor 原生壳（APK）里。网页 / PWA 一律 false。 */
export function isNative() {
  try {
    // ⚠️ 不能只用 Capacitor.isNativePlatform()。
    //
    // 它内部把 `window.webkit.messageHandlers.bridge` 的存在当作 iOS 原生壳，
    // 但 **iOS 的 WebKit 环境（包括从 Safari「添加到主屏幕」的独立 App）也会暴露它** ——
    // 结果网页端被误判成原生，设置页走进原生分支，显示“设备没有指纹/人脸”并置灰。
    // （这是真实发生过的 bug，用户截图里就是这条文案。）
    //
    // 只信「确实接上了原生桥」的两个证据：
    //   ① androidBridge —— 只有 Capacitor 安卓壳注入
    //   ② Capacitor.PluginHeaders —— 由原生 capacitor.js 注入，
    //      @capacitor/core 只读不写，浏览器里永远是 undefined
    if (typeof window.androidBridge !== "undefined") {
      return true;
    }
    const headers = window.Capacitor?.PluginHeaders;

    return Array.isArray(headers) && headers.length > 0;
  } catch {
    return false;
  }
}

/**
 * 设备是否支持且已录入生物识别。
 * 注意：必须先用 isNative() 拦住网页端 —— 该插件在 web 平台有「模拟实现」，
 * 不拦的话浏览器里会假装验证成功。
 */
export async function isAvailable() {
  if (!isNative()) return false;
  try {
    // 加超时：原生插件不响应时不能把调用方（设置页、登录引导）卡住
    const result = await withTimeout(BiometricAuth.checkBiometry(), 4000);
    return result?.isAvailable === true;
  } catch {
    return false;
  }
}

/**
 * 设备支持的生物识别类型名，供设置页展示（“指纹” / “Face ID” …）。
 * 不可用时返回空串 —— 调用方据此决定不渲染开关。
 */
export async function describeBiometry() {
  if (!isNative()) return "";
  try {
    // ⚠️ 必须加超时：这个调用在插件不响应时永远不会 settle，
    // 而调用方（设置页的检测 effect）会 await 它 —— 结果是页面永远停在加载／
    // 开关看起来“不可用”。实机上报过“安卓没有可用的生物识别”。
    const result = await withTimeout(BiometricAuth.checkBiometry(), 4000);
    if (result?.isAvailable !== true) return "";

    switch (Number(result.biometryType)) {
      case BiometryType.touchId:
        return "Touch ID";
      case BiometryType.faceId:
        return "Face ID";
      case BiometryType.fingerprintAuthentication:
        return "Fingerprint";
      case BiometryType.faceAuthentication:
        return "Face";
      case BiometryType.irisAuthentication:
        return "Iris";
      default:
        return "Biometric";
    }
  } catch {
    return "";
  }
}

/** 稳定的设备标识：同一台设备恒定，重装会变（这是预期的，Keystore 也一起清空）。 */
export function getDeviceId() {
  try {
    const cached = localStorage.getItem(DEVICE_ID_LS_KEY);
    if (cached) return cached;
    const generated =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_ID_LS_KEY, generated);
    return generated;
  } catch {
    // localStorage 不可用（隐私模式）时退化成会话内临时 id
    return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** 设备名，仅用于「我的登录设备」页展示。 */
export function getDeviceName() {
  if (!isNative()) {
    return typeof navigator !== "undefined" ? "Web" : "Unknown";
  }
  try {
    const platform = Capacitor.getPlatform();
    return `${platform === "android" ? "Android" : platform} device`;
  } catch {
    return "Mobile device";
  }
}

/**
 * 弹出生物识别。成功 resolve，失败/取消 reject。
 *
 * ⚠️ 千万不要再加 androidTitle / androidSubtitle —— 两个都试过，都会造成重复显示：
 *
 *   1. androidTitle：省略时插件默认用 “Fingerprint Authentication” / “Face Authentication”
 *      这类名称（BiometricAuthNative.java 的 biometryNameMap）；而系统本来就会在弹窗顶部
 *      显示应用名。传 "EazyCount" 会让它出现两次。
 *   2. androidSubtitle：在安卓上它与 reason 是**两个不同位置** ——
 *      AuthActivity.java:72 是 setTitle(title).setSubtitle(subtitle).setDescription(reason)。
 *      传同一个字符串就会上下显示两遍（实机截图确认过）。
 *
 * 所以只传 reason（安卓上用作文案，iOS 上是必填的 localizedReason）。
 */
export async function authenticate() {
  const lang = readLoginLang();
  // 文案尽量短：系统弹窗本来就在上方显示应用名，
  // 再写一遍 “to EazyCount” 只会多折一行，让弹窗看起来拥挤。
  const reason = lang === "zh" ? "验证指纹以登录" : "Verify your fingerprint to sign in";

  await BiometricAuth.authenticate({
    reason,
    // 空字符串 = 不要标题行。默认值是 “Fingerprint Authentication” 这类名称，
    // 与系统已经显示的应用名 + 上面的 reason 重复，是第三行冗余文字。
    androidTitle: "",
    cancelTitle: lang === "zh" ? "取消" : "Cancel",
    // 不允许用锁屏密码兜底：这里要的是「生物识别」本身，
    // 允许设备凭据会让「指纹解锁」名不副实。
    allowDeviceCredential: false,
    // 仍然**不传** androidSubtitle：它与 reason 是两个不同的显示位置，
    // 传同一个字符串会上下显示两遍（见文件顶部说明）。
  });
}

/** 令牌写入 Keystore（Android）/ Keychain（iOS） */
export async function saveToken(token) {
  await ensurePrefix();
  await SecureStorage.set(TOKEN_KEY, token);
}

/** 读令牌；不存在或 Keystore 密钥失效时返回 null（不抛） */
export async function loadToken() {
  if (!isNative()) return null;
  try {
    await ensurePrefix();
    const value = await withTimeout(SecureStorage.get(TOKEN_KEY), 4000);
    if (typeof value !== "string" || value === "") return null;

    // 宽容提取：不要求长度恰好 64。
    // 有些实现会把值包一层（JSON 引号、前缀拼接），严格长度校验会把
    // 一把**本来可用**的令牌当成“没有凭据”丢掉 —— 那就是设置里
    // 明明已开启却显示 Off 的原因。只要里面能取出一段 64 位 hex 就用它。
    const match = value.match(/[0-9a-f]{64}/i);
    return match ? match[0].toLowerCase() : null;
  } catch {
    // 指纹变更 / 改锁屏密码 / 重装 / 恢复备份 → Keystore 密钥失效，这里会抛
    return null;
  }
}

/** 清本地凭据。用于：关闭指纹解锁、令牌被吊销/过期、Keystore 失效 */
export async function clearToken() {
  try {
    await ensurePrefix();
    await SecureStorage.remove(TOKEN_KEY);
  } catch {
    /* 已经是清空状态 */
  }
}

/**
 * 仅用于诊断：原生生物识别的真实返回。
 *
 * 为何需要：APK 里 webContentsDebuggingEnabled=false，拿不到 console；
 * 而“不可用”可能来自好几个原因（插件不响应 / 超时 / 本身返回不可用）。
 * 把原因缩成一句短文本显示在界面上，一张截图就能定位。
 */
export async function biometryReport() {
  if (!isNative()) return "not-native";

  let plat = "?";
  try {
    plat = Capacitor.getPlatform();
  } catch {
    /* 忽略 */
  }

  try {
    const result = await withTimeout(BiometricAuth.checkBiometry(), 4000);
    if (result === null) return `timeout (plat=${plat})`;
    return `available=${result.isAvailable} type=${result.biometryType} plat=${plat}`;
  } catch (err) {
    return `error ${err?.message || err} (plat=${plat})`;
  }
}

/**
 * 给「可能卡住的本地/原生调用」加超时。
 *
 * 为什么必须有：启动门禁检查凭据时会 await 原生插件（SecureStorage）。
 * 插件不响应（旧 APK 里没装、桥接异常等）时，这个 await **永远不会 settle**，
 * 门禁就永久停在“检查登录状态…” —— 整个 App 卡死，连密码登录都进不去。
 * 这是实机上报过的问题。宁可当成“没有凭据”回退到密码登录，也不能卡住。
 *
 * @param {Promise<*>} promise
 * @param {number} ms
 * @returns {Promise<*>} 超时或出错都返回 null
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value ?? null);
    };

    const timer = setTimeout(() => done(null), ms);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        done(value);
      })
      .catch(() => {
        clearTimeout(timer);
        done(null);
      });
  });
}
