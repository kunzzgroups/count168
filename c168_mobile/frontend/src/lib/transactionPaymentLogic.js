import { resolveSavedCurrencyOrder } from "./currencyOrder.js";
import { parseBalanceValue } from "./transactionFormat.js";
import { MoneyDecimal } from "./money/moneyDecimal.js";

function clearTxSearchCache() {
  /* mobile: no desktop search cache */
}

export const TRANSACTION_CURRENCY_FILTER_KEY_PREFIX = "transaction_currency_filter_v1_";
export const TX_LIST_SESSION_PREFIX = "count168_txlist_v1_";
export const TX_LIST_INVALIDATE_LS_KEY = "count168_tx_invalidate_ts";
export const TX_LIST_INVALIDATE_HANDLED_KEY = "count168_tx_invalidate_handled";
export const TX_DATA_CHANGED_EVENT = "tx-data-changed";

/** Broadcast that transaction balances changed elsewhere (maintenance delete, process post, etc.). */
export function notifyTransactionListInvalidated(source = "unknown") {
  const ts = Date.now();
  try {
    localStorage.setItem(TX_LIST_INVALIDATE_LS_KEY, String(ts));
  } catch {
    /* ignore */
  }
  clearTxSearchCache();
  window.dispatchEvent(new CustomEvent(TX_DATA_CHANGED_EVENT, { detail: { ts, source } }));
  return ts;
}

/** @param {string|null|undefined} role */
export function getRoleClass(role) {
  if (!role) return "";
  const roleLower = String(role).toLowerCase().trim();
  const roleMap = {
    capital: "transaction-role-capital",
    bank: "transaction-role-bank",
    cash: "transaction-role-cash",
    profit: "transaction-role-profit",
    expenses: "transaction-role-expenses",
    company: "transaction-role-company",
    partner: "transaction-role-partner",
    staff: "transaction-role-staff",
    upline: "transaction-role-upline",
    agent: "transaction-role-agent",
    member: "transaction-role-member",
    debtor: "transaction-role-debtor",
    none: "transaction-role-none",
  };
  return roleMap[roleLower] || "";
}

export function getRoleSortOrder(role) {
  if (!role) return 999;
  const roleLower = String(role).toLowerCase().trim();
  const roleOrder = {
    capital: 1,
    bank: 2,
    cash: 3,
    profit: 4,
    expenses: 5,
    company: 6,
    staff: 7,
    upline: 8,
    agent: 9,
    member: 10,
    none: 11,
  };
  return roleOrder[roleLower] ?? 999;
}

export function sortByRole(data) {
  return [...(data || [])].sort((a, b) => {
    const roleA = getRoleSortOrder(a.role);
    const roleB = getRoleSortOrder(b.role);
    if (roleA !== roleB) return roleA - roleB;
    return String(a.account_id || "").localeCompare(String(b.account_id || ""));
  });
}

/** 与 search_api.php 去重键一致：account_db_id + currency（防止异常重复行）。 */
export function dedupeRowsByAccountAndCurrency(rows) {
  const out = [];
  const indexByKey = new Map();
  const norm = (v) => String(v || "").toUpperCase().trim();
  const keyOf = (row) => {
    if (row?.type_search_row) {
      const tid = Number(row?.transaction_id);
      const accountDbId = norm(row?.account_db_id);
      const currency = norm(row?.currency);
      return `TX:${tid > 0 ? tid : "x"}_${accountDbId || "DB"}_${currency}`;
    }
    const currency = norm(row?.currency);
    // Prefer stable UI identity (account_id). account_db_id is fallback only.
    const accountCode = norm(row?.account_id);
    const accountDbId = norm(row?.account_db_id);
    const anchor = accountCode || `DB:${accountDbId}`;
    return `${anchor}_${currency}`;
  };
  const toAbs = (v) => Math.abs(parseBalanceValue(v) ?? 0);
  const toBoolFlag = (v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return parseInt(String(v || "0"), 10) !== 0;
  };
  const scoreRow = (row) => {
    if (!row || typeof row !== "object") return 0;
    // Prefer rows that actually carry transaction signals / non-zero metrics.
    const score =
      toAbs(row.win_loss) * 100 +
      toAbs(row.cr_dr) * 80 +
      toAbs(row.balance) * 20 +
      toAbs(row.bf) * 10 +
      (toBoolFlag(row.has_win_loss_transactions) ? 5000 : 0) +
      (toBoolFlag(row.has_crdr_transactions) ? 5000 : 0) +
      (toBoolFlag(row.has_win_loss_history) ? 2000 : 0) +
      (toBoolFlag(row.has_period_id_product_rows) ? 1500 : 0);
    return score;
  };

  for (const row of rows || []) {
    const k = keyOf(row);
    if (!indexByKey.has(k)) {
      indexByKey.set(k, out.length);
      out.push(row);
      continue;
    }
    const idx = indexByKey.get(k);
    const prev = out[idx];
    if (scoreRow(row) >= scoreRow(prev)) {
      out[idx] = row;
    }
  }
  return out;
}

