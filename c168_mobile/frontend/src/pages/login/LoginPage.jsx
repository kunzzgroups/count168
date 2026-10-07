import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LOGIN_I18N, localizeAuthApiMessage } from "../../translateFile/authTranslate.js";
import { readLoginLang, writeLoginLang } from "../../lib/loginLang.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import { resolveMobileLandingPath } from "../../utils/mobilePermissions.js";
import { useAuthBackground } from "./useAuthBackground.js";
import PasswordInput from "../../components/PasswordInput.jsx";
import { extractPlainTextFromRichText } from "../../utils/content/richTextSanitizer.js";
import { isNative } from "../../lib/biometricStore.js";
import { useBiometricEnrol, BiometricEnrolModal } from "../../components/lock/BiometricEnrolModal.jsx";
import { readLastCompanyId, writeLastCompanyId } from "../../lib/lastLoginPrefs.js";
import { onBrandLogoError } from "../../lib/brandAssets.js";

// 登录页 logo：先播拼图动图（webp，54 帧），放完换成静态图。
// 时序取自设计稿：gif/webp 的完整帧在 2.12–2.91s 稳住，所以 2.5s 切换正好落在稳住的帧上，
// 切过去和静态图长得一样，肉眼看不到跳变。
const LOGO_ANIMATION_MS = 2500;
const LOGO_ANIM = "/images/count_logo_puzzle_animation.webp";
const LOGO_STATIC = "/images/count_logo.webp";

function initialLogoSrc() {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return LOGO_STATIC;
  } catch (e) {}
  return LOGO_ANIM;
}
import {
  getPasskeyId,
  hasPasskeyOnDevice,
  consumeSkipPasskeyAutoLogin,
  passkeyErrorMessage,
  startConditionalPasskeyLogin,
  tryImmediatePasskeyLogin,
} from "../../lib/webauthn.js";

const LOGIN_ASSET_RETRY_KEY = "ec_mobile_login_asset_retry";

/**
 * 这些 passkey 错误码不是“用户需要知道的故障”，而是平台限制或用户主动放弃：
 *   NotAllowedError —— 多数平台上等于“需要用户手势”，页面加载时调用必被拒
 *   CANCELLED / AbortError —— 用户自己取消或导航走了
 *   UNSUPPORTED —— 环境不支持条件式调解
 *   NO_ASSERTION —— 没拿到断言（一般是上面几种的副作用）
 * 遇到这些就静默回退，不要弹任何提示。
 * 其余（尤其是 CREDENTIAL_UNKNOWN）必须告知，否则就变成“能选但登不了”。
 */
