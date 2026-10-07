import { useEffect, useState } from "react";
import { getHistory } from "../lib/transactionApi.js";
import {
  assembleContiguousSuffix,
  historyChunkFetchOrder,
  splitHistoryDateChunks,
} from "../lib/transactionHistoryProgressive.js";
import { paymentHistoryParamsReady } from "../lib/transactionHistoryScope.js";
import { useRealtimeDomain } from "../lib/realtime/useRealtimeDomain.js";
import { REALTIME_DOMAINS } from "../lib/realtime/realtimeEvents.js";

/**
 * Progressive Payment History: newest month first (fast paint), then older remainder.
 * Reloads on ledger realtime events (desktop c987735d1f), so a change made on another
 * device or tab while this page is open is not left on screen stale.
 */
export function useMobilePaymentHistoryProgressive({ scope, scopeApi, enabled }) {
  const [rows, setRows] = useState([]);
  const [accountMeta, setAccountMeta] = useState(null);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [ledgerReloadToken, setLedgerReloadToken] = useState(0);

  const historyParamsReady = enabled && paymentHistoryParamsReady(scope);

  useRealtimeDomain(
    REALTIME_DOMAINS.LEDGER,
    () => {
      setLedgerReloadToken((n) => n + 1);
    },
    { enabled: historyParamsReady },
  );

  useEffect(() => {
    if (!historyParamsReady) {
      setRows([]);
      setAccountMeta(null);
      setIsInitialLoading(false);
      setIsLoadingMore(false);
      setErrorMessage(null);
      return undefined;
    }

    const ac = new AbortController();
    let cancelled = false;

    const chunks = splitHistoryDateChunks(scope.dateFrom, scope.dateTo);
    const slots = chunks.map(() => null);
    setRows([]);
    setAccountMeta(null);
    setErrorMessage(null);
    setIsInitialLoading(true);
    setIsLoadingMore(false);

    const publish = () => {
      if (cancelled) return;
      setRows(assembleContiguousSuffix(slots));
    };

    const fetchChunk = async (chunkIndex) => {
      const chunk = chunks[chunkIndex];
      const data = await getHistory({
        ...scopeApi,
        accountId: scope.accountDbId,
        dateFrom: chunk.dateFrom,
        dateTo: chunk.dateTo,
        currency: scope.currency,
        virtualCompanyCode: scope.virtualCompanyCode,
        pureTypeSearch: scope.pureTypeSearch,
        signal: ac.signal,
      });
      if (cancelled) return null;
      if (!data?.success) {
        throw new Error(data?.message || data?.error || "Failed to load history");
      }
      slots[chunkIndex] = Array.isArray(data.data) ? data.data : [];
      if (data.account) {
        setAccountMeta((prev) => prev || data.account);
      }
      publish();
      return data;
    };

    (async () => {
      try {
        if (!chunks.length) {
          setIsInitialLoading(false);
          return;
        }

        const order = historyChunkFetchOrder(chunks.length);
        const newestIdx = order[0];

        await fetchChunk(newestIdx);
        if (cancelled) return;
        setIsInitialLoading(false);

        const rest = order.slice(1);
        if (!rest.length) return;

        setIsLoadingMore(true);
        for (const chunkIndex of rest) {
          if (cancelled) return;
          await fetchChunk(chunkIndex);
        }
      } catch (err) {
        if (cancelled || err?.name === "AbortError") return;
        setErrorMessage(err?.message || "Failed to load history");
        if (!slots.some((s) => s != null)) {
          setRows([]);
        }
      } finally {
        if (!cancelled) {
          setIsInitialLoading(false);
          setIsLoadingMore(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [
    historyParamsReady,
    ledgerReloadToken,
    scope.accountDbId,
    scope.currency,
    scope.dateFrom,
    scope.dateTo,
    scope.pureTypeSearch,
    scope.virtualCompanyCode,
    scopeApi.companyId,
    scopeApi.viewGroup,
    scopeApi.groupId,
    scopeApi.groupAggregate,
    scopeApi.subsidiaryAccountsOnly,
  ]);

  return {
    rows,
    accountMeta,
    isInitialLoading,
    isLoadingMore,
    errorMessage,
  };
}