/** 去重左右表并按行重算 totals（修复竞态/缓存叠行导致的重复 CAPITAL 等）。 */
/** Merge multiple search_api payloads (group/company All modes). */
export function mergeSearchApiDataList(dataList) {
  const left = [];
  const right = [];
  for (const d of dataList) {
    if (!d || typeof d !== "object") continue;
    if (Array.isArray(d.left_table)) left.push(...d.left_table);
    if (Array.isArray(d.right_table)) right.push(...d.right_table);
  }
  return sanitizeSearchApiData({ left_table: left, right_table: right });
}

export function sanitizeSearchApiData(data) {
  if (!data || typeof data !== "object") return data;
  const left = dedupeRowsByAccountAndCurrency(data.left_table);
  const right = dedupeRowsByAccountAndCurrency(data.right_table);
  const totalsLeft = calculateTotals(left);
  const totalsRight = calculateTotals(right);
  return {
    ...data,
    left_table: left,
    right_table: right,
    totals: {
      left: totalsLeft,
      right: totalsRight,
      summary: applySummaryWinLossDisplayTolerance(calculateTotals([...left, ...right])),
    },
  };
}

/**
 * Instantly patch period Cr/Dr (or Win/Loss) + Balance in search payload after submit.
 * Missing accounts are skipped (forceRefresh will insert them). Re-splits left/right by balance sign.
 */
