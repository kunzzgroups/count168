import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LOGIN_I18N, localizeAuthApiMessage } from "../../translateFile/authTranslate.js";
import { readLoginLang, writeLoginLang } from "../../lib/loginLang.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import { resolveMobileLandingPath } from "../../utils/mobilePermissions.js";
import { useAuthBackground } from "./useAuthBackground.js";
import PasswordInput from "../../components/PasswordInput.jsx";
import { extractPlainTextFromRichText } from "../../utils/content/richTextSanitizer.js";
import {
  getDeviceId,
  getDeviceName,
  isAvailable as biometricAvailable,
  isNative,
  loadToken,
  saveToken,
} from "../../lib/biometricStore.js";
import { nativeBiometricLogin } from "../../lib/biometricLogin.js";
import { registerDeviceToken } from "../../lib/deviceTokenApi.js";
import { readLastCompanyId, writeLastCompanyId } from "../../lib/lastLoginPrefs.js";
import {
  loginWithPasskey,
  passkeyErrorMessage,
  webauthnSupported,
} from "../../lib/webauthn.js";

const LOGIN_ASSET_RETRY_KEY = "ec_mobile_login_asset_retry";

/** Uppercase display via CSS; keep raw value while typing so caret stays put. */
function useUppercaseField(initial = "") {
  const [value, setValue] = useState(initial);

  const onChange = useCallback((e) => {
    setValue(e.target.value);
  }, []);

  const onBlur = useCallback((e) => {
    setValue(e.target.value.toUpperCase());
  }, []);

  const onFocus = useCallback((e) => {
    // Keep focused field above soft keyboard on mobile.
    requestAnimationFrame(() => {
      e.target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
  }, []);

  return {
    value,
    setValue,
    fieldProps: {
      value,
      onChange,
      onBlur,
      onFocus,
      autoCapitalize: "characters",
      autoCorrect: "off",
      spellCheck: false,
      style: { textTransform: "uppercase" },
    },
  };
}

function tryLoginPageReloadOnce() {
  if (sessionStorage.getItem(LOGIN_ASSET_RETRY_KEY)) {
    sessionStorage.removeItem(LOGIN_ASSET_RETRY_KEY);
    return false;
  }
  sessionStorage.setItem(LOGIN_ASSET_RETRY_KEY, "1");
  const url = new URL(window.location.href);
  url.searchParams.set("_", String(Date.now()));
  window.location.replace(url.toString());
  return true;
}

function resolvePostLoginPath(data, role, me) {
  const userType = String(data.user_type || me?.user_type || "").toLowerCase();
  const redirect = String(data.redirect || "").trim();

  if (role === "member" || userType === "member") {
    return "/member";
  }

  if (/owner[-_]secondary[-_]password/i.test(redirect) || redirect === "/owner-secondary-password") {
    return "/owner-secondary-password";
  }
  if (/user[-_]secondary[-_]password/i.test(redirect) || redirect === "/user-secondary-password") {
    return "/user-secondary-password";
  }

  if (me) return resolveMobileLandingPath(me);
  return "/dashboard";
}

function AlertModal({ open, title, message, confirmText, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className={`sc-login-modal-overlay${open ? " is-open" : ""}`}
      aria-hidden={open ? "false" : "true"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sc-login-modal-box"
        role="dialog"
        aria-labelledby="modalTitle"
        aria-describedby="modalMessage"
      >
        <div className="sc-login-modal-icon-wrap">
          <i className="fas fa-exclamation-triangle sc-login-modal-icon" aria-hidden="true" />
        </div>
        <h3 id="modalTitle" className="sc-login-modal-title">
          {title}
        </h3>
        <p id="modalMessage" className="sc-login-modal-message">
          {message}
        </p>
        <div className="sc-login-modal-actions">
          <button type="button" className="sc-login-btn sc-login-btn-primary" onClick={onClose}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function EnrollModal({ open, busy, error, title, body, enableLabel, laterLabel, onEnable, onSkip }) {
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
          <i className="fas fa-fingerprint sc-login-modal-icon" aria-hidden="true" />
        </div>
        <h3 id="enrollTitle" className="sc-login-modal-title">
          {title}
        </h3>
        <p className="sc-login-modal-message">{error || body}</p>
        <div className="sc-login-modal-actions sc-login-modal-actions--stack">
          <button
            type="button"
            className="sc-login-btn sc-login-btn-primary"
            onClick={onEnable}
            disabled={busy}
          >
            {busy ? <i className="fas fa-spinner fa-spin" aria-hidden="true" /> : enableLabel}
          </button>
          <button
            type="button"
            className="sc-login-btn sc-login-btn--ghost"
            onClick={onSkip}
            disabled={busy}
          >
            {laterLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const roleFromUrl = searchParams.get("role") === "member" ? "member" : "admin";

  const [role, setRole] = useState(roleFromUrl);
  // 只读一次 localStorage；写成 useState 初始化器是为了不在每次渲染都读
  const [initialCompany] = useState(() => readLastCompanyId());
  const companyField = useUppercaseField(initialCompany);
  const userIdField = useUppercaseField("");
  const companyId = companyField.value;
  const userField = userIdField.value;
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [maintenanceList, setMaintenanceList] = useState([]);
  const [modal, setModal] = useState({ open: false, title: "Notice", message: "" });
  const [enroll, setEnroll] = useState({ open: false, targetPath: "", busy: false, error: "" });
  const [submitting, setSubmitting] = useState(false);
  // 生物识别登录入口："native"（APK 指纹）/ "web"（WebAuthn passkey）/ "none"
  const [bioMode, setBioMode] = useState("none");
  const [bioBusy, setBioBusy] = useState(false);
  const [lang, setLang] = useState(() => readLoginLang());

  const verifyTimeoutRef = useRef(null);
  const langThumbRef = useRef(null);
  const prevLangRef = useRef(lang);
  const i18n = useMemo(() => LOGIN_I18N[lang] || LOGIN_I18N.en, [lang]);

  const setLoginRole = useCallback(
    (nextRole) => {
      setRole(nextRole);
      const next = new URLSearchParams(searchParams);
      if (nextRole === "member") {
        next.set("role", "member");
      } else {
        next.delete("role");
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    setRole(roleFromUrl);
  }, [roleFromUrl]);

  useEffect(() => {
    writeLoginLang(lang);
  }, [lang]);

  useEffect(() => {
    const thumb = langThumbRef.current;
    const prevLang = prevLangRef.current;
    if (!thumb || prevLang === lang) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      prevLangRef.current = lang;
      return;
    }

    const fromX = prevLang === "zh" ? "100%" : "0%";
    const toX = lang === "zh" ? "100%" : "0%";
    const overshootX = lang === "zh" ? "112%" : "-12%";
    const reboundX1 = lang === "zh" ? "97%" : "3%";
    const reboundX2 = lang === "zh" ? "101.2%" : "-1.2%";

    thumb.animate(
      [
        { transform: `translateX(${fromX}) scaleX(1) scaleY(1)` },
        { transform: `translateX(${overshootX}) scaleX(1.1) scaleY(0.9)`, offset: 0.46 },
        { transform: `translateX(${reboundX1}) scaleX(0.95) scaleY(1.05)`, offset: 0.68 },
        { transform: `translateX(${reboundX2}) scaleX(1.03) scaleY(0.97)`, offset: 0.86 },
        { transform: `translateX(${toX}) scaleX(0.99) scaleY(1.01)`, offset: 0.94 },
        { transform: `translateX(${toX}) scaleX(1) scaleY(1)` },
      ],
      {
        duration: 980,
        easing: "cubic-bezier(0.34, 1.72, 0.64, 1)",
        fill: "none",
      },
    );

    prevLangRef.current = lang;
  }, [lang]);

  useEffect(() => {
    sessionStorage.removeItem(LOGIN_ASSET_RETRY_KEY);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(buildApiUrl("api/session/current_user_api.php"), {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        const json = await res.json();
        if (cancelled || !res.ok || !json?.success || !json?.data) return;

        const user = json.data;
        const userType = String(user.user_type || "").toLowerCase();
        if (userType === "member") {
          navigate("/member", { replace: true });
          return;
        }
        if (user.needs_owner_secondary) {
          navigate("/owner-secondary-password", { replace: true });
          return;
        }
        if (user.needs_user_secondary) {
          navigate("/user-secondary-password", { replace: true });
          return;
        }
        navigate(resolveMobileLandingPath(user), { replace: true });
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [navigate]);

  const showNotice = useCallback(
    (message, title) => {
      setModal({
        open: true,
        title: title || i18n.notice,
        message: message || i18n.unknownError,
      });
    },
    [i18n.notice, i18n.unknownError],
  );

  /**
   * 登录成功后的落地点。仅在 APK 内、且设备支持生物识别、且还没开过指纹时
   * 先弹「开启指纹解锁」；其余情况直接跳。
   *
   * 只在最终落地点调用（dashboard / member），不在二级密码跳转前调用 ——
   * 后端签发接口要求 secondary_password_verified === true。
   */
  const finishLogin = useCallback(
    async (targetPath) => {
      try {
        if (isNative() && (await biometricAvailable()) && !(await loadToken())) {
          setEnroll({ open: true, targetPath, busy: false, error: "" });
          return;
        }
      } catch {
        /* 探测失败就静默跳过，不影响登录 */
      }
      navigate(targetPath, { replace: true });
    },
    [navigate],
  );

  /** 是否开启指纹解锁；无论选哪个都继续跳转，不让用户卡在这里 */
  const finishEnroll = useCallback(
    async (enable) => {
      const targetPath = enroll.targetPath || "/dashboard";
      if (!enable) {
        setEnroll({ open: false, targetPath: "", busy: false, error: "" });
        navigate(targetPath, { replace: true });
        return;
      }

      setEnroll((prev) => ({ ...prev, busy: true, error: "" }));
      try {
        const issued = await registerDeviceToken({
          deviceId: getDeviceId(),
          deviceName: getDeviceName(),
        });
        if (!issued.ok) {
          // 失败不阻断登录，告知后可重试或直接进 App
          setEnroll((prev) => ({
            ...prev,
            busy: false,
            error:
              issued.code === "DEVICE_LIMIT"
                ? i18n.bioDeviceLimit
                : i18n.bioEnableFailed,
          }));
          return;
        }
        await saveToken(issued.token);
        setEnroll({ open: false, targetPath: "", busy: false, error: "" });
        navigate(targetPath, { replace: true });
      } catch {
        setEnroll((prev) => ({ ...prev, busy: false, error: i18n.bioEnableFailed }));
      }
    },
    [enroll.targetPath, i18n.bioDeviceLimit, i18n.bioEnableFailed, navigate],
  );

  /**
   * 用 passkey（Face ID / 指纹）登录。
   * 必须定义在 finishLogin / showNotice **之后** —— 依赖数组在渲染时求值，
   * 放前面会撞上 const 的暂时性死区。
   */
  const handleBioLogin = useCallback(async () => {
    setBioBusy(true);
    try {
      const result =
        bioMode === "native" ? await nativeBiometricLogin() : await loginWithPasskey();
      if (!result.ok) {
        // 带原因/错误码地提示 —— 只显示“失败”会让用户和我都无从而适
        showNotice(passkeyErrorMessage(lang, result.code, i18n.bioFailed));
        return;
      }
      await finishLogin(result.redirect || "/dashboard");
    } finally {
      setBioBusy(false);
    }
  }, [bioMode, finishLogin, i18n.bioFailed, lang, showNotice]);
  useAuthBackground();

  // 登录页的生物识别入口。两端判据不同，但对用户是同一个按钮：
  //   原生（APK）—— 本地还存着凭据才值得显示（否则没什么可用）
  //   浏览器 —— 只要支持 WebAuthn 就显示。
  //
  // ⚠️ 浏览器端**不再**用 platformAuthenticatorAvailable() 当门槛：它在 iOS 上会给
  // 假阴性（用户实际能注册并登录 passkey，该探测却返回 false），结果按钮直接不出现。
  // 宁可显示按钮，让实际尝试时的错误说清楚原因。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isNative()) {
        const stored = await loadToken();
        if (!cancelled) setBioMode(stored ? "native" : "none");
        return;
      }
      if (!cancelled) setBioMode(webauthnSupported() ? "web" : "none");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(buildApiUrl("api/maintenance/get_public_api.php"), {
          signal: ac.signal,
          credentials: "include",
        });
        const result = await res.json();
        if (result.success && Array.isArray(result.data)) {
          setMaintenanceList(result.data);
        } else {
          setMaintenanceList([]);
        }
      } catch (e) {
        if (e.name !== "AbortError") setMaintenanceList([]);
      }
    })();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const v = companyId.trim();
    if (verifyTimeoutRef.current) clearTimeout(verifyTimeoutRef.current);
    if (!v) return undefined;

    verifyTimeoutRef.current = setTimeout(async () => {
      try {
        const fd = new FormData();
        fd.append("company_id", v);
        await fetch(buildApiUrl("api/company/verify_api.php"), { method: "POST", body: fd });
      } catch {
        /* silent */
      }
    }, 500);

    return () => {
      if (verifyTimeoutRef.current) clearTimeout(verifyTimeoutRef.current);
    };
  }, [companyId]);

  const userPlaceholder = useMemo(
    () => (role === "member" ? i18n.accountPlaceholder : i18n.usernamePlaceholder),
    [role, i18n.accountPlaceholder, i18n.usernamePlaceholder],
  );

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("action", "login");
      fd.append("company_id", companyId.toUpperCase().trim());
      fd.append("password", password);
      fd.append("login_role", role);
      if (role === "member") {
        fd.append("account_id", userField.toUpperCase().trim());
      } else {
        fd.append("login_id", userField.toUpperCase().trim());
      }
      // member 也要传：后端已为 member / owner 实现 device_token 记住我
      // （过去只对 user 生效，而前端连字段都不发，member 根本没有记住我）
      if (rememberMe) fd.append("remember_me", "1");

      const res = await fetch(buildApiUrl("api/session/login_api.php"), {
        method: "POST",
        body: fd,
        credentials: "include",
        cache: "no-store",
      });
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        const proxyOffline = res.status === 500 && /ECONNREFUSED|proxy error/i.test(raw);
        const msg = proxyOffline
          ? i18n.loginBackendOffline
          : res.ok
            ? i18n.loginInvalidResponse
            : i18n.loginServerError.replace("{status}", String(res.status));
        if (tryLoginPageReloadOnce()) return;
        showNotice(msg);
        return;
      }

      if (data.status === "success" && data.redirect) {
        sessionStorage.removeItem(LOGIN_ASSET_RETRY_KEY);
        // 记住公司 ID：iOS 钥匙串只有 username + password 两个槽位，
        // 这个第三字段系统不保存，不本地记住的话每次都要手输。
        writeLastCompanyId(companyId);
        const redirect = String(data.redirect || "").trim();
        if (/owner[-_]secondary[-_]password/i.test(redirect) || redirect === "/owner-secondary-password") {
          navigate("/owner-secondary-password", { replace: true });
          return;
        }
        if (/user[-_]secondary[-_]password/i.test(redirect) || redirect === "/user-secondary-password") {
          navigate("/user-secondary-password", { replace: true });
          return;
        }
        if (role === "member" || String(data.user_type || "").toLowerCase() === "member") {
          void finishLogin("/member");
          return;
        }

        let me = null;
        try {
          const meRes = await fetch(buildApiUrl("api/session/current_user_api.php"), {
            credentials: "include",
            cache: "no-store",
          });
          const meJson = await meRes.json();
          if (meRes.ok && meJson?.success && meJson?.data) {
            me = meJson.data;
          }
        } catch {
          /* fall through */
        }

        void finishLogin(resolvePostLoginPath(data, role, me));
        return;
      }

      showNotice(localizeAuthApiMessage(data.message, lang) || i18n.loginFailed);
    } catch {
      if (tryLoginPageReloadOnce()) return;
      showNotice(i18n.loginBackendOffline);
    } finally {
      setSubmitting(false);
    }
  };

  const maintenanceVisible = maintenanceList.length > 0;

  return (
    <>
      <div className="sc-login-column">
        <div className="sc-login-shell">
          {maintenanceVisible && (
            <div className="sc-login-maintenance-wrapper">
              <div className="sc-login-maintenance-track">
                {[...maintenanceList, ...maintenanceList].map((item, index) => (
                  <div className="sc-login-maintenance-item" key={`${item.id}-${index}`}>
                    <span className="sc-login-maintenance-dot" />
                    <span className="sc-login-maintenance-label">{item.prefix || i18n.maintenanceLabel}</span>
                    <span>{extractPlainTextFromRichText(item.content)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="sc-login-card">
            <div className="sc-login-role-tabs">
              <button
                id="admin-tab"
                type="button"
                className={`sc-login-role-tab${role === "admin" ? " active" : ""}`}
                onClick={() => setLoginRole("admin")}
              >
                {i18n.admin}
              </button>
              <button
                id="member-tab"
                type="button"
                className={`sc-login-role-tab${role === "member" ? " active" : ""}`}
                onClick={() => setLoginRole("member")}
              >
                {i18n.member}
              </button>
            </div>

            <div className="sc-login-card-content">
              <form className="sc-login-form" onSubmit={onSubmit}>
                <div className="sc-login-input-row">
                  <i className="fas fa-building sc-login-input-icon" />
                  <input
                    id="company-id"
                    type="text"
                    className="sc-login-input"
                    placeholder={i18n.companyPlaceholder}
                    required
                    autoComplete="organization"
                    inputMode="text"
                    enterKeyHint="next"
                    {...companyField.fieldProps}
                  />
                </div>

                <div className="sc-login-input-row">
                  <i className="fas fa-user sc-login-input-icon" />
                  <input
                    id="user-id"
                    type="text"
                    className="sc-login-input"
                    placeholder={userPlaceholder}
                    required
                    autoComplete="username"
                    inputMode="text"
                    enterKeyHint="next"
                    {...userIdField.fieldProps}
                  />
                </div>

                <div className="sc-login-input-row">
                  <i className="fas fa-lock sc-login-input-icon" />
                  <PasswordInput
                    id="password"
                    className="sc-login-input"
                    placeholder={i18n.passwordPlaceholder}
                    required
                    autoComplete="current-password"
                    enterKeyHint="go"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    showLabel={i18n.showPassword}
                    hideLabel={i18n.hidePassword}
                    onFocus={(e) => {
                      requestAnimationFrame(() => {
                        e.target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
                      });
                    }}
                  />
                </div>

                <div className="sc-login-options">
                  <label className="sc-login-remember">
                    <input
                      type="checkbox"
                      className="sc-login-remember-check"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                    />
                    <span className="sc-login-remember-slider" aria-hidden="true" />
                    <span className="sc-login-remember-text">{i18n.rememberMe}</span>
                  </label>
                  {role === "admin" && (
                    <Link to="/reset-password" className="sc-login-forgot-link">
                      {i18n.forgotPassword}
                    </Link>
                  )}
                </div>

                <button type="submit" className="sc-login-btn sc-login-submit-btn" disabled={submitting}>
                  <span>{submitting ? i18n.loggingIn : i18n.login}</span>
                </button>

                {bioMode !== "none" ? (
                  <button
                    type="button"
                    className="sc-login-passkey-btn"
                    onClick={() => void handleBioLogin()}
                    disabled={submitting || bioBusy}
                  >
                    <i className="fas fa-fingerprint" aria-hidden="true" />
                    <span>{bioBusy ? i18n.bioWorking : i18n.bioLogin}</span>
                  </button>
                ) : null}

                <div className="sc-login-lang-ios-wrap">
                  <div
                    className={`sc-login-lang-ios ${lang === "zh" ? "is-zh" : "is-en"}`}
                    role="group"
                    aria-label="Switch language"
                  >
                    <span ref={langThumbRef} className="sc-login-lang-ios-thumb" />
                    <button
                      type="button"
                      className={`sc-login-lang-seg${lang === "en" ? " active" : ""}`}
                      onClick={() => setLang("en")}
                      aria-pressed={lang === "en"}
                    >
                      EN
                    </button>
                    <button
                      type="button"
                      className={`sc-login-lang-seg${lang === "zh" ? " active" : ""}`}
                      onClick={() => setLang("zh")}
                      aria-pressed={lang === "zh"}
                    >
                      中
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>

      <AlertModal
        open={modal.open}
        title={modal.title}
        message={modal.message}
        confirmText={i18n.confirm}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
      />

      <EnrollModal
        open={enroll.open}
        busy={enroll.busy}
        error={enroll.error}
        title={i18n.bioTitle}
        body={i18n.bioBody}
        enableLabel={i18n.bioEnable}
        laterLabel={i18n.bioLater}
        onSkip={() => void finishEnroll(false)}
        onEnable={() => void finishEnroll(true)}
      />
    </>
  );
}
