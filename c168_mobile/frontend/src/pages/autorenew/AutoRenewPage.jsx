import { useMemo, useState } from "react";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import { useIncrementalList } from "../../hooks/useIncrementalList.js";
import { useMobileAutoRenew } from "../../hooks/useMobileAutoRenew.js";
import {
  formatRemainingForRow,
  rowStableKey,
  tenantCode,
} from "../../lib/autoRenewHelpers.js";
import { formatDomainFeeDisplay2 } from "../../lib/domainHelpers.js";
import EarningsSegmentControl from "../dashboard/EarningsSegmentControl.jsx";
import { AutoRenewDetailSheet } from "./AutoRenewSheets.jsx";
import "../account/account.css";
import "../dashboard/dashboard.css";
import "./auto-renew.css";

function StatusBadge({ status, t }) {
  const label =
    status === "approved"
      ? t("statusApproved")
      : status === "rejected"
        ? t("statusRejected")
        : t("statusPending");
  return <span className={`m-ar-status m-ar-status--${status || "pending"}`}>{label}</span>;
}

function RenewCard({ row, t, onOpen }) {
  const code = tenantCode(row);
  const price = Number(row.price);
  return (
    <button type="button" className="m-ar-card tap-scale" onClick={() => onOpen(row)}>
      <div className="m-ar-card-top">
        <div className="m-ar-card-titles">
          <strong>{code}</strong>
          {row.owner_name ? <small>{row.owner_name}</small> : null}
        </div>
        <StatusBadge status={row.status} t={t} />
      </div>
      <div className="m-ar-card-meta">
        <span>
          {t("expirationDate")}: {row.expiration_date || t("notSet")}
        </span>
        <span>
          {t("timeRemaining")}: {formatRemainingForRow(row, t)}
        </span>
        {Number.isFinite(price) && price > 0 ? (
          <span>
            {t("colPrice")}: {formatDomainFeeDisplay2(price)}
          </span>
        ) : null}
      </div>
      <span className="m-ar-card-open">
        {t("openDetail")}
        <i className="fas fa-chevron-right" aria-hidden="true" />
      </span>
    </button>
  );
}

function FilterChip({ active, label, count, onClick }) {
  return (
    <button
      type="button"
      className={`m-ar-chip tap-scale${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{label}</span>
      {count != null ? <em>{count}</em> : null}
    </button>
  );
}

export default function AutoRenewPage() {
  const api = useMobileAutoRenew();
  const { i18n, t } = api;
  const [activeRow, setActiveRow] = useState(null);
  const list = useIncrementalList(api.rows, 40);

  const segmentTabs = useMemo(
    () => [
      {
        id: "company",
        label: (
          <span className="m-ar-seg-label">
            {t("companyTab")}
            {api.tabPendingCounts.company > 0 ? (
              <span className="m-ar-seg-badge">{api.tabPendingCounts.company}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "group",
        label: (
          <span className="m-ar-seg-label">
            {t("groupTab")}
            {api.tabPendingCounts.group > 0 ? (
              <span className="m-ar-seg-badge">{api.tabPendingCounts.group}</span>
            ) : null}
          </span>
        ),
      },
    ],
    [api.tabPendingCounts.company, api.tabPendingCounts.group, t],
  );

  const emptyHint =
    api.search.trim() !== ""
      ? t("noResults")
      : api.statusFilter === "approved"
        ? t("emptyHintApproved")
        : api.statusFilter === "rejected"
          ? t("emptyHintRejected")
          : t("emptyHintPending");

  const stickyBar = (
    <div className="m-ar-sticky">
      <MobileSubpageHeader
        backTo="/more"
        backAriaLabel={t("backToMore")}
        title={t("pageTitle")}
        subtitle={t("pageSubtitle")}
      />
      <EarningsSegmentControl
        ariaLabel={t("pageTitle")}
        tabs={segmentTabs}
        value={api.entityTab}
        onChange={api.setEntityTab}
      />
      <label className="m-account-search">
        <i className="fas fa-magnifying-glass" aria-hidden="true" />
        <input
          value={api.search}
          onChange={(e) => api.setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
        />
      </label>
      <div className="m-ar-chips" role="group" aria-label={t("pageTitle")}>
        {/* Desktop parity (22b5a3124a): status chips are all / pending / approved / rejected —
            the phone was missing "all", so the list could never show every status at once. */}
        <FilterChip
          active={api.statusFilter === "all"}
          label={t("filterShowAll")}
          count={api.counts.total}
          onClick={() => api.setStatusFilter("all")}
        />
        <FilterChip
          active={api.statusFilter === "pending"}
          label={t("filterPending")}
          count={api.counts.pending}
          onClick={() => api.setStatusFilter("pending")}
        />
        <FilterChip
          active={api.statusFilter === "approved"}
          label={t("filterApproved")}
          count={api.counts.approved}
          onClick={() => api.setStatusFilter("approved")}
        />
        <FilterChip
          active={api.statusFilter === "rejected"}
          label={t("filterRejected")}
          count={api.counts.rejected}
          onClick={() => api.setStatusFilter("rejected")}
        />
      </div>
    </div>
  );

  if (api.blocked) return null;

  return (
    <MobileShell
      i18n={i18n}
      me={api.me}
      companyCode={api.companyCode}
      groupId={api.groupId}
      onLogout={api.logout}
      onRefresh={api.refresh}
      refreshing={api.refreshing}
      stickyBar={stickyBar}
      lang={api.lang}
      onLangChange={api.setLang}
      overlayOpen={Boolean(activeRow)}
      overlay={
        <AutoRenewDetailSheet
          open={Boolean(activeRow)}
          onClose={() => setActiveRow(null)}
          row={activeRow}
          accounts={api.accounts}
          feeSettings={api.feeSettings}
          canEdit={api.canEdit}
          busy={api.busyId != null && api.busyId === activeRow?.request_id}
          t={t}
          onApprove={api.approve}
          onReject={api.reject}
          onDelete={api.remove}
        />
      }
    >
      <div className="m-ar-page">
        {api.toast ? (
          <div className={`m-account-toast ${api.toast.tone}`}>{api.toast.message}</div>
        ) : null}
        {api.error ? <div className="m-account-error">{api.error}</div> : null}
        {!api.canEdit && !api.loading ? (
          <p className="m-ar-readonly">{t("readOnlyNotice")}</p>
        ) : null}

        {api.loading ? (
          <div className="m-account-loading">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            <span>{t("loading")}</span>
          </div>
        ) : list.visible.length ? (
          <div className="m-ar-list">
            {list.visible.map((row) => (
              <RenewCard key={rowStableKey(row)} row={row} t={t} onOpen={setActiveRow} />
            ))}
            {list.hasMore ? (
              <div ref={list.sentinelRef} className="m-admin-sentinel" aria-hidden="true" />
            ) : null}
          </div>
        ) : (
          <div className="m-account-empty">
            <i className="fas fa-arrows-rotate" aria-hidden="true" />
            <p>{api.search.trim() ? t("noResults") : t("emptyTitle")}</p>
            <small>{emptyHint}</small>
          </div>
        )}
      </div>
    </MobileShell>
  );
}
