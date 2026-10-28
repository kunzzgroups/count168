import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useOutletContext, useSearchParams } from "react-router-dom";
import MobileShell from "../../components/layout/MobileShell.jsx";
import MobileSubpageHeader from "../../components/layout/MobileSubpageHeader.jsx";
import { useMobilePaymentHistoryProgressive } from "../../hooks/useMobilePaymentHistoryProgressive.js";
import {
  formatHistoryBalanceMoney,
  formatHistoryMoney,
  formatRateForHistoryDisplay,
  getHistoryRemark,
  toUpperDisplay,
} from "../../lib/transactionFormat.js";
import {
  paymentHistoryParamsReady,
  paymentHistoryScopeApiParams,
  paymentHistoryTitle,
  resolveHistoryAccountName,
  resolvePaymentHistoryScope,
} from "../../lib/transactionHistoryScope.js";
import { historyTypeCardClass } from "../../lib/transactionTypeStyles.js";
import { moneyToneClass } from "../../lib/money/moneyToneClass.js";
import ExportPdfSheet from "./ExportPdfSheet.jsx";
import "./transaction-history.css";
import "./transaction-history-types.css";

/** Stable id from history API rows (field is transaction_id, not id). */
function historyRowId(row) {
  const n = Number(row?.transaction_id ?? row?.id ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Sort key for history row dates (supports DD/MM/YYYY and YYYY-MM-DD). */
function historyDateSortKey(row) {
  const raw = String(row?.date || "").trim();
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return `${dmy[3]}${dmy[2].padStart(2, "0")}${dmy[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10).replace(/-/g, "");
  return raw;
}

/** Oldest date first, newest at the bottom; B/F (period opening) always stays on top. */
function sortHistoryNewestLast(rows) {
  return [...(rows || [])].sort((a, b) => {
    const aBf = a?.row_type === "bf" ? 0 : 1;
    const bBf = b?.row_type === "bf" ? 0 : 1;
    if (aBf !== bBf) return aBf - bBf;
    const byDate = historyDateSortKey(a).localeCompare(historyDateSortKey(b));
    if (byDate !== 0) return byDate;
    return historyRowId(a) - historyRowId(b);
  });
}

function MoneyTone({ value, children }) {
  return <span className={moneyToneClass(value)}>{children}</span>;
}

function rowKey(row, idx) {
  const id = historyRowId(row);
  return id || `${idx}-${row.date || ""}-${row.balance || ""}`;
}

export default function TransactionHistoryPage() {
  const { tx } = useOutletContext();
  const [searchParams] = useSearchParams();
  const scope = useMemo(() => resolvePaymentHistoryScope(searchParams), [searchParams]);
  const scopeApi = useMemo(() => paymentHistoryScopeApiParams(scope), [scope]);
  const paramsReady = paymentHistoryParamsReady(scope);

  const [exportOpen, setExportOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);

  const m = tx.m;
  const i18n = tx.i18n;

  const exportScope = useMemo(() => {
    const companyId =
      scope.companyId ||
      (Number(tx.companyId) > 0 ? Number(tx.companyId) : undefined) ||
      (Number(tx.selectedCompany?.id) > 0 ? Number(tx.selectedCompany.id) : undefined);
    return { ...scope, companyId };
  }, [scope, tx.companyId, tx.selectedCompany]);

  const {
    rows,
    accountMeta,
    isInitialLoading: loading,
    isLoadingMore,
    errorMessage,
  } = useMobilePaymentHistoryProgressive({
    scope,
    scopeApi,
    enabled: paramsReady,
  });

  const error = errorMessage || "";

  useEffect(() => {
    setExpandedKey(null);
  }, [scope.accountDbId, scope.dateFrom, scope.dateTo, scope.currency]);

  const title = useMemo(() => {
    const meta = accountMeta
      ? {
          ...accountMeta,
          name: resolveHistoryAccountName({
            accountName: scope.accountName,
            accountMeta,
            accountCode: scope.accountCode,
          }),
        }
      : null;
    return paymentHistoryTitle({
      accountCode: scope.accountCode,
      accountName: scope.accountName,
      accountMeta: meta,
    });
  }, [accountMeta, scope.accountCode, scope.accountName]);

  const resolvedAccountName = resolveHistoryAccountName({
    accountName: scope.accountName,
    accountMeta,
    accountCode: scope.accountCode,
  });

  const displayRows = useMemo(() => sortHistoryNewestLast(rows), [rows]);

  // Newest row is at the bottom: jump there once per query when the first batch has painted.
  const bottomRef = useRef(null);
  const scrolledKeyRef = useRef("");
  const queryKey = `${scope.accountDbId}|${scope.dateFrom}|${scope.dateTo}|${scope.currency}`;
  useEffect(() => {
    if (loading || displayRows.length === 0 || scrolledKeyRef.current === queryKey) return;
    scrolledKeyRef.current = queryKey;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [loading, displayRows.length, queryKey]);

  if (!paramsReady) {
    return <Navigate to="/transaction" replace />;
  }

  const stickyBar = (
    <div className="m-tx-hist-sticky">
      <MobileSubpageHeader
        backTo="/transaction"
        backAriaLabel={m.backToList}
        title={title}
        subtitle={`${scope.dateFrom} — ${scope.dateTo}${scope.currency ? ` · ${scope.currency}` : ""}`}
        trailing={
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="m-tx-hist-export tap-scale"
            aria-label={m.exportPdf}
            title={m.exportPdf}
          >
            <i className="fas fa-file-pdf" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );

  return (
    <MobileShell
      i18n={i18n}
      me={tx.me}
      onLogout={tx.logout}
      stickyBar={stickyBar}
      lang={tx.lang}
      onLangChange={tx.setLang}
      showBottomNav={false}
      overlayOpen={exportOpen}
      overlay={
        <ExportPdfSheet
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          m={m}
          scope={exportScope}
          accountCode={scope.accountCode || accountMeta?.account_id || ""}
          accountName={resolvedAccountName}
          lang={tx.lang}
        />
      }
    >
      <div className="m-tx-hist-page">
        <p className="m-tx-hist-count">
          {m.paymentHistoryShowingEntries.replace("{count}", String(displayRows.length))}
        </p>
        <p className="m-tx-hist-hint">{m.paymentHistoryBalanceHint}</p>
        <p className="m-tx-hist-expand-hint">{m.paymentHistoryTapRowHint}</p>

        {loading ? (
          <div className="m-tx-hist-loading">{m.loadingHistory}</div>
        ) : error ? (
          <div className="m-tx-hist-error">{error}</div>
        ) : displayRows.length === 0 ? (
          <p className="m-tx-hist-empty">{m.searchCompletedNoData}</p>
        ) : (
          <div className="m-tx-hist-dense-wrap">
            <table className="m-tx-hist-dense-table">
              <colgroup>
                <col className="m-tx-hist-col--date" />
                <col className="m-tx-hist-col--product" />
                <col className="m-tx-hist-col--num" span={3} />
                <col className="m-tx-hist-col--chev" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--date">
                    {m.dateCompact || m.date || "Date"}
                  </th>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--product">
                    {m.idProduct || m.idProductCompact || "Id Product"}
                  </th>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--num">
                    {m.winLossTableCompact}
                  </th>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--num">
                    {m.crDrTable}
                  </th>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--num">
                    {m.balanceTableCompact}
                  </th>
                  <th scope="col" className="m-tx-hist-dense-th m-tx-hist-dense-th--chev">
                    <span className="sr-only">{m.paymentHistoryDetails}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, idx) => {
                  const key = rowKey(row, idx);
                  const expanded = expandedKey === key;
                  const typeCls = historyTypeCardClass(row);
                  const idProductDisplay = toUpperDisplay(
                    row.is_bank_process_transaction ? row.card_owner || "-" : row.product || "-",
                  );
                  const createdRaw = row.created_by;
                  const createdBy =
                    createdRaw == null ||
                    String(createdRaw).trim() === "" ||
                    String(createdRaw).toLowerCase() === "null"
                      ? "-"
                      : String(createdRaw);
                  const remark = getHistoryRemark(row);
                  const description = toUpperDisplay(row.description);
                  const cur = toUpperDisplay(row.currency);
                  const detailId = `hist-detail-${key}`;
                  const toggle = () => setExpandedKey(expanded ? null : key);

                  return (
                    <Fragment key={key}>
                      <tr
                        className={`m-tx-hist-row ${typeCls}${idx % 2 === 1 ? " m-tx-hist-row--alt" : ""}${expanded ? " m-tx-hist-row--expanded" : ""}`}
                        tabIndex={0}
                        role="button"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={toggle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle();
                          }
                        }}
                      >
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--date">
                          {row.date || "—"}
                        </td>
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--product">
                          {idProductDisplay || "—"}
                        </td>
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--num">
                          <MoneyTone value={row.win_loss}>{formatHistoryMoney(row.win_loss)}</MoneyTone>
                        </td>
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--num">
                          <MoneyTone value={row.cr_dr}>{formatHistoryMoney(row.cr_dr)}</MoneyTone>
                        </td>
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--num">
                          <MoneyTone value={row.balance}>
                            {formatHistoryBalanceMoney(row.balance)}
                          </MoneyTone>
                        </td>
                        <td className="m-tx-hist-dense-td m-tx-hist-dense-td--chev">
                          <i
                            className={`fas fa-chevron-${expanded ? "up" : "down"} m-tx-hist-chev`}
                            aria-hidden="true"
                          />
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className="m-tx-hist-detail-row" id={detailId}>
                          <td className="m-tx-hist-detail" colSpan={6}>
                            <div className="m-tx-hist-detail-panel">
                              <div className="m-tx-hist-detail-block">
                                <span className="m-tx-hist-detail-label">
                                  {m.description || m.descriptionCompact}
                                </span>
                                <p
                                  className={
                                    description && description !== "-"
                                      ? "m-tx-hist-detail-desc"
                                      : "m-tx-hist-detail-desc m-tx-hist-detail-desc--muted"
                                  }
                                >
                                  {description && description !== "-" ? description : "—"}
                                </p>
                              </div>

                              <div className="m-tx-hist-detail-meta">
                                <div className="m-tx-hist-detail-meta-item">
                                  <span className="m-tx-hist-detail-label">
                                    {m.currencyCompact || m.currency}
                                  </span>
                                  <span
                                    className={
                                      cur && cur !== "-"
                                        ? "m-tx-hist-detail-value"
                                        : "m-tx-hist-detail-value m-tx-hist-detail-value--muted"
                                    }
                                  >
                                    {cur && cur !== "-" ? cur : "—"}
                                  </span>
                                </div>
                                <div className="m-tx-hist-detail-meta-item">
                                  <span className="m-tx-hist-detail-label">
                                    {m.createdByCompact || m.createdBy}
                                  </span>
                                  <span
                                    className={
                                      createdBy && createdBy !== "-"
                                        ? "m-tx-hist-detail-value"
                                        : "m-tx-hist-detail-value m-tx-hist-detail-value--muted"
                                    }
                                  >
                                    {createdBy && createdBy !== "-" ? createdBy : "—"}
                                  </span>
                                </div>
                              </div>

                              {row.rate && row.rate !== "-" ? (
                                <div className="m-tx-hist-detail-block m-tx-hist-detail-block--inline">
                                  <span className="m-tx-hist-detail-label">{m.rate}</span>
                                  <span className="m-tx-hist-detail-value">
                                    {formatRateForHistoryDisplay(row.rate)}
                                  </span>
                                </div>
                              ) : null}

                              {remark && remark !== "-" ? (
                                <div className="m-tx-hist-detail-block">
                                  <span className="m-tx-hist-detail-label">
                                    {m.remark || m.remarkCompact}
                                  </span>
                                  <p className="m-tx-hist-detail-desc">{remark}</p>
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {isLoadingMore ? (
              <p className="m-tx-hist-loading m-tx-hist-loading--more">{m.loadingMoreHistory || m.loadingHistory}</p>
            ) : null}
            <div ref={bottomRef} aria-hidden="true" />
          </div>
        )}
      </div>
    </MobileShell>
  );
}
