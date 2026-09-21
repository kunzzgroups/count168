import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { flushSync } from "react-dom";
import { isCancelledError, useQueryClient } from "@tanstack/react-query";
import {
  TRANSACTION_CURRENCY_FILTER_KEY_PREFIX,
  TX_LIST_INVALIDATE_LS_KEY,
  TX_LIST_INVALIDATE_HANDLED_KEY,
  buildTransactionSearchQueryFilters,
  filterTransactionTableRows,
  applySummaryWinLossDisplayTolerance,
  buildTxListSessionKey,
  calculateTotals,
  countDisplayedRows,
  applyTypeSearchAccountFilter,
  hasSubmitFocusByCurrency,
  getSubmitFocusAccountIdsForCurrency,
  readTransactionCurrencyFilterState,
  pickTransactionDefaultCurrency,
  readTxListFromSessionStorage,
  sortByRole,
  applyOptimisticSubmitBalancePatch,
  sanitizeSearchApiData,
  mergeSearchApiDataList,
} from "../lib/transactionPaymentLogic.js";
import {
  searchTransactions as searchTransactionsApi,
  fetchTypeAccountSearch,
  fetchTypeTransactionSearch,
  saveUserCurrencyOrder,
  transactionQueryKeys,
} from "../lib/transactionApi.js";
import { buildOptimisticSubmitDeltas } from "../lib/transactionSubmitHelpers.js";
import { parseDmyToDate } from "../lib/transactionPaymentPageUtils.js";
import { getTxSearchCache, setTxSearchCache, clearTxSearchCache } from "../../../utils/transaction/transactionSearchCache.js";
import {
  buildDefaultSearchApiParams,
  buildTransactionSearchRequestKey,
} from "../lib/transactionScopePrefetch.js";
import {
  buildDashboardCurrencyScopeKey,
  notifyDashboardCurrencyFilterChanged,
} from "../../../utils/company/sharedCompanyFilter.js";

/** Type Search uses Capture Date + search_api period metrics (not all-time grid API). */
/** Period Type Search: Capture Date × all pure manual types (form Type is ignored for filtering). */
const PERIOD_TYPE_SEARCH_TYPES = new Set([
  "CONTRA",
  "PAYMENT",
  "CLAIM",
  "CLEAR",
  "RATE",
  "ADJUSTMENT",
  "PROFIT",
  "ALL",
]);
/** Fixed search form type — list visibility/metrics do not follow the right-side Type dropdown. */
const TYPE_SEARCH_LIST_FORM_TYPE = "ALL";

const INITIAL_TRANSACTION_SEARCH_STATE = {
  showName: false,
  showCaptureOnly: false,
  showPaymentOnly: false,
  showZeroBalance: false,
};

/** Anchor submit-focus Capture Date range at "today": a past tx date extends the range
 *  forward to today, a future tx date extends it backward from today. */
function resolveSubmitFocusDateRange(txDate, todayDmy) {
  const tx = String(txDate || "").trim();
  const today = String(todayDmy || "").trim();
  if (!tx) return { from: today, to: today };
  if (!today || tx === today) return { from: tx, to: tx };
  const txDt = parseDmyToDate(tx);
  const todayDt = parseDmyToDate(today);
  if (!txDt || !todayDt) return { from: tx, to: tx };
  return txDt.getTime() < todayDt.getTime()
    ? { from: tx, to: today }
    : { from: today, to: tx };
}

function syncCaptureDateDom(dateFromDmy, dateToDmy) {
  const from = String(dateFromDmy || "").trim();
  const to = String(dateToDmy || dateFromDmy || "").trim();
  if (!from || !to) return;
  const df = document.getElementById("date_from");
  const dt = document.getElementById("date_to");
  if (df) df.value = from;
  if (dt) dt.value = to;
  if (window.MaintenanceDateRangePicker?.commitRangeToDmy) {
    window.MaintenanceDateRangePicker.commitRangeToDmy(from, to, { triggerOnChange: false });
    return;
  }
  window.MaintenanceDateRangePicker?.refreshInputsDisplay?.({
    dateFromId: "date_from",
    dateToId: "date_to",
    displayId: "date-range-display",
  });
}
import {
  persistCurrencyDisplayOrder,
  persistUserCurrencyDisplayOrder,
  resolveSavedCurrencyOrder,
} from "../../../utils/company/currencyDisplayOrder.js";
import { useCrossPageCurrencySync } from "../../../utils/company/useCrossPageCurrencySync.js";
import {
  transactionScopeApiParams,
  transactionScopeCacheCompanyKey,
  transactionScopeCacheKey,
  transactionScopeIsReady,
  resolveTransactionCurrencyOrderParams,
  resolveTransactionCurrencyOrderCacheKey,
} from "../lib/transactionScope.js";

