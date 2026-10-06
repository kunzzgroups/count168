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
