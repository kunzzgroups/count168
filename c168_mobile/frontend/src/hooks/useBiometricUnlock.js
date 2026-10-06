/**
 * 指纹锁屏状态机。
 *
 *   checking ──非原生/无凭据──> disabled   （正常进 App，走密码登录）
 *      └──有凭据──> locked ──指纹成功+换会话成功──> unlocked
 *                     │
 *                     ├── 凭据永久失效（令牌被吊销/过期/账号停用）──> disabled（清本地凭据）
 *                     └── 暂时不可用（维护中/网络）──> 留在 locked，可重试
 *
 * 关键约束：disabled/unlocked 之外的任何状态都**不能渲染任何业务页面**，
 * 否则会先打出 API 请求（路由本身没有守卫，见 App.jsx）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  authenticate,
  clearToken,
  getDeviceId,
  isNative,
  loadToken,
} from "../lib/biometricStore.js";
import { loginWithDeviceToken } from "../lib/deviceTokenApi.js";

export const GATE_CHECKING = "checking";
export const GATE_LOCKED = "locked";
export const GATE_UNLOCKED = "unlocked";
export const GATE_DISABLED = "disabled";

/** 这些错误码表示凭据永远废了 → 清本地凭据，回密码登录，不要重试 */
const PERMANENT_FAILURE_CODES = new Set([
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "USER_DISABLED",
]);

/**
 * 这些生物识别错误说明**这台设备现在根本做不了**，重试多少次都没用 →
 * 直接回密码登录（并清掉本地凭据：设备上生物识别登记已变，Keystore 密钥
 * 也几乎必然已失效，留着只会每次启动都白弹一次）。
 *
 * 注意别把 biometryLockout 放进来 —— 那是“失败次数过多临时锁定”，
 * 等一会就能再用，清掉凭据对用户是损失。
 */
const BIOMETRIC_UNUSABLE_CODES = new Set([
  "biometryNotEnrolled",
  "biometryNotAvailable",
  "passcodeNotSet",
  "noDeviceCredential",
]);

export const FAIL_BIOMETRIC = "biometric";
export const FAIL_SERVER = "server";

export function useBiometricUnlock() {
  const navigate = useNavigate();
  const [state, setState] = useState(() => (isNative() ? GATE_CHECKING : GATE_DISABLED));
  const [busy, setBusy] = useState(false);
  // { kind, code, message } —— message 优先展示（服务端可能给了具体原因，例如维护公告）
  const [failure, setFailure] = useState(null);
  const [attempts, setAttempts] = useState(0);

  // StrictMode 下 effect 会跑两次，用它避免连续弹两次指纹
  const attemptGuard = useRef(false);

  const goDisabled = useCallback(async (clearCredentials) => {
    if (clearCredentials) await clearToken();
    setState(GATE_DISABLED);
  }, []);

  const unlock = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      // 1) 系统生物识别（文案与语言在 biometricStore.authenticate 里统一处理）
      await authenticate();

      // 2) 取出 Keystore 里的令牌
      const token = await loadToken();
      if (!token) {
        // Keystore 密钥失效（改了指纹/锁屏密码、重装、恢复备份）
        await goDisabled(true);
        return;
      }

      // 3) 换会话
      const result = await loginWithDeviceToken({ token, deviceId: getDeviceId() });
      if (result.ok) {
        setState(GATE_UNLOCKED);
        navigate(result.redirect, { replace: true });
        return;
      }

      if (PERMANENT_FAILURE_CODES.has(result.code)) {
        await goDisabled(true);
        return;
      }

      // 维护中等暂时性失败：保留凭据，留在锁屏让用户重试或改用密码。
      // 把服务端的 message 一并带上 —— 维护公告这类信息比“暂时不可用”有用得多。
      setAttempts((n) => n + 1);
      setFailure({ kind: FAIL_SERVER, code: result.code || "UNKNOWN", message: result.message || "" });
      setState(GATE_LOCKED);
    } catch (err) {
      const code = String(err?.code || "cancelled");

      if (BIOMETRIC_UNUSABLE_CODES.has(code)) {
        // 这台设备做不了生物识别了，不要卡在重试上
        await goDisabled(true);
        return;
      }

      // 用户取消 / 指纹不匹配 / 临时锁定：留在锁屏
      setAttempts((n) => n + 1);
      setFailure({ kind: FAIL_BIOMETRIC, code, message: "" });
      setState(GATE_LOCKED);
    } finally {
      setBusy(false);
    }
  }, [goDisabled, navigate]);

  /** 用户点「用密码登录」：清掉本地凭据，回密码登录 */
  const usePasswordInstead = useCallback(async () => {
    await goDisabled(true);
    navigate("/login", { replace: true });
  }, [goDisabled, navigate]);

  useEffect(() => {
    if (state !== GATE_CHECKING) return undefined;

    let cancelled = false;
    (async () => {
      const token = await loadToken();
      if (cancelled) return;
      if (!token) {
        setState(GATE_DISABLED);
        return;
      }
      setState(GATE_LOCKED);
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  // 进入锁屏后自动弹一次指纹
  useEffect(() => {
    if (state !== GATE_LOCKED || attemptGuard.current) return;
    attemptGuard.current = true;
    void unlock();
  }, [state, unlock]);

  return { state, busy, failure, attempts, unlock, usePasswordInstead };
}