export function applyOptimisticSubmitBalancePatch(rawSearchData, { currency, deltas } = {}) {
  if (!rawSearchData || typeof rawSearchData !== "object") return rawSearchData;
  const currencyCode = String(currency || "").toUpperCase().trim();
  if (!currencyCode || !Array.isArray(deltas) || deltas.length === 0) return rawSearchData;

  const deltaById = new Map();
  for (const d of deltas) {
    const id = Number(d?.accountDbId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const prev = deltaById.get(id) || { crDrDelta: "0", winLossDelta: "0" };
    try {
      if (d.crDrDelta != null && String(d.crDrDelta).trim() !== "") {
        prev.crDrDelta = MoneyDecimal.add(prev.crDrDelta, d.crDrDelta).toString();
      }
      if (d.winLossDelta != null && String(d.winLossDelta).trim() !== "") {
        prev.winLossDelta = MoneyDecimal.add(prev.winLossDelta, d.winLossDelta).toString();
      }
    } catch {
      /* skip bad delta */
    }
    deltaById.set(id, prev);
  }
  if (deltaById.size === 0) return rawSearchData;

  const patchRow = (row) => {
    const id = Number(row?.account_db_id);
    const rowCur = String(row?.currency || "").toUpperCase().trim();
    if (!deltaById.has(id) || rowCur !== currencyCode) return row;
    const delta = deltaById.get(id);
    try {
      const bf = cleanMoneyCell(row?.bf);
      const wlFull = cleanMoneyCell(row?.win_loss_full != null ? row.win_loss_full : row?.win_loss);
      const crDr = cleanMoneyCell(row?.cr_dr);

      const nextWlFull =
        delta.winLossDelta && !MoneyDecimal.toDecimal(delta.winLossDelta, 0).isZero()
          ? MoneyDecimal.add(wlFull, delta.winLossDelta).toString()
          : wlFull;
      const nextCrDr =
        delta.crDrDelta && !MoneyDecimal.toDecimal(delta.crDrDelta, 0).isZero()
          ? MoneyDecimal.add(crDr, delta.crDrDelta).toString()
          : crDr;

      const balanceFull = MoneyDecimal.add(MoneyDecimal.add(bf, nextWlFull), nextCrDr).toString();
      const next = {
        ...row,
        win_loss: MoneyDecimal.formatFixedHalfUp(nextWlFull, 2),
        win_loss_full: nextWlFull,
        cr_dr: MoneyDecimal.formatFixedHalfUp(nextCrDr, 2),
        balance_full: balanceFull,
        balance: MoneyDecimal.formatFixedHalfUp(balanceFull, 2),
      };
      if (delta.crDrDelta && !MoneyDecimal.toDecimal(delta.crDrDelta, 0).isZero()) {
        next.has_crdr_transactions = 1;
      }
      if (delta.winLossDelta && !MoneyDecimal.toDecimal(delta.winLossDelta, 0).isZero()) {
        next.has_win_loss_transactions = 1;
      }
      return next;
    } catch {
      return row;
    }
  };

  const combined = [...(rawSearchData.left_table || []), ...(rawSearchData.right_table || [])].map(patchRow);
  const left = [];
  const right = [];
  for (const row of combined) {
    try {
      if (MoneyDecimal.cmp(cleanMoneyCell(row?.balance), "0") < 0) right.push(row);
      else left.push(row);
    } catch {
      left.push(row);
    }
  }

  return sanitizeSearchApiData({
    ...rawSearchData,
    left_table: left,
    right_table: right,
  });
}

export const TX_FILTER_EPS = 0.00001;

/** API 返回的 0/1、true/false、"0"/"1" 统一为布尔。 */
function txRowFlag(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return parseInt(String(v || "0"), 10) !== 0;
}

/** True when ending balance is non-zero (2dp display tolerance). */
export function rowHasNonZeroBalance(row) {
  return !rowIsZeroBalance(row);
}

/** Balance 展示列是否为 0（与 transaction.js rowIsZeroBalance 一致）。 */
export function rowIsZeroBalance(row) {
  const num = parseBalanceValue(String(row?.balance ?? "").replace(/,/g, ""));
  if (num === null) return true;
  return Math.abs(num) <= TX_FILTER_EPS;
}

/**
 * 本期是否有 Payment/CrDr 动账：展示净额非 0，或 API 标志有流水（含轧成 0.00 / CONTRA 清账）。
 * 与 search_api has_crdr_transactions / has_contra_clear_period 对齐。
 */
export function rowHasPeriodCrdr(row) {
  const crdr = parseBalanceValue(row?.cr_dr);
  if (crdr !== null && Math.abs(crdr) > TX_FILTER_EPS) return true;
  return txRowFlag(row?.has_crdr_transactions) || txRowFlag(row?.has_contra_clear_period);
}

/**
 * 本期是否有 Win/Loss 动账：展示净额非 0，或 API 标志有流水（含当日正负轧成 0.00）。
 * 与 search_api has_win_loss_transactions / has_period_id_product_rows 对齐。
 */
export function rowHasPeriodWinLoss(row) {
  const wl = parseBalanceValue(String(row?.win_loss ?? "").replace(/,/g, ""));
  if (wl !== null && Math.abs(wl) > TX_FILTER_EPS) return true;
  return txRowFlag(row?.has_win_loss_transactions) || txRowFlag(row?.has_period_id_product_rows);
}

/**
 * API 查询参数：Show all 0 balance 与 Payment/Win-Loss Only 联动的覆盖规则。
 * @returns {{ showInactiveForQuery: boolean, showCaptureOnlyForQuery: boolean, hideZeroBalanceForQuery: boolean }}
 */
export function buildTransactionSearchQueryFilters({
  showZeroBalance = false,
  showPaymentOnly = false,
  showCaptureOnly = false,
}) {
  return {
    showInactiveForQuery: showZeroBalance && showPaymentOnly ? false : !!showPaymentOnly,
    showCaptureOnlyForQuery: showZeroBalance && showCaptureOnly ? false : !!showCaptureOnly,
    hideZeroBalanceForQuery: !showZeroBalance,
  };
}

/** Layer B：零余额过滤（balance=0 但本期有 Cr/Dr 或 Win/Loss 动账时仍显示）。 */
export function rowPassesHideZeroBalanceFilter(showZero, row, opts = {}) {
  if (showZero) return true;
  if (!rowIsZeroBalance(row)) return true;
  if (opts.showPaymentOnly && rowHasPeriodCrdr(row)) return true;
  if (opts.showWinLossOnly && rowHasPeriodWinLoss(row)) return true;
  return false;
}

/**
 * Layer A + B 完整过滤（与 transaction.js applyFilters 一致）。
 * @param {object[]} rows
 * @param {{ showZero?: boolean, showPaymentOnly?: boolean, showWinLossOnly?: boolean }} opts
 */
export function applyTransactionDisplayFilters(rows, { showZero = false, showPaymentOnly = false, showWinLossOnly = false } = {}) {
  let filtered = Array.isArray(rows) ? rows : [];
  if (showPaymentOnly || showWinLossOnly) {
    if (showPaymentOnly && showWinLossOnly) {
      filtered = filtered.filter((row) =>
        showZero
          ? rowIsZeroBalance(row) || rowHasPeriodCrdr(row) || rowHasPeriodWinLoss(row)
          : rowHasPeriodCrdr(row) || rowHasPeriodWinLoss(row),
      );
    } else if (showPaymentOnly) {
      filtered = filtered.filter((row) =>
        showZero ? rowIsZeroBalance(row) || rowHasPeriodCrdr(row) : rowHasPeriodCrdr(row),
      );
    } else {
      filtered = filtered.filter((row) =>
        showZero ? rowIsZeroBalance(row) || rowHasPeriodWinLoss(row) : rowHasPeriodWinLoss(row),
      );
    }
  }
  const layerBOpts = { showPaymentOnly, showWinLossOnly };
  return filtered.filter((row) => rowPassesHideZeroBalanceFilter(showZero, row, layerBOpts));
}

/** 左右表一次性过滤（rawSearchData → 展示行）。 */
export function filterTransactionTableRows(rawLeft, rawRight, { showZeroBalance, showPaymentOnly, showCaptureOnly }) {
  const opts = {
    showZero: !!showZeroBalance,
    showPaymentOnly: !!showPaymentOnly,
    showWinLossOnly: !!showCaptureOnly,
  };
  return {
    left: applyTransactionDisplayFilters(rawLeft, opts),
    right: applyTransactionDisplayFilters(rawRight, opts),
  };
}

/**
 * Historically re-split RATE rows by Cr/Dr sign. Product rule is now unified with
 * CONTRA/PAYMENT: keep search_api Balance-based left/right for all types.
 * Kept as a passthrough so older call sites stay safe.
 */
export function normalizeRateRowsByCrDr(leftRows, rightRows, _isRate = false) {
  return {
    leftRows: Array.isArray(leftRows) ? [...leftRows] : [],
    rightRows: Array.isArray(rightRows) ? [...rightRows] : [],
  };
}

/** @deprecated Use {@link filterTransactionTableRows} — kept for legacy two-step callers. */
export function applyPaymentWinLossFilters(rawLeft, rawRight, { showPaymentOnly, showCaptureOnly, showZeroBalance = false }) {
  const { left, right } = filterTransactionTableRows(rawLeft, rawRight, {
    showZeroBalance,
    showPaymentOnly,
    showCaptureOnly,
  });
  return { filteredLeft: left, filteredRight: right };
}

/** @deprecated Use {@link filterTransactionTableRows} — Layer A+B 已在 applyPaymentWinLossFilters 内完成。 */
export function applyZeroBalanceFilter(filteredLeft, filteredRight, showZeroBalance, { showCaptureOnly = false, showPaymentOnly = false } = {}) {
  return filterTransactionTableRows(filteredLeft, filteredRight, {
    showZeroBalance,
    showPaymentOnly,
    showCaptureOnly,
  });
}

/** Same as `js/transaction.js` winLossFullRawForTotals: sum full-precision W/L before half-up. */
function winLossFullRawForTotals(row) {
  const raw =
    row && row.win_loss_full !== undefined && row.win_loss_full !== null && String(row.win_loss_full).trim() !== ""
      ? row.win_loss_full
      : row && row.win_loss != null
        ? row.win_loss
        : "0";
  const s = raw === "-" ? "0" : String(raw).replace(/,/g, "").trim();
  try {
    MoneyDecimal.toDecimal(s, 0);
    return s;
  } catch {
    return "0";
  }
}

function cleanMoneyCell(value) {
  const s = String(value ?? "")
    .replace(/,/g, "")
    .trim();
  if (!s || s === "-") return "0";
  return s;
}

/** Match `js/transaction.js` calculateTotals (bf/cr_dr sum; win_loss from win_loss_full; balance = bf+wl+cr). */
export function calculateTotals(rows) {
  let bfAcc = MoneyDecimal.toDecimal("0", 0);
  let wlAcc = MoneyDecimal.toDecimal("0", 0);
  let crAcc = MoneyDecimal.toDecimal("0", 0);
  for (const row of rows || []) {
    try {
      bfAcc = bfAcc.plus(MoneyDecimal.toDecimal(cleanMoneyCell(row?.bf), 0));
    } catch {
      /* skip bad row */
    }
    try {
      wlAcc = wlAcc.plus(MoneyDecimal.toDecimal(winLossFullRawForTotals(row), 0));
    } catch {
      /* skip */
    }
    try {
      crAcc = crAcc.plus(MoneyDecimal.toDecimal(cleanMoneyCell(row?.cr_dr), 0));
    } catch {
      /* skip */
    }
  }
  const bfTot = MoneyDecimal.formatFixed(bfAcc.toString(), 2);
  const wlTot = MoneyDecimal.formatFixedHalfUp(wlAcc.toString(), 2);
  const crTot = MoneyDecimal.formatFixed(crAcc.toString(), 2);
  const balTot = MoneyDecimal.formatFixedHalfUp(MoneyDecimal.add(MoneyDecimal.add(bfTot, wlTot), crTot).toString(), 2);
  return { bf: bfTot, win_loss: wlTot, cr_dr: crTot, balance: balTot };
}

/**
 * Bottom Summary only: when `?tx_wl_tol=1`, show Total Win/Loss as 0.00 if |W/L| ≤ RM1.00 (legacy `transaction.php`).
 * Does not alter per-side totals or API data.
 */
export function applySummaryWinLossDisplayTolerance(totals) {
  if (totals == null || typeof totals !== "object") return totals;
  let tolActive = false;
  try {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search || "").get("tx_wl_tol") === "1") {
      tolActive = true;
    }
  } catch {
    return totals;
  }
  if (!tolActive) return totals;
  const tolRaw = "1.00";
  let tol;
  try {
    tol = MoneyDecimal.toDecimal(String(tolRaw).replace(/,/g, "").trim(), 0).abs();
  } catch {
    return totals;
  }
  if (tol.isZero()) return totals;
  let absWl;
  try {
    absWl = MoneyDecimal.toDecimal(String(totals.win_loss ?? "0").replace(/,/g, "").trim(), 0).abs();
  } catch {
    return totals;
  }
  if (absWl.gt(tol)) return totals;
  const bf2 = String(totals.bf ?? "0").replace(/,/g, "").trim();
  const cr2 = String(totals.cr_dr ?? "0").replace(/,/g, "").trim();
  const wl0 = MoneyDecimal.formatFixedHalfUp("0", 2);
  const balance2 = MoneyDecimal.formatFixedHalfUp(MoneyDecimal.add(MoneyDecimal.add(bf2, wl0), cr2).toString(), 2);
  return { bf: totals.bf, win_loss: wl0, cr_dr: totals.cr_dr, balance: balance2 };
}

