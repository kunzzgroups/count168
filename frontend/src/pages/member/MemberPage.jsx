import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { assetUrl } from "../../utils/core/apiUrl.js";
import { applyLoginLang, useLoginLang } from "../../utils/i18n/useLoginLang.js";
import { MAINTENANCE_I18N } from "../../translateFile/pages/maintenanceTranslate.js";
import { TRANSACTION_I18N } from "../../translateFile/pages/transactionTranslate.js";
import { formatMemberRowDescription, getMemberText } from "../../translateFile/pages/memberTranslate.js";
import SidebarLangSwitch from "../../components/SidebarLangSwitch.jsx";
import SidebarMenuTooltip from "../../components/SidebarMenuTooltip.jsx";
import ReportDatePicker from "../report/common/ReportDatePicker.jsx";
import PaymentHistoryExportPdfModal from "../transaction/components/PaymentHistoryExportPdfModal.jsx";
import {
  buildMaintenancePeriodPresets,
  formatDmyFromDate,
  formatDmyFromYmd,
  parseDmy,
} from "../maintenance/shared/maintenanceDateHelpers.js";
import "../../../public/css/member.css";
import "../../../public/css/sidebar.css";
import "../../../public/css/userlist.css";
import "../../../public/css/date-range-picker.css";
import "../../../public/css/report-outlined-fields.css";
import "../../../public/css/member-transaction.css";
import AvatarPickerModal from "../../components/AvatarPickerModal.jsx";
import ConfirmLogoutModal from "../../components/ConfirmLogoutModal.jsx";
import ExpirationReminderModal from "../../components/ExpirationReminderModal.jsx";
import SidebarExpirationCountdown from "../../components/SidebarExpirationCountdown.jsx";
import MemberMiniGrid from "./components/MemberMiniGrid.jsx";
import MemberMoneyCell from "./components/MemberMoneyCell.jsx";
import MemberGridAccountPills from "./components/MemberGridAccountPills.jsx";
import {
  computeTableTotals,
  splitWinLossAccountBands,
  WINLOSS_ACCOUNT_SEGMENT_MAX_BUTTONS_NARROW,
  WINLOSS_ACCOUNT_SEGMENT_NARROW_MQ,
} from "./memberPageHelpers.js";
import { useMemberWinLoss } from "./useMemberWinLoss.js";
import { useMemberPageShell } from "./useMemberPageShell.js";
import { useSidebarTabletCollapse } from "../../hooks/useSidebarTabletCollapse.js";
import { DASHBOARD_I18N } from "../../translateFile/shell/dashboardTranslate.js";
import { bindMediaQueryChange } from "../../utils/dom/bindMediaQueryChange.js";
import AnnouncementUpdateCard from "../../components/announcements/AnnouncementUpdateCard.jsx";

