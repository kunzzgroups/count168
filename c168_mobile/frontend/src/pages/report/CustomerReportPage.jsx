import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import { useMaintenanceSession } from "../../hooks/useMaintenanceSession.js";
import { periodPresetRange } from "../../lib/dashboardDateUtils.js";
import {
  companyIsBankOnly,
  fetchCustomerReport,
  fetchReportCurrencies,
  formatReportAmount,
  isGroupLedgerDeniedError,
  reportAmountAdd,
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

function CustomerMetric({ label, value, tone = "" }) {
  return (
    <div className={`m-rpt-metric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{formatReportAmount(value)}</strong>
    </div>
  );
}

function CustomerTotalStrip({ i18n, totals }) {
  if (!totals) return null;
  return (
    <div className="m-rpt-summary">
      <div className="m-rpt-summary-label">{i18n.total}</div>
      <div className="m-rpt-metric-row m-rpt-metric-row--2">
        <CustomerMetric label={i18n.win} value={totals.win} tone="is-pos" />
        <CustomerMetric label={i18n.lose} value={totals.lose} tone="is-neg" />
      </div>
    </div>
  );
}

export default function CustomerReportPage() {
  const s = useMaintenanceSession({ canAccess: canShowReportEntry });
  const i18n = useMemo(() => reportText(s.lang), [s.lang]);
  const { scope, applyScope, companies, allowedGroupIds } = s;

  const boot = useMemo(() => defaultThisMonth(), []);
  const [dateFrom, setDateFrom] = useState(boot.dateFrom);
  const [dateTo, setDateTo] = useState(boot.dateTo);
  const [activePreset, setActivePreset] = useState("thisMonth");
  const [accountId, setAccountId] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [selectedCurrencies, setSelectedCurrencies] = useState(["MYR"]);
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  const seqRef = useRef(0);
  const scopeReady = maintenanceScopeIsReady(scope);
  const scopeCacheKey = maintenanceScopeKey(scope);

  const loadList = useCallback(
    async (signal, { soft = false } = {}) => {
      if (!scopeReady) return;
      const seq = ++seqRef.current;
      if (!soft) setListLoading(true);
      setListError("");
      try {
        const json = await fetchCustomerReport(
          {
            scope,
            dateFrom,
            dateTo,
            accountId: accountId || undefined,
            showAll,
            selectedCurrencies,
            showAllCurrencies,
          },
          { signal },
        );
        if (seq !== seqRef.current) return;
        setRows(Array.isArray(json?.data) ? json.data : []);
        setTotals(
          json?.total_win != null || json?.total_lose != null
            ? { win: json.total_win, lose: json.total_lose }
            : null,
        );
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
    [
      scope,
      applyScope,
      companies,
      allowedGroupIds,
      scopeReady,
      dateFrom,
      dateTo,
      accountId,
      showAll,
      selectedCurrencies,
      showAllCurrencies,
      i18n.loadFailed,
    ],
  );

  // Align with desktop: pick MYR (or first available) when scope changes — never "All".
  useEffect(() => {
    if (!s.me || !scopeReady) return undefined;
    const ac = new AbortController();
    (async () => {
      try {
        const list = await fetchReportCurrencies(scope, { signal: ac.signal });
        const codes = [
          ...new Set(
            (list || [])
              .map((c) => String(c.code || c.currency || c).trim().toUpperCase())
              .filter((code) => /^[A-Z]{3}$/.test(code)),
          ),
        ];
        if (!codes.length) return;
        const preferred = codes.includes("MYR") ? "MYR" : codes[0];
        setShowAllCurrencies(false);
        setSelectedCurrencies((prev) => {
          const cur = prev.map((c) => String(c).toUpperCase()).filter((c) => codes.includes(c));
          if (cur.length) return cur;
          return [preferred];
        });
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    })();
    return () => ac.abort();
  }, [s.me, scopeReady, scopeCacheKey, scope]);

  useRealtimeDomain(
    REALTIME_DOMAINS.LEDGER,
    () => {
      loadList(undefined, { soft: true });
    },
    { enabled: Boolean(s.me) && scopeReady },
  );

  useEffect(() => {
    if (!s.me || !scopeReady) return undefined;
    const ac = new AbortController();
    loadList(ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    s.me,
    scopeCacheKey,
    dateFrom,
    dateTo,
    accountId,
    showAll,
    showAllCurrencies,
    selectedCurrencies.join(","),
  ]);

  const displayRows = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const hay = `${row.account_id || ""} ${row.name || ""} ${row.currency || ""}`.toUpperCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const row of displayRows) {
      const c = String(row.currency || "-").toUpperCase();
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(row);
    }
    return [...map.entries()];
  }, [displayRows]);

  const multiCurrency = grouped.length > 1;
  const currencySubtotals = useMemo(() => {
    const out = new Map();
    for (const [currency, items] of grouped) {
      out.set(currency, {
        win: items.reduce((acc, row) => reportAmountAdd(acc, row.win), "0"),
        lose: items.reduce((acc, row) => reportAmountAdd(acc, row.lose), "0"),
      });
    }
    return out;
  }, [grouped]);

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
      setAccountId(next.accountId ?? "");
      setShowAll(Boolean(next.showAll));
      const nextCurrencies = Array.isArray(next.selectedCurrencies)
        ? next.selectedCurrencies.map((c) => String(c).toUpperCase()).filter(Boolean)
        : [];
      setSelectedCurrencies(nextCurrencies.length ? nextCurrencies : ["MYR"]);
      // Desktop customer report uses concrete currency chips — never "All currencies".
      setShowAllCurrencies(false);
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
        title={i18n.customerTitle}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: i18n.searchAccount,
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
      <div className="m-rpt-chip-row">
        {showAll ? <span className="m-rpt-chip is-on">{i18n.showAll}</span> : null}
        {selectedCurrencies.map((c) => (
          <span key={c} className="m-rpt-chip">
            {String(c).toUpperCase()}
          </span>
        ))}
      </div>
      {/* Single-currency: API totals OK. Multi-currency: per-block subtotals only (avoid mixed FX). */}
      {!multiCurrency ? <CustomerTotalStrip i18n={i18n} totals={totals} /> : null}
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
          variant="customer"
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
          accountId={accountId}
          showAll={showAll}
          selectedCurrencies={selectedCurrencies}
          showAllCurrencies={showAllCurrencies}
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
            {grouped.map(([currency, items]) => {
              const sub = currencySubtotals.get(currency);
              return (
                <div key={currency} className="m-rpt-currency-block">
                  <div className="m-rpt-currency-head">{currency}</div>
                  {items.map((row, idx) => {
                    const code = String(row.account_id || "").toUpperCase();
                    const label = row.name ? `${code} (${row.name})` : code || i18n.account;
                    return (
                      <article
                        key={`${row.account_id}|${row.currency}|${idx}`}
                        className="m-rpt-line"
                      >
                        <div className="m-rpt-line-name">{label}</div>
                        <div className="m-rpt-metric-row m-rpt-metric-row--2">
                          <CustomerMetric
                            label={i18n.win}
                            value={row.win}
                            tone="is-pos"
                          />
                          <CustomerMetric label={i18n.lose} value={row.lose} tone="is-neg" />
                        </div>
                      </article>
                    );
                  })}
                  {multiCurrency && sub ? (
                    <div className="m-rpt-currency-subtotal">
                      <div className="m-rpt-summary-label">
                        {i18n.total} · {currency}
                      </div>
                      <div className="m-rpt-metric-row m-rpt-metric-row--2">
                        <CustomerMetric label={i18n.win} value={sub.win} tone="is-pos" />
                        <CustomerMetric label={i18n.lose} value={sub.lose} tone="is-neg" />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </MobileShell>
  );
}