/** Merge left+right footer totals (each already `calculateTotals` output). */
export function mergeTotals(leftT, rightT) {
  const bf = MoneyDecimal.formatFixed(MoneyDecimal.add(String(leftT?.bf ?? "0"), String(rightT?.bf ?? "0")).toString(), 2);
  const wl = MoneyDecimal.formatFixedHalfUp(MoneyDecimal.add(String(leftT?.win_loss ?? "0"), String(rightT?.win_loss ?? "0")).toString(), 2);
  const cr = MoneyDecimal.formatFixed(MoneyDecimal.add(String(leftT?.cr_dr ?? "0"), String(rightT?.cr_dr ?? "0")).toString(), 2);
  const bal = MoneyDecimal.formatFixedHalfUp(MoneyDecimal.add(MoneyDecimal.add(bf, wl), cr).toString(), 2);
  return { bf, win_loss: wl, cr_dr: cr, balance: bal };
}

/** Map search grid row → AccountSelect option (legacy accountDataMap match). */
export function resolveGridRowToAccountOption(row, accountOptions) {
  const list = Array.isArray(accountOptions) ? accountOptions : [];
  const dbId = row?.account_db_id != null && String(row.account_db_id).trim() !== "" ? String(row.account_db_id).trim() : "";
  const code = String(row?.account_id || "").trim();
  if (dbId) {
    const byDb = list.find((o) => String(o.id) === dbId);
    if (byDb) return byDb;
    const n = parseInt(dbId, 10);
    if (!Number.isNaN(n)) {
      const byNum = list.find((o) => parseInt(String(o.id), 10) === n);
      if (byNum) return byNum;
    }
  }
  if (code) {
    const u = code.toUpperCase();
    const byCode = list.find((o) => String(o.account_id || "").trim().toUpperCase() === u);
    if (byCode) return byCode;
  }
  if (!dbId && !code) return null;
  return {
    id: dbId || code,
    account_id: code || dbId,
    display_text: code ? `${code}${row.account_name ? ` - ${row.account_name}` : ""}` : String(dbId),
    currency: row.currency || null,
  };
}

