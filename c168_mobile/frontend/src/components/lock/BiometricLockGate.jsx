import { useEffect, useState } from "react";
import { readLoginLang } from "../../lib/loginLang.js";
import {
  GATE_CHECKING,
  GATE_DISABLED,
  GATE_LOCKED,
  GATE_UNLOCKED,
  useBiometricUnlock,
} from "../../hooks/useBiometricUnlock.js";
import "./biometric-lock.css";

const TEXT = {
  zh: {
    verifying: "正在验证…",
    lockedTitle: "指纹解锁",
    lockedHint: "请使用指纹解锁 EazyCount",
    retry: "重试",
    usePassword: "用密码登录",
    checking: "正在检查登录状态…",
    cancelled: "已取消，请重试",
    retryable: "暂时无法验证，请稍后重试",
  },
  en: {
    verifying: "Verifying…",
    lockedTitle: "Fingerprint unlock",
    lockedHint: "Unlock EazyCount with your fingerprint",
    retry: "Try again",
    usePassword: "Use password",
    checking: "Checking your session…",
    cancelled: "Cancelled, please try again",
    retryable: "Temporarily unavailable, please try again",
  },
};

/**
 * 启动门禁层。
 *
 * 必须包住**整个** App 内容（含 Routes、实时桥、底部导航）：
 * 路由本身没有守卫，任何子组件一挂载就会打 API 请求。
 * 只有 unlocked / disabled 才渲染 children。
 */
export default function BiometricLockGate({ children }) {
  const { state, busy, errorCode, unlock, usePasswordInstead } = useBiometricUnlock();
  const [lang, setLang] = useState(() => readLoginLang());

  // 主题在登录页之外也可能被切换，这里跟随
  useEffect(() => {
    setLang(readLoginLang());
  }, [state]);

  const t = TEXT[lang] || TEXT.en;

  if (state === GATE_UNLOCKED || state === GATE_DISABLED) {
    return children;
  }

  const isChecking = state === GATE_CHECKING;

  return (
    <div className="bio-lock" role="dialog" aria-modal="true" aria-label={t.lockedTitle}>
      <div className="bio-lock__bg" aria-hidden="true" />
      <div className="bio-lock__card">
        <div className="bio-lock__icon" aria-hidden="true">
          <i className={isChecking ? "fas fa-spinner fa-spin" : "fas fa-fingerprint"} />
        </div>

        {isChecking ? (
          <p className="bio-lock__hint">{t.checking}</p>
        ) : (
          <>
            <h1 className="bio-lock__title">{t.lockedTitle}</h1>
            <p className="bio-lock__hint">
              {busy ? t.verifying : errorCode && errorCode !== "cancelled" ? t.retryable : t.lockedHint}
            </p>

            <button
              type="button"
              className="bio-lock__btn bio-lock__btn--primary tap-scale"
              onClick={() => void unlock()}
              disabled={busy}
            >
              <i className="fas fa-fingerprint" aria-hidden="true" />
              <span>{busy ? t.verifying : t.retry}</span>
            </button>

            <button
              type="button"
              className="bio-lock__btn bio-lock__btn--ghost tap-scale"
              onClick={() => void usePasswordInstead()}
              disabled={busy}
            >
              {t.usePassword}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export { GATE_CHECKING, GATE_DISABLED, GATE_LOCKED, GATE_UNLOCKED };
