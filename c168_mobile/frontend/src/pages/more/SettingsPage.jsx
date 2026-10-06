import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import MobileLangSwitch from "../../components/layout/MobileLangSwitch.jsx";
import MobileThemeSwitch from "../../components/layout/MobileThemeSwitch.jsx";
import MobileOnOffSwitch from "../../components/layout/MobileOnOffSwitch.jsx";
import { fetchJson } from "../../lib/fetchJson.js";
import { useSyncedLoginLang, writeLoginLang } from "../../lib/loginLang.js";
import { clearLastCompanyId } from "../../lib/lastLoginPrefs.js";
import { readLoginTheme, writeLoginTheme } from "../../lib/loginTheme.js";
import { MORE_I18N } from "../../translateFile/moreTranslate.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import {
  clearToken,
  describeBiometry,
  biometryReport,
  getDeviceId,
  getDeviceName,
  loadToken,
  saveToken,
} from "../../lib/biometricStore.js";
import { registerDeviceToken, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
import {
  createPasskey,
  biometricDiagnostic,
  listPasskeys,
  passkeyErrorMessage,
  removeAllPasskeys,
  webauthnSupported,
} from "../../lib/webauthn.js";
import "./more.css";

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lang, setLangState] = useSyncedLoginLang();
  const [theme, setThemeState] = useState(() => readLoginTheme());
  // 生物识别解锁：**一个开关，三种后端**（用户不需要知道背后是哪套机制）
  //   原生（安卓 APK）→ device_token：本地凭据 + 系统指纹弹窗
  //   浏览器有 WebAuthn → passkey：服务端公钥，抗钓鱼
  //   浏览器没 WebAuthn（iOS 独立 App）→ 「保持登录」：30 天免密
  const [bioMode, setBioMode] = useState("none"); // "native" | "passkey" | "none"
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioTypeLabel, setBioTypeLabel] = useState("");
  const [bioExpiresAt, setBioExpiresAt] = useState("");
  const [bioCount, setBioCount] = useState(0);
  const [bioBusy, setBioBusy] = useState(false);
  // 仅“原生不可用”时填：APK 关了 web 调试拿不到 console，靠界面一行字诊断
  const [bioUnavailableReason, setBioUnavailableReason] = useState("");
  const [bioError, setBioError] = useState("");
  const i18n = useMemo(() => MORE_I18N[lang] || MORE_I18N.en, [lang]);

  const setLang = useCallback((next) => {
    setLangState(writeLoginLang(next));
  }, []);

  const setTheme = useCallback((next) => {
    setThemeState(writeLoginTheme(next));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const { res, json } = await fetchJson(buildApiUrl("api/session/current_user_api.php"), {
          signal: ac.signal,
        });
        if (!res.ok || !json?.success || !json?.data) {
          navigate("/login", { replace: true });
          return;
        }
        setMe(json.data);
      } catch (error) {
        if (error?.name !== "AbortError") navigate("/login", { replace: true });
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [navigate]);

  const logout = useCallback(async () => {
    try {
      await fetchJson(buildApiUrl("api/session/logout_api.php"), { method: "POST" });
    } finally {
      // 产品要求：退出登录时清掉记住的公司 ID（下次登录需重新输入）
      clearLastCompanyId();
      navigate("/login", { replace: true });
    }
  }, [navigate]);

  // 探测本机能不能用生物识别、是否已开启。两端走不同判据，但对用户是同一个开关。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ① **按平台切分**（这正是产品要的：“开关要去检测 iOS 还是安卓”）。
      //
      // 原生（安卓壳）用原生插件；网页（iOS 加到主屏幕）用 passkey。
      // 平台判断只信 isNative() —— 它在包里只认 androidBridge / Capacitor.PluginHeaders，
      // 而 PluginHeaders 只有原生壳会注入（@capacitor/core 只读不写），所以 iOS 上必为 false。
      if (isNative()) {
        const [label, storedToken] = await Promise.all([describeBiometry(), loadToken()]);
        if (cancelled) return;
        setBioMode("native");
        setBioTypeLabel(label); // 只用于显示类型名（Fingerprint / Face），空着也能用
        // ⚠️ **只要在原生壳里就算了支持**，不再拿 checkBiometry() 当门槛。
        // 原因：登录页在同一台机器上能用指纹，证明插件是好的；
        // 而 checkBiometry() 在安卓上报过不应答，拿它做门槛会把开关置灰。
        // （“目前能不能用”应由 authenticate() 的真实报错回答，不是由一个探测回答。）
        setBioSupported(true);
        setBioEnabled(Boolean(storedToken));
        // 探测无应答时只记一行诊断，不影响开关可用性
        if (label === "") setBioUnavailableReason(await biometryReport());
        return;
      }

      // ② 网页端（iOS）：有 WebAuthn 就走 passkey。
      //
      // ⚠️ 门槛**只能是 webauthnSupported()**，不能再加 platformAuthenticatorAvailable()：
      // 后者在 iOS 上会给假阴性（用户实际能注册并登录，探测却返回 false），
      // 加了它 iOS 就置灰 —— 而且它在安卓 WebView 里也是 false，
      // 结果两端全灰。见 webauthn.js 里该函数上方的告警。
      if (webauthnSupported()) {
        setBioMode("passkey");
        setBioTypeLabel("");
        setBioSupported(true);
        const listed = await listPasskeys();
        if (cancelled) return;
        setBioCount(listed.count || 0);
        setBioEnabled((listed.count || 0) > 0);
        return;
      }

      // ③ 什么都不能用（原生插件无应答，且没有 WebAuthn）→ 开关置灰。
      //    产品明确不要「30 天免登录」这种替代品，所以不再降级为别的功能。
      setBioMode("none");
      setBioTypeLabel("");
      setBioSupported(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** @param {boolean|undefined} next 显式目标值；不传则取反 */
  const toggleBiometric = useCallback(
    async (next) => {
      const enable = next === undefined ? !bioEnabled : Boolean(next);
      setBioBusy(true);
      setBioError("");
      try {
        if (bioMode === "passkey") {
          if (enable) {
            const created = await createPasskey(getDeviceName());
            if (!created.ok) {
              // 不再把 NotAllowedError 当成“用户取消”而静默吞掉：
              // 它同时也是“没有用户手势 / 超时 / 策略不允许”的代码。
              setBioError(passkeyErrorMessage(lang, created.code, i18n.bioEnableFailed));
              return;
            }
          } else {
            const removed = await removeAllPasskeys();
            if (!removed.ok) {
              setBioError(removed.message || i18n.bioEnableFailed || "Could not turn off.");
              return;
            }
          }
          const listed = await listPasskeys();
          setBioCount(listed.count || 0);
          setBioEnabled((listed.count || 0) > 0);
          return;
        }

        // 原生路径
        if (!enable) {
          // 关闭：先吐销服务端令牌，再清本地 Keystore
          await revokeDeviceToken({ deviceId: getDeviceId() });
          await clearToken();
          setBioEnabled(false);
          return;
        }

        const issued = await registerDeviceToken({
          deviceId: getDeviceId(),
          deviceName: getDeviceName(),
        });
        if (!issued.ok) {
          setBioError(
            issued.code === "DEVICE_LIMIT"
              ? i18n.bioDeviceLimit || "Too many devices."
              : i18n.bioEnableFailed || "Could not enable biometric unlock.",
          );
          return;
        }
        await saveToken(issued.token);
        setBioEnabled(true);
      } catch {
        setBioError(i18n.bioEnableFailed || "Could not enable biometric unlock.");
      } finally {
        setBioBusy(false);
      }
    },
    [bioEnabled, bioMode, i18n.bioDeviceLimit, i18n.bioEnableFailed, lang],
  );

  // 这一行只显示「标题 + on/off」（产品要求：不要多余说明文字），
  // 所以只需要算出标题。三种后端共用一行，标题跟着模式变，避免名不副实。
  // 这一行只显示「标题 + on/off」（产品要求：不要多余说明文字）。
  // 产品也明确不要「30 天免登录」这种替代品，所以标题固定。
  const bioLabel = i18n.biometric;

  const companyCode = String(me?.company_code || me?.company_id || "").toUpperCase();
  const groupId = String(me?.login_group_id || me?.login_identifier || "").toUpperCase();
  const displayName = me?.nickname || me?.username || me?.name || "—";
  const role = String(me?.role || me?.user_type || "").toUpperCase();
  const scopeLabel = [companyCode, groupId].filter(Boolean).join(" · ");

  return (
    <MobileShell
      i18n={i18n}
      me={me}
      companyCode={companyCode}
      groupId={groupId}
      onLogout={logout}
      lang={lang}
      onLangChange={setLang}
      stickyBar={
        <MobileSubpageHeader
          backTo="/more"
          backAriaLabel={i18n.back}
          title={i18n.settings}
        />
      }
    >
      <main className="m-more-page m-more-page--settings">
        {loading ? (
          <div className="m-more-state">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
          </div>
        ) : (
          <>
            <section className="m-more-profile">
              <div className="m-more-avatar" aria-hidden="true">
                {initials(displayName)}
              </div>
              <div className="m-more-profile-copy">
                <strong>{displayName}</strong>
                <span>{role || "USER"}</span>
                {scopeLabel ? <em>{scopeLabel}</em> : null}
              </div>
            </section>

            <section className="m-more-settings-group" aria-label={i18n.settings}>
              <div className="m-more-settings-row">
                <span>{i18n.language}</span>
                <MobileLangSwitch
                  lang={lang}
                  onChange={setLang}
                  ariaLabel={i18n.language}
                  tone="light"
                />
              </div>
              <div className="m-more-settings-row">
                <span>{i18n.appearance}</span>
                <MobileThemeSwitch
                  theme={theme}
                  onChange={setTheme}
                  ariaLabel={i18n.appearance}
                  lightLabel={i18n.themeLight}
                  darkLabel={i18n.themeDark}
                />
              </div>
            </section>

          {/*
           * 生物识别解锁：**只有一个开关**。
           * 背后是 device_token（原生）还是 WebAuthn passkey（浏览器）由平台决定，
           * 用户不需要看到两栏、也不需要知道差别。
           */}
          <section className="m-more-settings-group" aria-label={bioLabel || "Biometric Unlock"}>
            <div className="m-more-settings-row">
              <span>{bioLabel || "Biometric Unlock"}</span>
              {/* 只留 on / off，不放任何说明文字（产品要求） */}
              {bioBusy ? (
                <i className="fas fa-spinner fa-spin" aria-hidden="true" />
              ) : (
                <MobileOnOffSwitch
                  on={bioEnabled}
                  disabled={!bioSupported}
                  onChange={(next) => void toggleBiometric(next)}
                  ariaLabel={bioLabel || "Biometric Unlock"}
                  onLabel={i18n.bioOn || "On"}
                  offLabel={i18n.bioOff || "Off"}
                />
              )}
            </div>

            {/* 可用时一行字都不显示；不可用时必须给一行原因，否则就是个沉默的死开关 */}
            {!bioSupported && bioUnavailableReason ? (
              <p className="m-more-settings-hint">{`[${bioUnavailableReason}]`}</p>
            ) : null}

            {/* 只在真的出错时提示一行 */}
            {bioError ? (
              <p className="m-more-settings-hint m-more-settings-hint--error" role="alert">
                {bioError}
              </p>
            ) : null}
          </section>

            <button type="button" className="m-more-logout tap-scale" onClick={() => void logout()}>
              <i className="fas fa-right-from-bracket" aria-hidden="true" />
              {i18n.logout}
            </button>
          </>
        )}
      </main>
    </MobileShell>
  );
}
