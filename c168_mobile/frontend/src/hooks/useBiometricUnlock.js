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
 *
 * ── 两条路径 ────────────────────────────────────────────────
 *
 *   安卓 APK（isNative）：生物识别凭据（Keystore 里的 device_token）或 PIN → 锁屏
 *   iOS / 网页（!isNative）：**只有设过 PIN 才锁**。
 *     那里 loadToken() 恒为 null（见 lib/biometricStore.js），所以不会有生物识别
 *     自动弹窗；passkey 那条路仍然由 LoginPage 自己管，这里不碰。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildApiUrl } from "../utils/apiUrl.js";
import { fetchJson } from "../lib/fetchJson.js";
import {
  biometryInfo,
  clearToken,
  getDeviceId,
  isNative,
  loadToken,
  withTimeout,
} from "../lib/biometricStore.js";
import {
  CAP,
  METHOD,
  autoSwitchTarget,
  capabilityFromProbe,
  ensureSettings,
  saveSettings,
} from "../lib/biometricSettings.js";
import { nativeBiometricLogin, nativePinLogin } from "../lib/biometricLogin.js";
import { skipNextPasskeyAutoLogin } from "../lib/webauthn.js";
import {
  clearPin,
  pinAttemptsLeft,
  pinEnabled,
  readPinSettings,
} from "../lib/pinStore.js";

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
 */const BIOMETRIC_UNUSABLE_CODES = new Set([
  "biometryNotEnrolled",
  "biometryNotAvailable",
  "passcodeNotSet",
  "noDeviceCredential",
]);

