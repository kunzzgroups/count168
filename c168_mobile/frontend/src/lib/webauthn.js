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

/* ── 错误码 → 可操作的原因 ────────────────────────────────── */

/**
 * WebAuthn / 服务端错误码的翻译表。
 *
 * 为什么值得维护：只显示「失败」等于没有信息，用户无法自救，我也无法定位。
 * **未知错误码会把原码附在括号里** —— 这是有意的：宁可看起来技术一点，
 * 也不要再出现「失败了但不知道为何」。等错误都覆盖后再考虑收敛。
 */
const PASSKEY_ERRORS = {
  zh: {
    NotAllowedError: "验证未完成（可能被取消或超时）。请重试，并完成 Face ID / 指纹验证。",
    SecurityError: "当前网址无法注册 passkey（域名与 RP ID 不匹配）。请确认地址是 https://www.count168.com。",
    InvalidStateError: "这台设备已经注册过 passkey 了。",
    NotSupportedError: "当前环境不支持 passkey。若你是从“添加到主屏幕”打开，请改用 Safari。",
    AbortError: "验证被中断，请重试。",
    TypeError: "浏览器拒绝了这次注册请求（参数不兼容）。",
    UNSUPPORTED: "此浏览器不支持生物识别登录。",
    NO_CREDENTIAL: "没有拿到凭据数据，请重试。",
    OPTIONS_FAILED: "服务器拒绝了这次请求，请重新登录后再试。",
    CLIENT_DATA_INVALID: "验证数据校验失败，请重试。",
    ATTESTATION_INVALID: "无法验证这台设备的凭据。",
    CREDENTIAL_MISMATCH: "凭据校验不一致，请重试。",
    CHALLENGE_EXPIRED: "这次请求已过期，请重试。",
    SECONDARY_PASSWORD_REQUIRED: "请先通过二级密码验证。",
    CREDENTIAL_LIMIT: "注册数量已达上限。",
    NOT_LOGGED_IN: "登录状态已失效，请重新登录。",
    VERIFY_FAILED: "服务器未能验证这次注册。",
  },
  en: {
    NotAllowedError: "Verification did not complete (cancelled or timed out). Please try again and finish the Face ID / fingerprint prompt.",
    SecurityError: "This address cannot register a passkey (domain and RP ID mismatch). Check that you are on https://www.count168.com.",
    InvalidStateError: "This device already has a passkey.",
    NotSupportedError: "Passkeys are not supported here. If you opened this from the home screen, use Safari instead.",
    AbortError: "Verification was interrupted. Please try again.",
    TypeError: "The browser rejected this request (incompatible parameters).",
    UNSUPPORTED: "This browser cannot use biometric login.",
    NO_CREDENTIAL: "No credential data received. Please try again.",
    OPTIONS_FAILED: "The server rejected this request. Please login again and retry.",
    CLIENT_DATA_INVALID: "Could not verify this request. Please try again.",
    ATTESTATION_INVALID: "Could not verify this device.",
    CREDENTIAL_MISMATCH: "Credential mismatch. Please try again.",
    CHALLENGE_EXPIRED: "This request expired. Please try again.",
    SECONDARY_PASSWORD_REQUIRED: "Please verify your secondary password first.",
    CREDENTIAL_LIMIT: "You have reached the passkey limit.",
    NOT_LOGGED_IN: "Your session expired. Please login again.",
    VERIFY_FAILED: "The server could not verify this registration.",
  },
};

/**
 * @param {string} lang
 * @param {string} code  WebAuthn 异常名或服务端错误码
 * @param {string} fallback 翻译表没有时的基础文案
 */
export function passkeyErrorMessage(lang, code, fallback) {
  const table = PASSKEY_ERRORS[lang] || PASSKEY_ERRORS.en;
  if (code && table[code]) {
    return table[code];
  }
  const base = fallback || (lang === "zh" ? "操作失败。" : "Something went wrong.");
  return code ? `${base} (${code})` : base;
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

/**
 * 是否存在「平台验证器」（Face ID / Touch ID / 安卓指纹 / Windows Hello）。
 *
 * ⚠️ **不要拿它当显示开关/按钮的门槛。** 它在 iOS 上会给出**假阴性**：
 * 用户实际能成功注册并登录 passkey，这个探测却返回 false。
 * 曾经因此把设置页的开关和登录页的按钮都误杀成“不支持”。
 * 真正的判据用 webauthnSupported()，让它失败时由具体错误码说明原因。
 *
 * 保留此函数：它在“想区分平台验证器 / 外部安全密钥”时仍然有用。
 */
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
        // 只在非空时传。空数组虽然合法，但 Safari 对参数形状特别挑，
        // 能少传一个就少一个变数。
        ...((opt.excludeCredentials || []).length > 0
          ? {
              excludeCredentials: opt.excludeCredentials.map((c) => ({
                type: c.type,
                id: b64urlToBytes(c.id),
              })),
            }
          : {}),
      },
    });
  } catch (err) {
    // 把原始错误名带回去 —— 否则界面上只能显示“失败”，无法定位。
    // 注意：**不**把 NotAllowedError 当成“用户取消”而静默吞掉：
    // 它同时也是“没有用户手势 / 认证超时 / 策略不允许”的代码，吞了就等于掩盖真故障。
    // eslint-disable-next-line no-console
    console.error("[webauthn] create() failed:", err?.name, err?.message, err);
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
    // eslint-disable-next-line no-console
    console.error("[webauthn] get() failed:", err?.name, err?.message, err);
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
