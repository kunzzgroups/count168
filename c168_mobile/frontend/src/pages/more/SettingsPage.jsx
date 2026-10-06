import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import MobileLangSwitch from "../../components/layout/MobileLangSwitch.jsx";
import MobileThemeSwitch from "../../components/layout/MobileThemeSwitch.jsx";
import MobileOnOffSwitch from "../../components/layout/MobileOnOffSwitch.jsx";
import { fetchJson } from "../../lib/fetchJson.js";
import { useSyncedLoginLang, writeLoginLang } from "../../lib/loginLang.js";
import { readLoginTheme, writeLoginTheme } from "../../lib/loginTheme.js";
import { MORE_I18N } from "../../translateFile/moreTranslate.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import {
  clearToken,
  describeBiometry,
  getDeviceId,
  getDeviceName,
  loadToken,
  saveToken,
} from "../../lib/biometricStore.js";
import { registerDeviceToken, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
import {
  createPasskey,
  listPasskeys,
  passkeyErrorMessage,
  platformAuthenticatorAvailable,
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
  // 生物识别解锁：**一个开关，两种后端**（用户不需要知道背后是哪套机制）
  //   原生（安卓 APK）→ device_token：本地凭据 + 系统指纹弹窗
  //   浏览器（含 iPhone）→ WebAuthn passkey：服务端公钥，抗钓鱼
  const [bioMode, setBioMode] = useState("none"); // "native" | "web" | "none"
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioTypeLabel, setBioTypeLabel] = useState("");
  const [bioBusy, setBioBusy] = useState(false);
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
      navigate("/login", { replace: true });
    }
  }, [navigate]);

  // 探测本机能不能用生物识别、是否已开启。两端走不同判据，但对用户是同一个开关。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isNative()) {
        // 原生：describeBiometry() 不可用时返回空串，兼作“是否支持”的判据
        const [label, storedToken] = await Promise.all([describeBiometry(), loadToken()]);
        if (cancelled) return;
        setBioMode("native");
        setBioTypeLabel(label);
        setBioSupported(label !== "");
        setBioEnabled(Boolean(storedToken));
        return;
      }

      // 浏览器：靠 WebAuthn。安卓 WebView 不支持它，所以这里只会是真浏览器。
      const supported = webauthnSupported() && (await platformAuthenticatorAvailable());
      if (cancelled) return;
      setBioMode("web");
      setBioTypeLabel("");
      setBioSupported(supported);
      if (!supported) return;
      const listed = await listPasskeys();
      if (cancelled) return;
      setBioEnabled((listed.count || 0) > 0);
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
        if (bioMode === "web") {
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
          <section className="m-more-settings-group" aria-label={i18n.biometric || "Biometric Unlock"}>
            <div className="m-more-settings-row">
              <span>{i18n.biometric || "Biometric Unlock"}</span>
              {/* 开关始终渲染：位置要能看到。不支持的环境置灰，由下方说明解释原因 */}
              {bioBusy ? (
                <i className="fas fa-spinner fa-spin" aria-hidden="true" />
              ) : (
                <MobileOnOffSwitch
                  on={bioEnabled}
                  disabled={!bioSupported}
                  onChange={(next) => void toggleBiometric(next)}
                  ariaLabel={i18n.biometric || "Biometric Unlock"}
                  onLabel={i18n.bioOn || "On"}
                  offLabel={i18n.bioOff || "Off"}
                />
              )}
            </div>

            <p className="m-more-settings-hint">
              {!bioSupported
                ? i18n.bioUnsupportedHint || ""
                : bioEnabled
                  ? // 原生才报具体的指纹/人脸类型；浏览器端由 passkeyErrorMessage 在出错时说明
                    [i18n.bioEnabledHint || "", bioMode === "native" ? bioTypeLabel : ""]
                      .filter(Boolean)
                      .join(" · ")
                  : i18n.bioDisabledHint || ""}
            </p>

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
