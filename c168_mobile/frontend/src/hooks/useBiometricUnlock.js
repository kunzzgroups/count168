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
  clearToken,
  getDeviceId,
  isNative,
  loadToken,
  withTimeout,
} from "../lib/biometricStore.js";
import { nativeBiometricLogin } from "../lib/biometricLogin.js";

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

/**
 * 这个错误码说明**用户选的那种方式在这台设备上已经用不了了**
 * （在系统里删了指纹、改了录入、设备凭据被移除）。
 *
 * ⚠️ 此时**不能清凭据**。凭据是 SecureStorage 里的 device_token，
 * 它并不会因为录入变化而失效；清掉只会把功能弄死，而且用户回不了头。
 * 正确做法：留在锁屏、说出原因、把「换一种方式」摆在界面上（规格 §7）。
 */
export function methodUnavailable(code) {
  return BIOMETRIC_UNUSABLE_CODES.has(code);
}

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
      const result = await nativeBiometricLogin();

      if (result.ok) {
        setState(GATE_UNLOCKED);
        navigate(result.redirect, { replace: true });
        return;
      }

      if (result.stage === "credential") {
        // 本地没有凭据，或 Keystore 密钥失效
        // （改指纹/锁屏密码、重装、恢复备份都会导致失效）
        await goDisabled(true);
        return;
      }

      if (result.stage === "biometric") {
        // 所有生物识别失败一律**留在锁屏**：不自动换方式（规格 §7），
        // 也不清凭据（见 methodUnavailable 上方说明）。
        // 界面会根据 code 决定要不要把「换一种方式」推出来。
        setAttempts((n) => n + 1);
        setFailure({ kind: FAIL_BIOMETRIC, code: result.code, message: "" });
        setState(GATE_LOCKED);
        return;
      }

      // stage === "server"
      if (PERMANENT_FAILURE_CODES.has(result.code)) {
        await goDisabled(true);
        return;
      }

      // 维护中等暂时性失败：保留凭据，留在锁屏让用户重试或改用密码。
      // 把服务端的 message 一并带上 —— 维护公告这类信息比“暂时不可用”有用得多。
      setAttempts((n) => n + 1);
      setFailure({ kind: FAIL_SERVER, code: result.code || "UNKNOWN", message: result.message || "" });
      setState(GATE_LOCKED);
    } finally {
      setBusy(false);
    }
  }, [goDisabled, navigate]);

  /**
   * 用户点「用密码登录」。
   *
   * ⚠️ **不清凭据**（之前传的是 true，这是个真 bug）：
   *
   * 「这一次用密码」不等于「把生物识别关掉」。用户可能只是因为
   * 脸在暗处没识出来、或指纹湿了。原来这一下会把 Keystore 里的令牌删掉，
   * 后果有两个，实机都报过：
   *   1. 模型里 enabled=1 而 Keystore 里 token=no —— 状态与实际对不上，
   *      生物识别再也登录不了；
   *   2. 登录页的判断是“没有令牌就弹开启引导” → 于是**每次密码登录都弹引导**。
   *
   * 保留凭据后：本次会话仍然正常地走密码登录（state 置 DISABLED 就够），
   * 下次冷启动该弹生物识别还弹 —— 那正是功能本身。
   * 真正失效的凭据（令牌过期 / 被吐销）由 unlock() 里的
   * PERMANENT_FAILURE_CODES 分支清理，那里清才是对的。
   */
  const usePasswordInstead = useCallback(async () => {
    await goDisabled(false);
    navigate("/login", { replace: true });
  }, [goDisabled, navigate]);

  useEffect(() => {
    if (state !== GATE_CHECKING) return undefined;

    let cancelled = false;
    (async () => {
      // 超时保护：原生插件不响应时 loadToken 会永远不 settle，
      // 那样门禁会永久停在“检查登录状态…”。超时当成“没凭据”处理。
      const token = await withTimeout(loadToken(), 4000);
      if (cancelled) return;
      setState(typeof token === "string" && token ? GATE_LOCKED : GATE_DISABLED);
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  /**
   * 兑底看门狗：不管检查流程因为什么原因没走完，都不能把 App 永久卡住。
   * 5 秒后仍未离开 checking 就直接当成“无凭据”，放行到密码登录。
   * 这是对“实机卡在 checking session”这类问题的硬保障。
   */
  useEffect(() => {
    if (state !== GATE_CHECKING) return undefined;
    const timer = setTimeout(() => {
      setState((prev) => (prev === GATE_CHECKING ? GATE_DISABLED : prev));
    }, 5000);

    return () => clearTimeout(timer);
  }, [state]);

  // 进入锁屏后自动弹一次指纹
  useEffect(() => {
    if (state !== GATE_LOCKED || attemptGuard.current) return;
    attemptGuard.current = true;
    void unlock();
  }, [state, unlock]);

  return { state, busy, failure, attempts, unlock, usePasswordInstead };
}
