import { useCallback, useEffect, useMemo, useState } from "react";
import { assetUrl, buildApiUrl } from "../../utils/core/apiUrl.js";
import { injectStylesheet } from "../../utils/core/injectStylesheet.js";
import { MAINTENANCE_I18N } from "../../translateFile/pages/maintenanceTranslate.js";
import { formatMemberRole, getMemberText } from "../../translateFile/pages/memberTranslate.js";
import { ensureMaintenanceDateRangePicker } from "../../utils/date/dateRangePicker.js";
import {
  publishMaintenanceModeEvent,
  subscribeMaintenanceModeEvent,
} from "../../utils/maintenance/maintenanceRealtimeBus.js";
import { useExpirationReminder } from "../../hooks/useExpirationReminder.js";
import { useAnnouncementUnread } from "../../hooks/useAnnouncementUnread.js";
import { clearDashboardFilterSession, clearOwnerCompaniesCache } from "../../utils/company/sharedCompanyFilter.js";
import { spaPath } from "../../utils/routing/pageRoutes.js";

function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

const AVATAR_MAP = {
  male1: assetUrl("images/avatar1.png"),
  male2: assetUrl("images/avatar2.png"),
  male3: assetUrl("images/avatar3.png"),
  male4: assetUrl("images/avatar4.png"),
  male5: assetUrl("images/avatar5.png"),
  male6: assetUrl("images/avatar6.png"),
  male7: assetUrl("images/avatar7.png"),
  male8: assetUrl("images/avatar8.png"),
  male9: assetUrl("images/avatar9.png"),
  female1: assetUrl("images/female1.png"),
  female2: assetUrl("images/female2.png"),
  female3: assetUrl("images/female3.png"),
  female4: assetUrl("images/female4.png"),
  female5: assetUrl("images/female5.png"),
  female6: assetUrl("images/female6.png"),
  female7: assetUrl("images/female7.png"),
  female8: assetUrl("images/female8.png"),
  female9: assetUrl("images/female9.png"),
};

/**
 * Member page shell: session bootstrap, sidebar avatar, announcements, logout, toasts.
 */
