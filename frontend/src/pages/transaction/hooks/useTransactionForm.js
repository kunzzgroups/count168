import { useState, useEffect, useCallback, useRef } from "react";
import {
  transactionScopeApiParams,
  transactionScopeCacheKey,
  transactionScopeIsReady,
} from "../lib/transactionScope.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  parseRateExpression,
  buildClientRequestId,
  parseBalanceValue,
  countRateDecimalPlaces,
  formatRateAmount,
  formatAmountForStore,
  RATE_STORE_MAX_DECIMALS,
  TX_STORE_MAX_DECIMALS,
} from "../lib/transactionFormat.js";
import {
  buildRatePayload,
  toNumberLike,
  collectSubmitFocusAccountIds,
  computeRateMiddlemanProfit,
  parseMiddlemanRateInput,
  parsePositiveAmt,
} from "../lib/transactionSubmitHelpers.js";
import { submitTransaction, transactionQueryKeys } from "../lib/transactionApi.js";
import { MoneyDecimal } from "../../../utils/money/moneyDecimal.js";
import {
  notifyTransactionListInvalidated,
  resolveGridRowToAccountOption,
} from "../lib/transactionPaymentLogic.js";

function sanitizeTransactionAmountInput(value) {
  const raw = String(value ?? "").replace(/,/g, "");
  if (raw === "") return "";

  const filtered = raw.replace(/[^\d.-]/g, "");
  if (filtered === "") return "";

  const hasLeadingMinus = filtered.startsWith("-");
  let unsigned = filtered.replace(/-/g, "");

  const firstDotIdx = unsigned.indexOf(".");
  if (firstDotIdx !== -1) {
    unsigned = `${unsigned.slice(0, firstDotIdx + 1)}${unsigned.slice(firstDotIdx + 1).replace(/\./g, "")}`;
  }

  return hasLeadingMinus ? `-${unsigned}` : unsigned;
}

/** Badge + list refresh must not block the Submit button after the POST succeeds. */
function kickOffPostSubmitRefresh({ refreshContraInboxBadge, scopeApi, onAfterSuccessfulSubmit, focusOpts }) {
  const tasks = [Promise.resolve(refreshContraInboxBadge?.(scopeApi))];
  if (focusOpts) {
    // Start the submit-focus refresh first: its synchronous flushSync prefix commits
    // the widened currency selection before the invalidate broadcast below fires —
    // otherwise useTransactionSync's tx-data-changed listener re-searches with the
    // stale (pre-submit) currency selection and can clobber this result.
    tasks.push(Promise.resolve(onAfterSuccessfulSubmit?.(focusOpts)));
  }
  // Invalidate Dashboard / TX / Report client caches (do not wait for SSE).
  notifyTransactionListInvalidated("tx_submit");
  void Promise.all(tasks).catch((err) => {
    console.error(err);
  });
}

