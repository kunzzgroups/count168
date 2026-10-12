import { useCallback, useEffect, useRef, useState } from "react";
import { readLoginLang } from "../../lib/loginLang.js";
import {
  getDeviceId,
  getDeviceName,
  isAvailable as biometricAvailable,
  isNative,
  loadToken,
  readBioOptOut,
  saveToken,
  writeBioOptOut,
} from "../../lib/biometricStore.js";
import { registerDeviceToken } from "../../lib/deviceTokenApi.js";
import { clearPin, isPinSupported, pinEnabled, readPinSettings } from "../../lib/pinStore.js";
import { LOGIN_I18N } from "../../translateFile/authTranslate.js";
import { pinText } from "../../translateFile/pinTranslate.js";
import { PinSetupPanel, usePinSetup } from "./PinSetupModal.jsx";

/**
 * 登录完成时的「开启解锁」引导 —— **密码登录页与二级密码页共用**。
 *
 * ── 为什么必须抽出来 ──────────────────────────────────────────────
 *
 * 这段逻辑原来只写在 LoginPage 里，于是**只有走密码 / passkey 登录的人会看到引导**。
 * 而有二级密码的身份（owner 在后端是无条件需要的；C168 的 user 设了才需要）
 * 走的是另一条路：LoginPage 把用户 `navigate` 到二级密码页，二级密码页成功后再
 * 直接 `navigate` 进 App —— 引导**从头到尾不会出现** ✗
 *
 * ── 两种引导（**按设备实情二选一**）────────────────────────────────
 *
 *   设备有生物识别 → 引导「开启生物识别」
 *   设备没有        → 引导「设置 PIN」（4/6 位）
 *
 * 第二个分支是这次新加的：没有指纹 / 人脸的用户原来**既没有门禁也没有快捷入口**，
 * 每次冷启动都只能重输账号密码。引导必须覆盖他们，否则 PIN 功能等于藏起来了。
 *
 * ── 何时提 ────────────────────────────────────────────────────────
 *
 * 判据与原来一致，只有四个条件同时成立才提：
 *   1. 在原生壳里（网页端走 passkey，不弹这个）
 *   2. 用户没有拒绝过（读过「暂不开启」）
 *   3. 本机**没有凭据**（没凭据 = 生物识别开不了）
 *   4. 设备确实有可用的生物识别，**或者**这台设备能安全存 PIN
 *
 * 注意第 3 条就是「有没有开启过」的判据，**不要**改成读模型里的 enabled：
 * 模型说 enabled 但凭据被作废时，用 enabled 判断会既不弹引导、也无法解锁。
 *
 * @param {(targetPath: string) => void} onDone 用哪个都行之后跳到哪
 */

/**
 * 本轮引导的方式与「PIN 提交」回调。
 *
 * ⚠️ 为什么要模块级变量：登录页（LoginPage.jsx）目前**只传**
 * `open/busy/error/onEnable/onSkip`，而它的 `<BiometricEnrolModal>` 是常驻渲染、
 * 靠 `open` 控制显隐的 —— 不补这个，登录页上的 PIN 引导要么显示成生物识别引导，
 * 要么更糟：用户老老实实输两遍 PIN 然后**什么都不发生**。
 *
 * 顺序上是安全的：`offer()` 先写这里、再 `setOpen(true)`，两者在同一次渲染里生效，
 * 所以弹窗真正渲染时读到的必然是本轮的值（同一个模块，同步赋值）。
 *
 * 显式传 `mode` / `onEnablePin` 优先（二级密码页就是这么用的）。
 * TODO：登录页那个并行改动落地后，给它补上
 * `mode={enrol.mode} onEnablePin={enrol.enablePin}`，这个对象就可以删掉。
 */
const pendingOffer = { mode: "biometric", submitPin: null };

