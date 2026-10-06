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
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioTypeLabel, setBioTypeLabel] = useState("");
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");
  const [pkSupported, setPkSupported] = useState(false);
  const [pkCount, setPkCount] = useState(0);
  const [pkMax, setPkMax] = useState(0);
  const [pkBusy, setPkBusy] = useState(false);
  const [pkError, setPkError] = useState("");
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
      // describeBiometry() 不可用时返回空串，所以它同时就是“是否支持”的判据
      const [label, storedToken] = await Promise.all([describeBiometry(), loadToken()]);
      if (cancelled) return;
      setBioTypeLabel(label);
      setBioSupported(label !== "");
      setBioEnabled(Boolean(storedToken));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** @param {boolean|undefined} next 显式目标值；不传则取反（开关直接传 true/false） */
  const toggleBiometric = useCallback(
    async (next) => {
      const enable = next === undefined ? !bioEnabled : Boolean(next);
      setBioBusy(true);
      setBioError("");
      try {
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
    },
    [bioEnabled, i18n.bioDeviceLimit, i18n.bioEnableFailed],
  );

  // passkey（WebAuthn）探测 + 已注册数量。安卓 APK 的 WebView 不支持 WebAuthn，
  // 所以那边这一栏不会出现 —— 它是留给 iPhone / 桌面浏览器的。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = webauthnSupported() && (await platformAuthenticatorAvailable());
      if (cancelled) return;
      setPkSupported(supported);
      if (!supported) return;
      const listed = await listPasskeys();
      if (cancelled) return;
      setPkCount(listed.count || 0);
      setPkMax(listed.max || 0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddPasskey = useCallback(async () => {
    setPkBusy(true);
    setPkError("");
    try {
      const result = await createPasskey(getDeviceName());
      if (!result.ok) {
        // 用户主动取消不算错误，不要弹红字吓人
        if (result.code !== "NotAllowedError" && result.code !== "CANCELLED") {
          setPkError(result.message || i18n.passkeyAddFailed || "Could not add a passkey.");
        }
        return;
      }
      const listed = await listPasskeys();
      setPkCount(listed.count || 0);
      setPkMax(listed.max || 0);
    } finally {
      setPkBusy(false);
    }
  }, [i18n.passkeyAddFailed]);

  const handleRemovePasskeys = useCallback(async () => {
    setPkBusy(true);
    setPkError("");
    try {
      const result = await removeAllPasskeys();
      if (!result.ok) {
        setPkError(result.message || i18n.passkeyRemoveFailed || "Could not remove.");
        return;
      }
      setPkCount(0);
    } finally {
      setPkBusy(false);
    }
  }, [i18n.passkeyRemoveFailed]);

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

          <section className="m-more-settings-group" aria-label={i18n.biometric || "Biometric Unlock"}>
            <div className="m-more-settings-row">
              <span>{i18n.biometric || "Fingerprint unlock"}</span>
              {/* 开关始终渲染：位置要能看到。浏览器 / 旧 APK 上置灰，由下方说明解释原因 */}
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
                  ? [i18n.bioEnabledHint || "", bioTypeLabel].filter(Boolean).join(" · ")
                  : i18n.bioDisabledHint || ""}
            </p>

            {bioError ? (
              <p className="m-more-settings-hint m-more-settings-hint--error" role="alert">
                {bioError}
              </p>
            ) : null}
          </section>

          {/* passkey 是另一种登录方式（服务端公钥认证），不是「给本地凭据加把锁」，
              所以单独一张卡片，不与上面的 Biometric Unlock 混在一起。 */}
          {pkSupported ? (
            <section className="m-more-settings-group" aria-label={i18n.passkey || "Face ID / Passkey"}>
              <div className="m-more-settings-row">
                <span>{i18n.passkey || "Face ID / Passkey"}</span>
                {pkBusy ? (
                  <i className="fas fa-spinner fa-spin" aria-hidden="true" />
                ) : pkCount > 0 ? (
                  <button
                    type="button"
                    className="m-more-settings-link m-more-settings-link--danger"
                    onClick={() => void handleRemovePasskeys()}
                  >
                    {i18n.passkeyRemove || "Remove"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="m-more-settings-link"
                    onClick={() => void handleAddPasskey()}
                  >
                    {i18n.passkeyRegister || "Add"}
                  </button>
                )}
              </div>
              <p className="m-more-settings-hint">
                {pkCount > 0
                  ? `${i18n.passkeyRegistered || "Registered"} · ${pkCount}/${pkMax}`
                  : i18n.passkeyHintOff || ""}
              </p>
              {pkError ? (
                <p className="m-more-settings-hint m-more-settings-hint--error" role="alert">
                  {pkError}
                </p>
              ) : null}
            </section>
          ) : null}

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