const SILENT_PASSKEY_CODES = new Set([
  "NotAllowedError",
  "CANCELLED",
  "AbortError",
  "UNSUPPORTED",
  "NO_ASSERTION",
]);

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
  const [submitting, setSubmitting] = useState(false);
  const [lang, setLang] = useState(() => readLoginLang());
  const [logoSrc, setLogoSrc] = useState(initialLogoSrc);

  useEffect(() => {
    if (logoSrc !== LOGO_ANIM) return undefined;
    // 先把静态图预加载好，再切，避免切换瞬间白一下
    const preload = new Image();
    preload.src = LOGO_STATIC;
    const timer = setTimeout(() => setLogoSrc(LOGO_STATIC), LOGO_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [logoSrc]);

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

  /**
   * 会话检查已完成且**未登录**；在此之前不许碰 passkey。
   *
   * ⚠️ 为何必须有它：路由没有守卫，打开 App 会先落到 /login。
   * 而下面那个 passkey 效果在挂载时立刻调 get() —— 于是**已登录的用户**
   * 也会先被弹一次系统 passkey 界面，然后才被会话检查跳进 App。
   * 实机反馈就是「直接进 App，但会跳出 passkey 弹窗」。
   * 两个效果当初是并行跑的，这就是个竞态。
   */
  const [passkeyMayRun, setPasskeyMayRun] = useState(false);

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
        if (cancelled) return;

        if (!res.ok || !json?.success || !json?.data) {
          // 确实没登录 → 这时才允许走 passkey 自动登录
          setPasskeyMayRun(true);
          return;
        }

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
        if (err?.name !== "AbortError") {
          // 会话检查本身失败（网络等）→ 不能因此彻底禁用 passkey 自动登录，
          // 否则用户永远只能手输密码。放行，让 passkey 流程自己去试。
          setPasskeyMayRun(true);
        }
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
  /**
   * 开启引导（与二级密码页共用，见 components/lock/BiometricEnrolModal.jsx）。
   * 为何抽成公共的：有二级密码的身份（owner 无条件需要）走的是**另一条路** ——
   * LoginPage 把用户 navigate 到二级密码页，二级密码页成功后直接进 App，
   * 引导从头到尾不会出现 ✗ 结果就是“有二级密码的 owner 开不了生物识别”。
   */
  const enrol = useBiometricEnrol((targetPath) => navigate(targetPath, { replace: true }));

  const finishLogin = useCallback(
    async (targetPath) => {
      // 引导已接管跳转就不要再 navigate
      if (await enrol.offer(targetPath)) return;
      navigate(targetPath, { replace: true });
    },
    [enrol, navigate],
  );


  /**
   * 用 passkey（Face ID / 指纹）登录。
   * 必须定义在 finishLogin / showNotice **之后** —— 依赖数组在渲染时求值，
   * 放前面会撞上 const 的暂时性死区。
   */
  useAuthBackground();

  /**
   * 登录页**不放任何生物识别按钮**（产品要求）。
   *
   * 防 NFC 靠的是 authenticatorAttachment: "platform"（见 lib/webauthn.js），
   * **不是**靠“必须有凭据 ID” —— 后者会让老注册彻底用不了。
   *
   * 两步走：
   *   ① 先试一次「立即弹」—— 实机已验证 iOS 会在页面加载时弹系统界面（不要求手势），
   *      所以打开 App 就有机会直接刷脸；
   *   ② 不行就回退到条件式调解 —— 点一下账号栏，系统在自动填充栏里提示刷脸。
   */
  useEffect(() => {
    if (isNative()) return undefined;        // APK 走启动门禁，这里不做

    // 已登录就绝不碰 passkey（否则会先弹一次系统界面再被跳进 App）
    if (!passkeyMayRun) return undefined;

    // 主动退出登录后的那一次不要立即弹刷脸：用户刚明确要离开，立刻又刷进来
    // 看着就像“没退出成功”（实机反馈过）。自动填充栏的条件式调解仍在。
    if (consumeSkipPasskeyAutoLogin()) return undefined;

    // 仅在**本机注册过** passkey 时动作。
    //
    // 为何不再要求“必须知道凭据 ID”：已用 authenticatorAttachment: "platform"
    // 把 iOS 限定在平台验证器上，不会再落到 NFC；而拿 ID 当门槛的代价是
    // 老注册完全用不了（实机上就是“打开不弹任何东西”）。
    if (!hasPasskeyOnDevice()) return undefined;

    const credentialId = getPasskeyId();

    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        // ① 先试「立即弹」—— 已知具体凭据时，iOS 应走 Face ID 而不是 NFC
        const immediate = await tryImmediatePasskeyLogin({ signal: ac.signal });
        if (cancelled) return;
        if (immediate.ok) {
          await finishLogin(immediate.redirect || "/dashboard");
          return;
        }

        const immediateCode = immediate.code || "";
        if (immediateCode && !SILENT_PASSKEY_CODES.has(immediateCode)) {
          // 例如 CREDENTIAL_UNKNOWN：用户确实选了一把已失效的 passkey。
          showNotice(passkeyErrorMessage(lang, immediateCode, i18n.bioFailed));
          return;
        }

        // ② 回退到条件式调解：点一下账号栏，系统在自动填充栏里提示刷脸
        const conditional = await startConditionalPasskeyLogin({ signal: ac.signal });
        if (cancelled || !conditional.ok) {
          const code = conditional.code || "";
          if (!cancelled && code && !SILENT_PASSKEY_CODES.has(code)) {
            showNotice(passkeyErrorMessage(lang, code, i18n.bioFailed));
          }
          return;
        }
        await finishLogin(conditional.redirect || "/dashboard");
      } catch {
        /* 任何意外都不要影响正常输入登录 */
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [finishLogin, i18n.bioFailed, lang, passkeyMayRun, showNotice]);

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
          <div className="sc-login-brand">
            <div className="sc-login-brand-logo">
              <img src={logoSrc} alt="" onError={onBrandLogoError} data-logo-kind="brand" />
            </div>
            <h1 className="sc-login-title">{i18n.title}</h1>
            <p className="sc-login-tagline">{i18n.tagline}</p>
          </div>

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
                  {/* 安卓键盘默认会自动首字母大写 / 自动更正，公司代码会被改成 Ms1 这种 */}
                  <input
                    id="company-id"
                    type="text"
                    className="sc-login-input"
                    placeholder={i18n.companyPlaceholder}
                    required
                    autoComplete="organization"
                    inputMode="text"
                    enterKeyHint="next"
                    autoCapitalize="none"
                    autoCorrect="off"
                    {...companyField.fieldProps}
                  />
                </div>

                <div className="sc-login-input-row">
                  <i className="fas fa-user sc-login-input-icon" />
                  {/* 同上：用户名也不能被自动大写 / 更正 */}
                  <input
                    id="user-id"
                    type="text"
                    className="sc-login-input"
                    placeholder={userPlaceholder}
                    required
                    autoComplete="username"
                    inputMode="text"
                    enterKeyHint="next"
                    autoCapitalize="none"
                    autoCorrect="off"
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
                  <i className="fas fa-arrow-right sc-login-submit-arrow" aria-hidden="true" />
                </button>

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

      <BiometricEnrolModal
        open={enrol.open}
        busy={enrol.busy}
        error={enrol.error}
        onSkip={enrol.skip}
        onEnable={() => void enrol.enable()}
      />
    </>
  );
}