export function useTransactionForm({
  todayDmy,
  pushToast,
  onSearch,
  onAfterSuccessfulSubmit,
  refreshContraInboxBadge,
  filterSnapshot,
  transactionScope,
  accountOptions,
  m,
  t,
}) {
  const [txType, setTxTypeRaw] = useState("CONTRA");
  useEffect(() => {
    if (txType === "RECEIVE") setTxTypeRaw("CONTRA");
  }, [txType]);
  const [txDate, setTxDate] = useState(null);
  const [txToAccount, setTxToAccount] = useState(null);
  const [txFromAccount, setTxFromAccount] = useState(null);
  const [txCurrency, setTxCurrency] = useState("");
  const [txAmount, setTxAmount] = useState("");
  const [txFullAmount, setTxFullAmount] = useState("");
  const [txRemark, setTxRemark] = useState("");
  const [txConfirm, setTxConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [rateDate, setRateDate] = useState(null);
  const [rateToAccount, setRateToAccount] = useState(null);
  const [rateFromAccount, setRateFromAccount] = useState(null);
  const [rateCurrencyFrom, setRateCurrencyFrom] = useState("");
  const [rateCurrencyTo, setRateCurrencyTo] = useState("");
  const [rateCurrencyFromAmount, setRateCurrencyFromAmount] = useState("");
  const [rateFullAmount, setRateFullAmount] = useState("");
  const [rateExchangeRateRaw, setRateExchangeRateRaw] = useState("");
  const [rateCurrencyToAmount, setRateCurrencyToAmount] = useState("");
  /** Legacy `rate_currency_to_amount.dataset.grossAmount` — submit uses this, not the net preview in `rateCurrencyToAmount`. */
  const [rateToAmountGrossStr, setRateToAmountGrossStr] = useState("");
  /** Legacy `rate_currency_from_amount.dataset` gross slot (only populated after RATE row Reverse swap). */
  const [rateFromAmountGrossStr, setRateFromAmountGrossStr] = useState("");

  const [rateTransferToAccount, setRateTransferToAccount] = useState(null);
  const [rateTransferFromAccount, setRateTransferFromAccount] = useState(null);

  const [rateMiddlemanAccount, setRateMiddlemanAccount] = useState(null);
  const [rateMiddlemanRate, setRateMiddlemanRate] = useState("");
  const [rateMiddlemanAmount, setRateMiddlemanAmount] = useState("");
  const [rateMiddlemanInputAmount, setRateMiddlemanInputAmount] = useState("");
  const [rateMiddlemanPlatformFee, setRateMiddlemanPlatformFee] = useState("");

  // Type switch keeps whichever date was picked in sync across the two independent
  // date fields (txDate for standard types, rateDate for RATE), instead of RATE
  // falling back to today just because rateDate was never written to.
  const setTxType = useCallback(
    (next) => {
      const v = String(next || "").trim().toUpperCase();
      if (v === "RECEIVE") return;
      const nextType = v || "CONTRA";
      if (nextType === "RATE" && txType !== "RATE") {
        setRateDate(txDate);
      } else if (nextType !== "RATE" && txType === "RATE") {
        setTxDate(rateDate);
      }
      setTxTypeRaw(nextType);
    },
    [txType, txDate, rateDate],
  );

  const queryClient = useQueryClient();

  const changeTxAmount = useCallback((val) => {
    setTxAmount(sanitizeTransactionAmountInput(val));
    setTxFullAmount("");
  }, []);

  const changeRateCurrencyFromAmount = useCallback((val) => {
    setRateCurrencyFromAmount(val);
    setRateFullAmount("");
  }, []);
  const scopeKeyRef = useRef(transactionScopeCacheKey(transactionScope));

  useEffect(() => {
    const key = transactionScopeCacheKey(transactionScope);
    if (scopeKeyRef.current === key) return;
    scopeKeyRef.current = key;
    setTxToAccount(null);
    setTxFromAccount(null);
    setRateToAccount(null);
    setRateFromAccount(null);
    setRateTransferToAccount(null);
    setRateTransferFromAccount(null);
    setRateMiddlemanAccount(null);
    setTxFullAmount("");
    setRateFullAmount("");
  }, [transactionScope]);

  const submitMutation = useMutation({
    mutationFn: ({ scopeApi, payload, clientRequestId }) =>
      submitTransaction({ ...scopeApi, payload, clientRequestId }),
    onSuccess: () => {
      // Mark stale only — explicit post-submit refresh owns the refetch.
      queryClient.invalidateQueries({ queryKey: transactionQueryKeys.searchRoot(), refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: transactionQueryKeys.contraInboxRoot(), refetchType: "none" });
    },
  });

    const handleBalanceCellClick = useCallback(
    (row, side) => {
      if (filterSnapshot?.mutationsBlocked) return;
      if (!row) return;
      const isLeftTable = side === "left";
      const balanceAttr =
        row.balance_full != null && String(row.balance_full).trim() !== "" ? row.balance_full : row.balance;
      const rowCurrency =
        row.currency && String(row.currency).trim() ? String(row.currency).trim().toUpperCase() : "";
      const resolved = resolveGridRowToAccountOption(row, accountOptions);
      if (!resolved) {
        pushToast(m.couldNotResolveAccount, "error");
        return;
      }
      const accountCurrency = resolved.currency ? String(resolved.currency).trim().toUpperCase() : "";
      const syncCurrency = rowCurrency || accountCurrency || null;

      const parsedBalance = parseBalanceValue(balanceAttr);
      const isRateView = txType === "RATE";
      const isProfitType = !isRateView && txType === "PROFIT";
      const treatAsPositiveRow = isRateView
        ? isLeftTable
        : isProfitType
          ? (parsedBalance === null ? isLeftTable : parsedBalance >= 0)
          : isLeftTable;

      const parts = [];
      let amountSet = false;
      let amountDisplay = "";

      if (parsedBalance !== null) {
        const absFullVal = MoneyDecimal.abs(String(balanceAttr)).toString();
        if (isRateView) {
          setRateFullAmount(absFullVal);
        } else {
          setTxFullAmount(absFullVal);
        }

        if (isProfitType) {
          try {
            const balDec = MoneyDecimal.toDecimal(String(parsedBalance), 0);
            amountDisplay = MoneyDecimal.formatFixedHalfUp(balDec.toString(), 2);
          } catch {
            const absStr = MoneyDecimal.abs(String(parsedBalance)).toString();
            amountDisplay = MoneyDecimal.formatFixedHalfUp(absStr, 2);
          }
        } else {
          const absStr = MoneyDecimal.abs(String(parsedBalance)).toString();
          amountDisplay = MoneyDecimal.formatFixedHalfUp(absStr, 2);
        }
        amountSet = true;
      }

      if (isRateView) {
        if (treatAsPositiveRow) {
          setRateToAccount(resolved);
          setRateTransferFromAccount(resolved);
        } else {
          setRateFromAccount(resolved);
          setRateTransferToAccount(resolved);
        }
        if (amountSet) setRateCurrencyFromAmount(amountDisplay);
        if (syncCurrency) setRateCurrencyFrom(syncCurrency);
        parts.push(t("syncedFromAccount", { account: row.account_id || resolved.account_id }).replace("From", treatAsPositiveRow ? m.fromAccount : m.toAccount));
        if (amountSet) parts.push(t("syncedAmountShort", { amount: amountDisplay }));
        if (syncCurrency) parts.push(t("syncedCurrency", { currency: syncCurrency }));
        if (parts.length) pushToast(t("synced", { text: parts.join(", ") }), "success");
        else if (amountSet) pushToast(t("syncedAmount", { amount: amountDisplay }), "success");
        return;
      }

      if (treatAsPositiveRow) {
        setTxToAccount(resolved);
      } else {
        setTxFromAccount(resolved);
      }
      if (amountSet) setTxAmount(amountDisplay);
      if (syncCurrency) setTxCurrency(syncCurrency);

      parts.push(t("syncedFromAccount", { account: row.account_id || resolved.account_id }).replace("From", treatAsPositiveRow ? m.fromAccount : m.toAccount));
      if (amountSet) parts.push(t("syncedAmountShort", { amount: amountDisplay }));
      if (syncCurrency) parts.push(t("syncedCurrency", { currency: syncCurrency }));
      if (parts.length) pushToast(t("synced", { text: parts.join(", ") }), "success");
      else if (amountSet) pushToast(t("syncedAmount", { amount: amountDisplay }), "success");
    },
    [accountOptions, filterSnapshot?.mutationsBlocked, pushToast, txType, m, t],
  );

  const needsFromTo = ["CONTRA", "PAYMENT", "CLAIM", "PROFIT", "CLEAR"].includes(txType);
  const showStandardFromAndReverse = txType !== "RATE" && needsFromTo;
  const isAdjustment = txType === "ADJUSTMENT";

  const onReverseAccounts = useCallback(() => {
    if (filterSnapshot?.mutationsBlocked) return;
    const to = txToAccount;
    const from = txFromAccount;
    setTxToAccount(from);
    setTxFromAccount(to);
  }, [filterSnapshot?.mutationsBlocked, txToAccount, txFromAccount]);

  useEffect(() => {
    if (txType !== "RATE") return;

    const clean = (v) => String(v ?? "").replace(/,/g, "").trim();

    const parsed = parseRateExpression(rateExchangeRateRaw);
    let rateDec = MoneyDecimal.toDecimal("0", 0);
    if (parsed.valid) {
      try {
        rateDec = MoneyDecimal.toDecimal(parsed.value, 0);
      } catch {
        // ignore
      }
    }

    // MM profit: Fee − PT（PT-Fee 恒为正数、恒代表减法）；负 Rate-Mul 仅除法 Rate 生效
    const finalFeeDec = computeRateMiddlemanProfit({
      fromAmount: rateCurrencyFromAmount,
      middlemanRate: rateMiddlemanRate,
      feeAmount: rateMiddlemanInputAmount,
      platformFeeAmount: rateMiddlemanPlatformFee,
      exchangeRateRaw: rateExchangeRateRaw,
    });
    let middleStr = "";
    if (!finalFeeDec.isZero()) {
      middleStr = formatRateAmount(finalFeeDec.toString());
    } else if (
      finalFeeDec.isZero() &&
      (clean(rateMiddlemanRate) || clean(rateMiddlemanInputAmount) || clean(rateMiddlemanPlatformFee))
    ) {
      middleStr = "0.00";
    }
    setRateMiddlemanAmount(middleStr);

    // To preview: gross − Middle-Man Amount（finalFeeDec，含 Rate-Mul + Fee，两个都填就都扣）。
    // Calc uses full precision; formatRateAmount is display-only half-up 2.
    const toAmountDeductionDec = finalFeeDec;

    try {
      const fromDec = MoneyDecimal.toDecimal(clean(rateCurrencyFromAmount) || "0", 0);
      if (!parsed.valid || !fromDec.gt(0)) {
        setRateCurrencyToAmount("");
        setRateToAmountGrossStr("");
        return;
      }
      if (!rateDec.gt(0)) {
        setRateCurrencyToAmount("");
        setRateToAmountGrossStr("");
        return;
      }

      const baseGross = fromDec.times(rateDec);

      const grossDisplayStr = formatRateAmount(baseGross.toString());
      setRateToAmountGrossStr(grossDisplayStr);

      let displayVal = baseGross;
      if (!toAmountDeductionDec.isZero()) {
        displayVal = displayVal.minus(toAmountDeductionDec);
      }

      setRateCurrencyToAmount(formatRateAmount(displayVal.toString()));
    } catch {
      setRateCurrencyToAmount("");
      setRateToAmountGrossStr("");
    }
  }, [
    txType,
    rateCurrencyFromAmount,
    rateExchangeRateRaw,
    rateMiddlemanRate,
    rateMiddlemanInputAmount,
    rateMiddlemanPlatformFee,
  ]);

  const onRateCurrencyRowReverse = useCallback(() => {
    const tmpAmt = rateCurrencyFromAmount;
    setRateCurrencyFromAmount(rateCurrencyToAmount);
    setRateFullAmount("");
    setRateCurrencyToAmount(tmpAmt);
    const tmpGrossTo = rateToAmountGrossStr;
    setRateToAmountGrossStr(rateFromAmountGrossStr);
    setRateFromAmountGrossStr(tmpGrossTo);
  }, [rateCurrencyFromAmount, rateCurrencyToAmount, rateToAmountGrossStr, rateFromAmountGrossStr]);

  const onSubmitTx = async () => {
    if (!txConfirm) return;
    if (submitting) return;
    if (filterSnapshot?.mutationsBlocked) {
      pushToast(m.readOnlyModeCannotSubmit, "error");
      return;
    }

    const scopeApi = transactionScopeApiParams(transactionScope);
    if (!transactionScopeIsReady(transactionScope)) {
      pushToast(m.submitFailed, "error");
      return;
    }

    if (!txType) {
      pushToast(m.pleaseSelectTransactionType, "error");
      return;
    }
    if (txType === "RECEIVE") {
      pushToast(m.receiveTypeDisabled, "error");
      return;
    }

    if (txType === "RATE") {
      const toId = rateToAccount?.id ? String(rateToAccount.id) : "";
      const fromId = rateFromAccount?.id ? String(rateFromAccount.id) : "";
      if (!toId) {
        pushToast(m.pleaseSelectToAccount, "error");
        return;
      }
      if (!fromId) {
        pushToast(m.rateTransactionNeedFromAccount, "error");
        return;
      }
      if (!rateCurrencyFrom || !rateCurrencyTo) {
        pushToast(m.pleaseSelectBothCurrencies, "error");
        return;
      }
      const finalRateAmount = rateFullAmount || rateCurrencyFromAmount;
      const fromAmt = toNumberLike(finalRateAmount);
      const toGrossRaw = String(rateToAmountGrossStr || "").trim().replace(/,/g, "");
      const toGrossStr = toGrossRaw !== "" ? toGrossRaw : String(rateCurrencyToAmount || "").trim().replace(/,/g, "");
      const grossNum = toNumberLike(toGrossStr);
      if (!Number.isFinite(fromAmt) || fromAmt <= 0 || !Number.isFinite(grossNum) || grossNum <= 0) {
        pushToast(m.pleaseEnterValidCurrencyAmounts, "error");
        return;
      }
      const parsedRate = parseRateExpression(rateExchangeRateRaw);
      if (!parsedRate.valid) {
        pushToast(m.pleaseEnterValidRateValue, "error");
        return;
      }
      if (!rateDate) {
        pushToast(m.pleaseSelectTransactionDate, "error");
        return;
      }

      const middleId = rateMiddlemanAccount?.id ? String(rateMiddlemanAccount.id) : "";
      const mmrNorm = String(rateMiddlemanRate ?? "")
        .replace(/,/g, "")
        .trim();
      const mmFeeNorm = String(rateMiddlemanInputAmount ?? "")
        .replace(/,/g, "")
        .trim();
      const mmPlatNorm = String(rateMiddlemanPlatformFee ?? "")
        .replace(/,/g, "")
        .trim();
      const hasMiddleRate = mmrNorm !== "";
      const hasMiddleFee = mmFeeNorm !== "";
      const hasMiddlePlatFee = mmPlatNorm !== "";
      const hasAnyMiddleParam = hasMiddleRate || hasMiddleFee || hasMiddlePlatFee;

      // Middle-Man: account alone needs rate multiplier, fee, or platform fee; filling any of the three requires account.
      if (hasAnyMiddleParam && !middleId) {
        pushToast(m.pleaseSelectMiddleManAccount, "error");
        return;
      }
      if (middleId && !hasAnyMiddleParam) {
        pushToast(m.pleaseEnterMiddleManRateOrFee, "error");
        return;
      }
      if (hasMiddleRate && !parseMiddlemanRateInput(mmrNorm).valid) {
        pushToast(m.pleaseEnterMiddleManRate, "error");
        return;
      }
      if (countRateDecimalPlaces(String(finalRateAmount ?? "").replace(/,/g, "").trim()) > RATE_STORE_MAX_DECIMALS) {
        pushToast(m.rateAmountMaxDecimals, "error");
        return;
      }

      setSubmitting(true);
      try {
        const clientRequestId = buildClientRequestId();
        const { payload } = buildRatePayload({
          toId,
          fromId,
          fromAmt: finalRateAmount,
          toGrossStr,
          rateDate,
          txRemark,
          rateCurrencyFrom,
          rateCurrencyTo,
          parsedRateNormalizedStr: parsedRate.value,
          rateMiddlemanRate,
          rateMiddlemanAmount,
          rateMiddlemanAccount,
          rateExchangeRateRaw,
          rateFromAccount,
          rateToAccount,
          rateTransferToAccount,
          rateTransferFromAccount,
          rateMiddlemanInputAmount,
          rateMiddlemanPlatformFee,
        });

        const res = await submitMutation.mutateAsync({ scopeApi, payload, clientRequestId });
        if (res?.success) {
          const approvalStatus = res?.data?.approval_status ? String(res.data.approval_status).toUpperCase() : "";
          if (approvalStatus === "PENDING") {
            pushToast(m.submittedWaitingApproval, "info");
          } else {
            pushToast(res?.message || m.rateTransactionSubmitted, "success");
          }
          setTxConfirm(false);
          setRateCurrencyFromAmount("");
          setRateFullAmount("");
          // Rate is left intact after submit — customers commonly repeat the same
          // rate across several accounts, so re-entering it each time is friction.
          setRateCurrencyToAmount("");
          setRateToAmountGrossStr("");
          setRateFromAmountGrossStr("");
          setRateMiddlemanRate("");
          setRateMiddlemanAmount("");
          setRateMiddlemanInputAmount("");
          setRateMiddlemanPlatformFee("");
          setRateToAccount(null);
          setRateFromAccount(null);
          setRateTransferToAccount(null);
          setRateTransferFromAccount(null);
          setRateMiddlemanAccount(null);
          kickOffPostSubmitRefresh({
            refreshContraInboxBadge,
            scopeApi,
            onAfterSuccessfulSubmit,
            focusOpts:
              approvalStatus === "PENDING"
                ? null
                : {
                    accountIds: collectSubmitFocusAccountIds({
                      txType: "RATE",
                      rateToAccountId: rateToAccount?.id,
                      rateFromAccountId: rateFromAccount?.id,
                      rateTransferToAccountId: rateTransferToAccount?.id,
                      rateTransferFromAccountId: rateTransferFromAccount?.id,
                      rateMiddlemanAccountId: rateMiddlemanAccount?.id,
                    }),
                    submitCurrency: [rateCurrencyFrom, rateCurrencyTo],
                    transactionDate: rateDate,
                  },
          });
          return;
        }
        pushToast(res?.message || m.submitFailed, "error");
      } catch (e) {
        console.error(e);
        pushToast(m.networkError, "error");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const toId = txToAccount?.id ? String(txToAccount.id) : "";
    const fromId = txFromAccount?.id ? String(txFromAccount.id) : "";

    if (!toId) {
      pushToast(m.pleaseSelectToAccount, "error");
      return;
    }

    const needsFromTo = ["CONTRA", "PAYMENT", "CLAIM", "PROFIT", "CLEAR"].includes(txType);
    const isAdjustment = txType === "ADJUSTMENT";

    if (txType === "PROFIT") {
      if (!fromId) {
        pushToast(m.profitPleaseSelectFromAccount, "error");
        return;
      }
      if (toId && fromId && toId === fromId) {
        pushToast(m.profitSameAccountError, "error");
        return;
      }
    }

    if (needsFromTo && (!fromId || fromId === toId)) {
      pushToast(m.paymentContraEtcNeedFromAccount, "error");
      return;
    }

    if (!txDate) {
      pushToast(m.pleaseSelectTransactionDate, "error");
      return;
    }

    const finalAmount = txFullAmount || txAmount;
    const cleanedAmt = MoneyDecimal.cleanMoneyInput(finalAmount);
    if (cleanedAmt === "") {
      pushToast(
        isAdjustment ? m.pleaseEnterNonZeroAdjustment : m.pleaseEnterValidAmount,
        "error",
      );
      return;
    }

    let amtDec;
    try {
      amtDec = MoneyDecimal.toDecimal(cleanedAmt);
    } catch {
      pushToast(m.pleaseEnterValidAmount, "error");
      return;
    }

    const isProfitTx = txType === "PROFIT";

    if (isAdjustment && amtDec.isZero()) {
      pushToast(m.pleaseEnterNonZeroAdjustment, "error");
      return;
    }
    if (isProfitTx && amtDec.isZero()) {
      pushToast(m.profitEnterNonZeroAmount, "error");
      return;
    }
    if (!isAdjustment && !isProfitTx && amtDec.lt(0)) {
      pushToast(m.pleaseEnterValidAmountGteZero, "error");
      return;
    }

    if (countRateDecimalPlaces(cleanedAmt) > TX_STORE_MAX_DECIMALS) {
      pushToast(m.amountMaxDecimals, "error");
      return;
    }

    if (!txCurrency) {
      pushToast(m.pleaseSelectCurrency, "error");
      return;
    }

    setSubmitting(true);
    try {
      const clientRequestId = buildClientRequestId();
      const storeAmt = formatAmountForStore(
        isProfitTx ? amtDec.abs().toString() : cleanedAmt,
        TX_STORE_MAX_DECIMALS,
      );
      const payload = {
        transaction_type: isProfitTx ? (amtDec.lt(0) ? "LOSE" : "WIN") : txType,
        account_id: toId,
        from_account_id: isAdjustment ? "" : fromId || "",
        amount: storeAmt,
        transaction_date: txDate,
        description: "",
        sms: String(txRemark || "").toUpperCase(),
        currency: txCurrency,
      };

      const res = await submitMutation.mutateAsync({ scopeApi, payload, clientRequestId });
      if (res?.success) {
        const approvalStatus = res?.data?.approval_status ? String(res.data.approval_status).toUpperCase() : "";
        if (approvalStatus === "PENDING") {
          pushToast(m.submittedWaitingApproval, "info");
        } else {
          pushToast(res?.message || m.transactionSubmitted, "success");
        }
        setTxAmount("");
        setTxFullAmount("");
        setTxConfirm(false);
        kickOffPostSubmitRefresh({
          refreshContraInboxBadge,
          scopeApi,
          onAfterSuccessfulSubmit,
          focusOpts:
            approvalStatus === "PENDING"
              ? null
              : {
                  accountIds: collectSubmitFocusAccountIds({
                    txType,
                    toAccountId: toId,
                    fromAccountId: fromId,
                    isAdjustment,
                  }),
                  submitCurrency: txCurrency,
                  amount: payload.amount,
                  txType: payload.transaction_type,
                  toAccountId: toId,
                  fromAccountId: isAdjustment ? "" : fromId,
                  transactionDate: txDate,
                },
        });
        return;
      }
      pushToast(res?.message || m.submitFailed, "error");
    } catch (e) {
      console.error(e);
      pushToast(m.networkError, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return {
    txType,
    setTxType,
    txDate,
    setTxDate,
    txToAccount,
    setTxToAccount,
    txFromAccount,
    setTxFromAccount,
    txCurrency,
    setTxCurrency,
    txAmount,
    setTxAmount: changeTxAmount,
    txRemark,
    setTxRemark,
    txConfirm,
    setTxConfirm,
    submitting,
    setSubmitting,
    needsFromTo,
    showStandardFromAndReverse,
    isAdjustment,
    onReverseAccounts,
    rateDate,
    setRateDate,
    rateToAccount,
    setRateToAccount,
    rateFromAccount,
    setRateFromAccount,
    rateCurrencyFrom,
    setRateCurrencyFrom,
    rateCurrencyTo,
    setRateCurrencyTo,
    rateCurrencyFromAmount,
    setRateCurrencyFromAmount: changeRateCurrencyFromAmount,
    rateExchangeRateRaw,
    setRateExchangeRateRaw,
    rateCurrencyToAmount,
    setRateCurrencyToAmount,
    onRateCurrencyRowReverse,
    rateTransferToAccount,
    setRateTransferToAccount,
    rateTransferFromAccount,
    setRateTransferFromAccount,
    rateMiddlemanAccount,
    setRateMiddlemanAccount,
    rateMiddlemanRate,
    setRateMiddlemanRate,
    rateMiddlemanAmount,
    setRateMiddlemanAmount,
    rateMiddlemanInputAmount,
    setRateMiddlemanInputAmount,
    rateMiddlemanPlatformFee,
    setRateMiddlemanPlatformFee,
    onSubmitTx,
    handleBalanceCellClick,
  };
}
