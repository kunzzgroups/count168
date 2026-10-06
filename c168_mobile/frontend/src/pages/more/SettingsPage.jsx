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
  getDeviceId,
  getDeviceName,
  isNative,
  loadToken,
  saveToken,
  withTimeout,
} from "../../lib/biometricStore.js";
import { registerDeviceToken, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
import {
  createPasskey,
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
  const [bioError, setBioError] = useState("");
  /**
   * ⚠️ 临时诊断：**每次改动必须递增这个号**。
   *
   * 为何需要它：iOS 主屏幕应用 / 安卓 WebView 会把 JS 留在内存里，
   * 从后台切回来不会重新加载 —— 于是“改了代码设备上却一模一样”。
   * 用户截图里的这个号能直接确定设备跑的是哪个包。
   * 功能稳下来后连同下面那行一起删。
   *
   * 初始值故意非空：如果连这一行都不显示，那就不是探测失败而是**包没更新**。
   */
  const BIO_BUILD = "b8";
  const [bioDiag, setBioDiag] = useState("boot");
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

  /**
   * ────────────────────────────────────────────────────────────────────
   * 生物识别可用性判定 —— **iOS 与安卓分开写**
   * ────────────────────────────────────────────────────────────────────
   *
   * 判据直接照抄**登录页已经在跑通的那两条通路**，不另发明探测：
   *
   *   安卓  hooks/useBiometricUnlock.js ： isNative() → loadToken()
   *   iOS   LoginPage.jsx 的 passkey 通路 ： !isNative() → hasPasskeyOnDevice()
   *
   * 为何必须照抄：登录页在两端都能用（iOS 人脸 / 安卓指纹），
   * 说明那里的判据是对的。设置页之前自己用了两个探测，
   * 而它们在真机上都会给出**与事实相反**的结果：
   *   · checkBiometry() 在安卓上不应答 → 开关被置灰
   *   · platformAuthenticatorAvailable() 在 iOS 上是假阴性 → 开关被置灰
   */

  /** 安卓：Capacitor 原生壳。判据与登录门禁**完全一致**。 */
  const probeAndroid = useCallback(async () => {
    // 凭据在 Keystore（device_token）。与 useBiometricUnlock 同一套。
    const token = await withTimeout(loadToken(), 4000);
    // 类型名只是装饰（Fingerprint / Face），**不参与可用性判断** ——
    // 拿它当门槛就是之前安卓置灰的原因。
    let label = "";
    try {
      label = await withTimeout(describeBiometry(), 3000);
    } catch {
      label = "";
    }
    return {
      mode: "native",
      // 在原生壳里就是支持的：同一台机器的登录页已经能用指纹。
      supported: true,
      enabled: Boolean(token),
      label,
      count: 0,
      note: `token=${token ? "yes" : "no"}${label ? "" : " probe=none"}`,
    };
  }, []);

  /** iOS：Safari「加到主屏幕」的网页。判据与登录页 passkey 通路一致。 */
  const probeIos = useCallback(async () => {
    const supported = webauthnSupported();
    let count = 0;
    if (supported) {
      try {
        const listed = await listPasskeys();
        count = listed.count || 0;
      } catch {
        count = 0;
      }
    }
    return {
      mode: supported ? "passkey" : "none",
      supported,
      enabled: count > 0,
      label: "",
      count,
      note: `wk=${supported ? 1 : 0} count=${count}`,
    };
  }, []);

  // 探测本机能不能用生物识别、是否已开启。两端分开写，但对用户是同一个开关。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const native = isNative();
        const r = native ? await probeAndroid() : await probeIos();
        if (cancelled) return;
        setBioMode(r.mode);
        setBioTypeLabel(r.label || "");
        setBioSupported(r.supported);
        setBioEnabled(r.enabled);
        setBioCount(r.count || 0);
        setBioDiag(`native=${native ? 1 : 0} mode=${r.mode} sup=${r.supported ? 1 : 0} ${r.note}`);
      } catch (err) {
        // ⚠️ 探测自己抛错也必须留下痕迹，否则就是个沉默的死开关。
        // 这正是之前几轮的现象：探测里调了一个没 import 的函数（isNative），
        // ReferenceError 在第一行就抛出，诊断行一个字都没有 —— 看起来像
        // “改什么都没用”，实际是这一段从来没跑过。
        if (cancelled) return;
        setBioSupported(false);
        setBioDiag(`THREW ${err?.message || err}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [probeAndroid, probeIos]);

  /** @param {boolean|undefined} next 显式目标值；不传则取反 */
  const toggleBiometric = useCallback(
    async (next) => {
      const enable = next === undefined ? !bioEnabled : Boolean(next);
      setBioBusy(true);
      setBioError("");
      setBioDiag(`mode=${bioMode} tap=${enable ? "on" : "off"} …`);
      try {
        if (bioMode === "passkey") {
          if (enable) {
            const created = await createPasskey(getDeviceName());
            if (!created.ok) {
              // 不再把 NotAllowedError 当成“用户取消”而静默吞掉：
              // 它同时也是“没有用户手势 / 超时 / 策略不允许”的代码。
              setBioError(passkeyErrorMessage(lang, created.code, i18n.bioEnableFailed));
              setBioDiag(`mode=passkey tap=on FAIL code=${created.code}`);
              return;
            }
          } else {
            const removed = await removeAllPasskeys();
            if (!removed.ok) {
              setBioError(removed.message || i18n.bioEnableFailed || "Could not turn off.");
              setBioDiag(`mode=passkey tap=off FAIL ${removed.message || ""}`);
              return;
            }
          }
          const listed = await listPasskeys();
          setBioCount(listed.count || 0);
          setBioEnabled((listed.count || 0) > 0);
          setBioDiag(`mode=passkey tap=${enable ? "on" : "off"} OK count=${listed.count || 0}`);
          return;
        }

        // 原生路径
        if (!enable) {
          // 关闭：先吐销服务端令牌，再清本地 Keystore
          await revokeDeviceToken({ deviceId: getDeviceId() });
          await clearToken();
          setBioEnabled(false);
          setBioDiag("mode=native tap=off OK");
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
          setBioDiag(`mode=native tap=on FAIL code=${issued.code || "?"}`);
          return;
        }
        await saveToken(issued.token);
        setBioEnabled(true);
        setBioDiag(`mode=native tap=on OK token=${issued.token ? "saved" : "MISSING"}`);
      } catch (err) {
        setBioError(i18n.bioEnableFailed || "Could not enable biometric unlock.");
        setBioDiag(`mode=${bioMode} tap=${enable ? "on" : "off"} THREW ${err?.message || err}`);
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

            {/* 诊断行：本次排查专用，初始值就是 "boot"，
                所以只要这行不出现，就说明设备跑的不是新包（而不是探测失败）。
                功能稳下来后连同 BIO_BUILD 一起删。 */}
            {bioDiag ? (
              <p className="m-more-settings-hint">{`[${BIO_BUILD}] ${bioDiag}`}</p>
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
