/**
 * WebAuthn / Passkey（Face ID / 指纹登录）前端封装。
 *
 * 与手机 App 的指纹解锁是**两套不同机制**，别混淆：
 *   - APK 内：device_token —— 「本地存凭据 + 生物识别门禁」，凭据是共享秘密
 *   - 浏览器：WebAuthn —— 服务端公钥认证，没有共享秘密，且抗钓鱼
 * 安卓 WebView 不支持 WebAuthn，所以 APK 里不会走这里（isNative() 为真时我们不动它）。
 */

import { buildApiUrl } from "../utils/apiUrl.js";

/* ── base64url ↔ ArrayBuffer（WebAuthn 全用 ArrayBuffer，接口全用 base64url）── */

function b64urlToBytes(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── 能力探测 ───────────────────────────────────────────────── */

/** 当前环境是否支持 WebAuthn（必须是安全上下文：https 或 localhost） */
export function webauthnSupported() {
  try {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext === true &&
      typeof window.PublicKeyCredential === "function" &&
      typeof navigator !== "undefined" &&
      !!navigator.credentials
    );
  } catch {
    return false;
  }
}

/** 是否存在「平台验证器」（Face ID / Touch ID / 安卓指纹）—— 决定要不要给用户看刷脸入口 */
export async function platformAuthenticatorAvailable() {
  if (!webauthnSupported()) return false;
  try {
    const fn = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn !== "function") return false;
    return (await fn.call(window.PublicKeyCredential)) === true;
  } catch {
    return false;
  }
}

/* ── 网络 ───────────────────────────────────────────────────── */

async function postForm(path, params = {}) {
  const fd = new FormData();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  });
  const res = await fetch(buildApiUrl(path), {
    method: "POST",
    body: fd,
    credentials: "include",
    cache: "no-store",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

/* ── 注册一把 passkey ───────────────────────────────────────── */

/**
 * @param {string} deviceName
 * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
 */
export async function createPasskey(deviceName) {
  if (!webauthnSupported()) {
    return { ok: false, code: "UNSUPPORTED", message: "This browser cannot use biometric login." };
  }

  const { json: opt } = await postForm("api/session/webauthn_register_options_api.php");
  if (!opt?.success) {
    return { ok: false, code: opt?.code || "OPTIONS_FAILED", message: opt?.message || "" };
  }

  let credential = null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(opt.challenge),
        rp: { id: opt.rp.id, name: opt.rp.name },
        user: {
          id: b64urlToBytes(opt.user.id),
          name: opt.user.name,
          displayName: opt.user.displayName,
        },
        pubKeyCredParams: opt.pubKeyCredParams,
        timeout: opt.timeout,
        attestation: opt.attestation,
        authenticatorSelection: opt.authenticatorSelection,
        excludeCredentials: (opt.excludeCredentials || []).map((c) => ({
          type: c.type,
          id: b64urlToBytes(c.id),
        })),
      },
    });
  } catch (err) {
    // 用户取消 / 超时 / 设备不支持 —— 都不是错误状态，只需要安静地退回
    return { ok: false, code: err?.name || "CANCELLED", message: "" };
  }

  const response = credential?.response;
  if (!response) {
    return { ok: false, code: "NO_CREDENTIAL", message: "" };
  }

  const { json } = await postForm("api/session/webauthn_register_verify_api.php", {
    credential_id: bytesToB64url(credential.rawId),
    client_data_json: bytesToB64url(response.clientDataJSON),
    attestation_object: bytesToB64url(response.attestationObject),
    device_name: deviceName || "",
  });

  if (!json?.success) {
    return { ok: false, code: json?.code || "VERIFY_FAILED", message: json?.message || "" };
  }
  return { ok: true };
}

/* ── 用 passkey 登录 ────────────────────────────────────────── */

/**
 * @returns {Promise<{ok:boolean, redirect?:string, code?:string, message?:string}>}
 */
export async function loginWithPasskey() {
  if (!webauthnSupported()) {
    return { ok: false, code: "UNSUPPORTED", message: "This browser cannot use biometric login." };
  }

  const { json: opt } = await postForm("api/session/webauthn_login_options_api.php");
  if (!opt?.success) {
    return { ok: false, code: opt?.code || "OPTIONS_FAILED", message: opt?.message || "" };
  }

  let assertion = null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(opt.challenge),
        rpId: opt.rpId,
        timeout: opt.timeout,
        userVerification: opt.userVerification,
        // 空 = 可发现凭据：让验证器自己挑一把，用户不用先输账号
        allowCredentials: [],
      },
    });
  } catch (err) {
    return { ok: false, code: err?.name || "CANCELLED", message: "" };
  }

  const response = assertion?.response;
  if (!response) {
    return { ok: false, code: "NO_ASSERTION", message: "" };
  }

  const { json } = await postForm("api/session/webauthn_login_verify_api.php", {
    credential_id: bytesToB64url(assertion.rawId),
    client_data_json: bytesToB64url(response.clientDataJSON),
    authenticator_data: bytesToB64url(response.authenticatorData),
    signature: bytesToB64url(response.signature),
    user_handle: response.userHandle ? bytesToB64url(response.userHandle) : "",
  });

  if (json?.status !== "success") {
    return { ok: false, code: json?.code || "VERIFY_FAILED", message: json?.message || "" };
  }
  return { ok: true, redirect: json.redirect || "/dashboard" };
}

/* ── 查询 / 移除 ────────────────────────────────────────────── */

export async function listPasskeys() {
  const res = await fetch(buildApiUrl("api/session/webauthn_credentials_api.php"), {
    credentials: "include",
    cache: "no-store",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!json?.success) {
    return { ok: false, count: 0, devices: [], message: json?.message || "" };
  }
  return { ok: true, count: json.count ?? 0, max: json.max ?? 0, devices: json.devices || [] };
}

export async function removeAllPasskeys() {
  const { json } = await postForm("api/session/webauthn_credentials_api.php", { revoke_all: "1" });
  if (!json?.success) {
    return { ok: false, message: json?.message || "" };
  }
  return { ok: true, removed: json.removed ?? 0 };
}