/** One row per currency code (scope APIs may return same code with different currency ids). */
export function dedupeCurrencyRowsByCode(rows) {
  const byCode = new Map();
  for (const row of rows) {
    const code = String(row?.code || row?.currency || "")
      .trim()
      .toUpperCase();
    if (!code || byCode.has(code)) continue;
    byCode.set(code, { ...row, code });
  }
  return [...byCode.values()];
}

/**
 * Apply saved API/global/local order to currency rows from get_company_currencies_api.
 * `explicitOrderKey` = company id number, or `g:GROUP` for a pure Group ledger
 * (desktop 5b0455a06e). Falls back to whatever the API says the order belongs to.
 */
export function orderCurrencyRows(orderedData, orderData, explicitOrderKey = null) {
  let ordered = dedupeCurrencyRowsByCode(orderedData);
  try {
    let orderKey = explicitOrderKey;
    if (orderKey == null || orderKey === "") {
      const cid = Number(orderData?.data?.company_id);
      const gid = orderData?.data?.group_id;
      if (Number.isFinite(cid) && cid > 0) orderKey = cid;
      else if (gid) orderKey = `g:${String(gid).trim().toUpperCase()}`;
    }
    const savedOrder = resolveSavedCurrencyOrder(
      orderKey,
      orderData?.success ? orderData?.data?.order : null,
    );
    if (!savedOrder?.length) return ordered;

    const normalized = [];
    savedOrder.forEach((code) => {
      const upper = String(code || "")
        .trim()
        .toUpperCase();
      if (!upper || upper === "ALL") return;
      if (!normalized.includes(upper)) normalized.push(upper);
    });
    const byCode = new Map(
      ordered.map((c) => [
        String(c.code || c.currency || "")
          .trim()
          .toUpperCase(),
        c,
      ]),
    );
    const out = [];
    normalized.forEach((upper) => {
      if (byCode.has(upper)) {
        out.push(byCode.get(upper));
        byCode.delete(upper);
      }
    });
    byCode.forEach((c) => out.push(c));
    return out;
  } catch {
    return ordered;
  }
}

