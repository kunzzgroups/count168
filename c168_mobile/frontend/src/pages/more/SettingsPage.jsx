import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import MobileLangSwitch from "../../components/layout/MobileLangSwitch.jsx";
import MobileThemeSwitch from "../../components/layout/MobileThemeSwitch.jsx";
import { fetchJson } from "../../lib/fetchJson.js";
import { useSyncedLoginLang, writeLoginLang } from "../../lib/loginLang.js";
import { readLoginTheme, writeLoginTheme } from "../../lib/loginTheme.js";
import { MORE_I18N } from "../../translateFile/moreTranslate.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import {
  clearToken,
  getDeviceId,
  getDeviceName,
  isAvailable as biometricAvailable,
  isNative,
  loadToken,
  saveToken,
} from "../../lib/biometricStore.js";
import { registerDeviceToken, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
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
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
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

  // 探测本机是否支持生物识别，以及是否已开启（本地令牌存在即视为已开启）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = isNative() && (await biometricAvailable());
      if (cancelled) return;
      setBioSupported(supported);
      if (!supported) return;
      setBioEnabled(Boolean(await loadToken()));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleBiometric = useCallback(async () => {
    setBioBusy(true);
    setBioError("");
    try {
      if (bioEnabled) {
        // 关闭：先吐销服务端令牌，再清本地
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
            : i18n.bioEnableFailed || "Could not enable fingerprint unlock.",
        );
        return;
      }
      await saveToken(issued.token);
      setBioEnabled(true);
    } catch {
      setBioError(i18n.bioEnableFailed || "Could not enable fingerprint unlock.");
    } finally {
      setBioBusy(false);
    }
  }, [bioEnabled, i18n.bioDeviceLimit, i18n.bioEnableFailed]);

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

          <section className="m-more-settings-group" aria-label={i18n.biometric || "Biometric"}>
            <div className="m-more-settings-row">
              <span>{i18n.biometric || "Fingerprint unlock"}</span>
              {bioSupported ? (
                bioBusy ? (
                  <i className="fas fa-spinner fa-spin" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="m-more-logout tap-scale"
                    onClick={() => void toggleBiometric()}
                  >
                    {bioEnabled ? i18n.bioOn || "On" : i18n.bioOff || "Off"}
                  </button>
                )
              ) : (
                <em>{i18n.bioUnsupported || "Not available on this device"}</em>
              )}
            </div>
            {bioError ? (
              <div className="m-more-settings-row">
                <span role="alert">{bioError}</span>
              </div>
            ) : null}
            <div className="m-more-settings-row">
              <button
                type="button"
                className="m-more-logout tap-scale"
                onClick={() => navigate("/more/login-devices")}
              >
                {i18n.loginDevices || "Login devices"}
              </button>
            </div>
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
