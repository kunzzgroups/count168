import { useEffect, useState } from "react";
import { readLoginLang } from "../../lib/loginLang.js";
import { METHOD, ensureSettings } from "../../lib/biometricSettings.js";
import { loadToken } from "../../lib/biometricStore.js";
import {
  FAIL_BIOMETRIC,
  GATE_CHECKING,
  GATE_DISABLED,
  GATE_LOCKED,
  GATE_UNLOCKED,
  useBiometricUnlock,
} from "../../hooks/useBiometricUnlock.js";
import "./biometric-lock.css";

/**
 * 连续失败到这个次数后，把「用密码登录」换成主按钮。
 *
 * 为什么需要：生物识别可能一直失败（指纹识别不出、系统锁定、服务器不可达），
 * 而如果界面永远只突出「重试」，用户会卡在一个**永远不会成功**的循环里。
 */
const ATTEMPTS_BEFORE_PASSWORD_FIRST = 2;

/**
 * 图标必须跟着**用户选的方式**走，而且只能在**被保证**的范围内画。
 *
 * 为何指纹可以用指纹图标，人脸却不行：
 * 安卓没有「只用指纹 / 只用人脸」的开关，App 只能选生物识别的**强度**。
 * 选指纹时传 strong，能真正排除人脸 → 画指纹图标是属实的；
 * 选人脸时只能传 weak，系统仍可能弹指纹 → 此时画人脸图标就是在撒谎，
 * 而实机已经报过这个矛盾（“文案说人脸、弹出来是指纹”）。
 * 所以人脸 / 未知一律用中性图标。
 */
function lockIcon(method) {
  return method === METHOD.FINGERPRINT ? "fas fa-fingerprint" : "fas fa-shield-halved";
}

/** 未识别时的文案：**不提具体方式**（同上，我们无法保证弹的是哪一种） */

const TEXT = {
  zh: {
    verifying: "正在验证…",
    lockedTitle: "生物识别解锁",
    lockedHint: "请验证身份以解锁 EazyCount",
    retry: "重试",
    usePassword: "用密码登录",
    checking: "正在检查登录状态…",
    bioFailed: "未能识别，请重试",
    tooMany: "多次未能识别。可以直接用密码登录。",
    tryLater: "暂时无法验证，请稍后重试",
    // 按具体原因给可操作的提示 ——「暂时不可用」这种话帮不了用户
    byCode: {
      biometryLockout: "系统已临时锁定生物识别（失败次数过多）。请用密码登录，或稍后再试。",
      authenticationFailed: "未能识别，请重试。",
      userCancel: "已取消。可重新尝试，或改用密码登录。",
      systemCancel: "系统中断了验证，请重试。",
      appCancel: "验证被中断，请重试。",
      userFallback: "你选择了其它方式，请用密码登录。",
      TOKEN_INVALID: "此设备已失效，请重新登录。",
      TOKEN_EXPIRED: "此设备已失效，请重新登录。",
      TOKEN_REVOKED: "此设备的生物识别解锁已关闭，请重新登录。",
      MAINTENANCE: "系统维护中，请稍后再试或改用密码登录。",
      SERVER_ERROR: "暂时连不上服务器，请稍后重试。",
    },
  },
  en: {
    verifying: "Verifying…",
    lockedTitle: "Biometric Unlock",
    lockedHint: "Unlock EazyCount with biometrics",
    retry: "Try again",
    usePassword: "Use password",
    checking: "Checking your session…",
    bioFailed: "Not recognised. Please try again.",
    tooMany: "Several attempts failed. You can sign in with your password instead.",
    tryLater: "Temporarily unavailable, please try again",
    byCode: {
      biometryLockout:
        "Biometrics are temporarily locked after too many attempts. Use your password, or try again shortly.",
      authenticationFailed: "Not recognised. Please try again.",
      userCancel: "Cancelled. You can try again, or use your password.",
      systemCancel: "The system interrupted verification. Please try again.",
      appCancel: "Verification was interrupted. Please try again.",
      userFallback: "You chose another method. Please use your password.",
      TOKEN_INVALID: "This device is no longer signed in.",
      TOKEN_EXPIRED: "This device is no longer signed in.",
      TOKEN_REVOKED: "Biometric unlock was turned off for this device. Please login again.",
      MAINTENANCE: "System under maintenance. Try again later, or use your password.",
      SERVER_ERROR: "Cannot reach the server right now. Please try again.",
    },
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
  const { state, busy, failure, attempts, unlock, usePasswordInstead } = useBiometricUnlock();
  const [lang, setLang] = useState(() => readLoginLang());
  /**
   * 用户选的解锁方式。**只用来决定图标**，不用来决定流程 ——
   * 流程由 resolveBiometric() 单一决策（见 lib/biometricSettings.js）。
   */
  const [method, setMethod] = useState(() => METHOD.NONE);

  // 主题在登录页之外也可能被切换，这里跟随
  useEffect(() => {
    setLang(readLoginLang());
  }, [state]);

  // 读取权威设置；顺带把旧键迁到新模型（凭据是否存在要问 Keystore）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let credentialPresent = false;
      try {
        credentialPresent = Boolean(await loadToken());
      } catch {
        credentialPresent = false;
      }
      if (cancelled) return;
      setMethod(ensureSettings(credentialPresent).method);
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const t = TEXT[lang] || TEXT.en;

  if (state === GATE_UNLOCKED || state === GATE_DISABLED) {
    return children;
  }

  const isChecking = state === GATE_CHECKING;

  let hint = t.lockedHint;
  if (busy) {
    hint = t.verifying;
  } else if (failure) {
    hint =
      failure.message ||
      (t.byCode && t.byCode[failure.code]) ||
      (attempts >= ATTEMPTS_BEFORE_PASSWORD_FIRST
        ? t.tooMany
        : failure.kind === FAIL_BIOMETRIC
          ? t.bioFailed
          : t.tryLater);
  }

  // 连续失败后把密码登录提到主位
  const passwordFirst = attempts >= ATTEMPTS_BEFORE_PASSWORD_FIRST;

  const retryButton = (primary) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => void unlock()}
      disabled={busy}
    >
      <i className={lockIcon(method)} aria-hidden="true" />
      <span>{busy ? t.verifying : t.retry}</span>
    </button>
  );

  const passwordButton = (primary) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => void usePasswordInstead()}
      disabled={busy}
    >
      <i className="fas fa-key" aria-hidden="true" />
      <span>{t.usePassword}</span>
    </button>
  );

  return (
    <div className="bio-lock" role="dialog" aria-modal="true" aria-label={t.lockedTitle}>
      <div className="bio-lock__bg" aria-hidden="true" />
      <div className="bio-lock__card">
        <div className="bio-lock__icon" aria-hidden="true">
          <i className={isChecking ? "fas fa-spinner fa-spin" : lockIcon(method)} />
        </div>

        {isChecking ? (
          <p className="bio-lock__hint">{t.checking}</p>
        ) : (
          <>
            <h1 className="bio-lock__title">{t.lockedTitle}</h1>
            <p className="bio-lock__hint">{hint}</p>

            {passwordFirst ? (
              <>
                {passwordButton(true)}
                {retryButton(false)}
              </>
            ) : (
              <>
                {retryButton(true)}
                {passwordButton(false)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { GATE_CHECKING, GATE_DISABLED, GATE_LOCKED, GATE_UNLOCKED };