export function useTransactionSearch({
  filterSnapshot,
  transactionScope,
  currencyScopeBundle,
  todayDmy,
  pushToast,
  txType,
  currencyRowsOrdered,
  setCurrencyRowsOrdered,
  m,
  t,
}) {
  const [dateFrom, setDateFrom] = useState(null);
  const [dateTo, setDateTo] = useState(null);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [searchState, setSearchState] = useState({ ...INITIAL_TRANSACTION_SEARCH_STATE });
  const [showAllCurrencies, setShowAllCurrencies] = useState(false);
  const [selectedCurrencies, setSelectedCurrencies] = useState([]);
  /** Block cross-page currency sync when All or multi-select is active (empty currentCode would re-apply MYR etc.). */
  const suppressCrossPageCurrencyRef = useRef(false);
  /** Until user changes currency, keep ordered-first default on cold boot (ignore dashboard cross-page sync). */
  const bootCurrencyDefaultRef = useRef(true);
  const coldBootCurrencyAppliedRef = useRef(false);
  /** Snapshot of selected currencies immediately before entering All — restored when All is toggled off. */
  const currenciesBeforeAllRef = useRef([]);
  /**
   * Left filters as of last Type Search entry — restored on exit.
   * Snapshot taken once per entry; silent/preserveCurrencyFilter re-runs do not overwrite.
   * Never overwritten by in-session Submit focus (tx date / currency).
   */
  const filtersBeforeTypeSearchRef = useRef(null);
  /** True from Type Search entry until exit (includes post-submit submit-focus within that session). */
  const typeSearchSessionActiveRef = useRef(false);
  /** First Submit inside a Type Search session already applied tx-date + tx-currency focus. */
  const typeSearchFirstSubmitFocusDoneRef = useRef(false);
  const [rawSearchData, setRawSearchData] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [tablesVisible, setTablesVisible] = useState(false);
  /** Right-side type search mode (server filters account list via type_account_ids). */
  const [typeSearchActive, setTypeSearchActive] = useState(false);
  const [typeSearchAccountIds, setTypeSearchAccountIds] = useState([]);
  const [typeSearchFormType, setTypeSearchFormType] = useState(null);
  /** Post-submit focused rows per currency: { MYR: [ids], SGD: [ids] } on current capture range. */
  const [submitFocusByCurrency, setSubmitFocusByCurrency] = useState({});
  const [submitFocusRangeKey, setSubmitFocusRangeKey] = useState(null);
  /** Capture ranges left while in submit-focus — returning runs full Type Search (scheme A). */
  const submitFocusLeftRangeKeysRef = useRef(new Set());

  const queryClient = useQueryClient();
  const latestRunTokenRef = useRef(0);
  const lastCompletedSearchKeyRef = useRef("");
  const lastCompletedSearchTsRef = useRef(0);
  const categoryChangedByUserRef = useRef(false);
  const initialSearchDoneRef = useRef(false);
  const lastSearchCommitMsRef = useRef(0);
  const runSearchRef = useRef(null);
  const runTypeSearchRef = useRef(null);
  const typeSearchActiveRef = useRef(false);
  const typeSearchFormTypeRef = useRef(null);
  const showAllCurrenciesRef = useRef(false);
  const selectedCurrenciesRef = useRef([]);
  const autoSearchTimerRef = useRef(null);
  /** Tracks last server-side filter chips; null until after first search commit (avoids duplicate fetch on mount). */
  const prevServerSideFiltersRef = useRef(null);
  /** After a real company switch, skip one blocking "Loading data" overlay (still fetch in background). */
  const suppressBlockingOverlayOnceRef = useRef(false);
  const prevScopeKeyForSearchRef = useRef(null);
  /** Detect company strip switch — reset Category / date / display chips (not Currency). */
  const prevCompanyIdForFilterResetRef = useRef(null);
  /** Capture Date 变更后触发搜索；与「仅首次拉数」的 initial effect 分离，避免 initialSearchDoneRef 为 true 时改日期不请求 */
  const prevCaptureDateRangeKeyRef = useRef(null);
  /** First approved submit may jump Capture Date to the tx date; later submits keep the current range. */
  const hasAutoJumpedCaptureDateOnSubmitRef = useRef(false);
  const lastInitialSearchKeyRef = useRef("");
  /** Set while Type Search auto-applies currency (ALL / detected codes) — blocks default list re-fetch. */
  const suppressCurrencyDefaultSearchRef = useRef(false);
  const earlyCurrencyScopeRef = useRef(null);
  const [categoryOpen, setCategoryOpen] = useState(false);

  const categoryAllCheckboxRef = useRef(null);
  const effectiveDateFrom = dateFrom || todayDmy;
  const effectiveDateTo = dateTo || todayDmy;
  const effectiveDateRangeText = `${effectiveDateFrom} - ${effectiveDateTo}`;
  const captureRangeKey = `${effectiveDateFrom}|${effectiveDateTo}`;
  const submitFocusActive =
    hasSubmitFocusByCurrency(submitFocusByCurrency) && submitFocusRangeKey === captureRangeKey;
  const listPresentationModeActive = typeSearchActive || submitFocusActive;
  const selectedCurrenciesKey = selectedCurrencies.map((c) => String(c || "").toUpperCase()).join(",");
  const scopeViewGroup = transactionScope?.viewGroup ?? null;
  const scopeReady = transactionScopeIsReady(transactionScope);
  const scopeApi = useMemo(() => transactionScopeApiParams(transactionScope), [transactionScope]);
  const scopeCacheCompanyKey = transactionScopeCacheCompanyKey(transactionScope);
  const scopeKey = transactionScopeCacheKey(transactionScope) || null;
  const orderParams = useMemo(
    () =>
      resolveTransactionCurrencyOrderParams(
        transactionScope,
        filterSnapshot?.snapCompaniesAll || filterSnapshot?.snapCompanies,
      ),
    [transactionScope, filterSnapshot?.snapCompanies, filterSnapshot?.snapCompaniesAll],
  );
  const orderCacheKey = useMemo(
    () =>
      resolveTransactionCurrencyOrderCacheKey(
        transactionScope,
        filterSnapshot?.snapCompaniesAll || filterSnapshot?.snapCompanies,
      ),
    [transactionScope, filterSnapshot?.snapCompanies, filterSnapshot?.snapCompaniesAll],
  );

  const persistCurrencyFilter = useCallback((companyId, showAll, sel, scopeGroup = null) => {
    if (!companyId) return;
    try {
      localStorage.setItem(
        TRANSACTION_CURRENCY_FILTER_KEY_PREFIX + companyId,
        JSON.stringify({ showAll: !!showAll, currencies: [...(sel || [])] }),
      );
      if (!showAll && sel?.length >= 1) {
        const scopeKey =
          buildDashboardCurrencyScopeKey({
            companyId: /^\d+$/.test(String(companyId)) ? Number(companyId) : null,
            selectedGroup: scopeGroup,
          }) || String(companyId);
        notifyDashboardCurrencyFilterChanged(sel[sel.length - 1], scopeKey);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCategory = useCallback(() => setCategoryOpen((v) => !v), []);

  const onCategoryAllChange = useCallback((checked) => {
    if (!checked) return;
    categoryChangedByUserRef.current = true;
    setSelectedCategories([]);
  }, []);

  const toggleCategoryValue = useCallback((value) => {
    const v = String(value || "").toUpperCase().trim();
    categoryChangedByUserRef.current = true;
    setSelectedCategories((prev) => {
      const set = new Set(prev.map((x) => String(x).toUpperCase()));
      if (set.has(v)) set.delete(v);
      else set.add(v);
      return [...set];
    });
  }, []);

  const removeCategoryTag = useCallback((categoryValue) => {
    const v = String(categoryValue || "").toUpperCase().trim();
    setSelectedCategories((prev) => prev.filter((x) => String(x).toUpperCase() !== v));
    // Trigger search after state update
    categoryChangedByUserRef.current = true;
  }, []);

  const scheduleAutoSearch = useCallback(({ isInitialLoad = false, delayMs = 260, forceRefresh = false } = {}) => {
    if (autoSearchTimerRef.current) clearTimeout(autoSearchTimerRef.current);
    autoSearchTimerRef.current = setTimeout(() => {
      autoSearchTimerRef.current = null;
      if (typeSearchActiveRef.current && typeSearchFormTypeRef.current) {
        void runTypeSearchRef.current?.(typeSearchFormTypeRef.current, {
          preserveCurrencyFilter: true,
          silent: true,
          forceRefresh,
        });
        return;
      }
      void runSearchRef.current?.({
        silent: true,
        notifyErrors: true,
        showBlockingOverlay: false,
        isInitialLoad,
        forceRefresh,
      });
    }, delayMs);
  }, []);

  const txCurrencyCodes = useMemo(
    () =>
      (currencyRowsOrdered || [])
        .map((r) => String(r.code || "").toUpperCase().trim())
        .filter(Boolean),
    [currencyRowsOrdered],
  );

  const beginScopeCurrencyDefault = useCallback(() => {
    bootCurrencyDefaultRef.current = true;
    suppressCrossPageCurrencyRef.current = true;
  }, []);

  const notifySingleCurrencyIfNeeded = useCallback(
    (codes) => {
      if (!Array.isArray(codes) || codes.length !== 1) return;
      const scopeKey =
        buildDashboardCurrencyScopeKey({
          companyId:
            transactionScope?.scopeCompanyId > 0 ? transactionScope.scopeCompanyId : null,
          selectedGroup: transactionScope?.selectedGroup ?? scopeViewGroup,
        }) || String(scopeCacheCompanyKey);
      notifyDashboardCurrencyFilterChanged(codes[0], scopeKey);
    },
    [
      scopeCacheCompanyKey,
      transactionScope?.selectedGroup,
      transactionScope?.scopeCompanyId,
      scopeViewGroup,
    ],
  );

  const toggleAllCurrenciesBtn = useCallback(() => {
    if (txCurrencyCodes.length < 2) return;
    bootCurrencyDefaultRef.current = false;
    if (showAllCurrencies) {
      const avail = new Set(txCurrencyCodes);
      const restored = currenciesBeforeAllRef.current
        .map((c) => String(c || "").toUpperCase().trim())
        .filter((c) => c && avail.has(c));
      // Restore prior selection as-is (including empty → no lists).
      const nextSel = restored;

      suppressCrossPageCurrencyRef.current = nextSel.length !== 1;
      setShowAllCurrencies(false);
      setSelectedCurrencies(nextSel);
      persistCurrencyFilter(scopeCacheCompanyKey, false, nextSel, transactionScope?.selectedGroup);
      notifySingleCurrencyIfNeeded(nextSel);
      if (nextSel.length === 0) {
        setRawSearchData(null);
        setTablesVisible(false);
        return;
      }
      scheduleAutoSearch();
      return;
    }

    currenciesBeforeAllRef.current = selectedCurrencies
      .map((c) => String(c || "").toUpperCase().trim())
      .filter(Boolean);
    suppressCrossPageCurrencyRef.current = true;
    setShowAllCurrencies(true);
    setSelectedCurrencies([]);
    persistCurrencyFilter(scopeCacheCompanyKey, true, [], transactionScope?.selectedGroup);
    scheduleAutoSearch();
  }, [
    showAllCurrencies,
    selectedCurrencies,
    txCurrencyCodes,
    scopeCacheCompanyKey,
    persistCurrencyFilter,
    scheduleAutoSearch,
    transactionScope?.selectedGroup,
    notifySingleCurrencyIfNeeded,
  ]);

  /** All 仅在两种及以上货币时可用；仅一种时退出 All 并选中该货币。 */
  useEffect(() => {
    if (txCurrencyCodes.length >= 2 || !showAllCurrencies) return;
    const code = txCurrencyCodes[0];
    setShowAllCurrencies(false);
    setSelectedCurrencies(code ? [code] : []);
    persistCurrencyFilter(
      scopeCacheCompanyKey,
      false,
      code ? [code] : [],
      transactionScope?.selectedGroup,
    );
    if (code) notifySingleCurrencyIfNeeded([code]);
    scheduleAutoSearch();
  }, [
    txCurrencyCodes,
    showAllCurrencies,
    scopeCacheCompanyKey,
    transactionScope?.selectedGroup,
    persistCurrencyFilter,
    notifySingleCurrencyIfNeeded,
    scheduleAutoSearch,
  ]);

  suppressCrossPageCurrencyRef.current =
    showAllCurrencies || selectedCurrencies.length !== 1;

  const applyCrossPageCurrency = useCallback(
    (code) => {
      if (bootCurrencyDefaultRef.current) return;
      const c = String(code || "").toUpperCase().trim();
      if (!c || suppressCrossPageCurrencyRef.current) return;
      setShowAllCurrencies(false);
      setSelectedCurrencies([c]);
      persistCurrencyFilter(
        scopeCacheCompanyKey,
        false,
        [c],
        transactionScope?.selectedGroup,
      );
      scheduleAutoSearch();
    },
    [
      scopeCacheCompanyKey,
      persistCurrencyFilter,
      scheduleAutoSearch,
      transactionScope?.selectedGroup,
    ],
  );

  useCrossPageCurrencySync({
    enabled: txCurrencyCodes.length > 0 && scopeReady,
    companyId:
      transactionScope?.scopeCompanyId > 0
        ? transactionScope.scopeCompanyId
        : null,
    selectedGroup: transactionScope?.selectedGroup ?? scopeViewGroup,
    availableCodes: txCurrencyCodes,
    currentCode: selectedCurrencies.length === 1 ? selectedCurrencies[0] : "",
    onApplyCode: applyCrossPageCurrency,
    suppressRef: suppressCrossPageCurrencyRef,
    respectEmptyRef: suppressCrossPageCurrencyRef,
  });

  const toggleCurrencyBtn = useCallback(
    (code) => {
      bootCurrencyDefaultRef.current = false;
      const c = String(code || "").toUpperCase().trim();
      if (!c) return;

      const set = new Set(selectedCurrencies.map((x) => String(x || "").toUpperCase().trim()));
      if (set.has(c)) {
        set.delete(c);
      } else {
        set.add(c);
      }
      const nextSel = [...set];
      const nextShowAll = false;

      // Empty selection is allowed: hide lists (no search) until a currency is chosen again.
      // Set before notify/state — cross-page listener runs synchronously and would collapse multi-select.
      suppressCrossPageCurrencyRef.current = nextShowAll || nextSel.length !== 1;

      setShowAllCurrencies(nextShowAll);
      setSelectedCurrencies(nextSel);
      persistCurrencyFilter(scopeCacheCompanyKey, nextShowAll, nextSel, transactionScope?.selectedGroup);
      notifySingleCurrencyIfNeeded(nextSel);
      if (nextSel.length === 0) {
        setRawSearchData(null);
        setTablesVisible(false);
        return;
      }
      scheduleAutoSearch();
    },
    [
      selectedCurrencies,
      scopeCacheCompanyKey,
      persistCurrencyFilter,
      scheduleAutoSearch,
      transactionScope?.selectedGroup,
      notifySingleCurrencyIfNeeded,
    ],
  );

  typeSearchActiveRef.current = typeSearchActive;
  typeSearchFormTypeRef.current = typeSearchFormType;
  showAllCurrenciesRef.current = showAllCurrencies;
  selectedCurrenciesRef.current = selectedCurrencies;

  const onCurrencyDragStart = useCallback((code) => {
    window.__dragging_currency_code = code;
  }, []);

  const onCurrencyDropOn = useCallback(
    async (targetCode) => {
      const sourceCode = window.__dragging_currency_code;
      delete window.__dragging_currency_code;
      if (!sourceCode || sourceCode === targetCode) return;

      const list = [...currencyRowsOrdered];
      const sIdx = list.findIndex((x) => x.code === sourceCode);
      const tIdx = list.findIndex((x) => x.code === targetCode);
      if (sIdx === -1 || tIdx === -1) return;

      const [moved] = list.splice(sIdx, 1);
      list.splice(tIdx, 0, moved);

      setCurrencyRowsOrdered(list);
      const codes = list.map((x) => String(x.code || x.currency || "").trim().toUpperCase()).filter(Boolean);
      // Cross-page sync: keep the user-global order in step so every page follows this drag.
      persistUserCurrencyDisplayOrder(codes);
      if (orderCacheKey != null) {
        persistCurrencyDisplayOrder(orderCacheKey, codes);
      }
      try {
        await saveUserCurrencyOrder(codes, {
          companyId: orderParams.companyId ?? undefined,
          groupId: orderParams.groupId ?? undefined,
        });
        if (orderCacheKey != null) {
          await queryClient.invalidateQueries({
            queryKey: [...transactionQueryKeys.userCurrencyOrder(), orderCacheKey],
          });
        }
      } catch {
        /* localStorage already updated */
      }
    },
    [currencyRowsOrdered, setCurrencyRowsOrdered, orderCacheKey, orderParams, queryClient],
  );

  useEffect(() => {
    if (!categoryOpen) return;
    const close = (e) => {
      if (e.target.closest?.(".category-dropdown")) return;
      setCategoryOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [categoryOpen]);

  // Category-only auto search (currency toggles call scheduleAutoSearch directly; they are not gated by this ref).
  useEffect(() => {
    if (!categoryChangedByUserRef.current) return;
    categoryChangedByUserRef.current = false;
    if (!scopeReady) return;
    if (!effectiveDateFrom || !effectiveDateTo) return;
    if (!showAllCurrencies && selectedCurrencies.length === 0) return;
    scheduleAutoSearch();
  }, [
    selectedCategories,
    scopeReady,
    effectiveDateFrom,
    effectiveDateTo,
    effectiveDateRangeText,
    showAllCurrencies,
    selectedCurrencies,
    scheduleAutoSearch,
  ]);

  // Show 0 balance / Payment Only / Win-Loss Only 均影响 API 参数或组合范围，切换后必须重搜。
  // Type Search / submit-focus: chips may toggle for UI only — do not re-search or leave the mode.
  useEffect(() => {
    if (!initialSearchDoneRef.current) return;
    if (!scopeReady) return;
    if (!effectiveDateFrom || !effectiveDateTo) return;
    if (!showAllCurrencies && selectedCurrencies.length === 0) return;

    const current = {
      showPaymentOnly: searchState.showPaymentOnly,
      showCaptureOnly: searchState.showCaptureOnly,
      showZeroBalance: searchState.showZeroBalance,
    };

    if (prevServerSideFiltersRef.current === null) {
      prevServerSideFiltersRef.current = current;
      return;
    }

    const prev = prevServerSideFiltersRef.current;
    const zeroBalanceChanged = prev.showZeroBalance !== current.showZeroBalance;
    const filtersChanged =
      zeroBalanceChanged ||
      prev.showPaymentOnly !== current.showPaymentOnly ||
      prev.showCaptureOnly !== current.showCaptureOnly;

    prevServerSideFiltersRef.current = current;

    if (!filtersChanged) return;
    if (typeSearchActive || submitFocusActive) return;

    scheduleAutoSearch({ delayMs: 80, forceRefresh: zeroBalanceChanged });
  }, [
    searchState.showPaymentOnly,
    searchState.showCaptureOnly,
    searchState.showZeroBalance,
    scopeReady,
    effectiveDateFrom,
    effectiveDateTo,
    showAllCurrencies,
    selectedCurrenciesKey,
    scheduleAutoSearch,
    typeSearchActive,
    submitFocusActive,
  ]);

  const saveTxListToSession = useCallback(
    (data) => {
      try {
        const queryFilters = buildTransactionSearchQueryFilters(searchState);
        const key = buildTxListSessionKey({
          companyId: scopeCacheCompanyKey,
          dateFrom: effectiveDateFrom,
          dateTo: effectiveDateTo,
          selectedCategories,
          showInactive: queryFilters.showInactiveForQuery,
          showCaptureOnly: queryFilters.showCaptureOnlyForQuery,
          hideZeroBalance: queryFilters.hideZeroBalanceForQuery,
          showAllCurrencies,
          selectedCurrencies,
        });
        if (!key || !data) return;
        const ts = Date.now();
        const wrap = JSON.stringify({ v: 2, savedAt: ts, data });
        if (wrap.length > 1800000) return;
        sessionStorage.setItem(key, wrap);
        lastSearchCommitMsRef.current = ts;
      } catch {
        /* quota */
      }
    },
    [
      scopeCacheCompanyKey,
      effectiveDateFrom,
      effectiveDateTo,
      selectedCategories,
      searchState.showPaymentOnly,
      searchState.showCaptureOnly,
      searchState.showZeroBalance,
      showAllCurrencies,
      selectedCurrencies,
    ],
  );

  const runSearch = useCallback(
    async ({
      silent = false,
      isInitialLoad = false,
      forceRefresh = false,
      notifyErrors: notifyErrorsOpt,
      showBlockingOverlay: showBlockingOverlayOpt,
      searchStateOverride = null,
      typeAccountIdsOverride = undefined,
      typeSearchFormTypeOverride = undefined,
      typeSearchOverride = undefined,
      dateFromOverride = undefined,
      dateToOverride = undefined,
      selectedCategoriesOverride = undefined,
      showAllCurrenciesOverride = undefined,
      selectedCurrenciesOverride = undefined,
    } = {}) => {
      const cid = scopeCacheCompanyKey;
      const notifyErr = notifyErrorsOpt !== undefined ? notifyErrorsOpt : !silent;
      const queryDateFrom = String(dateFromOverride ?? effectiveDateFrom ?? "").trim();
      const queryDateTo = String(dateToOverride ?? effectiveDateTo ?? "").trim();
      const effectiveCategories = selectedCategoriesOverride ?? selectedCategories;
      const effectiveShowAll = showAllCurrenciesOverride ?? showAllCurrencies;
      const effectiveSelectedCurrencies = selectedCurrenciesOverride ?? selectedCurrencies;
      if (!scopeReady || !cid) return;
      if (!queryDateFrom || !queryDateTo) {
        pushToast(m.pleaseSelectDateRange, "error");
        return;
      }
      if (!effectiveShowAll && effectiveSelectedCurrencies.length === 0) {
        setRawSearchData(null);
        setTablesVisible(false);
        return;
      }

      const effectiveSearchState = searchStateOverride ?? searchState;
      let activeTypeSearch =
        typeSearchOverride === true || (typeSearchOverride !== false && typeSearchActive);
      if (typeSearchOverride !== true && typeSearchActive) {
        setTypeSearchActive(false);
        setTypeSearchFormType(null);
        setTypeSearchAccountIds([]);
        activeTypeSearch = false;
      }
      const accountIdsForType =
        typeAccountIdsOverride !== undefined
          ? typeAccountIdsOverride
          : activeTypeSearch
            ? typeSearchAccountIds
            : [];
      const presentationFormType = activeTypeSearch
        ? TYPE_SEARCH_LIST_FORM_TYPE
        : typeSearchFormTypeOverride ?? typeSearchFormType ?? txType;

      const categoryParam =
        effectiveCategories.length > 0 && !effectiveCategories.includes("")
          ? [...effectiveCategories].sort().join(",")
          : "";
      const singleSelectedCurrency =
        !effectiveShowAll && effectiveSelectedCurrencies.length === 1
          ? String(effectiveSelectedCurrencies[0] || "").toUpperCase()
          : "";

      const queryFilters = buildTransactionSearchQueryFilters(effectiveSearchState);
      const { showInactiveForQuery, showCaptureOnlyForQuery, hideZeroBalanceForQuery } = queryFilters;
      const hideZeroForApi = activeTypeSearch ? false : hideZeroBalanceForQuery;

      const requestKey = buildTransactionSearchRequestKey({
        scopeCacheCompanyKey: cid,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        categoryParam,
        showInactive: showInactiveForQuery,
        showCaptureOnly: showCaptureOnlyForQuery,
        hideZeroBalance: hideZeroForApi,
        showAllCurrencies: effectiveShowAll,
        selectedCurrencies: effectiveSelectedCurrencies,
        typeSearch: activeTypeSearch,
        typeAccountIds: accountIdsForType,
        typeSearchFormType: activeTypeSearch ? presentationFormType : "",
      });

      if (!isInitialLoad && !forceRefresh && lastCompletedSearchKeyRef.current === requestKey && Date.now() - lastCompletedSearchTsRef.current < 1200) {
        return;
      }

      const sessionKey = buildTxListSessionKey({
        companyId: cid,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        selectedCategories: effectiveCategories,
        showInactive: showInactiveForQuery,
        showCaptureOnly: showCaptureOnlyForQuery,
        hideZeroBalance: hideZeroForApi,
        showAllCurrencies: effectiveShowAll,
        selectedCurrencies: effectiveSelectedCurrencies,
      });

      if (forceRefresh) {
        clearTxSearchCache();
        try {
          if (sessionKey) sessionStorage.removeItem(sessionKey);
        } catch {
          /* ignore */
        }
        await queryClient.invalidateQueries({ queryKey: transactionQueryKeys.searchRoot() });
      }

      let instantData = null;
      if (!forceRefresh) {
        instantData =
          getTxSearchCache(requestKey) ?? (sessionKey ? readTxListFromSessionStorage(sessionKey) : null);
      }

      let blockOverlay = showBlockingOverlayOpt !== undefined ? showBlockingOverlayOpt : !silent;
      // Never suppress the tables loading indicator when we have nothing to paint —
      // isInitialLoad / company-switch suppress used to leave a silent blank under slow nets.
      const hasExistingData = Boolean(instantData || rawSearchData);
      if (showBlockingOverlayOpt === undefined) {
        if ((isInitialLoad || suppressBlockingOverlayOnceRef.current) && hasExistingData) {
          blockOverlay = false;
        }
      }
      if (suppressBlockingOverlayOnceRef.current) {
        suppressBlockingOverlayOnceRef.current = false;
      }

      const runToken = ++latestRunTokenRef.current;

      if (instantData) {
        setRawSearchData(instantData);
        const instantRows =
          (instantData.left_table?.length || 0) + (instantData.right_table?.length || 0);
        setTablesVisible(instantRows > 0);
      }

      let didSetBlockingLoading = false;
      const showLoadingIndicator = blockOverlay && !hasExistingData;
      if (showLoadingIndicator) {
        setSearchLoading(true);
        didSetBlockingLoading = true;
      }
      if (!instantData) {
        setTablesVisible((prev) => (showLoadingIndicator || prev ? true : prev));
      }

      const subsidiarySearch =
        scopeApi.subsidiaryAccountsOnly ||
        (scopeApi.companyId != null && Number(scopeApi.companyId) > 0);
      const paramsBase = {
        ...scopeApi,
        // Search must not send view_group when drilling into a subsidiary — backend would treat it as group ledger.
        viewGroup: subsidiarySearch ? undefined : scopeApi.viewGroup,
        groupId: subsidiarySearch ? undefined : scopeApi.groupId,
        groupAggregate: subsidiarySearch ? undefined : scopeApi.groupAggregate,
        subsidiaryAccountsOnly: subsidiarySearch ? true : scopeApi.subsidiaryAccountsOnly,
        dateFrom: queryDateFrom,
        dateTo: queryDateTo,
        showInactive: showInactiveForQuery,
        showCaptureOnly: showCaptureOnlyForQuery,
        hideZeroBalance: hideZeroForApi,
        categories: effectiveCategories.length > 0 ? effectiveCategories : undefined,
        currencyCodes:
          !effectiveShowAll && effectiveSelectedCurrencies.length > 0 ? effectiveSelectedCurrencies : undefined,
        typeSearch: activeTypeSearch,
        typeAccountIds: activeTypeSearch ? accountIdsForType : undefined,
        typeSearchFormType: activeTypeSearch ? presentationFormType : undefined,
      };

      const fetchSearch = (params) =>
        queryClient.fetchQuery({
          queryKey: transactionQueryKeys.search(params),
          queryFn: ({ signal }) =>
            searchTransactionsApi({ ...params, skipCache: Boolean(forceRefresh), signal }),
          // forceRefresh (e.g. right after submit): bypass React Query staleTime so the
          // table reflects the new transaction immediately instead of returning cached data.
          staleTime: forceRefresh ? 0 : 5 * 60_000,
          gcTime: 15 * 60_000,
        });

      const commitQuiet = (data) => {
        const cleaned = sanitizeSearchApiData(data);
        setRawSearchData(cleaned);
        setTxSearchCache(requestKey, cleaned);
        saveTxListToSession(cleaned);
        lastCompletedSearchKeyRef.current = requestKey;
        lastCompletedSearchTsRef.current = Date.now();
        const displayed = countDisplayedRows(cleaned, effectiveSearchState, presentationFormType, activeTypeSearch);
        setTablesVisible(displayed > 0);
        if (!silent && displayed > 0) {
          pushToast(t("searchCompletedFoundRecords", { displayed }), "success");
        }
      };

      try {
        let currentData = null;
        if (transactionScope?.mode === "aggregate" && transactionScope.mergeCompanyIds?.length) {
          const results = await Promise.all(
            transactionScope.mergeCompanyIds.map((cid) =>
              fetchSearch({
                ...paramsBase,
                companyId: cid,
                viewGroup: scopeViewGroup || undefined,
                groupId: undefined,
              }),
            ),
          );
          if (latestRunTokenRef.current !== runToken) return;
          const payloads = results.filter((r) => r?.success && r?.data).map((r) => r.data);
          if (!payloads.length) {
            if (notifyErr) pushToast(m.searchFailed, "error");
            return;
          }
          currentData = mergeSearchApiDataList(payloads);
        } else {
          const result = await fetchSearch(paramsBase);
          if (latestRunTokenRef.current !== runToken) return;
          if (!result?.success || !result?.data) {
            if (notifyErr) {
              pushToast(result?.message || result?.error || m.searchFailed, "error");
            }
            return;
          }
          currentData = result.data;
        }
        const leftRows = Array.isArray(currentData.left_table) ? currentData.left_table : [];
        const rightRows = Array.isArray(currentData.right_table) ? currentData.right_table : [];
        const totalAccounts = leftRows.length + rightRows.length;

        if (singleSelectedCurrency && totalAccounts === 0) {
          const fallback = await fetchSearch({
            ...paramsBase,
            currencyCodes: undefined,
          });
          if (latestRunTokenRef.current !== runToken) return;
          if (fallback?.success && fallback?.data) {
            const fbLeft = (fallback.data.left_table || []).filter(
              (row) => String(row?.currency || "").toUpperCase() === singleSelectedCurrency,
            );
            const fbRight = (fallback.data.right_table || []).filter(
              (row) => String(row?.currency || "").toUpperCase() === singleSelectedCurrency,
            );
            currentData = {
              ...fallback.data,
              left_table: fbLeft,
              right_table: fbRight,
              totals: {
                left: calculateTotals(fbLeft),
                right: calculateTotals(fbRight),
                summary: applySummaryWinLossDisplayTolerance(calculateTotals([...fbLeft, ...fbRight])),
              },
            };
          }
        } else if (effectiveSearchState.showCaptureOnly && totalAccounts === 0) {
          const fallback = await fetchSearch({
            ...paramsBase,
            showCaptureOnly: false,
          });
          if (latestRunTokenRef.current !== runToken) return;
          if (fallback?.success && fallback?.data?.totals) {
            currentData = {
              ...currentData,
              totals: fallback.data.totals,
            };
          }
        }

        if (latestRunTokenRef.current !== runToken) return;
        commitQuiet(currentData);
      } catch (e) {
        if (e?.name === "AbortError" || isCancelledError(e)) return;
        console.error(e);
        if (notifyErr) pushToast(t("searchFailedWithMessage", { message: e.message }), "error");
      } finally {
        if (didSetBlockingLoading) setSearchLoading(false);
      }
    },
    [
      scopeReady,
      scopeApi,
      scopeCacheCompanyKey,
      effectiveDateFrom,
      effectiveDateTo,
      showAllCurrencies,
      selectedCurrencies,
      selectedCategories,
      searchState,
      pushToast,
      saveTxListToSession,
      queryClient,
      txType,
      typeSearchActive,
      typeSearchAccountIds,
      typeSearchFormType,
      rawSearchData,
      m,
      t,
    ],
  );
  runSearchRef.current = runSearch;

  const runTypeSearch = useCallback(
    async (formTxType, opts = {}) => {
      const {
        dateFrom: dateFromOverride,
        dateTo: dateToOverride,
        silent = false,
        preserveSearchState = false,
        forceRefresh = false,
        preserveCurrencyFilter = false,
        showAllCurrenciesOverride = undefined,
        selectedCurrenciesOverride = undefined,
      } = opts;
      const normalizedType = String(formTxType || "").toUpperCase().trim();
      if (!normalizedType) return;

      // First entry into Type Search: snapshot left filters, clear to today, then
      // discover currencies with pure manual (Submit-type) activity today.
      // None → MYR; some → select exactly those codes (not ALL).
      let categoriesForQuery = selectedCategories;
      let didApplyTypeSearchEntryClear = false;
      let resolvedDateFromOverride = dateFromOverride;
      let resolvedDateToOverride = dateToOverride;
      let resolvedShowAllOverride = showAllCurrenciesOverride;
      let resolvedSelectedOverride = selectedCurrenciesOverride;
      let entryFocusCurrencyFallback = null;

      if (!typeSearchActiveRef.current && !preserveCurrencyFilter) {
        const today = String(todayDmy || "").trim();
        const availableCodes = (txCurrencyCodes || [])
          .map((c) => String(c || "").toUpperCase().trim())
          .filter(Boolean);
        entryFocusCurrencyFallback =
          pickTransactionDefaultCurrency(availableCodes) || availableCodes[0] || "MYR";

        if (today) {
          if (!filtersBeforeTypeSearchRef.current) {
            filtersBeforeTypeSearchRef.current = {
              selectedCategories: [...selectedCategories],
              dateFrom: String(effectiveDateFrom || "").trim(),
              dateTo: String(effectiveDateTo || "").trim(),
              showAllCurrencies: !!showAllCurrencies,
              selectedCurrencies: (selectedCurrencies || [])
                .map((c) => String(c || "").toUpperCase().trim())
                .filter(Boolean),
              searchState: {
                showName: !!searchState.showName,
                showPaymentOnly: !!searchState.showPaymentOnly,
                showCaptureOnly: !!searchState.showCaptureOnly,
                showZeroBalance: !!searchState.showZeroBalance,
              },
            };
          }
          typeSearchSessionActiveRef.current = true;
          typeSearchFirstSubmitFocusDoneRef.current = false;

          didApplyTypeSearchEntryClear = true;
          categoriesForQuery = [];
          setSelectedCategories([]);
          categoryChangedByUserRef.current = false;
          setDateFrom(today);
          setDateTo(today);
          syncCaptureDateDom(today);
          prevCaptureDateRangeKeyRef.current = `${today}|${today}`;

          if (!preserveSearchState) {
            setSearchState({ ...INITIAL_TRANSACTION_SEARCH_STATE });
            prevServerSideFiltersRef.current = {
              showPaymentOnly: false,
              showCaptureOnly: false,
              showZeroBalance: false,
            };
          }

          // Discover across all currencies for today; narrow after results.
          resolvedDateFromOverride = today;
          resolvedDateToOverride = today;
          resolvedShowAllOverride = true;
          resolvedSelectedOverride = [];
        }
      }

      const queryShowAll =
        resolvedShowAllOverride !== undefined
          ? resolvedShowAllOverride
          : preserveCurrencyFilter
            ? showAllCurrenciesRef.current
            : showAllCurrencies;
      const querySelectedRaw =
        resolvedSelectedOverride !== undefined
          ? resolvedSelectedOverride
          : preserveCurrencyFilter
            ? selectedCurrenciesRef.current
            : selectedCurrencies;
      const querySelected = (Array.isArray(querySelectedRaw) ? querySelectedRaw : [])
        .map((c) => String(c || "").toUpperCase().trim())
        .filter(Boolean);

      if (preserveCurrencyFilter && !queryShowAll && querySelected.length === 0) {
        setRawSearchData(null);
        setTablesVisible(false);
        return;
      }

      if (autoSearchTimerRef.current) {
        clearTimeout(autoSearchTimerRef.current);
        autoSearchTimerRef.current = null;
      }
      latestRunTokenRef.current += 1;

      setSubmitFocusByCurrency({});
      setSubmitFocusRangeKey(null);

      if (!preserveSearchState && !didApplyTypeSearchEntryClear) {
        const clearedState = {
          showName: false,
          showPaymentOnly: false,
          showCaptureOnly: false,
          showZeroBalance: false,
        };
        setSearchState((prev) => ({ ...prev, ...clearedState }));
      }

      if (!scopeReady || !scopeCacheCompanyKey) return;
      const queryDateFrom = String(resolvedDateFromOverride ?? effectiveDateFrom ?? "").trim();
      const queryDateTo = String(resolvedDateToOverride ?? effectiveDateTo ?? "").trim();
      if (!queryDateFrom || !queryDateTo) {
        pushToast(m.pleaseSelectDateRange, "error");
        return;
      }

      setSearchLoading(true);
      try {
        if (forceRefresh) {
          // Only invalidate React Query search roots — do not wipe in-memory/session company grids.
          await queryClient.invalidateQueries({ queryKey: transactionQueryKeys.searchRoot() });
        }

        const subsidiarySearch =
          scopeApi.subsidiaryAccountsOnly ||
          (scopeApi.companyId != null && Number(scopeApi.companyId) > 0);
        const currencyCodes =
          queryShowAll || querySelected.length === 0 ? undefined : querySelected;
        const scopeParams = {
          ...scopeApi,
          viewGroup: subsidiarySearch ? undefined : scopeApi.viewGroup,
          groupId: subsidiarySearch ? undefined : scopeApi.groupId,
          groupAggregate: subsidiarySearch ? undefined : scopeApi.groupAggregate,
          subsidiaryAccountsOnly: subsidiarySearch ? true : scopeApi.subsidiaryAccountsOnly,
        };

        let payload = null;
        let typeAccountIds = [];

        // Period Type Search: always ALL — Capture Date × any pure manual type.
        // Right-side Type dropdown is for submit only; do not filter the list by it.
        if (PERIOD_TYPE_SEARCH_TYPES.has(normalizedType)) {
          typeAccountIds = await fetchTypeAccountSearch({
            ...scopeParams,
            transactionType: TYPE_SEARCH_LIST_FORM_TYPE,
          });
          if (typeAccountIds.length === 0) {
            const fallbackCode = entryFocusCurrencyFallback || "MYR";
            flushSync(() => {
              setTypeSearchActive(true);
              setTypeSearchFormType(TYPE_SEARCH_LIST_FORM_TYPE);
              setTypeSearchAccountIds([]);
              setRawSearchData({ left_table: [], right_table: [], totals: null });
              setTablesVisible(false);
              if (didApplyTypeSearchEntryClear) {
                bootCurrencyDefaultRef.current = false;
                suppressCrossPageCurrencyRef.current = false;
                setShowAllCurrencies(false);
                setSelectedCurrencies([fallbackCode]);
                persistCurrencyFilter(
                  scopeCacheCompanyKey,
                  false,
                  [fallbackCode],
                  transactionScope?.selectedGroup,
                );
              }
            });
            if (!silent) {
              pushToast(t("searchCompletedFoundRecords", { displayed: 0 }), "info");
            }
            return;
          }

          const categoryParam =
            categoriesForQuery.length > 0 && !categoriesForQuery.includes("")
              ? [...categoriesForQuery].sort().join(",")
              : undefined;
          const result = await searchTransactionsApi({
            ...scopeParams,
            dateFrom: queryDateFrom,
            dateTo: queryDateTo,
            showInactive: false,
            showCaptureOnly: false,
            hideZeroBalance: false,
            categories: categoryParam ? categoryParam.split(",") : undefined,
            currencyCodes,
            typeSearch: true,
            typeAccountIds,
            typeSearchFormType: TYPE_SEARCH_LIST_FORM_TYPE,
            skipCache: Boolean(forceRefresh),
          });
          if (!result?.success || !result?.data) {
            pushToast(result?.message || result?.error || m.searchFailed, "error");
            return;
          }
          payload = result.data;
        } else {
          payload = await fetchTypeTransactionSearch({
            ...scopeParams,
            transactionType: normalizedType,
            currencyCodes,
          });
          if (!payload) {
            pushToast(m.searchFailed, "error");
            return;
          }
        }

        const rawCleaned = sanitizeSearchApiData(payload);

        const hasTypeSearchMovement = (row) => {
          if (!row) return false;
          if (Number(row?.has_crdr_transactions) === 1 || Number(row?.has_win_loss_transactions) === 1) {
            return true;
          }
          if (Number(row?.has_contra_clear_period) === 1) return true;
          const wl = parseFloat(String(row?.win_loss ?? "").replace(/,/g, "")) || 0;
          const wlFull = parseFloat(String(row?.win_loss_full ?? "").replace(/,/g, "")) || 0;
          if (Math.abs(wl) > 0.0001 || Math.abs(wlFull) > 0.0001) return true;
          const crDr = parseFloat(String(row?.cr_dr ?? "").replace(/,/g, "")) || 0;
          return Math.abs(crDr) > 0.0001;
        };

        const activeLeft = (rawCleaned.left_table || []).filter(hasTypeSearchMovement);
        const activeRight = (rawCleaned.right_table || []).filter(hasTypeSearchMovement);

        let cleaned = sanitizeSearchApiData({
          ...rawCleaned,
          left_table: activeLeft,
          right_table: activeRight,
        });

        const categoryKey = [...categoriesForQuery]
          .map((x) => String(x || "").toUpperCase().trim())
          .filter(Boolean)
          .sort()
          .join(",");
        const scopeKeyForInit = transactionScopeCacheKey(transactionScope) || "";

        // Keep query currency — never auto-flip the ALL chip from result rows.
        // On first entry, narrow to currencies that actually have Submit-type activity today.
        let nextShowAll = queryShowAll;
        let nextSelectedCurrencies = queryShowAll ? [] : [...querySelected];

        if (didApplyTypeSearchEntryClear) {
          const foundSet = new Set();
          [...(cleaned.left_table || []), ...(cleaned.right_table || [])].forEach((row) => {
            const cur = String(row?.currency || "").toUpperCase().trim();
            if (cur) foundSet.add(cur);
          });
          const order = (txCurrencyCodes || [])
            .map((c) => String(c || "").toUpperCase().trim())
            .filter(Boolean);
          let focusCurrencies = [...foundSet].sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            if (ia === -1 && ib === -1) return a.localeCompare(b);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          });
          if (focusCurrencies.length === 0) {
            focusCurrencies = [entryFocusCurrencyFallback || "MYR"];
          }
          nextShowAll = false;
          nextSelectedCurrencies = focusCurrencies;

          const focusSet = new Set(focusCurrencies);
          cleaned = sanitizeSearchApiData({
            ...cleaned,
            left_table: (cleaned.left_table || []).filter((row) =>
              focusSet.has(String(row?.currency || "").toUpperCase().trim()),
            ),
            right_table: (cleaned.right_table || []).filter((row) =>
              focusSet.has(String(row?.currency || "").toUpperCase().trim()),
            ),
          });
        }

        const displayed =
          (cleaned.left_table?.length || 0) + (cleaned.right_table?.length || 0);

        flushSync(() => {
          setTypeSearchActive(true);
          setTypeSearchFormType(TYPE_SEARCH_LIST_FORM_TYPE);
          setTypeSearchAccountIds(typeAccountIds);
          setRawSearchData(cleaned);
          if (didApplyTypeSearchEntryClear) {
            bootCurrencyDefaultRef.current = false;
            suppressCrossPageCurrencyRef.current = nextSelectedCurrencies.length !== 1;
            setShowAllCurrencies(false);
            setSelectedCurrencies(nextSelectedCurrencies);
          } else {
            suppressCrossPageCurrencyRef.current = queryShowAll || querySelected.length !== 1;
          }
          setTablesVisible(displayed > 0);
        });

        lastInitialSearchKeyRef.current = [
          scopeKeyForInit,
          nextShowAll ? "ALL" : nextSelectedCurrencies.join(","),
          categoryKey,
          queryDateFrom,
          queryDateTo,
        ].join("|");

        persistCurrencyFilter(
          scopeCacheCompanyKey,
          nextShowAll,
          nextShowAll ? [] : nextSelectedCurrencies,
          transactionScope?.selectedGroup,
        );

        if (!silent && displayed > 0) {
          pushToast(t("searchCompletedFoundRecords", { displayed }), "success");
        } else if (!silent && displayed === 0) {
          pushToast(t("searchCompletedFoundRecords", { displayed: 0 }), "info");
        }
      } catch (e) {
        if (e?.name === "AbortError" || isCancelledError(e)) return;
        console.error(e);
        pushToast(t("searchFailedWithMessage", { message: e.message }), "error");
      } finally {
        setSearchLoading(false);
      }
    },
    [
      scopeReady,
      scopeCacheCompanyKey,
      scopeApi,
      transactionScope,
      effectiveDateFrom,
      effectiveDateTo,
      showAllCurrencies,
      selectedCurrencies,
      selectedCategories,
      searchState,
      selectedCurrenciesKey,
      txCurrencyCodes,
      todayDmy,
      persistCurrencyFilter,
      pushToast,
      m,
      t,
      queryClient,
    ],
  );
  runTypeSearchRef.current = runTypeSearch;

  /**
   * After successful submit/approval: focus submitted accounts.
   * Inside a Type Search session, only the first Submit clears left filters to tx date + tx currency
   * (does not touch filtersBeforeTypeSearchRef). Later submits keep that focused filter set.
   */
  const applySubmitFocusAndRefresh = useCallback(
    async ({
      accountIds,
      submitCurrency,
      amount,
      txType: submitTxType,
      toAccountId,
      fromAccountId,
      transactionDate,
    } = {}) => {
      const ids = [...new Set((accountIds || []).map((id) => Number(id)).filter((id) => id > 0))];
      if (ids.length === 0) return;
      if (!scopeReady || !scopeCacheCompanyKey) return;
      if (!effectiveDateFrom || !effectiveDateTo) return;

      const txDate = String(transactionDate || "").trim();
      const focusRange = resolveSubmitFocusDateRange(txDate, todayDmy);
      // RATE submits pass [fromCurrency, toCurrency]; other types pass a single string.
      const currencyCodes = [
        ...new Set(
          (Array.isArray(submitCurrency) ? submitCurrency : [submitCurrency])
            .map((c) => String(c || "").toUpperCase().trim())
            .filter(Boolean),
        ),
      ];
      const currencyCode = currencyCodes[0] || "";

      const inTypeSearchSession =
        typeSearchSessionActiveRef.current || typeSearchActiveRef.current;
      const applyTypeSearchFirstSubmitFocus =
        inTypeSearchSession && !typeSearchFirstSubmitFocusDoneRef.current && !!txDate && currencyCodes.length > 0;

      let searchDateFrom = effectiveDateFrom;
      let searchDateTo = effectiveDateTo;
      let rangeKey = `${effectiveDateFrom}|${effectiveDateTo}`;
      let didJumpCaptureDate = false;
      let currencyOverrides = {};
      let categoriesOverride;
      let searchStateOverride = {
        ...searchState,
        showPaymentOnly: false,
        showCaptureOnly: false,
        showZeroBalance: true,
      };

      if (applyTypeSearchFirstSubmitFocus) {
        // First Submit in Type Search session — focus on this tx; keep entry snapshot untouched.
        typeSearchFirstSubmitFocusDoneRef.current = true;
        typeSearchSessionActiveRef.current = true;
        hasAutoJumpedCaptureDateOnSubmitRef.current = true;

        didJumpCaptureDate =
          focusRange.from !== effectiveDateFrom || focusRange.to !== effectiveDateTo;
        searchDateFrom = focusRange.from;
        searchDateTo = focusRange.to;
        rangeKey = `${focusRange.from}|${focusRange.to}`;
        prevCaptureDateRangeKeyRef.current = rangeKey;

        categoriesOverride = [];
        searchStateOverride = {
          ...INITIAL_TRANSACTION_SEARCH_STATE,
          showZeroBalance: true,
        };
        currencyOverrides = {
          showAllCurrenciesOverride: false,
          selectedCurrenciesOverride: currencyCodes,
        };
      } else if (!inTypeSearchSession) {
        // Submit from normal list → enter Type Search session: snapshot left filters,
        // then clear to Type Search focus form (tx date + tx currency). Exit restores snapshot.
        if (!filtersBeforeTypeSearchRef.current) {
          filtersBeforeTypeSearchRef.current = {
            selectedCategories: [...selectedCategories],
            dateFrom: String(effectiveDateFrom || "").trim(),
            dateTo: String(effectiveDateTo || "").trim(),
            showAllCurrencies: !!showAllCurrencies,
            selectedCurrencies: (selectedCurrencies || [])
              .map((c) => String(c || "").toUpperCase().trim())
              .filter(Boolean),
            searchState: {
              showName: !!searchState.showName,
              showPaymentOnly: !!searchState.showPaymentOnly,
              showCaptureOnly: !!searchState.showCaptureOnly,
              showZeroBalance: !!searchState.showZeroBalance,
            },
          };
        }
        typeSearchSessionActiveRef.current = true;
        typeSearchFirstSubmitFocusDoneRef.current = true;
        hasAutoJumpedCaptureDateOnSubmitRef.current = true;

        if (txDate) {
          didJumpCaptureDate =
            focusRange.from !== effectiveDateFrom || focusRange.to !== effectiveDateTo;
          searchDateFrom = focusRange.from;
          searchDateTo = focusRange.to;
          rangeKey = `${focusRange.from}|${focusRange.to}`;
          prevCaptureDateRangeKeyRef.current = rangeKey;
        }

        categoriesOverride = [];
        searchStateOverride = {
          ...INITIAL_TRANSACTION_SEARCH_STATE,
          showZeroBalance: true,
        };
        if (currencyCodes.length > 0) {
          currencyOverrides = {
            showAllCurrenciesOverride: false,
            selectedCurrenciesOverride: currencyCodes,
          };
        }
      } else {
        // 2nd+ Submit inside Type Search session: keep first-submit date/currency focus,
        // but widen the currency focus if this submit touches a currency not in it yet
        // (e.g. a RATE transaction whose 2nd currency wasn't part of the session's first-submit focus).
        rangeKey = `${effectiveDateFrom}|${effectiveDateTo}`;
        if (!showAllCurrencies && currencyCodes.length > 0) {
          const currentSet = new Set(
            (selectedCurrencies || []).map((c) => String(c || "").toUpperCase().trim()).filter(Boolean),
          );
          const missing = currencyCodes.filter((c) => !currentSet.has(c));
          if (missing.length > 0) {
            currencyOverrides = {
              showAllCurrenciesOverride: false,
              selectedCurrenciesOverride: [...currentSet, ...missing],
            };
          }
        }
      }

      const clearLeftToSubmitFocus =
        applyTypeSearchFirstSubmitFocus || (!inTypeSearchSession && !!txDate);
      const currencyStateToApply = clearLeftToSubmitFocus
        ? currencyCodes
        : currencyOverrides.selectedCurrenciesOverride ?? null;

      // Paint focused rows (+ optimistic balances when staying on the same capture range) before refresh.
      flushSync(() => {
        if (clearLeftToSubmitFocus) {
          if (txDate) {
            setDateFrom(focusRange.from);
            setDateTo(focusRange.to);
            syncCaptureDateDom(focusRange.from, focusRange.to);
          }
          setSelectedCategories([]);
          categoryChangedByUserRef.current = false;
          setSearchState({ ...INITIAL_TRANSACTION_SEARCH_STATE });
          prevServerSideFiltersRef.current = {
            showPaymentOnly: false,
            showCaptureOnly: false,
            showZeroBalance: false,
          };
        } else if (didJumpCaptureDate) {
          setDateFrom(focusRange.from);
          setDateTo(focusRange.to);
          syncCaptureDateDom(focusRange.from, focusRange.to);
        }

        if (currencyStateToApply && currencyStateToApply.length > 0) {
          bootCurrencyDefaultRef.current = false;
          suppressCrossPageCurrencyRef.current = currencyStateToApply.length !== 1;
          setShowAllCurrencies(false);
          setSelectedCurrencies(currencyStateToApply);
          persistCurrencyFilter(
            scopeCacheCompanyKey,
            false,
            currencyStateToApply,
            transactionScope?.selectedGroup,
          );
          notifySingleCurrencyIfNeeded(currencyStateToApply);
        }

        setTypeSearchActive(false);
        setTypeSearchFormType(null);
        setTypeSearchAccountIds([]);

        if (!clearLeftToSubmitFocus) {
          // Submit-focus shows Cr/Dr rows; clear Win/Loss / Payment Only so the fetch and UI match.
          setSearchState((prev) => {
            if (!prev.showPaymentOnly && !prev.showCaptureOnly) return prev;
            return { ...prev, showPaymentOnly: false, showCaptureOnly: false };
          });
          if (prevServerSideFiltersRef.current) {
            prevServerSideFiltersRef.current = {
              ...prevServerSideFiltersRef.current,
              showPaymentOnly: false,
              showCaptureOnly: false,
            };
          }
        }

        if (currencyCodes.length > 0) {
          setSubmitFocusByCurrency((prev) => {
            const base = !didJumpCaptureDate && submitFocusRangeKey === rangeKey ? { ...prev } : {};
            for (const code of currencyCodes) {
              const existing = !didJumpCaptureDate && Array.isArray(base[code]) ? base[code] : [];
              base[code] = [...new Set([...existing, ...ids])];
            }
            return base;
          });
        }
        setSubmitFocusRangeKey(rangeKey);
        submitFocusLeftRangeKeysRef.current.delete(rangeKey);

        // Skip optimistic patch when jumping months — old-range rows are the wrong base.
        if (!didJumpCaptureDate) {
          const deltas = buildOptimisticSubmitDeltas({
            txType: submitTxType,
            amount,
            toAccountId,
            fromAccountId,
          });
          if (deltas.length > 0 && currencyCode) {
            let didPatch = false;
            setRawSearchData((prev) => {
              const patched = applyOptimisticSubmitBalancePatch(prev, {
                currency: currencyCode,
                deltas,
              });
              if (patched && patched !== prev) {
                didPatch = true;
                return patched;
              }
              return prev;
            });
            if (didPatch) setTablesVisible(true);
          }
        }
      });

      // Cancel any queued debounced search so it can't win the shared run-token race
      // and overwrite this submit's (authoritative) result with stale data.
      if (autoSearchTimerRef.current) {
        clearTimeout(autoSearchTimerRef.current);
        autoSearchTimerRef.current = null;
      }

      setSearchLoading(true);
      try {
        await runSearch({
          forceRefresh: true,
          silent: true,
          typeSearchOverride: false,
          searchStateOverride,
          ...(didJumpCaptureDate || clearLeftToSubmitFocus
            ? { dateFromOverride: searchDateFrom, dateToOverride: searchDateTo }
            : {}),
          ...(categoriesOverride !== undefined
            ? { selectedCategoriesOverride: categoriesOverride }
            : {}),
          ...currencyOverrides,
        });
      } finally {
        setSearchLoading(false);
      }
    },
    [
      scopeReady,
      scopeCacheCompanyKey,
      effectiveDateFrom,
      effectiveDateTo,
      submitFocusRangeKey,
      showAllCurrencies,
      selectedCurrencies,
      selectedCategories,
      persistCurrencyFilter,
      transactionScope?.selectedGroup,
      notifySingleCurrencyIfNeeded,
      runSearch,
      searchState,
    ],
  );

  /**
   * Exit Type Search / submit-focus and restore left filters from the entry snapshot
   * (Category / Capture Date / Currency / Show chips). Falls back to today + default currency
   * when no snapshot exists (e.g. submit-focus only).
   */
  const exitTypeSearchAndRefresh = useCallback(async () => {
    if (!typeSearchActive && !submitFocusActive) return;
    if (!scopeReady || !scopeCacheCompanyKey) return;

    const snap = filtersBeforeTypeSearchRef.current;
    filtersBeforeTypeSearchRef.current = null;
    typeSearchSessionActiveRef.current = false;
    typeSearchFirstSubmitFocusDoneRef.current = false;

    let restoreDateFrom;
    let restoreDateTo;
    let restoreShowAll;
    let restoreSelected;
    let restoreCategories;
    let restoreSearchState;

    if (snap) {
      restoreDateFrom = String(snap.dateFrom || "").trim();
      restoreDateTo = String(snap.dateTo || "").trim();
      restoreShowAll = !!snap.showAllCurrencies;
      restoreSelected = (Array.isArray(snap.selectedCurrencies) ? snap.selectedCurrencies : [])
        .map((c) => String(c || "").toUpperCase().trim())
        .filter(Boolean);
      restoreCategories = Array.isArray(snap.selectedCategories) ? [...snap.selectedCategories] : [];
      restoreSearchState = {
        showName: !!snap.searchState?.showName,
        showPaymentOnly: !!snap.searchState?.showPaymentOnly,
        showCaptureOnly: !!snap.searchState?.showCaptureOnly,
        showZeroBalance: !!snap.searchState?.showZeroBalance,
      };
    } else {
      const today = String(todayDmy || "").trim();
      if (!today) return;
      const codes = (currencyRowsOrdered || [])
        .map((r) => String(r.code || "").toUpperCase().trim())
        .filter(Boolean);
      const defaultCode = pickTransactionDefaultCurrency(codes);
      const defaultSel =
        defaultCode && codes.includes(defaultCode) ? [defaultCode] : codes[0] ? [codes[0]] : [];
      if (defaultSel.length === 0) return;

      restoreDateFrom = today;
      restoreDateTo = today;
      restoreShowAll = false;
      restoreSelected = defaultSel;
      restoreCategories = [];
      restoreSearchState = { ...INITIAL_TRANSACTION_SEARCH_STATE };
    }

    if (!restoreDateFrom || !restoreDateTo) return;
    if (!restoreShowAll && restoreSelected.length === 0) return;

    setSearchLoading(true);
    try {
      setTypeSearchActive(false);
      setTypeSearchFormType(null);
      setTypeSearchAccountIds([]);
      setSubmitFocusByCurrency({});
      setSubmitFocusRangeKey(null);
      submitFocusLeftRangeKeysRef.current.clear();

      setSearchState(restoreSearchState);
      setSelectedCategories(restoreCategories);
      categoryChangedByUserRef.current = false;
      setDateFrom(restoreDateFrom);
      setDateTo(restoreDateTo);
      syncCaptureDateDom(restoreDateFrom, restoreDateTo);
      prevCaptureDateRangeKeyRef.current = `${restoreDateFrom}|${restoreDateTo}`;
      prevServerSideFiltersRef.current = {
        showPaymentOnly: restoreSearchState.showPaymentOnly,
        showCaptureOnly: restoreSearchState.showCaptureOnly,
        showZeroBalance: restoreSearchState.showZeroBalance,
      };
      suppressCrossPageCurrencyRef.current = restoreShowAll || restoreSelected.length !== 1;
      bootCurrencyDefaultRef.current = false;
      setShowAllCurrencies(restoreShowAll);
      setSelectedCurrencies(restoreShowAll ? [] : restoreSelected);
      persistCurrencyFilter(
        scopeCacheCompanyKey,
        restoreShowAll,
        restoreShowAll ? [] : restoreSelected,
        transactionScope?.selectedGroup,
      );

      lastInitialSearchKeyRef.current = "";
      clearTxSearchCache();
      await queryClient.invalidateQueries({ queryKey: transactionQueryKeys.searchRoot() });

      await runSearch({
        forceRefresh: true,
        silent: false,
        typeSearchOverride: false,
        dateFromOverride: restoreDateFrom,
        dateToOverride: restoreDateTo,
        searchStateOverride: restoreSearchState,
        selectedCategoriesOverride: restoreCategories,
        showAllCurrenciesOverride: restoreShowAll,
        selectedCurrenciesOverride: restoreShowAll ? [] : restoreSelected,
      });
    } finally {
      setSearchLoading(false);
    }
  }, [
    typeSearchActive,
    submitFocusActive,
    scopeReady,
    scopeCacheCompanyKey,
    todayDmy,
    currencyRowsOrdered,
    persistCurrencyFilter,
    transactionScope?.selectedGroup,
    queryClient,
    runSearch,
  ]);

  /**
   * Sidebar same-page soft refresh: restore Capture Date / chips / categories / currency
   * to cold-boot defaults. Does not touch company/group scope.
   */
  const resetPageFiltersToDefaults = useCallback(async () => {
    const today = String(todayDmy || "").trim();
    if (!today) return false;

    const bundleCodes = (currencyScopeBundle?.rows || [])
      .map((r) => String(r.code || r.currency || "").toUpperCase().trim())
      .filter(Boolean);
    const orderedCodes = (currencyRowsOrdered || [])
      .map((r) => String(r.code || "").toUpperCase().trim())
      .filter(Boolean);
    const codes = bundleCodes.length ? bundleCodes : orderedCodes;
    const defaultCode = pickTransactionDefaultCurrency(codes);
    const nextSel =
      defaultCode && codes.includes(defaultCode) ? [defaultCode] : codes[0] ? [codes[0]] : [];

    setSearchLoading(true);
    try {
      filtersBeforeTypeSearchRef.current = null;
      typeSearchSessionActiveRef.current = false;
      typeSearchFirstSubmitFocusDoneRef.current = false;
      setTypeSearchActive(false);
      setTypeSearchFormType(null);
      setTypeSearchAccountIds([]);
      setSubmitFocusByCurrency({});
      setSubmitFocusRangeKey(null);
      submitFocusLeftRangeKeysRef.current.clear();

      setSearchState({ ...INITIAL_TRANSACTION_SEARCH_STATE });
      setSelectedCategories([]);
      categoryChangedByUserRef.current = false;
      setDateFrom(today);
      setDateTo(today);
      syncCaptureDateDom(today, today);
      prevCaptureDateRangeKeyRef.current = `${today}|${today}`;
      prevServerSideFiltersRef.current = {
        showPaymentOnly: INITIAL_TRANSACTION_SEARCH_STATE.showPaymentOnly,
        showCaptureOnly: INITIAL_TRANSACTION_SEARCH_STATE.showCaptureOnly,
        showZeroBalance: INITIAL_TRANSACTION_SEARCH_STATE.showZeroBalance,
      };

      beginScopeCurrencyDefault();
      bootCurrencyDefaultRef.current = true;
      coldBootCurrencyAppliedRef.current = true;
      earlyCurrencyScopeRef.current = scopeKey || earlyCurrencyScopeRef.current;
      currenciesBeforeAllRef.current = [];
      setShowAllCurrencies(false);
      if (nextSel.length > 0) {
        setSelectedCurrencies(nextSel);
      } else {
        // Metadata not ready — allow cold-boot / init to pick first ordered currency.
        coldBootCurrencyAppliedRef.current = false;
        earlyCurrencyScopeRef.current = null;
        setSelectedCurrencies([]);
      }

      if (scopeCacheCompanyKey != null && nextSel.length > 0) {
        persistCurrencyFilter(scopeCacheCompanyKey, false, nextSel, transactionScope?.selectedGroup);
      }

      lastInitialSearchKeyRef.current = "";
      lastCompletedSearchKeyRef.current = "";
      initialSearchDoneRef.current = false;
      clearTxSearchCache();
      try {
        await queryClient.invalidateQueries({ queryKey: transactionQueryKeys.searchRoot() });
      } catch {
        /* ignore */
      }

      if (nextSel.length === 0) {
        // Initial-search effect will run once currency defaults land.
        return true;
      }

      await runSearch({
        forceRefresh: true,
        silent: false,
        isInitialLoad: true,
        typeSearchOverride: false,
        dateFromOverride: today,
        dateToOverride: today,
        searchStateOverride: { ...INITIAL_TRANSACTION_SEARCH_STATE },
        selectedCategoriesOverride: [],
        showAllCurrenciesOverride: false,
        selectedCurrenciesOverride: nextSel,
      });
      return true;
    } finally {
      setSearchLoading(false);
    }
  }, [
    todayDmy,
    currencyRowsOrdered,
    currencyScopeBundle,
    beginScopeCurrencyDefault,
    scopeKey,
    scopeCacheCompanyKey,
    persistCurrencyFilter,
    transactionScope?.selectedGroup,
    queryClient,
    runSearch,
  ]);

  useEffect(() => {
    return () => {
      if (autoSearchTimerRef.current) {
        clearTimeout(autoSearchTimerRef.current);
        autoSearchTimerRef.current = null;
      }
      queryClient.cancelQueries({ queryKey: transactionQueryKeys.searchRoot() });
    };
  }, [queryClient]);

  useEffect(() => {
    if (!showAllCurrencies && selectedCurrencies.length === 0) {
      setRawSearchData(null);
      setTablesVisible(false);
    }
  }, [showAllCurrencies, selectedCurrencies]);

  const baseRowsPresentation = useMemo(() => {
    if (!rawSearchData) {
      return {
        hasData: false,
        baseLeft: [],
        baseRight: [],
      };
    }
    // rawSearchData is already sanitized on commit/replay; avoid duplicate dedupe pass.
    const rawLeft = Array.isArray(rawSearchData.left_table) ? rawSearchData.left_table : [];
    const rawRight = Array.isArray(rawSearchData.right_table) ? rawSearchData.right_table : [];
    let viewLeft = rawLeft;
    let viewRight = rawRight;
    const multiCurrencyView = showAllCurrencies || selectedCurrencies.length > 1;
    if (submitFocusActive && !multiCurrencyView) {
      const singleCode = String(selectedCurrencies[0] || "").toUpperCase().trim();
      const focusIds = getSubmitFocusAccountIdsForCurrency(submitFocusByCurrency, singleCode);
      if (focusIds.length > 0) {
        const focusSet = new Set(focusIds);
        const focused = applyTypeSearchAccountFilter(rawLeft, rawRight, focusSet);
        viewLeft = focused.left;
        viewRight = focused.right;
      }
    }
    if (typeSearchActive) {
      return {
        hasData: true,
        baseLeft: viewLeft,
        baseRight: viewRight,
      };
    }
    // Keep API Balance-based left/right for all types (including RATE) — do not re-split by Cr/Dr.
    return {
      hasData: true,
      baseLeft: sortByRole(viewLeft),
      baseRight: sortByRole(viewRight),
    };
  }, [
    rawSearchData,
    typeSearchActive,
    submitFocusActive,
    submitFocusByCurrency,
    showAllCurrencies,
    selectedCurrencies,
  ]);

  const tablePresentation = useMemo(() => {
    if (!rawSearchData) {
      return {
        mode: "none",
        defaultLeft: [],
        defaultRight: [],
        totalsLeft: calculateTotals([]),
        totalsRight: calculateTotals([]),
        totalsSummary: applySummaryWinLossDisplayTolerance(calculateTotals([])),
        grouped: [],
        singleCurrencyTitle: null,
      };
    }
    const filtered = filterTransactionTableRows(baseRowsPresentation.baseLeft, baseRowsPresentation.baseRight, {
      showZeroBalance: listPresentationModeActive ? true : searchState.showZeroBalance,
      showPaymentOnly: listPresentationModeActive ? false : searchState.showPaymentOnly,
      showCaptureOnly: listPresentationModeActive ? false : searchState.showCaptureOnly,
    });
    const sortedLeft = filtered.left;
    const sortedRight = filtered.right;
    const totalsLeft = calculateTotals(sortedLeft);
    const totalsRight = calculateTotals(sortedRight);
    const totalsSummary = applySummaryWinLossDisplayTolerance(calculateTotals([...sortedLeft, ...sortedRight]));

    const multi = showAllCurrencies || selectedCurrencies.length > 1;
    const codesOrdered = currencyRowsOrdered.map((c) => String(c.code || "").toUpperCase().trim()).filter(Boolean);

    if (!multi) {
      const singleCode =
        selectedCurrencies.length === 1 ? String(selectedCurrencies[0] || "").toUpperCase().trim() : null;
      const title = singleCode ? `Currency: ${singleCode}` : null;

      const singleLeft = singleCode
        ? sortedLeft.filter((row) => String(row?.currency || "").toUpperCase().trim() === singleCode)
        : sortedLeft;
      const singleRight = singleCode
        ? sortedRight.filter((row) => String(row?.currency || "").toUpperCase().trim() === singleCode)
        : sortedRight;

      const singleTotalsLeft = calculateTotals(singleLeft);
      const singleTotalsRight = calculateTotals(singleRight);
      const singleTotalsSummary = applySummaryWinLossDisplayTolerance(
        calculateTotals([...singleLeft, ...singleRight]),
      );

      return {
        mode: "default",
        defaultLeft: singleLeft,
        defaultRight: singleRight,
        totalsLeft: singleTotalsLeft,
        totalsRight: singleTotalsRight,
        totalsSummary: singleTotalsSummary,
        grouped: [],
        singleCurrencyTitle: title,
      };
    }

    const groupedMap = {};
    const pushRow = (row, side) => {
      const cur = String(row?.currency || "UNKNOWN").toUpperCase().trim() || "UNKNOWN";
      if (!groupedMap[cur]) groupedMap[cur] = { left: [], right: [] };
      groupedMap[cur][side].push(row);
    };
    sortedLeft.forEach((row) => pushRow(row, "left"));
    sortedRight.forEach((row) => pushRow(row, "right"));

    let orderedCurrs = [];
    codesOrdered.forEach((code) => {
      if (groupedMap[code]) orderedCurrs.push(code);
    });
    Object.keys(groupedMap).forEach((code) => {
      if (!orderedCurrs.includes(code)) orderedCurrs.push(code);
    });

    // active_currency_codes only applies when the user explicitly enables
    // "Show all 0 balance". Type Search / submit-focus force showZeroBalance for
    // ROW visibility — that must NOT hide currency sections that already have
    // period activity (e.g. MYR+SGD selected but only MYR section rendered).
    const activeCodes = rawSearchData.active_currency_codes;
    if (
      !listPresentationModeActive &&
      searchState.showZeroBalance &&
      Array.isArray(activeCodes) &&
      activeCodes.length > 0
    ) {
      const activeSet = new Set(activeCodes.map((c) => String(c || "").toUpperCase().trim()));
      orderedCurrs = orderedCurrs.filter((code) => {
        const upper = String(code || "").toUpperCase().trim();
        if (activeSet.has(upper)) return true;
        const g = groupedMap[upper];
        return Boolean(g && ((g.left?.length || 0) + (g.right?.length || 0) > 0));
      });
    }

    if (!showAllCurrencies && selectedCurrencies.length > 1) {
      const selSet = new Set(selectedCurrencies.map((x) => String(x || "").toUpperCase().trim()));
      orderedCurrs = orderedCurrs.filter((code) => selSet.has(String(code || "").toUpperCase().trim()));
    }

    // Multi-select: still show every selected currency that has rows, even if
    // order/active filters dropped it (keeps Type Search MYR+SGD sections honest).
    if (!showAllCurrencies && selectedCurrencies.length > 1) {
      selectedCurrencies.forEach((raw) => {
        const code = String(raw || "").toUpperCase().trim();
        if (!code || orderedCurrs.includes(code)) return;
        const g = groupedMap[code];
        if (g && ((g.left?.length || 0) + (g.right?.length || 0) > 0)) {
          orderedCurrs.push(code);
        }
      });
    }

    const grouped = orderedCurrs.map((currency) => {
      let gl = groupedMap[currency]?.left || [];
      let gr = groupedMap[currency]?.right || [];
      if (submitFocusActive) {
        const focusIds = getSubmitFocusAccountIdsForCurrency(submitFocusByCurrency, currency);
        if (focusIds.length > 0) {
          const focusSet = new Set(focusIds);
          const focused = applyTypeSearchAccountFilter(gl, gr, focusSet);
          gl = focused.left;
          gr = focused.right;
        }
      }
      const l = sortByRole(gl);
      const r = sortByRole(gr);
      const tL = calculateTotals(l);
      const tR = calculateTotals(r);
      const tS = applySummaryWinLossDisplayTolerance(calculateTotals([...l, ...r]));
      return { currency, left: l, right: r, totalsLeft: tL, totalsRight: tR, totalsSummary: tS };
    });

    if (grouped.length === 0 && (sortedLeft.length > 0 || sortedRight.length > 0)) {
      const title =
        selectedCurrencies.length === 1 ? `Currency: ${selectedCurrencies[0]}` : null;
      return {
        mode: "default",
        defaultLeft: sortedLeft,
        defaultRight: sortedRight,
        totalsLeft,
        totalsRight,
        totalsSummary,
        grouped: [],
        singleCurrencyTitle: title,
      };
    }

    return {
      mode: "grouped",
      defaultLeft: [],
      defaultRight: [],
      totalsLeft,
      totalsRight,
      totalsSummary,
      grouped,
      singleCurrencyTitle: null,
    };
  }, [
    rawSearchData,
    baseRowsPresentation,
    searchState,
    listPresentationModeActive,
    showAllCurrencies,
    selectedCurrencies,
    currencyRowsOrdered,
    submitFocusActive,
    submitFocusByCurrency,
  ]);

  /** Cold boot: pre-select first ordered currency before metadata returns so initial search can start early. */
  useLayoutEffect(() => {
    if (!scopeReady || !scopeCacheCompanyKey || !scopeKey) return;
    if (earlyCurrencyScopeRef.current === scopeKey) return;
    earlyCurrencyScopeRef.current = scopeKey;

    if (coldBootCurrencyAppliedRef.current) return;
    // Group-only ledger: wait for scoped account currencies — do not default early.
    if (transactionScope?.mode === "group") return;

    coldBootCurrencyAppliedRef.current = true;

    const savedOrder =
      orderCacheKey != null ? resolveSavedCurrencyOrder(orderCacheKey, null) : null;
    const defaultCode = pickTransactionDefaultCurrency(
      savedOrder?.length ? savedOrder : ["MYR"],
    );
    if (!defaultCode) return;
    setShowAllCurrencies(false);
    setSelectedCurrencies([defaultCode]);
  }, [scopeReady, scopeCacheCompanyKey, scopeKey, transactionScope?.mode, orderCacheKey]);

  useEffect(() => {
    const prev = prevScopeKeyForSearchRef.current;
    const scopeChanged = prev != null && prev !== scopeKey;
    const prevCompanyId = prevCompanyIdForFilterResetRef.current;
    const companyChanged =
      prevCompanyId != null &&
      String(prevCompanyId) !== String(scopeCacheCompanyKey ?? "");

    if (scopeKey == null) {
      if (prev != null) {
        suppressBlockingOverlayOnceRef.current = true;
        prevCaptureDateRangeKeyRef.current = null;
        prevServerSideFiltersRef.current = null;
        setRawSearchData(null);
        setSearchLoading(false);
        lastCompletedSearchKeyRef.current = "";
        try {
          latestRunTokenRef.current += 1;
          queryClient.cancelQueries({ queryKey: transactionQueryKeys.searchRoot() });
        } catch {
          /* ignore */
        }
      }
      prevScopeKeyForSearchRef.current = null;
      prevCompanyIdForFilterResetRef.current = null;
      return;
    }

    if (scopeChanged) {
      // Lock until user picks a currency — prevents cross-page sync from re-applying the previous company's code.
      bootCurrencyDefaultRef.current = true;
      suppressCrossPageCurrencyRef.current = true;
      earlyCurrencyScopeRef.current = null;
      currenciesBeforeAllRef.current = [];
      setSubmitFocusByCurrency({});
      setSubmitFocusRangeKey(null);
      submitFocusLeftRangeKeysRef.current.clear();
      setSearchLoading(false);
      lastCompletedSearchKeyRef.current = "";

      const today = String(todayDmy || "").trim();
      // Company switch: restore Category / Capture Date / display chips to cold-boot defaults.
      // Currency keeps the existing per-company default logic below.
      let date = effectiveDateFrom || today;
      if (companyChanged) {
        if (today) {
          date = today;
          setDateFrom(today);
          setDateTo(today);
          syncCaptureDateDom(today, today);
          prevCaptureDateRangeKeyRef.current = `${today}|${today}`;
        } else {
          prevCaptureDateRangeKeyRef.current = null;
        }
        setSelectedCategories([]);
        categoryChangedByUserRef.current = false;
        setSearchState({ ...INITIAL_TRANSACTION_SEARCH_STATE });
        prevServerSideFiltersRef.current = {
          showPaymentOnly: INITIAL_TRANSACTION_SEARCH_STATE.showPaymentOnly,
          showCaptureOnly: INITIAL_TRANSACTION_SEARCH_STATE.showCaptureOnly,
          showZeroBalance: INITIAL_TRANSACTION_SEARCH_STATE.showZeroBalance,
        };
        filtersBeforeTypeSearchRef.current = null;
        typeSearchSessionActiveRef.current = false;
        typeSearchFirstSubmitFocusDoneRef.current = false;
        setTypeSearchActive(false);
        setTypeSearchFormType(null);
        setTypeSearchAccountIds([]);
      } else {
        prevCaptureDateRangeKeyRef.current = null;
        prevServerSideFiltersRef.current = null;
      }

      const snapCompanies =
        filterSnapshot?.snapCompaniesAll || filterSnapshot?.snapCompanies || [];
      // Prefer live ordered pills for this scope when already loaded; else this company's saved order.
      const liveCodes =
        currencyScopeBundle?.scopeKey === scopeKey
          ? (currencyRowsOrdered || [])
              .map((r) => String(r.code || r.currency || "").toUpperCase().trim())
              .filter(Boolean)
          : [];
      const savedOrder =
        orderCacheKey != null ? resolveSavedCurrencyOrder(orderCacheKey, null) : null;
      const firstCode = pickTransactionDefaultCurrency(
        liveCodes.length ? liveCodes : savedOrder?.length ? savedOrder : ["MYR"],
      );
      const currencyPrefs = {
        showAll: false,
        currencies: firstCode ? [firstCode] : [],
      };
      const { requestKey } = buildDefaultSearchApiParams(transactionScope, {
        dateFrom: date,
        dateTo: companyChanged && today ? today : effectiveDateTo || date,
        snapCompanies,
      });
      const instantReplay =
        getTxSearchCache(requestKey) ??
        (() => {
          try {
            const sessionKey = buildTxListSessionKey({
              companyId: scopeCacheCompanyKey,
              dateFrom: date,
              dateTo: companyChanged && today ? today : effectiveDateTo || date,
              selectedCategories: [],
              showInactive: false,
              showCaptureOnly: false,
              hideZeroBalance: true,
              showAllCurrencies: currencyPrefs.showAll,
              selectedCurrencies: currencyPrefs.currencies,
            });
            return sessionKey ? readTxListFromSessionStorage(sessionKey) : null;
          } catch {
            return null;
          }
        })();

      if (instantReplay) {
        setRawSearchData(instantReplay);
        const replayRows =
          (instantReplay.left_table?.length || 0) + (instantReplay.right_table?.length || 0);
        setTablesVisible(replayRows > 0);
        suppressBlockingOverlayOnceRef.current = true;
      } else {
        // Cold scope: keep previous rows painted (stale-while-revalidate) — no Loading chrome.
        suppressBlockingOverlayOnceRef.current = true;
      }

      // Each company defaults to its own first ordered currency (not the previous company's selection).
      setShowAllCurrencies(false);
      setSelectedCurrencies(currencyPrefs.currencies);
      if (currencyPrefs.currencies.length === 0) {
        setRawSearchData(null);
        setTablesVisible(false);
      }

      try {
        latestRunTokenRef.current += 1;
        queryClient.cancelQueries({ queryKey: transactionQueryKeys.searchRoot() });
      } catch {
        /* ignore */
      }
    }

    prevScopeKeyForSearchRef.current = scopeKey;
    prevCompanyIdForFilterResetRef.current = scopeCacheCompanyKey ?? null;
    if (scopeChanged) {
      lastCompletedSearchKeyRef.current = "";
      initialSearchDoneRef.current = false;
      lastInitialSearchKeyRef.current = "";
    }
  }, [
    scopeKey,
    queryClient,
    transactionScope,
    scopeCacheCompanyKey,
    orderCacheKey,
    currencyScopeBundle?.scopeKey,
    currencyRowsOrdered,
    filterSnapshot?.snapCompanies,
    filterSnapshot?.snapCompaniesAll,
    effectiveDateFrom,
    effectiveDateTo,
    todayDmy,
  ]);

  const selectedCategoriesKey = useMemo(
    () =>
      [...selectedCategories]
        .map((x) => String(x || "").toUpperCase().trim())
        .filter(Boolean)
        .sort()
        .join(","),
    [selectedCategories],
  );

  // Initial search — ordered-first default can run before account/currency metadata finishes.
  useEffect(() => {
    if (!scopeReady) return;
    if (!scopeKey) return;
    if (!showAllCurrencies && selectedCurrencies.length === 0) return;

    const initSearchKey = [
      scopeKey,
      showAllCurrencies ? "ALL" : selectedCurrenciesKey,
      selectedCategoriesKey,
      effectiveDateFrom,
      effectiveDateTo,
    ].join("|");

    if (lastInitialSearchKeyRef.current === initSearchKey) return;

    if (suppressCurrencyDefaultSearchRef.current) {
      suppressCurrencyDefaultSearchRef.current = false;
      lastInitialSearchKeyRef.current = initSearchKey;
      return;
    }
    if (typeSearchActive) {
      lastInitialSearchKeyRef.current = initSearchKey;
      return;
    }

    let hadReplay = false;
    let pendingInvalidate = false;
    try {
      const invalidateTs = parseInt(localStorage.getItem(TX_LIST_INVALIDATE_LS_KEY) || "0", 10) || 0;
      const handledTs = parseInt(sessionStorage.getItem(TX_LIST_INVALIDATE_HANDLED_KEY) || "0", 10) || 0;
      pendingInvalidate = Boolean(invalidateTs && invalidateTs > handledTs);

      const queryFilters = buildTransactionSearchQueryFilters(searchState);
      const key = buildTxListSessionKey({
        companyId: scopeCacheCompanyKey,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
        selectedCategories,
        showInactive: queryFilters.showInactiveForQuery,
        showCaptureOnly: queryFilters.showCaptureOnlyForQuery,
        hideZeroBalance: queryFilters.hideZeroBalanceForQuery,
        showAllCurrencies,
        selectedCurrencies,
      });
      // Skip painting stale session rows when another page invalidated the list.
      const replay = !pendingInvalidate && key ? readTxListFromSessionStorage(key) : null;
      if (replay) {
        setRawSearchData(replay);
        const replayRows = (replay.left_table?.length || 0) + (replay.right_table?.length || 0);
        setTablesVisible(replayRows > 0);
        lastSearchCommitMsRef.current = Date.now();
        hadReplay = true;
      }
    } catch {
      /* ignore */
    }

    lastInitialSearchKeyRef.current = initSearchKey;
    prevServerSideFiltersRef.current = {
      showPaymentOnly: searchState.showPaymentOnly,
      showCaptureOnly: searchState.showCaptureOnly,
      showZeroBalance: searchState.showZeroBalance,
    };
    initialSearchDoneRef.current = true;
    void Promise.resolve(
      runSearchRef.current?.({
        isInitialLoad: true,
        silent: hadReplay && !pendingInvalidate,
        notifyErrors: !(hadReplay && !pendingInvalidate),
        // Never show blocking Loading overlay — keep prior/cached rows until replace.
        showBlockingOverlay: false,
        forceRefresh: pendingInvalidate,
      }),
    ).then(() => {
      if (!pendingInvalidate) return;
      try {
        const invalidateTs = parseInt(localStorage.getItem(TX_LIST_INVALIDATE_LS_KEY) || "0", 10) || 0;
        if (invalidateTs) sessionStorage.setItem(TX_LIST_INVALIDATE_HANDLED_KEY, String(invalidateTs));
      } catch {
        /* ignore */
      }
    });
  }, [
    scopeKey,
    scopeReady,
    scopeCacheCompanyKey,
    showAllCurrencies,
    selectedCurrenciesKey,
    effectiveDateFrom,
    effectiveDateTo,
    selectedCategoriesKey,
    typeSearchActive,
  ]);

  useEffect(() => {
    if (!scopeReady) return;
    if (!initialSearchDoneRef.current) return;
    if (!effectiveDateFrom || !effectiveDateTo) return;
    if (!showAllCurrencies && selectedCurrencies.length === 0) return;

    const key = captureRangeKey;
    const prevKey = prevCaptureDateRangeKeyRef.current;
    if (prevKey === null) {
      prevCaptureDateRangeKeyRef.current = key;
      return;
    }
    if (prevKey === key) return;

    if (submitFocusRangeKey === prevKey && hasSubmitFocusByCurrency(submitFocusByCurrency)) {
      submitFocusLeftRangeKeysRef.current.add(prevKey);
      setSubmitFocusByCurrency({});
      setSubmitFocusRangeKey(null);
      setTypeSearchActive(false);
      setTypeSearchFormType(null);
      setTypeSearchAccountIds([]);
    }

    prevCaptureDateRangeKeyRef.current = key;

    if (submitFocusLeftRangeKeysRef.current.has(key)) {
      void runTypeSearch(txType, { forceRefresh: true, silent: false });
      return;
    }

    if (submitFocusRangeKey === key && hasSubmitFocusByCurrency(submitFocusByCurrency)) {
      void runSearch({ forceRefresh: true, silent: true, typeSearchOverride: false });
      return;
    }

    if (typeSearchActive && typeSearchFormType) {
      void runTypeSearch(typeSearchFormType);
      return;
    }
    scheduleAutoSearch({
      delayMs: 120,
      forceRefresh: searchState.showZeroBalance,
    });
  }, [
    captureRangeKey,
    effectiveDateFrom,
    effectiveDateTo,
    scopeReady,
    showAllCurrencies,
    selectedCurrenciesKey,
    searchState.showZeroBalance,
    scheduleAutoSearch,
    typeSearchActive,
    typeSearchFormType,
    runTypeSearch,
    runSearch,
    txType,
    submitFocusRangeKey,
    submitFocusByCurrency,
    hasSubmitFocusByCurrency,
  ]);

  return {
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    effectiveDateFrom,
    effectiveDateTo,
    effectiveDateRangeText,
    selectedCategories,
    setSelectedCategories,
    searchState,
    setSearchState,
    showAllCurrencies,
    setShowAllCurrencies,
    selectedCurrencies,
    setSelectedCurrencies,
    rawSearchData,
    setRawSearchData,
    searchLoading,
    setSearchLoading,
    tablesVisible,
    setTablesVisible,
    runSearch,
    runTypeSearch,
    applySubmitFocusAndRefresh,
    exitTypeSearchAndRefresh,
    submitFocusActive,
    listPresentationModeActive,
    typeSearchActive,
    typeSearchFormType,
    persistCurrencyFilter,
    initialSearchDoneRef,
    lastSearchCommitMsRef,
    categoryChangedByUserRef,
    tablePresentation,
    categoryOpen,
    setCategoryOpen,
    categoryAllCheckboxRef,
    toggleCategory,
    onCategoryAllChange,
    toggleCategoryValue,
    removeCategoryTag,
    toggleAllCurrenciesBtn,
    onCurrencyDragStart,
    onCurrencyDropOn,
    toggleCurrencyBtn,
    beginScopeCurrencyDefault,
    resetPageFiltersToDefaults,
  };
}

