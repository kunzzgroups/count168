import { useState } from "react";
import { readLoginLang } from "../../lib/loginLang.js";
import { CAP, METHOD, canOfferMethodSwitch, ensureSettings, saveSettings } from "../../lib/biometricSettings.js";
import {
  FAIL_BIOMETRIC,
  FAIL_PIN,
  GATE_CHECKING,
  GATE_DISABLED,
  GATE_LOCKED,
  GATE_UNLOCKED,
  methodUnavailable,
  useBiometricUnlock,
} from "../../hooks/useBiometricUnlock.js";
import { pinFormat, pinText } from "../../translateFile/pinTranslate.js";
import PinPad from "./PinPad.jsx";
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

const TEXT = {
  zh: {
    verifying: "正在验证…",
    lockedTitle: "生物识别解锁",
    lockedHint: "请验证身份以解锁 EazyCount",
    retry: "重试",
    usePassword: "用密码登录",
    checking: "正在检查登录状态…",
    bioFailed: "未能识别，请重试",
    // 用户选的那种方式在这台设备上没了（在系统里删了指纹等）
    methodGoneFingerprint: "这台设备上已经没有可用的指纹了（可能在系统设置里被删掉）。",
    methodGoneFace: "这台设备上已经没有可用的人脸识别了。",
    nothingEnrolled: "这台手机还没有录入任何可供 App 使用的指纹或人脸，请先在系统设置里添加一个。",
    switchToFace: "改用人脸",
    switchToFingerprint: "改用指纹",
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
    methodGoneFingerprint: "Fingerprint is no longer set up on this device.",
    methodGoneFace: "Face recognition is no longer set up on this device.",
    nothingEnrolled:
      "No fingerprint or face is set up for apps on this phone. Add one in your phone's settings first.",
    switchToFace: "Use face instead",
    switchToFingerprint: "Use fingerprint instead",
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
 *
 * ── 两条解锁路径（同一张设备令牌，两个入口）──────────────────────────
 *
 *   生物识别：系统弹窗 → Keystore 里的明文令牌 → 换会话
 *   PIN     ：本机 4/6 位码解开密文 → 令牌 → 换会话
 *
 * 「锁不锁」= 有生物识别凭据 **或** 设过 PIN（见 hooks/useBiometricUnlock.js）。
 * 因此**没有指纹/人脸的设备也会被锁上** —— 那正是这次改动要服务的人。
 */
export default function BiometricLockGate({ children }) {
  const {
    state,
    busy,
    failure,
    attempts,
    capabilityState,
    bioCredential,
    pin,
    pinTries,
    unlock,
    unlockWithPin,
    usePasswordInstead,
  } = useBiometricUnlock();
  const [lang, setLang] = useState(() => readLoginLang());
  /**
   * 用户选的解锁方式。**只用来决定图标**，不用来决定流程 ——
   * 流程由 resolveBiometric() 单一决策（见 lib/biometricSettings.js）。
   */
  const [method, setMethod] = useState(() => METHOD.NONE);
  /**
   * 用户是否**主动**切到 PIN 界面。
   *   null  = 没表态 → 按设备实情自动决定（只有 PIN / 生物识别已不可用 → 直接给 PIN）
   *   true  = 明确要看 PIN
   *   false = 明确要回生物识别
   *
   * 用三态而不是布尔：自动判断只在用户没表态时生效，
   * 否则用户点回「用指纹」后会被自动逻辑立刻弹回 PIN —— 实机上的死循环就是这么来的。
   */
  const [pinChoice, setPinChoice] = useState(null);

  // ⚠️⚠️ 所有 hook 必须在下面那个 `if (...) return children` **之前**。
  // 本组件在已解锁 / 已关闭时会提前 return children，而 React 要求
  // **所有 hook 在每一次渲染中都按同一顺序被调用**。一旦 hook 落在提前 return
  // 之后，解锁那一瞬间 hook 数量就会变 → React 抛错 → **整个 App 白屏**。
  if (state === GATE_UNLOCKED || state === GATE_DISABLED) {
    return children;
  }

  const t = TEXT[lang] || TEXT.en;
  const tp = pinText(lang);
  const isChecking = state === GATE_CHECKING;

  /**
   * PIN 相关的失败文案。**只有这几条**能被 PIN 界面的错误行显示 ——
   * 服务端的暂时性失败（维护中 / 连不上）也在其中，因为那时 PIN 是对的。
   */
  const pinFailureText = (() => {
    if (!failure) return "";
    if (failure.kind === FAIL_PIN) {
      switch (failure.code) {
        case "WRONG_PIN":
          return pinTries <= 1 ? tp.pinWrongLast : pinFormat(tp.pinWrong, { left: pinTries });
        case "LOCKED_OUT":
          return tp.pinLockedOut;
        case "NO_PIN":
          return tp.pinNoPin;
        case "CORRUPT":
          return tp.pinCorrupt;
        case "NO_CRYPTO":
          return tp.setupNoCrypto;
        case "BAD_FORMAT":
          return tp.setupBadFormat;
        default:
          return tp.pinWrong;
      }
    }
    if (failure.kind === FAIL_BIOMETRIC) return "";
    return t.byCode[failure.code] || failure.message || t.tryLater;
  })();

  let hint = t.lockedHint;
  if (busy) {
    hint = t.verifying;
  } else if (failure) {
    hint =
      failure.kind === FAIL_PIN
        ? pinFailureText
        : failure.message ||
          (t.byCode && t.byCode[failure.code]) ||
          (attempts >= ATTEMPTS_BEFORE_PASSWORD_FIRST
            ? t.tooMany
            : failure.kind === FAIL_BIOMETRIC
              ? t.bioFailed
              : t.tryLater);
  }

  // 连续失败后把密码登录提到主位
  const passwordFirst = attempts >= ATTEMPTS_BEFORE_PASSWORD_FIRST;

  // 自动校正已经移到**弹窗之前**（见 hooks/useBiometricUnlock.js 的
  // preflightThenUnlock）：在那里判断一次，就能保证**第一次弹的就是正确的方式**。
  // 这里只保留**手动回退**。
  const otherMethod = method === METHOD.FINGERPRINT ? METHOD.FACE : METHOD.FINGERPRINT;
  const needsSwitch = Boolean(failure) && failure.kind === FAIL_BIOMETRIC && methodUnavailable(failure.code);
  const offerSwitch = needsSwitch && canOfferMethodSwitch(capabilityState);
  /**
   * 两种方式都没有 → **不给任何切换按钮**，只说一件事 + 一个出口。
   * 实机截图拍到过死循环：“指纹已不可用” → [改用人脸] → “人脸已不可用” → [改用指纹] → …
   */
  const nothingEnrolled = needsSwitch && capabilityState === CAP.NOT_ENROLLED;

  /**
   * 是不是该显示 PIN 界面。
   *
   *   用户明确点过 PIN                → 显示（只要 PIN 还在）
   *   用户明确点过「用指纹/人脸」      → 不显示
   *   用户没表态：只有 PIN（没有生物识别凭据）→ 显示
   *              ：生物识别刚被证明不可用（没录入 / 被删掉）→ 显示
   */
  const autoPin = pin.enabled && !bioCredential;
  const bioUnusableNow =
    Boolean(failure) && failure.kind === FAIL_BIOMETRIC && (methodUnavailable(failure.code) || capabilityState === CAP.NOT_ENROLLED);
  const showPin =
    pin.enabled && (pinChoice === null ? autoPin || bioUnusableNow : pinChoice === true);

  const switchMethod = (target) => {
    saveSettings({ enabled: true, method: target });
    setMethod(target);
    void unlock();
  };

  const switchButton = (primary) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => switchMethod(otherMethod)}
      disabled={busy}
    >
      <i className={lockIcon(otherMethod)} aria-hidden="true" />
      <span>{otherMethod === METHOD.FACE ? t.switchToFace : t.switchToFingerprint}</span>
    </button>
  );

  const retryButton = (primary) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => void unlock()}
      disabled={busy}
      data-testid="bio-lock-retry"
    >
      <i className={lockIcon(method)} aria-hidden="true" />
      <span>{busy ? t.verifying : t.retry}</span>
    </button>
  );

  /** 「用 PIN 解锁」—— 切到 PIN 键盘（**不做任何校验**，那是 PinPad 的事） */
  const pinButton = (primary) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => {
        setPinChoice(true);
      }}
      disabled={busy}
      data-testid="bio-lock-use-pin"
    >
      <i className="fas fa-key" aria-hidden="true" />
      <span>{tp.usePin}</span>
    </button>
  );

  /** PIN 界面的「用指纹 / 人脸解锁」—— 回到生物识别卡片 */
  const backToBioButton = () => (
    <button
      type="button"
      className="bio-lock__btn bio-lock__btn--ghost tap-scale"
      onClick={() => {
        setPinChoice(false);
      }}
      disabled={busy}
      data-testid="bio-lock-use-biometric"
    >
      <i className={lockIcon(method)} aria-hidden="true" />
      <span>{tp.useBiometric}</span>
    </button>
  );

  /**
   * 「返回登录」。**不清任何凭据**（见 useBiometricUnlock.usePasswordInstead 的说明）：
   * 「这一次用密码」不等于「把解锁关掉」。
   */
  const loginButton = (primary, label) => (
    <button
      type="button"
      className={`bio-lock__btn ${primary ? "bio-lock__btn--primary" : "bio-lock__btn--ghost"} tap-scale`}
      onClick={() => void usePasswordInstead()}
      disabled={busy}
      data-testid="bio-lock-back-to-login"
    >
      <i className="fas fa-arrow-left" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );

  // 有 PIN 时：兜底按钮是「用 PIN 解锁」，而「返回登录」单独一个（用户明确要求两者都在）
  const altButton = (primary) => (pin.enabled ? pinButton(primary) : loginButton(primary, t.usePassword));
  const backToLogin = () => (pin.enabled ? loginButton(false, tp.backToLogin) : null);

  const cardIcon = isChecking ? "fas fa-spinner fa-spin" : bioCredential ? lockIcon(method) : "fas fa-key";
  const cardTitle = !bioCredential && pin.enabled ? tp.pinTitle : t.lockedTitle;
  /** 没有生物识别凭据、但有 PIN：整张卡就是 PIN 卡，说明直接说 PIN */
  const cardHint = !bioCredential && pin.enabled && !failure ? pinFormat(tp.pinHint, { len: pin.len }) : hint;

  return (
    <div className="bio-lock" role="dialog" aria-modal="true" aria-label={cardTitle}>
      <div className="bio-lock__bg" aria-hidden="true" />
      <div className={`bio-lock__card${showPin ? " bio-lock__card--pin" : ""}`}>
        <div className="bio-lock__icon" aria-hidden="true">
          <i className={cardIcon} />
        </div>

        {isChecking ? (
          <p className="bio-lock__hint">{t.checking}</p>
        ) : showPin ? (
          <>
            <h1 className="bio-lock__title">{tp.pinTitle}</h1>
            <p className="bio-lock__hint">{pinFormat(tp.pinHint, { len: pin.len })}</p>
            <PinPad
              len={pin.len}
              busy={busy}
              lang={lang}
              error={busy ? "" : pinFailureText}
              hint={busy ? tp.pinBusy : ""}
              onSubmit={(entered) => unlockWithPin(entered)}
              testId="bio-lock-pin"
            />
            {bioCredential ? backToBioButton() : null}
            {loginButton(false, tp.backToLogin)}
          </>
        ) : (
          <>
            <h1 className="bio-lock__title">{cardTitle}</h1>
            <p className="bio-lock__hint">{cardHint}</p>
            {offerSwitch ? (
              <p className="bio-lock__hint">
                {method === METHOD.FINGERPRINT ? t.methodGoneFingerprint : t.methodGoneFace}
              </p>
            ) : null}

            {/* 两种都没有：只说“去系统设置里添加”，出口交给 PIN / 密码 */}
            {nothingEnrolled ? <p className="bio-lock__hint">{t.nothingEnrolled}</p> : null}

            {nothingEnrolled ? (
              <>
                {altButton(true)}
                {backToLogin()}
              </>
            ) : offerSwitch ? (
              <>
                {switchButton(true)}
                {altButton(false)}
                {backToLogin()}
              </>
            ) : passwordFirst && pin.enabled ? (
              <>
                {pinButton(true)}
                {retryButton(false)}
                {backToLogin()}
              </>
            ) : passwordFirst ? (
              <>
                {loginButton(true, t.usePassword)}
                {retryButton(false)}
              </>
            ) : !bioCredential ? (
              <>
                {altButton(true)}
                {backToLogin()}
              </>
            ) : (
              <>
                {retryButton(true)}
                {altButton(false)}
                {backToLogin()}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { GATE_CHECKING, GATE_DISABLED, GATE_LOCKED, GATE_UNLOCKED };
