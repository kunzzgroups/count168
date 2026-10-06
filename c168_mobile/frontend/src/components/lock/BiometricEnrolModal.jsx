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
import { LOGIN_I18N } from "../../translateFile/authTranslate.js";

/**
 * 登录完成时的「开启生物识别」引导 —— **密码登录页与二级密码页共用**。
 *
 * ── 为什么必须抽出来 ──────────────────────────────────────────────
 *
 * 这段逻辑原来只写在 LoginPage 里，于是**只有走密码 / passkey 登录的人会看到引导**。
 * 而有二级密码的身份（owner 在后端是无条件需要的；C168 的 user 设了才需要）
 * 走的是另一条路：LoginPage 把用户 `navigate` 到二级密码页，二级密码页成功后再
 * 直接 `navigate` 进 App —— 引导**从头到尾不会出现** ✗
 * 结果就是「有二级密码的 owner 根本没有开启生物识别的地方」。
 *
 * ── 何时提 ────────────────────────────────────────────────────────
 *
 * 判据与原来完全一致，只有四个条件同时成立才提：
 *   1. 在原生壳里（网页端走 passkey，不弹这个）
 *   2. 用户没有拒绝过（读过「暂不开启」）
 *   3. 本机**没有凭据**（没凭据 = 开不了，要么从未开启，要么凭据被系统作废）
 *   4. 设备确实有可用的生物识别
 *
 * 注意第 3 条就是「有没有开启过」的判据，**不要**改成读模型里的 enabled：
 * 模型说 enabled 但凭据被作废时，用 enabled 判断会既不弹引导、也无法解锁。
 *
 * @param {(targetPath: string) => void} onDone 用哪个都行之后跳到哪
 */
export function useBiometricEnrol(onDone) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = useRef("/dashboard");

  /**
   * 尝试弹引导。返回 true 表示**已经接管跳转**，调用方不要再 navigate。
   *
   * 这样调用方可以保持一行：`if (await enrol.offer(path)) return; navigate(path);`
   */
  const offer = useCallback(async (targetPath) => {
    target.current = targetPath || "/dashboard";
    try {
      const token = await loadToken();
      const shouldOffer = isNative() && !readBioOptOut() && !token;
      if (shouldOffer && (await biometricAvailable())) {
        setOpen(true);
        setBusy(false);
        setError("");
        return true;
      }
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
      finish(target.current);
    } catch {
      setBusy(false);
      setError(i18n.bioEnableFailed);
    }
  }, [finish]);

  return { open, busy, error, offer, enable, skip };
}

/**
 * 引导弹窗本体。
 *
 * ⚠️ 图标用**中性**的盾牌，不用指纹：
 * 此刻用户还没选方式，而安卓上没有「只用指纹 / 只用人脸」的开关，
 * 画指纹图标等于替用户预设了方式（锁屏那边也因为同一原因改成中性图标）。
 */
export function BiometricEnrolModal({ open, busy, error, onEnable, onSkip }) {
  const i18n = LOGIN_I18N[readLoginLang()] || LOGIN_I18N.en;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onSkip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onSkip]);

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
