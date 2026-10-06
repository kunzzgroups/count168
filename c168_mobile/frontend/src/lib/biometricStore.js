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
const KEY_PREFIX = "count168_biometric_";
const TOKEN_KEY = "device_token";
const DEVICE_ID_KEY = "device_id";

/** 明文 device_id 不敏感，放 localStorage 即可；令牌绝不能放这里。 */
const DEVICE_ID_LS_KEY = "ec_biometric_device_id";

let prefixReady = null;

function ensurePrefix() {
  if (!prefixReady) {
    prefixReady = SecureStorage.setKeyPrefix(KEY_PREFIX).catch(() => {
      // 设不上就别继续，否则后续读写落在一个没隔离的前缀里
      prefixReady = null;
    });
  }
  return prefixReady;
}

/** 是否跑在 Capacitor 原生壳（APK）里。网页 / PWA 一律 false。 */
export function isNative() {
  try {
    return Capacitor.isNativePlatform() === true;
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
    const result = await BiometricAuth.checkBiometry();
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
    const result = await BiometricAuth.checkBiometry();
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
    const value = await SecureStorage.get(TOKEN_KEY);
    return typeof value === "string" && value.length === 64 ? value : null;
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
