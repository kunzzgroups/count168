import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import { useMaintenanceSession } from "../../hooks/useMaintenanceSession.js";
import { periodPresetRange } from "../../lib/dashboardDateUtils.js";
import {
  companyIsBankOnly,
  fetchDomainReport,
  formatReportAmount,
  isGroupLedgerDeniedError,
  reportAmountTone,
} from "../../lib/reportApi.js";
import { resolveCompanyPickForGroup } from "../../lib/dashboardScope.js";
import {
  maintenanceScopeIsReady,
  maintenanceScopeKey,
} from "../../lib/mobileMaintenanceScope.js";
import { REALTIME_DOMAINS } from "../../lib/realtime/realtimeEvents.js";
import { useRealtimeDomain } from "../../lib/realtime/useRealtimeDomain.js";
import { reportText } from "../../translateFile/reportTranslate.js";
import { canShowReportEntry } from "../../utils/mobilePermissions.js";
import { ReportFilterBar, ReportFilterSheet } from "./ReportSheets.jsx";
import "./report.css";

function defaultThisMonth() {
  return periodPresetRange("thisMonth") || { dateFrom: "", dateTo: "" };
}

function DomainMetric({ label, value, tone = "" }) {
  return (
    <div className={`m-rpt-metric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{formatReportAmount(value)}</strong>
    </div>
  );
}

function DomainTotalStrip({ i18n, totals }) {
  if (!totals) return null;
  return (
    <div className="m-rpt-summary">
      <div className="m-rpt-summary-label">{i18n.total}</div>
      <div className="m-rpt-metric-row">
        <DomainMetric label={i18n.turnover} value={totals.turnover} />
        <DomainMetric label={i18n.win} value={totals.win} tone="is-pos" />
        <DomainMetric label={i18n.lose} value={totals.lose} tone="is-neg" />
        <DomainMetric
          label={i18n.winLose}
          value={totals.win_lose}
          tone={reportAmountTone(totals.win_lose)}
        />
      </div>
    </div>
  );
}

export default function DomainReportPage() {
  const s = useMaintenanceSession({ canAccess: canShowReportEntry });
  const i18n = useMemo(() => reportText(s.lang), [s.lang]);
  const { scope, applyScope, companies, allowedGroupIds } = s;

  const boot = useMemo(() => defaultThisMonth(), []);
  const [dateFrom, setDateFrom] = useState(boot.dateFrom);
  const [dateTo, setDateTo] = useState(boot.dateTo);
  const [activePreset, setActivePreset] = useState("thisMonth");
  const [processId, setProcessId] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  const seqRef = useRef(0);
  const scopeReady = maintenanceScopeIsReady(scope);
  const scopeCacheKey = maintenanceScopeKey(scope);
  const isGroupScope = scope?.mode === "group" || scope?.mode === "groupsAll";

  const loadList = useCallback(
    async (signal, { soft = false } = {}) => {
      if (!scopeReady) return;
      const seq = ++seqRef.current;
      if (!soft) setListLoading(true);
      setListError("");
      try {
        const json = await fetchDomainReport(
          {
            scope,
            dateFrom,
            dateTo,
            processId: processId || undefined,
          },
          { signal },
        );
        if (seq !== seqRef.current) return;
        setRows(Array.isArray(json?.data) ? json.data : []);
        setTotals(json?.totals || null);
      } catch (e) {
        if (e?.name === "AbortError" || seq !== seqRef.current) return;
        /* Desktop parity (36495fb2fc): the group-only pre-check can wrongly allow a group ledger
           the session is not assigned to. When the backend rejects it, fall back to a reportable
           subsidiary in that group instead of leaving the page stranded on an error. */
        if (!soft && scope.mode !== "company" && isGroupLedgerDeniedError(e)) {
          const gid = scope.groupId || (allowedGroupIds.length === 1 ? allowedGroupIds[0] : null);
          const pick = gid ? resolveCompanyPickForGroup(companies, gid, scope.companyId) : null;
          if (pick?.id) {
            const ok = await applyScope({
              mode: "company",
              companyId: Number(pick.id),
              groupId: gid,
            });
            /* The scope change re-runs this loader, so never paint the error here. */
            if (ok) return;
          }
        }
        if (!soft) {
          setListError(e?.message || i18n.loadFailed);
          setRows([]);
          setTotals(null);
        }
      } finally {
        if (seq === seqRef.current && !soft) setListLoading(false);
      }
    },
    [scope, applyScope, companies, allowedGroupIds, scopeReady, dateFrom, dateTo, processId, i18n.loadFailed],
  );

  useEffect(() => {
    if (!s.me || !scopeReady) return undefined;
    const ac = new AbortController();
    loadList(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.me, scopeCacheKey, dateFrom, dateTo, processId]);

  useRealtimeDomain(
    REALTIME_DOMAINS.LEDGER,
    () => {
      loadList(undefined, { soft: true });
    },
    { enabled: Boolean(s.me) && scopeReady },
  );

  const displayRows = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const label = `${row.process || ""} ${row.description || ""}`.toUpperCase();
      return label.includes(q);
    });
  }, [rows, query]);

  const scopeLabel = s.groupsAllMode
    ? i18n.allGroups || `${i18n.all} Groups`
    : s.groupMode
      ? s.selectedGroup || i18n.group
      : String(s.selectedCompany?.company_id || "").toUpperCase() || i18n.company;

  const applyWithBankGuard = useCallback(
    async (next) => {
      const scopeChanged =
        next.scope.mode !== scope?.mode ||
        String(next.scope.groupId ?? "") !== String(scope?.groupId ?? "") ||
        Number(next.scope.companyId ?? 0) !== Number(scope?.companyId ?? 0) ||
        Boolean(next.scope.mode === "groupsAll") !== Boolean(scope?.mode === "groupsAll");

      if (scopeChanged && next.scope.mode === "company" && next.scope.companyId) {
        const row = s.companies.find((c) => Number(c.id) === Number(next.scope.companyId));
        const code = String(row?.company_id || "").trim();
        if (code && (await companyIsBankOnly(code))) {
          s.notify(i18n.bankOnlyBlocked, "error");
          return;
        }
      }

      if (scopeChanged) {
        let draft;
        if (next.scope.mode === "groupsAll") draft = { mode: "groupsAll" };
        else if (next.scope.mode === "group") draft = { mode: "group", groupId: next.scope.groupId };
        else draft = { mode: "company", companyId: next.scope.companyId, groupId: next.scope.groupId };
        const ok = await s.applyScope(draft);
        if (!ok) return;
      }
      setDateFrom(next.dateFrom);
      setDateTo(next.dateTo);
      setActivePreset(next.activePreset);
      setProcessId(next.processId ?? "");
    },
    [scope, s, i18n.bankOnlyBlocked],
  );

  useEffect(() => {
    if (!s.me || s.loading || s.groupMode || s.groupsAllMode || !s.selectedCompany) return undefined;
    const code = String(s.selectedCompany.company_id || "").trim();
    if (!code) return undefined;
    let cancelled = false;
    (async () => {
      const bankOnly = await companyIsBankOnly(code);
      if (cancelled || !bankOnly) return;
      s.notify(i18n.bankOnlyBlocked, "error");
      const candidates = s.companies.filter((c) => Number(c.id) !== Number(s.companyId));
      for (const c of candidates) {
        const ok = !(await companyIsBankOnly(String(c.company_id || "").trim()));
        if (ok) {
          await s.applyScope({ mode: "company", companyId: c.id });
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.me, s.loading, s.companyId]);

  const stickyBar = (
    <div className="m-rpt-sticky">
      <MobileSubpageHeader
        backTo="/report"
        backAriaLabel={i18n.backToHub}
        title={i18n.domainTitle}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: i18n.searchProcess,
          clearAriaLabel: i18n.reset,
        }}
      />
      <ReportFilterBar
        i18n={i18n}
        dateFrom={dateFrom}
        dateTo={dateTo}
        groupMode={s.groupMode}
        groupsAllMode={s.groupsAllMode}
        selectedGroup={s.selectedGroup}
        selectedCompany={s.selectedCompany}
        onOpen={() => setFilterOpen(true)}
      />
      <DomainTotalStrip i18n={i18n} totals={totals} />
    </div>
  );

  if (s.blocked) return null;

  return (
    <MobileShell
      i18n={i18n}
      me={s.me}
      companyCode={scopeLabel}
      onLogout={s.logout}
      onRefresh={() => loadList()}
      refreshing={listLoading}
      stickyBar={stickyBar}
      lang={s.lang}
      onLangChange={s.setLang}
      overlayOpen={filterOpen}
      overlay={
        <ReportFilterSheet
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          i18n={i18n}
          variant="domain"
          dateFrom={dateFrom}
          dateTo={dateTo}
          activePreset={activePreset}
          groupMode={s.groupMode}
          groupsAllMode={s.groupsAllMode}
          selectedGroup={s.selectedGroup}
          companyId={s.companyId}
          companies={s.companies}
          groupIds={s.groupIds}
          allowedGroupIds={s.allowedGroupIds}
          processId={processId}
          onApply={applyWithBankGuard}
        />
      }
    >
      <div className="m-rpt-content">
        {s.toast ? (
          <div className={`m-rpt-toast${s.toast.tone === "error" ? " is-error" : ""}`}>
            {s.toast.message}
          </div>
        ) : null}
        {listError ? <div className="m-rpt-error">{listError}</div> : null}

        {listLoading && displayRows.length === 0 ? (
          <div className="m-rpt-state">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            <p>{i18n.loading}</p>
          </div>
        ) : displayRows.length === 0 ? (
          <div className="m-rpt-state">
            <i className="fas fa-inbox" aria-hidden="true" />
            <p>{scopeReady ? i18n.noData : i18n.needCompany}</p>
          </div>
        ) : (
          <div className="m-rpt-lines">
            {displayRows.map((row, idx) => {
              const label =
                !isGroupScope && row.description
                  ? `${row.process} (${row.description})`
                  : row.process;
              return (
                <article
                  key={`${row.process}|${row.description}|${idx}`}
                  className="m-rpt-line"
                >
                  <div className="m-rpt-line-name">{label || i18n.process}</div>
                  <div className="m-rpt-metric-row">
                    <DomainMetric label={i18n.turnover} value={row.turnover} />
                    <DomainMetric label={i18n.win} value={row.win} tone="is-pos" />
                    <DomainMetric label={i18n.lose} value={row.lose} tone="is-neg" />
                    <DomainMetric
                      label={i18n.winLose}
                      value={row.win_lose}
                      tone={reportAmountTone(row.win_lose)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </MobileShell>
  );
}
