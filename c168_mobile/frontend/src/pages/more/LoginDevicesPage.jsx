import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import { fetchJson } from "../../lib/fetchJson.js";
import { useSyncedLoginLang } from "../../lib/loginLang.js";
import { buildApiUrl } from "../../utils/apiUrl.js";
import { getDeviceId, isNative, clearToken } from "../../lib/biometricStore.js";
import { listDeviceTokens, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
import "./more.css";

const TEXT = {
  zh: {
    title: "我的登录设备",
    intro: "已开启指纹解锁的设备。下线后该设备需重新用密码登录。",
    empty: "还没有开启指纹解锁的设备",
    emptyHint: "在登录页开启指纹解锁后，设备会出现在这里。",
    current: "本机",
    revoked: "已下线",
    expired: "已过期",
    lastUsed: "最近使用",
    never: "从未使用",
    expiresAt: "到期",
    revoke: "下线",
    confirm: "确认下线",
    cancel: "取消",
    quota: "已用 {used}/{max} 台",
    quotaFull: "已达上限，需先下线一台才能在新设备上开启",
    loading: "加载中…",
    failed: "操作失败，请重试",
  },
  en: {
    title: "Login devices",
    intro: "Devices with fingerprint unlock enabled. Revoking requires a password login again.",
    empty: "No devices with fingerprint unlock yet",
    emptyHint: "Enable fingerprint unlock on the login screen and the device will show up here.",
    current: "This device",
    revoked: "Revoked",
    expired: "Expired",
    lastUsed: "Last used",
    never: "Never used",
    expiresAt: "Expires",
    revoke: "Revoke",
    confirm: "Confirm",
    cancel: "Cancel",
    quota: "{used}/{max} devices used",
    quotaFull: "Limit reached — revoke one device before enabling on a new one",
    loading: "Loading…",
    failed: "Action failed, please retry",
  },
};

function formatDateTime(value) {
  if (!value) return "";
  const normalized = String(value).replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export default function LoginDevicesPage() {
  const navigate = useNavigate();
  const [lang] = useSyncedLoginLang();
  const t = useMemo(() => TEXT[lang] || TEXT.en, [lang]);

  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState([]);
  const [max, setMax] = useState(0);
  const [active, setActive] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [error, setError] = useState("");

  const deviceId = getDeviceId();

  const loadDevices = useCallback(async () => {
    const result = await listDeviceTokens({ deviceId });
    if (!result.ok) {
      setError(result.message || t.failed);
      return;
    }
    setDevices(result.devices);
    setMax(result.max);
    setActive(result.active);
    setError("");
  }, [deviceId, t.failed]);

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
        await loadDevices();
      } catch (err) {
        if (err?.name !== "AbortError") navigate("/login", { replace: true });
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [navigate, loadDevices]);

  const handleRevoke = useCallback(
    async (target) => {
      setBusyId(target.device_id);
      setError("");
      try {
        const result = await revokeDeviceToken({ deviceId: target.device_id });
        if (!result.ok) {
          setError(result.message || t.failed);
          return;
        }
        // 下线的是本机：必须同时清掉 Keystore 里的令牌，
        // 否则下次启动仍会进锁屏，然后必然失败在 TOKEN_REVOKED 上。
        if (target.is_current) {
          await clearToken();
        }
        await loadDevices();
      } finally {
        setBusyId("");
        setConfirmId("");
      }
    },
    [loadDevices, t.failed],
  );

  const companyCode = String(me?.company_code || me?.company_id || "").toUpperCase();
  const groupId = String(me?.login_group_id || me?.login_identifier || "").toUpperCase();

  return (
    <MobileShell
      i18n={{ back: t.cancel, settings: t.title }}
      me={me}
      companyCode={companyCode}
      groupId={groupId}
      onLogout={() => navigate("/login", { replace: true })}
      lang={lang}
      stickyBar={
        <MobileSubpageHeader backTo="/more" backAriaLabel={t.cancel} title={t.title} />
      }
    >
      <main className="m-more-page m-more-page--settings">
        {loading ? (
          <div className="m-more-state">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
          </div>
        ) : (
          <>
            <section className="m-more-settings-group" aria-label={t.title}>
              <div className="m-more-settings-row">
                <span>{t.intro}</span>
              </div>
              <div className="m-more-settings-row">
                <span>{t.quota.replace("{used}", String(active)).replace("{max}", String(max))}</span>
                {max > 0 && active >= max ? <em>{t.quotaFull}</em> : null}
              </div>
            </section>

            {error ? (
              <section className="m-more-settings-group">
                <div className="m-more-settings-row">
                  <span role="alert">{error}</span>
                </div>
              </section>
            ) : null}

            {!isNative() ? (
              <section className="m-more-settings-group">
                <div className="m-more-settings-row">
                  <span>{t.emptyHint}</span>
                </div>
              </section>
            ) : null}

            {devices.length === 0 ? (
              <section className="m-more-settings-group">
                <div className="m-more-settings-row">
                  <span>{t.empty}</span>
                </div>
              </section>
            ) : (
              <section className="m-more-settings-group" aria-label={t.title}>
                {devices.map((device) => {
                  const isRevoked = !!device.revoked_at;
                  const statusLabel = isRevoked ? t.revoked : device.is_active ? "" : t.expired;
                  const lastUsed = device.last_used_at
                    ? `${t.lastUsed} ${formatDateTime(device.last_used_at)}`
                    : t.never;

                  return (
                    <div key={device.device_id} className="m-more-settings-row">
                      <div className="m-more-profile-copy">
                        <strong>
                          {device.device_name || device.device_id.slice(0, 8)}
                          {device.is_current ? <em> · {t.current}</em> : null}
                          {statusLabel ? <em> · {statusLabel}</em> : null}
                        </strong>
                        <span>{lastUsed}</span>
                        <span>
                          {t.expiresAt} {formatDateTime(device.expires_at)}
                        </span>
                      </div>

                      {isRevoked ? null : busyId === device.device_id ? (
                        <i className="fas fa-spinner fa-spin" aria-hidden="true" />
                      ) : confirmId === device.device_id ? (
                        <span>
                          <button
                            type="button"
                            className="m-more-logout tap-scale"
                            onClick={() => void handleRevoke(device)}
                          >
                            {t.confirm}
                          </button>
                          <button
                            type="button"
                            className="m-more-logout tap-scale"
                            onClick={() => setConfirmId("")}
                          >
                            {t.cancel}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="m-more-logout tap-scale"
                          onClick={() => setConfirmId(device.device_id)}
                        >
                          {t.revoke}
                        </button>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
          </>
        )}
      </main>
    </MobileShell>
  );
}