export function useMemberPageShell({ navigate, initSession, todayDmy, lang }) {
  const t = useCallback((key, params) => getMemberText(lang, key, params), [lang]);

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [companies, setCompanies] = useState([]);

  const initialAvatarId = readCookie("selectedAvatar") || "male1";
  const [selectedAvatarId, setSelectedAvatarId] = useState(initialAvatarId);
  const [selectedGender, setSelectedGender] = useState(
    initialAvatarId.startsWith("female") ? "female" : "male",
  );
  const [showAvatarOptions, setShowAvatarOptions] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [announcements, setAnnouncements] = useState([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const avatarSrc = useMemo(() => AVATAR_MAP[selectedAvatarId] || AVATAR_MAP.male1, [selectedAvatarId]);

  const showNotification = useCallback((message, type = "info") => {
    if (!message) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setNotifications((prev) => {
      const next = [...prev, { id, message, type }];
      return next.slice(-2);
    });
    window.setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 2500);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("lang-zh", lang === "zh");
    document.body.classList.toggle("lang-en", lang !== "zh");
    return () => {
      document.body.classList.remove("lang-zh", "lang-en");
    };
  }, [lang]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch(buildApiUrl("api/session/current_user_api.php"), { credentials: "include" });
        const meJson = await meRes.json();
        if (!meRes.ok || !meJson.success || !meJson.data) {
          navigate(spaPath("login"), { replace: true });
          return;
        }
        const u = meJson.data;
        if (String(u.user_type || "").toLowerCase() !== "member") {
          navigate(spaPath("dashboard"), { replace: true });
          return;
        }
        const loginId = Number(u.member_login_account_id || u.user_id) || 0;
        const cRes = await fetch(
          buildApiUrl(`api/accounts/account_company_api.php?action=get_account_companies&account_id=${loginId}`),
          { credentials: "include" },
        );
        const cJson = await cRes.json();
        if (!cancelled) {
          setMe(u);
          setCompanies(Array.isArray(cJson?.data) ? cJson.data : []);
          initSession(u, u.company_id, todayDmy, todayDmy);
        }
      } catch {
        if (!cancelled) navigate(spaPath("login"), { replace: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, todayDmy, initSession]);

  const refreshSession = useCallback(async () => {
    try {
      const meRes = await fetch(buildApiUrl("api/session/current_user_api.php"), { credentials: "include" });
      const meJson = await meRes.json();
      if (meRes.ok && meJson.success && meJson.data) {
        setMe(meJson.data);
        return meJson.data;
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  useEffect(() => {
    if (loading || !me) return undefined;
    let stopped = false;
    let inFlight = false;
    /** Maintenance probe — keep light; cross-tab bus already broadcasts enable events. */
    const POLL_MS = 30000;

    const tick = async () => {
      if (stopped || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const res = await fetch(buildApiUrl("api/session/current_user_api.php"), {
          credentials: "include",
          cache: "no-store",
        });
        let json = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        if (!res.ok && !stopped && (json?.maintenance_mode === true || json?.data?.maintenance_mode === true)) {
          if (typeof json?.message === "string" && json.message.trim() !== "") {
            sessionStorage.setItem("ec_maintenance_notice", json.message.trim());
          }
          // Tell sibling tabs in the same browser profile to logout immediately.
          publishMaintenanceModeEvent({
            enabled: true,
            message: typeof json?.message === "string" ? json.message : "",
          });
          clearDashboardFilterSession();
          clearOwnerCompaniesCache();
          window.location.assign(new URL(spaPath("login"), window.location.origin).href);
        }
      } catch {
        // silent: next tick retries
      } finally {
        inFlight = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };

    // Session was just loaded — do not fire an immediate duplicate request.
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loading, me]);

  useEffect(() => {
    if (loading || !me) return undefined;
    return subscribeMaintenanceModeEvent((event) => {
      if (!event?.enabled) return;
      if (typeof event.message === "string" && event.message.trim() !== "") {
        sessionStorage.setItem("ec_maintenance_notice", event.message.trim());
      }
      clearDashboardFilterSession();
      clearOwnerCompaniesCache();
      window.location.assign(new URL(spaPath("login"), window.location.origin).href);
    });
  }, [loading, me]);

  useEffect(() => {
    const onCompanySession = () => {
      void refreshSession();
    };
    window.addEventListener("eazycount:company-session-updated", onCompanySession);
    return () => window.removeEventListener("eazycount:company-session-updated", onCompanySession);
  }, [refreshSession]);

  useEffect(() => {
    injectStylesheet("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css").catch(() => {});
  }, []);

  useEffect(() => {
    if (loading || !me) return;
    ensureMaintenanceDateRangePicker();
    const maintenance = MAINTENANCE_I18N[lang] || MAINTENANCE_I18N.en;
    window.MaintenanceDateRangePicker?.setLocaleStrings?.({
      placeholder: t("selectDateRange"),
      selectEndDateHint: t("selectEndDate"),
      monthLabels: maintenance.monthsShort,
    });
  }, [loading, me, lang, t]);

  const handleSelectAvatar = useCallback((avatarId) => {
    setSelectedAvatarId(avatarId);
    setShowAvatarOptions(false);
    document.cookie = `selectedAvatar=${encodeURIComponent(avatarId)}; path=/; max-age=31536000; SameSite=Lax`;
    try {
      localStorage.setItem("selectedAvatar", avatarId);
    } catch {
      // ignore
    }
  }, []);

  const roleLabel = useMemo(() => formatMemberRole(lang, me?.role), [lang, me?.role]);

  const expirationReminder = useExpirationReminder(me, lang);
  /** 会员自助壳没挂 AppRealtimeBridge，用轮询兜底（页面隐藏时 hook 内部跳过）。 */
  const { unreadCount: announcementUnreadCount, markRead: markAnnouncementsRead } =
    useAnnouncementUnread(me, 60000);
  const displayAnnouncements = useMemo(
    () => expirationReminder.mergeAnnouncements(announcements),
    [announcements, expirationReminder.mergeAnnouncements],
  );

  const toggleNotificationsWithExpiration = useCallback(async () => {
    if (showNotifications) {
      setShowNotifications(false);
      return;
    }
    expirationReminder.onBellOpen();
    setShowNotifications(true);
    setAnnouncementsLoading(true);
    // 徽标清空写在后端（按账号），不依赖列表返回。
    markAnnouncementsRead();
    try {
      const res = await fetch(buildApiUrl("api/announcements/announcement_get_dashboard_api.php"), {
        credentials: "include",
      });
      const json = await res.json();
      setAnnouncements(json?.success && Array.isArray(json?.data) ? json.data : []);
    } catch {
      setAnnouncements([]);
    } finally {
      setAnnouncementsLoading(false);
    }
  }, [showNotifications, expirationReminder.onBellOpen, markAnnouncementsRead]);

  const performLogout = useCallback(async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    try {
      sessionStorage.setItem("ec_skip_session_bootstrap", "1");
      await fetch(buildApiUrl("api/session/logout_api.php"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
    } finally {
      clearDashboardFilterSession();
      clearOwnerCompaniesCache();
      setLogoutLoading(false);
      setShowLogoutConfirm(false);
      window.location.assign(new URL(spaPath("login"), window.location.origin).href);
    }
  }, [logoutLoading]);

  const logoutI18n = useMemo(
    () => ({
      confirmLogoutTitle: t("confirmLogoutTitle"),
      confirmLogoutMessage: t("confirmLogoutMessage"),
      cancel: t("cancel"),
      logout: t("logout"),
      loggingOut: t("loggingOut"),
    }),
    [t],
  );

  return {
    loading,
    me,
    companies,
    roleLabel,
    avatarSrc,
    selectedAvatarId,
    selectedGender,
    setSelectedGender,
    showAvatarOptions,
    setShowAvatarOptions,
    handleSelectAvatar,
    notifications,
    showNotification,
    showNotifications,
    toggleNotifications: toggleNotificationsWithExpiration,
    announcements: displayAnnouncements,
    announcementsLoading,
    announcementUnreadCount,
    showLogoutConfirm,
    setShowLogoutConfirm,
    logoutLoading,
    performLogout,
    logoutI18n,
    expirationReminder,
  };
}