/** Transaction page cold boot: MYR when available, otherwise first listed currency. */
export function pickTransactionDefaultCurrency(codes) {
  const list = (codes || []).map((c) => String(c || "").toUpperCase().trim()).filter(Boolean);
  if (list.includes("MYR")) return "MYR";
  return list[0] || "";
}

export function readTransactionCurrencyFilterState(companyId) {
  if (!companyId) return null;
  try {
    const raw = localStorage.getItem(TRANSACTION_CURRENCY_FILTER_KEY_PREFIX + companyId);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const showAll = !!o.showAll;
    const currencies = Array.isArray(o.currencies) ? o.currencies.map((c) => String(c || "").trim()).filter(Boolean) : [];
    return { showAll, currencies };
  } catch {
    return null;
  }
}

/** @param {Set<number>|null|undefined} typeSearchAccountIds */
export function rowMatchesTypeSearchAccountSet(row, typeSearchAccountIds) {
  if (!typeSearchAccountIds || typeSearchAccountIds.size === 0) return false;
  const dbId = Number(row?.account_db_id);
  if (!Number.isFinite(dbId) || dbId <= 0) return false;
  return typeSearchAccountIds.has(dbId);
}

/** Keep only rows whose account_db_id appears in the all-time type search set. */
export function applyTypeSearchAccountFilter(left, right, typeSearchAccountIds) {
  if (!typeSearchAccountIds || typeSearchAccountIds.size === 0) {
    return { left: [], right: [] };
  }
  const keep = (rows) =>
    (Array.isArray(rows) ? rows : []).filter((row) => rowMatchesTypeSearchAccountSet(row, typeSearchAccountIds));
  return { left: keep(left), right: keep(right) };
}