export default function MemberPage() {
  const navigate = useNavigate();
  const lang = useLoginLang();
  const t = useCallback((key, params) => getMemberText(lang, key, params), [lang]);
  const maintenanceLocale = useMemo(() => MAINTENANCE_I18N[lang] || MAINTENANCE_I18N.en, [lang]);
  const shellI18n = useMemo(() => DASHBOARD_I18N[lang] || DASHBOARD_I18N.en, [lang]);
  const {
    isTabletViewport,
    sidebarIconOnly,
    sidebarTabletExpanded,
    collapseSidebar,
    onHamburgerClick,
  } = useSidebarTabletCollapse();

  const wlFiltersColRef = useRef(null);
  const wlMatrixColRef = useRef(null);
  const accountButtonsRef = useRef(null);
  const accountMeasureRef = useRef(null);
  const currencyButtonsRef = useRef(null);
  const currencyMeasureRef = useRef(null);
  const [wlFiltersSyncPx, setWlFiltersSyncPx] = useState(null);
  const [accountNarrowViewport, setAccountNarrowViewport] = useState(false);
  const [accountLayout, setAccountLayout] = useState({ containerWidth: 0, segmentWidths: [] });
  const [currencyLayout, setCurrencyLayout] = useState({ containerWidth: 0, segmentWidths: [] });
  const [notifications, setNotifications] = useState([]);
  const [exportPdfOpen, setExportPdfOpen] = useState(false);
  const onOpenExportPdf = useCallback(() => setExportPdfOpen(true), []);
  const onCloseExportPdf = useCallback(() => setExportPdfOpen(false), []);

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

  const {
    viewAccountId,
    companyId,
    groupId,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    linkedAccounts,
    wlGridSelectedIds,
    linkedAccountCurrenciesMap,
    linkedCurrenciesLoaded,
    isAllSelected,
    selectedCurrencies,
    availableCurrencies,
    miniGridDisplayCurrencies,
    miniGridShell,
    miniGridLoading,
    miniGridBalances,
    miniGridTotals,
    miniGridHint,
    miniGridAccounts,
    miniGridHasSelection,
    showMiniRail,
    groupedRows,
    loadingTable,
    initSession,
    switchCompany,
    switchAccount,
    persistCurrencyOrder,
    applyWlGridSelection,
    onCurrencyAll,
    onCurrencyToggle,
    formatPaymentHistoryMoney,
  } = useMemberWinLoss({ showNotification, lang });

  const todayDmy = formatDmyFromDate(new Date());

  const {
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
    showNotifications,
    toggleNotifications,
    announcements,
    announcementsLoading,
    announcementUnreadCount,
    showLogoutConfirm,
    setShowLogoutConfirm,
    logoutLoading,
    performLogout,
    logoutI18n,
    expirationReminder,
  } = useMemberPageShell({
    navigate,
    initSession,
    todayDmy,
    lang,
  });

  useEffect(() => {
    const mq = window.matchMedia(WINLOSS_ACCOUNT_SEGMENT_NARROW_MQ);
    const update = () => setAccountNarrowViewport(mq.matches);
    update();
    return bindMediaQueryChange(mq, update);
  }, []);

  const accountFilterBands = useMemo(
    () =>
      splitWinLossAccountBands(
        linkedAccounts,
        accountLayout.segmentWidths,
        accountLayout.containerWidth,
      ),
    [linkedAccounts, accountLayout.containerWidth, accountLayout.segmentWidths],
  );

  useLayoutEffect(() => {
    const container = accountButtonsRef.current;
    const measure = accountMeasureRef.current;
    if (!container || !measure) return undefined;

    const update = () => {
      const containerWidth = Math.max(container.clientWidth, 0);
      const buttons = measure.querySelectorAll("button.user-gc-segment");
      const segmentWidths = Array.from(buttons).map((btn) => btn.offsetWidth);
      setAccountLayout((prev) => {
        if (
          prev.containerWidth === containerWidth
          && prev.segmentWidths.length === segmentWidths.length
          && prev.segmentWidths.every((w, i) => w === segmentWidths[i])
        ) {
          return prev;
        }
        return { containerWidth, segmentWidths };
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [linkedAccounts, viewAccountId, accountNarrowViewport, lang]);

  const currencyCells = useMemo(() => {
    const codes = Array.isArray(availableCurrencies) ? availableCurrencies : [];
    const showAllBtn = codes.length === 0 || codes.length > 1;

    const cells = [];
    if (showAllBtn) cells.push({ type: "all" });
    codes.forEach((c) => cells.push({ type: "code", code: c }));
    return cells;
  }, [availableCurrencies]);

  const currencyFilterBands = useMemo(
    () =>
      splitWinLossAccountBands(
        currencyCells,
        currencyLayout.segmentWidths,
        currencyLayout.containerWidth,
      ),
    [currencyCells, currencyLayout.containerWidth, currencyLayout.segmentWidths],
  );

  useLayoutEffect(() => {
    const container = currencyButtonsRef.current;
    const measure = currencyMeasureRef.current;
    if (!container || !measure) return undefined;

    const update = () => {
      const containerWidth = Math.max(container.clientWidth, 0);
      const buttons = measure.querySelectorAll("button.user-gc-segment");
      const segmentWidths = Array.from(buttons).map((btn) => btn.offsetWidth);
      setCurrencyLayout((prev) => {
        if (
          prev.containerWidth === containerWidth
          && prev.segmentWidths.length === segmentWidths.length
          && prev.segmentWidths.every((w, i) => w === segmentWidths[i])
        ) {
          return prev;
        }
        return { containerWidth, segmentWidths };
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [currencyCells, selectedCurrencies, isAllSelected, lang, accountNarrowViewport]);

  const handleWinLossCurrencyCodeDrop = useCallback(
    (e) => {
      e.preventDefault();
      const dragged = e.dataTransfer.getData("text/plain");
      const code = e.currentTarget?.dataset?.currency;
      if (!dragged || !code || dragged === code) return;
      const from = availableCurrencies.indexOf(dragged);
      const to = availableCurrencies.indexOf(code);
      if (from < 0 || to < 0) return;
      const next = [...availableCurrencies];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      persistCurrencyOrder(next);
    },
    [availableCurrencies, persistCurrencyOrder],
  );

  const periodPresets = useMemo(() => buildMaintenancePeriodPresets(maintenanceLocale), [maintenanceLocale]);

  const exportMessages = useMemo(() => {
    const base = TRANSACTION_I18N[lang] || TRANSACTION_I18N.en;
    return {
      ...base,
      exportPdf: t("exportPdf"),
      exportPdfTitle: t("exportPdfTitle"),
      exportPdfTitleWithAccount: t("exportPdfTitleWithAccount"),
      exportPdfHint: t("exportPdfHint"),
      exportPdfCurrency: t("exportPdfCurrency"),
      exportPdfDateRange: t("exportPdfDateRange"),
      exportPdfSelectDateRange: t("exportPdfSelectDateRange"),
      exportPdfSelectEndDate: t("exportPdfSelectEndDate"),
      exportPdfPeriod: t("exportPdfPeriod"),
      exportPdfCancel: t("exportPdfCancel"),
      exportPdfExporting: t("exportPdfExporting"),
      exportPdfFailed: t("exportPdfFailed"),
      exportPdfPopupBlocked: t("exportPdfPopupBlocked"),
      exportPdfLoadCurrenciesFailed: t("exportPdfLoadCurrenciesFailed"),
      exportPdfNoCurrencies: t("exportPdfNoCurrencies"),
      exportPdfMissingAccount: t("exportPdfMissingAccount"),
      pleaseSelectDateRange: t("pleaseSelectDateRange"),
      pleaseSelectCurrency: t("pleaseSelectCurrency"),
      all: t("all"),
      close: t("close"),
      loading: t("loading"),
    };
  }, [lang, t]);

  const exportScope = useMemo(() => {
    const acc = linkedAccounts.find((row) => Number(row.id) === Number(viewAccountId));
    const currencyPref = isAllSelected
      ? availableCurrencies.join(",")
      : selectedCurrencies.join(",");
    return {
      accountDbId: viewAccountId,
      companyId,
      groupId,
      dateFrom,
      dateTo,
      currency: currencyPref,
      accountCode: String(acc?.account_id || "").trim(),
      accountName: String(acc?.name || acc?.account_name || "").trim(),
    };
  }, [
    linkedAccounts,
    viewAccountId,
    companyId,
    groupId,
    dateFrom,
    dateTo,
    isAllSelected,
    selectedCurrencies,
    availableCurrencies,
  ]);

  const exportAccountTitle = useMemo(() => {
    const code = exportScope.accountCode;
    const name = exportScope.accountName;
    if (code && name && name !== code) return `${code} (${name})`;
    return code || name || "";
  }, [exportScope.accountCode, exportScope.accountName]);

  const handleDateRangeChange = useCallback(
    (start, end) => {
      setDateFrom(formatDmyFromYmd(start));
      setDateTo(formatDmyFromYmd(end));
    },
    [setDateFrom, setDateTo],
  );

  useLayoutEffect(() => {
    document.body.classList.remove("bg");
    document.body.classList.add(
      "dashboard-page",
      "transaction-page",
      "member-winloss-page",
      "ec-auth-shell",
    );
    return () => {
      document.body.classList.remove(
        "dashboard-page",
        "transaction-page",
        "member-winloss-page",
        "ec-auth-shell",
      );
    };
  }, []);

  useLayoutEffect(() => {
    if (!showMiniRail) {
      setWlFiltersSyncPx(null);
      return undefined;
    }
    const filtersEl = wlFiltersColRef.current;
    const matrixEl = wlMatrixColRef.current;
    const mq = window.matchMedia("(min-width: 1025px)");
    const update = () => {
      if (!showMiniRail || !mq.matches || !wlFiltersColRef.current) {
        setWlFiltersSyncPx(null);
        return;
      }
      const filtersH = wlFiltersColRef.current.scrollHeight;
      const matrixH = wlMatrixColRef.current?.scrollHeight ?? 0;
      setWlFiltersSyncPx(Math.ceil(Math.max(filtersH, matrixH)));
    };
    update();
    const ro = new ResizeObserver(() => update());
    if (filtersEl) ro.observe(filtersEl);
    if (matrixEl) ro.observe(matrixEl);
    const unbindMediaQuery = bindMediaQueryChange(mq, update);
    window.addEventListener("resize", update);
    return () => {
      unbindMediaQuery();
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [
    showMiniRail,
    lang,
    companies,
    linkedAccounts,
    availableCurrencies,
    currencyFilterBands,
    dateFrom,
    dateTo,
    companyId,
    viewAccountId,
    miniGridDisplayCurrencies.length,
    selectedCurrencies.length,
    miniGridAccounts.length,
    wlGridSelectedIds.length,
    miniGridLoading,
  ]);

  if (loading || !me) return null;

  return (
    <>
      <div
        className={`informationmenu-overlay sidebar-dismiss-overlay${sidebarTabletExpanded ? " show" : ""}`}
        onClick={collapseSidebar}
        aria-hidden={!sidebarTabletExpanded}
      />
      <div className={`informationmenu${sidebarIconOnly ? " is-collapsed" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="informationmenu-header">
          <div className="header-logo-section">
            {isTabletViewport && sidebarIconOnly && (
              <SidebarMenuTooltip label={shellI18n.sidebarExpand} enabled={sidebarIconOnly}>
                <button
                  type="button"
                  className="sidebar-hamburger-toggle"
                  onClick={onHamburgerClick}
                  aria-label={shellI18n.sidebarExpand}
                  aria-expanded={false}
                >
                  <span className="sidebar-hamburger-box" aria-hidden="true">
                    <span className="sidebar-hamburger-line" />
                    <span className="sidebar-hamburger-line" />
                    <span className="sidebar-hamburger-line" />
                  </span>
                </button>
              </SidebarMenuTooltip>
            )}
            <img src={assetUrl("images/count_whitelogo.png")} alt="EAZYCOUNT Logo" className="header-logo" />
            <div className={`notification-bell${expirationReminder.hasBellBadge || announcementUnreadCount > 0 ? " has-unread" : ""}`} title={t("notifications")} onClick={toggleNotifications}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2C10.34 2 9 3.34 9 5V5.29C6.72 6.15 5.12 8.39 5.01 11L5 11V16L3 18V19H21V18L19 16V11C18.88 8.39 17.28 6.15 15 5.29V5C15 3.34 13.66 2 12 2ZM12 22C10.9 22 10 21.1 10 20H14C14 21.1 13.1 22 12 22Z" />
              </svg>
            </div>
          </div>
          <div className="user-info-container">
            <div className="avatar-selector-container">
              <button
                type="button"
                className="current-avatar"
                aria-label={t("chooseAvatar")}
                onClick={() => setShowAvatarOptions(true)}
              >
                <img id="currentAvatarImg" className="current-avatar-img" src={avatarSrc} alt="Avatar" />
              </button>
            </div>
            <div className="user-avatar-dropdown">
              <div className="user-info">
                <div className="user-name" title={me.login_id || undefined}>
                  {me.login_id || "-"}
                </div>
                <div className="user-role" title={roleLabel || undefined}>
                  {roleLabel}
                </div>
              </div>
            </div>
          </div>
          <SidebarLangSwitch lang={lang} onLanguageChange={applyLoginLang} ariaLabel={t("switchLanguage")} />
        </div>
        <div className="informationmenu-content">
          <div className="content-separator" />
          <div className="informationmenu-section">
            <SidebarMenuTooltip label={t("winLoss")} enabled={sidebarIconOnly}>
              <div className="informationmenu-section-title current-page">
                <svg className="section-icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z" />
                </svg>
                <span className="sidebar-menu-label">{t("winLoss")}</span>
              </div>
            </SidebarMenuTooltip>
          </div>
        </div>
        <div className="informationmenu-footer">
          <SidebarExpirationCountdown
            status={me?.expiration_status || "normal"}
            label={t("exp")}
            hint={me?.expiration_hint || "-"}
          />
          <button className="btn logout-btn" onClick={() => setShowLogoutConfirm(true)} type="button">
            {sidebarIconOnly ? (
              <svg className="logout-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="16 17 21 12 16 7" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="21" y1="12" x2="9" y2="12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              t("logout")
            )}
          </button>
        </div>
      </div>

      <div className="transaction-container">
        <div className="transaction-main-content member-winloss-dash">
          <div className="transaction-search-section member-dash-unified-bar">
            <div
              className={`member-dash-columns${showMiniRail ? " member-dash-columns--two-col" : " member-dash-columns--no-mini-rail"}${wlFiltersSyncPx != null ? " member-dash-columns--wl-sync-h" : ""}${miniGridLoading ? " member-dash-columns--grid-loading" : ""}`}
              style={wlFiltersSyncPx != null ? { ["--member-winloss-filters-h"]: `${wlFiltersSyncPx}px` } : undefined}
            >
              <div className="member-dash-col member-dash-col-filters" ref={wlFiltersColRef}>
            <div className="member-winloss-date-export-row">
              <div className="member-winloss-date-field">
                <ReportDatePicker
                  dateFrom={parseDmy(dateFrom || todayDmy)}
                  dateTo={parseDmy(dateTo || todayDmy)}
                  onRangeChange={handleDateRangeChange}
                  containerClass="customer-report-filter-group"
                  label={t("dateRange")}
                  placeholder={t("selectDateRange")}
                  selectEndDateHint={t("selectEndDate")}
                  outlinedFloatingLabel
                  captureDateStyle
                  periodPresets={periodPresets}
                  periodShortcutsAria={t("period")}
                  monthLabels={maintenanceLocale.monthsShort}
                  weekdaysShort={maintenanceLocale.weekdaysShort}
                />
              </div>
              <button
                type="button"
                className="member-winloss-export-pdf-btn"
                aria-label={t("exportPdf")}
                title={t("exportPdf")}
                disabled={!viewAccountId || (!companyId && !groupId)}
                onClick={onOpenExportPdf}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M7 3h8l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinejoin="round"
                  />
                  <path d="M15 3v5h5" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
                  <path d="M9 12h6M9 16h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="user-gc-inline-panel member-winloss-gc-panel" id="member_gc_filter_panel">
              {companies.length > 1 && (
                <div className="user-gc-inline-row" id="member_company_filter">
                  <span className="user-gc-inline-label">{t("company")}</span>
                  <div className="user-gc-inline-pills user-gc-inline-pills--segment-scroll" id="member_company_buttons">
                    <div className="user-gc-segment-group" role="group" aria-label={t("ariaCompany")}>
                      {companies.map((company) => (
                        <button
                          key={company.id}
                          type="button"
                          className={`user-gc-segment${Number(company.company_id) === Number(companyId) ? " is-on" : ""}`}
                          onClick={() => switchCompany(company.company_id, company.company_code)}
                        >
                          {String(company.company_code || "").toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {linkedAccounts.length > 1 && (
                <div className="user-gc-inline-row" id="member_account_filter">
                  <span className="user-gc-inline-label">{t("account")}</span>
                  <div
                    className="user-gc-inline-pills member-winloss-account-pills"
                    id="member_account_buttons"
                    ref={accountButtonsRef}
                    role="group"
                    aria-label={t("ariaAccount")}
                  >
                    <div
                      ref={accountMeasureRef}
                      className="member-winloss-account-measure"
                      aria-hidden="true"
                    >
                      {linkedAccounts.map((acc) => {
                        const accountLabel = String(acc.account_id || acc.name || acc.id);
                        const isOn = Number(acc.id) === Number(viewAccountId);
                        return (
                          <button
                            key={`measure-${acc.id}`}
                            type="button"
                            tabIndex={-1}
                            className={`user-gc-segment${isOn ? " is-on" : ""}`}
                          >
                            <span className="member-winloss-account-pill-label">{accountLabel}</span>
                          </button>
                        );
                      })}
                    </div>
                    {accountFilterBands.map((band, segIdx) => (
                      <div
                        key={`member-acc-band-${segIdx}`}
                        className="user-gc-segment-group member-winloss-account-segments"
                        style={{
                          width: "fit-content",
                          maxWidth: "100%",
                        }}
                      >
                        {band.map((acc) => {
                          const accountLabel = String(acc.account_id || acc.name || acc.id);
                          return (
                            <button
                              key={acc.id}
                              type="button"
                              className={`user-gc-segment${Number(acc.id) === Number(viewAccountId) ? " is-on" : ""}`}
                              onClick={() => switchAccount(acc.id, acc.account_id, acc.name)}
                            >
                              <span className="member-winloss-account-pill-label">{accountLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="user-gc-inline-row" id="member_currency_filter">
                <span className="user-gc-inline-label">{t("currency")}</span>
                <div
                  className="user-gc-inline-pills member-winloss-currency-pills"
                  id="member_currency_buttons"
                  ref={currencyButtonsRef}
                  role="group"
                  aria-label={t("ariaCurrency")}
                >
                  <div
                    ref={currencyMeasureRef}
                    className="member-winloss-currency-measure"
                    aria-hidden="true"
                  >
                    {currencyCells.map((cell) =>
                      cell.type === "all" ? (
                        <button key="member-ccy-measure-all" type="button" tabIndex={-1} className="user-gc-segment">
                          {t("all")}
                        </button>
                      ) : (
                        <button
                          key={`member-ccy-measure-${cell.code}`}
                          type="button"
                          tabIndex={-1}
                          className="user-gc-segment"
                        >
                          {cell.code}
                        </button>
                      ),
                    )}
                  </div>
                  {currencyFilterBands.map((band, segIdx) => (
                    <div
                      key={`member-ccy-band-${segIdx}`}
                      className="user-gc-segment-group member-winloss-currency-segments"
                      style={{
                        width: "fit-content",
                        maxWidth: "100%",
                      }}
                    >
                      {band.map((cell) =>
                        cell.type === "all" ? (
                          <button
                            key="member-ccy-all"
                            type="button"
                            className={`user-gc-segment${isAllSelected ? " is-on" : ""}`}
                            onClick={onCurrencyAll}
                          >
                            {t("all")}
                          </button>
                        ) : (
                          <button
                            key={cell.code}
                            type="button"
                            draggable
                            data-currency={cell.code}
                            className={`user-gc-segment user-gc-segment--draggable-pill${!isAllSelected && selectedCurrencies.includes(cell.code) ? " is-on" : ""}`}
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", cell.code);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={handleWinLossCurrencyCodeDrop}
                            onClick={() => onCurrencyToggle(cell.code)}
                          >
                            {cell.code}
                          </button>
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
              </div>
              {showMiniRail && (
                <>
                  <div
                    className={`member-dash-col member-dash-col-matrix${miniGridHasSelection || miniGridLoading || miniGridShell ? "" : " member-dash-col-matrix--empty"}`}
                    ref={wlMatrixColRef}
                    aria-hidden="false"
                  >
                    {linkedAccounts.length > 0 && (
                      <div className="member-dash-rail-toolbar member-dash-matrix-toolbar">
                        <MemberGridAccountPills
                          linkedAccounts={linkedAccounts}
                          selectedIds={wlGridSelectedIds}
                          onApply={applyWlGridSelection}
                          t={t}
                        />
                      </div>
                    )}
                    {(miniGridHasSelection || miniGridLoading || miniGridShell) && (
                    <div className="member-dash-matrix-center-wrap">
                      <div className="member-dash-rail-matrix">
                        {miniGridLoading ? (
                          <p className="member-dash-matrix-loading" role="status">
                            {t("loading")}
                          </p>
                        ) : (
                          <MemberMiniGrid
                            shellMode={miniGridShell}
                            currencies={miniGridDisplayCurrencies}
                            accounts={miniGridAccounts}
                            balanceMap={miniGridBalances}
                            totalsByCu={miniGridTotals}
                            hint={miniGridHint}
                            linkedCurrenciesLoaded={linkedCurrenciesLoaded}
                            linkedAccountCurrenciesMap={linkedAccountCurrenciesMap}
                            t={t}
                          />
                        )}
                      </div>
                    </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        <div className="member-currency-section" id="member_currency_tables_section" style={{ display: "flex", visibility: "visible" }}>
          <div id="member_currency_tables" className="member-currency-tables">
            {loadingTable ? (
              <p className="member-currency-empty" style={{ margin: 0 }}>{t("loading")}</p>
            ) : groupedRows.length === 0 ? (
              <p className="member-currency-empty" style={{ margin: 0 }}>{t("noDataInRange")}</p>
            ) : (
              groupedRows.map(([currency, rows]) => {
                const { totalWinLoss, totalCrDr, closingBalance } = computeTableTotals(rows);
                return (
                  <div className="member-currency-table-wrapper" key={currency}>
                    <h3 className="member-currency-table-title">{t("currencyTitle", { currency })}</h3>
                    <table className="transaction-table member-winloss-table member-winloss-table--by-currency">
                      <colgroup>
                        <col className="transaction-history-col-date" />
                        <col className="transaction-history-col-product" />
                        <col className="transaction-history-col-rate" />
                        <col className="transaction-history-col-winloss" />
                        <col className="transaction-history-col-crdr" />
                        <col className="transaction-history-col-balance" />
                        <col className="transaction-history-col-description" />
                        <col className="transaction-history-col-remark" />
                      </colgroup>
                      <thead>
                        <tr className="transaction-table-header">
                          <th className="transaction-history-col-date">{t("colDate")}</th>
                          <th className="transaction-history-col-product">{t("colIdProduct")}</th>
                          <th className="transaction-history-col-rate">{t("colRate")}</th>
                          <th className="transaction-history-col-winloss">{t("colWinLoss")}</th>
                          <th className="transaction-history-col-crdr">{t("colCrDr")}</th>
                          <th className="transaction-history-col-balance">{t("colBalance")}</th>
                          <th className="transaction-history-col-description">{t("colDescription")}</th>
                          <th className="transaction-history-col-remark">{t("colRemark")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr className="transaction-table-row"><td colSpan={8} style={{ textAlign: "center" }}>{t("noData")}</td></tr>
                        ) : (
                          rows.map((row, idx) => (
                            <tr className={`transaction-table-row ${row.row_type === "bf" ? "member-bf-row" : ""}`} key={`${currency}-${idx}`}>
                              <td className="transaction-history-col-date">{row.date || "-"}</td>
                              <td className="transaction-history-col-product">{row.is_bank_process_transaction ? row.card_owner || "-" : row.product || "-"}</td>
                              <td className="transaction-history-col-rate">{row.rate || "-"}</td>
                              <td className="transaction-history-col-winloss">
                                <MemberMoneyCell value={row.win_loss} formatMoney={formatPaymentHistoryMoney} />
                              </td>
                              <td className="transaction-history-col-crdr">
                                <MemberMoneyCell value={row.cr_dr} formatMoney={formatPaymentHistoryMoney} />
                              </td>
                              <td className="transaction-history-col-balance">
                                <MemberMoneyCell value={row.balance} formatMoney={formatPaymentHistoryMoney} />
                              </td>
                              <td className="transaction-history-col-description text-uppercase">{formatMemberRowDescription(lang, row)}</td>
                              <td className="transaction-history-col-remark text-uppercase">{String(row.remark || row.sms || "-").toUpperCase()}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="transaction-table-row transaction-summary-total transaction-summary-total">
                          <td className="transaction-summary-total-label" colSpan={3}>
                            {t("totalRow", { currency })}
                          </td>
                          <td className="transaction-history-col-winloss">
                            <MemberMoneyCell value={totalWinLoss.toString()} formatMoney={formatPaymentHistoryMoney} />
                          </td>
                          <td className="transaction-history-col-crdr">
                            <MemberMoneyCell value={totalCrDr.toString()} formatMoney={formatPaymentHistoryMoney} />
                          </td>
                          <td className="transaction-history-col-balance">
                            <MemberMoneyCell value={closingBalance.toString()} formatMoney={formatPaymentHistoryMoney} />
                          </td>
                          <td className="transaction-history-col-description" colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div id="notificationContainer" className="transaction-notification-container">
          {notifications.map((note) => (
            <div
              key={note.id}
              className={`transaction-notification ${
                note.type === "error"
                  ? "transaction-notification-error"
                  : note.type === "warning"
                    ? "transaction-notification-warning"
                    : "transaction-notification-success"
              } show`}
            >
              {note.message}
            </div>
          ))}
        </div>
      </div>
      </div>

      <div className={`notification-overlay ${showNotifications ? "show" : ""}`} onClick={toggleNotifications} />
      <div className={`notification-panel ${showNotifications ? "show" : ""}`}>
        <div className="notification-header">
          <h2>{t("announcements")}</h2>
          <button className="notification-close" onClick={toggleNotifications} title={t("close")} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="notification-content">
          {announcementsLoading ? (
            <div className="notification-empty"><p>{t("loadingAnnouncements")}</p></div>
          ) : announcements.length > 0 ? (
            announcements.map((a, idx) => (
              <AnnouncementUpdateCard
                key={a.id ?? `${a.title || "announcement"}-${idx}`}
                announcement={a}
                labels={{
                  updateIncludes: t("updateIncludes"),
                  versionUpdated: t("versionUpdated"),
                  teamName: t("announcementTeam"),
                }}
                className={`notification-item unread${a.isExpirationReminder ? " expiration-reminder-item" : ""}`}
              />
            ))
          ) : (
            <div className="notification-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
              </svg>
              <p>{t("noAnnouncements")}</p>
            </div>
          )}
        </div>
      </div>

      <ExpirationReminderModal
        open={expirationReminder.showModal}
        title={expirationReminder.modalTitle}
        message={expirationReminder.modalMessage}
        confirmLabel={expirationReminder.modalI18n.confirm}
        onConfirm={expirationReminder.dismissModal}
        urgencyTier={expirationReminder.reminder?.tier || "yellow"}
      />

      <AvatarPickerModal
        open={showAvatarOptions}
        onClose={() => setShowAvatarOptions(false)}
        selectedAvatarId={selectedAvatarId}
        selectedGender={selectedGender}
        onGenderChange={setSelectedGender}
        onSelect={handleSelectAvatar}
        title={t("chooseAvatar")}
        maleLabel={t("male")}
        femaleLabel={t("female")}
        cancelLabel={t("cancel")}
      />

      <PaymentHistoryExportPdfModal
        open={exportPdfOpen}
        onClose={onCloseExportPdf}
        scope={exportScope}
        accountTitle={exportAccountTitle}
        messages={exportMessages}
        pickerInstanceId="member-export"
        shareCalendarPopup
      />

      <ConfirmLogoutModal
        open={showLogoutConfirm}
        loading={logoutLoading}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={performLogout}
        i18n={logoutI18n}
      />
    </>
  );
}