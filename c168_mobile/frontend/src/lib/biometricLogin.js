/**
 * 原生（APK）路径的生物识别登录：指纹 → 取出本地凭据 → 换成会话。
 *
 * 为什么抽出来：这条流程有**两个触发点** —— 启动时的锁屏门禁，以及登录页上的按钮。
 * 之前只有门禁有，于是用户一旦在 App 内登出，登录页就再也用不了指纹，
 * 只能重输密码（而本地凭据其实还在）。
 *
 * 浏览器不适用这里：那边走 WebAuthn passkey，见 lib/webauthn.js。
 */

import { authenticate, getDeviceId, loadToken, withTimeout } from "./biometricStore.js";
import { loginWithDeviceToken } from "./deviceTokenApi.js";
import { unlockWithPin } from "./pinStore.js";

/**
 * @returns {Promise<{ok:boolean, stage:'biometric'|'credential'|'server', code?:string,
 *                    message?:string, redirect?:string, userType?:string}>}
 *   stage 用于让调用方区分失败发生在哪一段：
 *     biometric —— 系统弹窗被取消/识别失败（可重试）
 *     credential —— 本地没有凭据或 Keystore 失效（重试无用，应回密码登录）
 *     server —— 服务端拒绝（要按 code 再分永久/暂时）
 */
export async function nativeBiometricLogin() {
  // ① 系统生物识别
  try {
    await authenticate();
  } catch (err) {
    return { ok: false, stage: "biometric", code: String(err?.code || "cancelled"), message: "" };
  }

  // ② 本地凭据（Keystore 失效时 loadToken 会返回 null）
  // 加超时：插件不响应时不能让调用方永远转圈
  const token = await withTimeout(loadToken(), 4000);
  if (typeof token !== "string" || !token) {
    return { ok: false, stage: "credential", code: "NO_CREDENTIAL", message: "" };
  }

  // ③ 换会话
  const result = await loginWithDeviceToken({ token, deviceId: getDeviceId() });
  return { ...result, stage: "server" };
}

/**
 * 原生（APK）路径的 **PIN** 登录：PIN → 解开本地凭据 → 换成会话。
 *
 * 与上面的指纹路径是**同一条链路的两个入口**，只把第 ① 步换掉：
 * 指纹是「系统弹窗证明是你」，PIN 是「只有你知道的码解开密文」。
 * 第 ② ③ 步完全一致（同一张设备令牌、同一个换会话接口）——
 * 这样服务端看到的仍然只是 device_login，不需要任何新端点、
 * 也不需要为 PIN 另发一张令牌（设备名额不会多占一个）。
 *
 * ⚠️ 明文令牌只在这里的局部变量里出现，永远不回写 Keystore：
 * 回写就等于「用过一次 PIN 之后，PIN 就不再是解锁的必需品」。
 *
 * @returns {Promise<{ok:boolean, stage:'pin'|'server', tokenOk?:boolean, code?:string,
 *                    message?:string, redirect?:string, attempts?:number}>}
 *   stage = 'pin'    → PIN 本身没通过（NO_PIN / WRONG_PIN / LOCKED_OUT / CORRUPT）
 *   stage = 'server' → PIN 通过了，服务端拒绝（要按 code 再分永久 / 暂时）
 */
export async function nativePinLogin(pin) {
  const deviceId = getDeviceId();

  const opened = await unlockWithPin({ pin });
  if (!opened.ok) {
    return { ok: false, stage: "pin", code: opened.code, attempts: opened.attempts || 0 };
  }

  const result = await loginWithDeviceToken({ token: opened.token, deviceId });
  return { ...result, stage: "server" };
}