export const FAIL_BIOMETRIC = "biometric";
export const FAIL_SERVER = "server";
/** PIN 本身没通过（错码 / 没设过 / 错太多被清）。与生物识别失败分开：界面文案完全不同。 */
export const FAIL_PIN = "pin";

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
  const [state, setState] = useState(() =>
    // ⚠️ 网页端（iOS 的 Safari / 加到主屏幕）也要进来 —— 只要本机设过 PIN。
    // 以前这里只有 isNative()，于是「没指纹/人脸」的 iOS 用户设了 PIN 也**永远不锁**，
    // 那条设置项就是个装饰（用户报的就是这个）。
    // 没设 PIN 的网页用户走的还是老路：直接 DISABLED（passkey 由登录页管，行为不变）。
    isNative() || pinEnabled() ? GATE_CHECKING : GATE_DISABLED,
  );
  const [busy, setBusy] = useState(false);
  /**
   * 本机**有没有生物识别凭据**（Keystore 里的 device_token）。
   *
   * 为何必须单独记一位：PIN 用户（没指纹/人脸的那种）**没有**这张令牌，
   * 但门禁同样要锁上。于是「锁不锁」不再等于「有没有令牌」，
   * 而「要不要自动弹指纹」仍然是「有没有令牌」——两件事必须分开，
   * 否则 PIN 用户启动时会先弹一次注定失败的生物识别。
   */
  const [bioCredential, setBioCredential] = useState(false);
  /** PIN 设置（{enabled, len}）；失败后被清时要刷新 */
  const [pin, setPin] = useState(() => readPinSettings());
  /** 还能试几次（错到 0 就回密码登录） */
  const [pinTries, setPinTries] = useState(() => pinAttemptsLeft());
  // { kind, code, message } —— message 优先展示（服务端可能给了具体原因，例如维护公告）
  const [failure, setFailure] = useState(null);
  const [attempts, setAttempts] = useState(0);
  /**
   * 预校正时探测到的设备能力状态。暴露给界面，用来决定**该不该**给
   * 「改用另一种方式」的按钮 —— 一个都没有时给按钮就是死循环。
   */
  const [capabilityState, setCapabilityState] = useState(CAP.UNKNOWN);

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
   * 用户点「用密码登录 / 返回登录」。
   *
   * ⚠️ **必须先把当前会话结束掉**，否则这句按钮是假的：
   * 它只 `navigate("/login")`，而登录页一挂载就会调 `current_user_api`，
   * 会话还活着 → 检查成功 → **直接被弹回 App**。
   * 实机反馈：iOS 上「点 Back to login 直接进去了，根本没看到登录页」——
   * 比 UX 问题更糟：那时任何人点一下就能绕过锁屏。
   *
   * ⚠️ **不清本地解锁凭据**（两者都不动）：
   *   · Keystore 里的生物识别凭据 —— 本次会话结束不影响它；
   *   · `ec_pin_unlock`（PIN 密文）—— 它加密的就是那张 device_token。
   * 所以下次冷启动该锁还是锁、该刷脸还是刷脸。
   * 服务端那边也不会被连坐：`logout_api.php` 只吐销 **kind='web'** 且
   * 对应 `remember_token` cookie 的那一条（见 includes/device_token.php），
   * 移动端那张 kind='biometric' 的凭据不在其中。
   *
   * 网络不通时：照样去登录页，最坏情况与改动前一样（可能被会话检查弹回去）。
   */
  const usePasswordInstead = useCallback(async () => {
    try {
      await fetchJson(buildApiUrl("api/session/logout_api.php"), { method: "POST" });
    } catch {
      /* 尽力而为：登录页仍然要能看到 */
    }
    // 会话没了之后，iOS 的 passkey 自动登录会立刻把人刷回来
    //（实机报过「点了退出→弹窗→刷完又进去了」），标记成“本次不要自动登”
    skipNextPasskeyAutoLogin();
    await goDisabled(false);
    navigate("/login", { replace: true });
  }, [goDisabled, navigate]);

  /**
   * 弹生物识别**之前**的方式校正。
   *
   * 为何要放在前面，而不是等失败后再补救：
   * 等失败后再换的话，用户会先看到一次**注定失败**的认证（实机反馈：
   * “没有直接弹出人脸识别”），然后才弹正确的那一次 —— 多一次、且莫名其妙。
   *
   * 产品要求：用户选的方式在这台设备上没了（比如在系统里删了指纹）
   * → **自动换成另一种、不询问**。
   *
   * ⚠️ 两条约束：
   *   1. 探测**明确**说目标可用才换（autoSwitchTarget 内部就要求 === true）；
   *   2. 探测限时 1.5s —— 不能因为探测慢就拖住解锁；超时 = 未知 = 不换，
   *      直接按原方式试。
   */
  const preflightThenUnlock = useCallback(async () => {
    try {
      const settings = ensureSettings(Boolean(await withTimeout(loadToken(), 4000)));
      const cap = capabilityFromProbe(await biometryInfo(1500));
      setCapabilityState(cap.state);
      const target = autoSwitchTarget(settings.method, cap);
      if (target) {
        // 显式写入：自动切换是产品要求，但**仍然一次性写完整模型**
        saveSettings({ enabled: true, method: target });
      }
    } catch {
      /* 探测/读取失败 → 当成未知，不换方式，直接按原方式试 */
    }
    await unlock();
  }, [unlock]);

  /** 重新读 PIN 状态（设置页改过、或失败后被清掉时用） */
  const refreshPin = useCallback(() => {
    setPin(readPinSettings());
    setPinTries(pinAttemptsLeft());
  }, []);

  /**
   * 用 PIN 解锁。
   *
   * 与 unlock() 一样只做三件事：验证 → 换会话 → 决定留在锁屏还是放行。
   * 区别在**失败的处理**：PIN 是「本地密码」，所以
   *   · 错码 → 留在锁屏，把「还能试几次」告诉界面
   *   · 错太多次 / 记录坏了 → PIN 已被清 → 刷新界面（界面会收回 PIN 入口）
   *   · 令牌被吊销 / 过期 → 与生物识别同一条路：清凭据 + 清 PIN，回密码登录
   *
   * @returns {Promise<boolean>} true = 已解锁（调用方不要再做 UI 动作）
   */
  const unlockWithPin = useCallback(
    async (entered) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await nativePinLogin(entered);

        if (result.ok) {
          refreshPin();
          setState(GATE_UNLOCKED);
          navigate(result.redirect, { replace: true });
          return true;
        }

        if (result.stage === "pin") {
          // PIN 记录在错太多次 / 坏掉时已经被清掉了 —— 界面据此收回入口
          refreshPin();
          setFailure({ kind: FAIL_PIN, code: result.code, message: "" });
          return false;
        }

        // stage === "server"：PIN 对了，是服务端拒绝
        if (PERMANENT_FAILURE_CODES.has(result.code)) {
          // 凭据已废 → 连带把 PIN 记录清掉：它加密的正是这张废令牌，
          // 留着只会让用户每次启动都输一遍 PIN 再被拒。
          await clearPin();
          refreshPin();
          await goDisabled(true);
          return false;
        }

        setFailure({
          kind: FAIL_SERVER,
          code: result.code || "UNKNOWN",
          message: result.message || "",
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [goDisabled, navigate, refreshPin],
  );

  useEffect(() => {
    if (state !== GATE_CHECKING) return undefined;

    let cancelled = false;
    (async () => {
      // 超时保护：原生插件不响应时 loadToken 会永远不 settle，
      // 那样门禁会永久停在“检查登录状态…”。超时当成“没凭据”处理。
      const token = await withTimeout(loadToken(), 4000);
      if (cancelled) return;
      const hasCredential = typeof token === "string" && Boolean(token);
      setBioCredential(hasCredential);
      // 锁不锁：有生物识别凭据**或**设过 PIN，都要锁；两样都没有才直接进 App。
      // ⚠️ 别写成只看凭据 —— 那样「只设了 PIN」的用户启动后**完全没有门禁**。
      setState(hasCredential || pinEnabled() ? GATE_LOCKED : GATE_DISABLED);
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

  // 进入锁屏后自动弹一次；┖─ 弹之前先校正方式，确保**第一次就是正确的方式**。
  //
  // ⚠️ 没有生物识别凭据时**绝不自动弹**：那种用户是 PIN 用户，
  // 弹一次生物识别只会失败（NO_CREDENTIAL），而那条分支会走 goDisabled(true)
  // —— 等于把锁屏直接放行，门禁形同不存在。
  useEffect(() => {
    if (state !== GATE_LOCKED || attemptGuard.current) return;
    if (!bioCredential) return;
    attemptGuard.current = true;
    void preflightThenUnlock();
  }, [state, bioCredential, preflightThenUnlock]);

  return {
    state,
    busy,
    failure,
    attempts,
    capabilityState,
    /** 本机有没有生物识别凭据（决定要不要给「重试/指纹」这类入口） */
    bioCredential,
    /** { enabled, len } */
    pin,
    /** 还能试几次 PIN */
    pinTries,
    unlock,
    unlockWithPin,
    refreshPin,
    usePasswordInstead,
  };
}
