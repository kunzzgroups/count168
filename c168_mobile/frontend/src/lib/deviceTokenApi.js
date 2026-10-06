/**
 * 指纹解锁的 4 个后端端点封装。
 *
 * 响应形状说明：device_login_api.php 刻意与 login_api.php **同构**（status/redirect/
 * user_type/login_scope），这样前端能直接复用 LoginPage 的 resolvePostLoginPath()。
 * 其余 3 个端点同时返回 status 与 success，两种约定都认。
 */

import { buildApiUrl } from "../utils/apiUrl.js";

function apiOk(json) {
  return json?.status === "success" || json?.success === true;
}

async function postForm(path, params) {
  const fd = new FormData();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) fd.append(key, String(value));
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

/** 开启指纹解锁：签发设备令牌。明文令牌只在这里出现一次。 */
export async function registerDeviceToken({ deviceId, deviceName }) {
  const { json } = await postForm("api/session/device_token_register_api.php", {
    device_id: deviceId,
    device_name: deviceName,
  });
  if (!apiOk(json) || typeof json?.token !== "string") {
    return { ok: false, code: json?.code || "UNKNOWN", message: json?.message || "" };
  }
  return { ok: true, token: json.token, expiresAt: json.expires_at || "" };
}

/**
 * 用设备令牌换会话。
 *
 * 返回 code 用于区分「永久失效」与「暂时不可用」：
 *   永久（要清本地凭据）：TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_REVOKED / USER_DISABLED
 *   暂时（保留凭据）：MAINTENANCE / SERVER_ERROR
 */
export async function loginWithDeviceToken({ token, deviceId }) {
  const { res, json } = await postForm("api/session/device_login_api.php", {
    token,
    device_id: deviceId,
  });

  if (!apiOk(json)) {
    return {
      ok: false,
      code: json?.code || (res.ok ? "UNKNOWN" : "SERVER_ERROR"),
      message: json?.message || "",
    };
  }

  return {
    ok: true,
    redirect: json.redirect || "/dashboard",
    userType: json.user_type || "user",
    companyId: json.company_id ?? null,
    loginScope: json.login_scope || "company",
    loginIdentifier: json.login_identifier || "",
  };
}

/** 吊销设备令牌：deviceId 单台，all=true 全部 */
export async function revokeDeviceToken({ deviceId, all } = {}) {
  const params = all ? { all: "1" } : { device_id: deviceId };
  const { json } = await postForm("api/session/device_token_revoke_api.php", params);
  if (!apiOk(json)) {
    return { ok: false, message: json?.message || "" };
  }
  return { ok: true, revoked: json.revoked ?? 0, scope: json.scope || "device" };
}

/** 已授权设备列表 */
export async function listDeviceTokens({ deviceId } = {}) {
  const url = buildApiUrl("api/session/device_tokens_api.php");
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const res = await fetch(url + query, { credentials: "include", cache: "no-store" });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!apiOk(json)) {
    return { ok: false, devices: [], max: 0, active: 0, message: json?.message || "" };
  }
  return {
    ok: true,
    devices: Array.isArray(json.devices) ? json.devices : [],
    max: json.max ?? 0,
    active: json.active ?? 0,
  };
}