/** Whether any currency has post-submit focused account ids. */
export function hasSubmitFocusByCurrency(byCurrency) {
  if (!byCurrency || typeof byCurrency !== "object") return false;
  return Object.values(byCurrency).some((ids) => Array.isArray(ids) && ids.length > 0);
}

/** Focused account ids for one currency code (uppercase key in map). */
export function getSubmitFocusAccountIdsForCurrency(byCurrency, currencyCode) {
  const code = String(currencyCode || "").toUpperCase().trim();
  if (!code) return [];
  const ids = byCurrency?.[code];
  return Array.isArray(ids) ? ids : [];
}

/** Row count after the same client filters as the main grid (for search-complete toasts). */
export function countDisplayedRows(rawSearchData, searchState, txType, typeSearchActive = false) {
  if (!rawSearchData) return 0;
  const rawLeft = dedupeRowsByAccountAndCurrency(rawSearchData.left_table || []);
  const rawRight = dedupeRowsByAccountAndCurrency(rawSearchData.right_table || []);
  const z = filterTransactionTableRows(rawLeft, rawRight, {
    showZeroBalance: typeSearchActive ? true : searchState.showZeroBalance,
    showPaymentOnly: typeSearchActive ? false : searchState.showPaymentOnly,
    showCaptureOnly: typeSearchActive ? false : searchState.showCaptureOnly,
  });
  return (z.left?.length || 0) + (z.right?.length || 0);
}

/** Read cached transaction list payload from sessionStorage (same format as saveTxListToSession). */
export function readTxListFromSessionStorage(sessionKey) {
  if (!sessionKey) return null;
  try {
    const raw = sessionStorage.getItem(sessionKey);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.data || (o.v !== 1 && o.v !== 2)) return null;
    const invalidateTs = parseInt(localStorage.getItem(TX_LIST_INVALIDATE_LS_KEY) || "0", 10) || 0;
    const savedAt = o.v === 2 && typeof o.savedAt === "number" ? o.savedAt : 0;
    if (invalidateTs > savedAt) return null;
    return sanitizeSearchApiData(o.data);
  } catch {
    return null;
  }
}

/** Row count in rendered table presentation (after client-side filters). */
export function countTransactionPresentationRows(tp) {
  if (!tp || tp.mode === "none") return 0;
  if (tp.mode === "grouped") {
    return (tp.grouped || []).reduce(
      (sum, g) => sum + (g.left?.length || 0) + (g.right?.length || 0),
      0,
    );
  }
  return (tp.defaultLeft?.length || 0) + (tp.defaultRight?.length || 0);
}

export function hasTransactionCurrencyFilter(showAllCurrencies, selectedCurrencies) {
  return Boolean(showAllCurrencies) || (Array.isArray(selectedCurrencies) && selectedCurrencies.length > 0);
}

export function shouldShowTransactionTablesSection({
  showAllCurrencies,
  selectedCurrencies,
  tablePresentation,
  searchLoading,
}) {
  if (!hasTransactionCurrencyFilter(showAllCurrencies, selectedCurrencies)) return false;
  if (countTransactionPresentationRows(tablePresentation) > 0) return true;
  return Boolean(searchLoading);
}

export function buildTxListSessionKey({
  companyId,
  dateFrom,
  dateTo,
  selectedCategories,
  showInactive,
  showCaptureOnly,
  hideZeroBalance,
  showAllCurrencies,
  selectedCurrencies,
}) {
  if (!dateFrom || !dateTo) return null;
  let cat = "";
  if (selectedCategories.length > 0 && !selectedCategories.includes("")) {
    cat = [...selectedCategories].sort().join(",");
  }
  let cur = "";
  if (!showAllCurrencies && selectedCurrencies.length > 0) {
    cur = [...selectedCurrencies].sort().join(",");
  }
  const cid = companyId != null ? String(companyId) : "";
  const hideZb = hideZeroBalance ? "1" : "0";
  return (
    TX_LIST_SESSION_PREFIX +
    [cid, dateFrom, dateTo, cat, showInactive ? "1" : "0", showCaptureOnly ? "1" : "0", hideZb, cur, showAllCurrencies ? "1" : "0"].join("|")
  );
}