export function useBiometricEnrol(onDone) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("biometric"); // "biometric" | "pin"
  const target = useRef("/dashboard");
  const pinSetup = usePinSetup({ lang: readLoginLang() });
  /** 供 pendingOffer 在**调用时**取最新实现（避免闭包拿到旧的那一份） */
  const pinSubmitRef = useRef(null);

  /**
   * 尝试弹引导。返回 true 表示**已经接管跳转**，调用方不要再 navigate。
   *
   * 这样调用方可以保持一行：`if (await enrol.offer(path)) return; navigate(path);`
   */
  const offer = useCallback(async (targetPath) => {
    target.current = targetPath || "/dashboard";
    try {
      const token = await loadToken();
      if (!isNative() || readBioOptOut() || token) return false;

      // 有生物识别就引导生物识别（体验更好、也更安全），
      // 没有才退回 PIN —— 顺序不能反：能刷脸的人不该被要求再记一个码。
      const hasBiometrics = await biometricAvailable();
      const canOfferPin = isPinSupported() && !readPinSettings().enabled;
      if (!hasBiometrics && !canOfferPin) return false;

      const nextMode = hasBiometrics ? "biometric" : "pin";
      pendingOffer.mode = nextMode;
      pendingOffer.submitPin = (pin, len) => pinSubmitRef.current?.(pin, len);
      setMode(nextMode);
      setOpen(true);
      setBusy(false);
      setError("");
      return true;
    } catch {
      /* 探测失败就静默跳过，不影响登录 */
    }
    return false;
  }, []);

  const finish = useCallback(
    (path) => {
      setOpen(false);
      setBusy(false);
      setError("");
      onDone?.(path);
    },
    [onDone],
  );

  const skip = useCallback(() => {
    // 「暂不开启」要记住 —— 否则下次登录又问一遍
    writeBioOptOut();
    finish(target.current);
  }, [finish]);

  const enable = useCallback(async () => {
    const i18n = LOGIN_I18N[readLoginLang()] || LOGIN_I18N.en;
    setBusy(true);
    setError("");
    try {
      const issued = await registerDeviceToken({
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
      });
      if (!issued.ok) {
        // 失败不阻断登录，告知后可重试或直接进 App
        setBusy(false);
        setError(issued.code === "DEVICE_LIMIT" ? i18n.bioDeviceLimit : i18n.bioEnableFailed);
        return;
      }
      await saveToken(issued.token);
      // ⚠️ 服务端同一 (用户, 设备, kind) 只有一行，这次签发**换掉了**旧令牌。
      // 旧令牌正是 PIN 密文里那把 —— 留着它，用户下次用 PIN 会拿到
      // 「此设备已失效」。所以开了生物识别就把 PIN 关掉，并让他知道要重设。
      if (pinEnabled()) await clearPin();
      finish(target.current);
    } catch {
      setBusy(false);
      setError(i18n.bioEnableFailed);
    }
  }, [finish]);

  /** PIN 引导的提交：两轮输入已在面板里对过，这里只负责落库与跳转 */
  const enablePin = useCallback(
    async (pin, len) => {
      const result = await pinSetup.save(pin, len);
      if (result.ok) finish(target.current);
    },
    [finish, pinSetup],
  );

  // 每次渲染刷新给 pendingOffer 用的那份回调（见上面的说明）。
  // 放 effect 里而不是 offer() 里：offer() 的依赖一多，弹窗读到的
  // 就可能是上一轮的闭包 —— 那会让“输完 PIN 没反应”换个形式重现。
  useEffect(() => {
    pinSubmitRef.current = enablePin;
  }, [enablePin]);

  return {
    open,
    busy: busy || pinSetup.busy,
    error: error || (mode === "pin" ? pinSetup.error : ""),
    mode,
    offer,
    enable,
    enablePin,
    skip,
  };
}

/**
 * 引导弹窗本体。
 *
 * ⚠️ 图标用**中性**的盾牌 / 钥匙，不用指纹：
 * 此刻用户还没选方式，而安卓上没有「只用指纹 / 只用人脸」的开关，
 * 画指纹图标等于替用户预设了方式（锁屏那边也因为同一原因改成中性图标）。
 *
 * @param {object} props
 * @param {"biometric"|"pin"} [props.mode] 不传时用本轮 offer 记下的方式（见 pendingOffer）
 */
export function BiometricEnrolModal({ open, busy, error, mode, onEnable, onEnablePin, onSkip }) {
  const i18n = LOGIN_I18N[readLoginLang()] || LOGIN_I18N.en;
  const lang = readLoginLang();
  const tp = pinText(lang);
  const active = mode || pendingOffer.mode;
  // 页面没传 onEnablePin（登录页）时，用 offer() 记下的那份
  const submitPin = onEnablePin || pendingOffer.submitPin;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onSkip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onSkip]);

  if (active === "pin") {
    return (
      <div
        className={`sc-login-modal-overlay sc-login-modal-overlay--pin${open ? " is-open" : ""}`}
        aria-hidden={open ? "false" : "true"}
      >
        <div className="sc-login-modal-box sc-login-modal-box--pin" role="dialog" aria-label={tp.setupTitle}>
          <PinSetupPanel
            lang={lang}
            noBiometric
            title={tp.setupTitle}
            busy={busy}
            error={error}
            onCancel={onSkip}
            cancelLabel={i18n.bioLater}
            onSubmit={(pin, len) => void submitPin?.(pin, len)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sc-login-modal-overlay${open ? " is-open" : ""}`}
      aria-hidden={open ? "false" : "true"}
    >
      <div className="sc-login-modal-box" role="dialog" aria-labelledby="enrollTitle">
        <div className="sc-login-modal-icon-wrap">
          <i className="fas fa-shield-halved sc-login-modal-icon" aria-hidden="true" />
        </div>
        <h3 id="enrollTitle" className="sc-login-modal-title">
          {i18n.bioTitle}
        </h3>
        <p className="sc-login-modal-message">{error || i18n.bioBody}</p>
        <div className="sc-login-modal-actions sc-login-modal-actions--stack">
          <button
            type="button"
            className="sc-login-btn sc-login-btn-primary"
            onClick={onEnable}
            disabled={busy}
          >
            {busy ? (
              <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            ) : (
              i18n.bioEnable
            )}
          </button>
          <button
            type="button"
            className="sc-login-btn sc-login-btn--ghost"
            onClick={onSkip}
            disabled={busy}
          >
            {i18n.bioLater}
          </button>
        </div>
      </div>
    </div>
  );
}
