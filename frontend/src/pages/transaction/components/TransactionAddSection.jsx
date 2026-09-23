import { useMemo } from "react";
import SimpleSelect from "../../../components/SimpleSelect.jsx";
import AccountSelect from "./AccountSelect.jsx";
import { assetUrl } from "../../../utils/core/apiUrl.js";

const TX_TYPE_OPTIONS = [
  "CONTRA",
  "PAYMENT",
  "CLAIM",
  "PROFIT",
  "RATE",
  "ADJUSTMENT",
  "CLEAR",
];

export default function TransactionAddSection({
  txType,
  setTxType,
  todayDmy,
  txDate,
  rateDate,
  accountOptions,
  txToAccount,
  setTxToAccount,
  showStandardFromAndReverse,
  txFromAccount,
  setTxFromAccount,
  onReverseAccounts,
  txCurrency,
  setTxCurrency,
  currencyOptions,
  txAmount,
  setTxAmount,
  rateToAccount,
  setRateToAccount,
  rateFromAccount,
  setRateFromAccount,
  rateCurrencyFrom,
  setRateCurrencyFrom,
  rateCurrencyFromAmount,
  setRateCurrencyFromAmount,
  rateExchangeRateRaw,
  setRateExchangeRateRaw,
  rateCurrencyTo,
  setRateCurrencyTo,
  rateCurrencyToAmount,
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
  rateMiddlemanInputAmount,
  setRateMiddlemanInputAmount,
  rateMiddlemanPlatformFee,
  setRateMiddlemanPlatformFee,
  txRemark,
  setTxRemark,
  txConfirm,
  setTxConfirm,
  submitting,
  onSubmitTx,
  onTypeSearch,
  onExitTypeSearch,
  typeSearchActive = false,
  searchLoading,
  mutationsBlocked = false,
  m,
  t,
}) {
  const standardHidden = txType === "RATE";
  const dateDisplayStandard = txDate?.trim() || todayDmy;
  const dateDisplayRate = rateDate?.trim() || todayDmy;
  const txTypeOptions = useMemo(() => TX_TYPE_OPTIONS.map((v) => ({ value: v, label: v })), []);
  const currencySelectOptions = useMemo(
    () => (currencyOptions || []).map((c) => ({ value: c, label: c })),
    [currencyOptions],
  );

  return (
    <div className={`transaction-add-section${mutationsBlocked ? " transaction-add-section--read-only" : ""}`}>
      <div className="transaction-form-group">
        <label className="transaction-label" htmlFor="transaction_type">
          {m.type}
        </label>
        <SimpleSelect
          id="transaction_type"
          className="transaction-select"
          value={txType}
          disabled={mutationsBlocked}
          onChange={setTxType}
          options={txTypeOptions}
          placeholder={m.type}
          includeEmptyOption={false}
        />
      </div>

      <div id="standard-transaction-fields" style={{ display: standardHidden ? "none" : "block" }}>
        <div className="transaction-form-group">
          <label className="transaction-label" htmlFor="transaction_date">
            {m.date}
          </label>
          <div className="transaction-add-datepicker-wrap">
            <input
              type="text"
              id="transaction_date"
              className="transaction-input"
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              placeholder={m.placeholderDdMmYyyy}
              value={dateDisplayStandard}
            />
            <input type="hidden" id="add_tx_date_from" readOnly aria-hidden="true" />
            <input type="hidden" id="add_tx_date_to" readOnly aria-hidden="true" />
            <div
              className={`date-range-picker transaction-add-datepicker-hitbox${mutationsBlocked ? " transaction-add-datepicker-hitbox--read-only" : ""}`}
              id="add-tx-date-range-picker"
              role="button"
              tabIndex={mutationsBlocked ? -1 : 0}
              aria-label="Transaction date"
              data-drp-from="add_tx_date_from"
              data-drp-to="add_tx_date_to"
              data-drp-display="add-tx-date-range-display"
              data-drp-collapse-single="true"
            >
              <span id="add-tx-date-range-display" className="transaction-add-datepicker-sr-span" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label">{m.account}</label>
          <div className={`transaction-account-inputs${showStandardFromAndReverse ? "" : " transaction-account-inputs--to-only"}`}>
            <AccountSelect
              ariaLabel={m.toAccount}
              placeholder={m.selectToAccount}
              options={accountOptions}
              value={txToAccount}
              onChange={setTxToAccount}
              disabled={mutationsBlocked}
              searchPlaceholder={m.searchAccount}
            />
            {showStandardFromAndReverse ? (
              <>
                <AccountSelect
                  ariaLabel={m.fromAccount}
                  placeholder={m.selectFromAccount}
                  options={accountOptions}
                  value={txFromAccount}
                  onChange={setTxFromAccount}
                  disabled={mutationsBlocked}
                  searchPlaceholder={m.searchAccount}
                />
                <button
                  type="button"
                  id="account_reverse_btn"
                  className="transaction-account-reverse-btn"
                  title={m.reverseAccounts}
                  aria-label={m.reverseAccounts}
                  disabled={mutationsBlocked}
                  onClick={onReverseAccounts}
                >
                  {m.reverse}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label" htmlFor="transaction_currency">
            {m.currency}
          </label>
          <SimpleSelect
            id="transaction_currency"
            className="transaction-select"
            value={txCurrency}
            disabled={mutationsBlocked}
            onChange={setTxCurrency}
            options={currencySelectOptions}
            placeholder={m.selectCurrency}
          />
        </div>

        <div className="transaction-form-group">
          <label className="transaction-label" htmlFor="action_amount">
            {m.amount}
          </label>
          <input
            type="text"
            inputMode="decimal"
            id="action_amount"
            className="transaction-input"
            value={txAmount}
            disabled={mutationsBlocked}
            onChange={(e) => setTxAmount(e.target.value)}
          />
        </div>
      </div>

      <div id="rate-transaction-fields" className="rate-fields" style={{ display: txType === "RATE" ? "flex" : "none" }}>
        <div className="transaction-form-group">
          <label className="transaction-label" htmlFor="rate_transaction_date">
            {m.date}
          </label>
          <div className="transaction-date-rate-wrap-inner">
            <input
              type="text"
              id="rate_transaction_date"
              className="transaction-input"
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              placeholder={m.placeholderDdMmYyyy}
              value={dateDisplayRate}
            />
            <input type="hidden" id="rate_tx_date_from" readOnly aria-hidden="true" />
            <input type="hidden" id="rate_tx_date_to" readOnly aria-hidden="true" />
            <div
              className={`date-range-picker transaction-add-datepicker-hitbox${mutationsBlocked ? " transaction-add-datepicker-hitbox--read-only" : ""}`}
              id="rate-tx-date-range-picker"
              role="button"
              tabIndex={mutationsBlocked ? -1 : 0}
              aria-label={m.rateTransactionDate}
              data-drp-from="rate_tx_date_from"
              data-drp-to="rate_tx_date_to"
              data-drp-display="rate-tx-date-range-display"
              data-drp-collapse-single="true"
            >
              <span id="rate-tx-date-range-display" className="transaction-add-datepicker-sr-span" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label">{m.account}</label>
          <div className="transaction-account-inputs">
            <AccountSelect
              ariaLabel={m.toAccount}
              placeholder={m.selectToAccount}
              options={accountOptions}
              value={rateToAccount}
              onChange={setRateToAccount}
              disabled={mutationsBlocked}
              searchPlaceholder={m.searchAccount}
            />
            <AccountSelect
              ariaLabel={m.fromAccount}
              placeholder={m.selectFromAccount}
              options={accountOptions}
              value={rateFromAccount}
              onChange={setRateFromAccount}
              disabled={mutationsBlocked}
              searchPlaceholder={m.searchAccount}
            />
            <button
              type="button"
              id="rate_account_reverse_btn"
              className="transaction-account-reverse-btn rate-reverse-btn"
              title={m.reverseAccounts}
              aria-label={m.reverseAccounts}
              disabled={mutationsBlocked}
              onClick={() => {
                setRateToAccount(rateFromAccount);
                setRateFromAccount(rateToAccount);
              }}
            >
              {m.reverse}
            </button>
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label">{m.currency}</label>
          <div className="rate-row rate-row-five-cols">
            <SimpleSelect
              id="rate_currency_from"
              className="transaction-select"
              value={rateCurrencyFrom}
              disabled={mutationsBlocked}
              onChange={setRateCurrencyFrom}
              options={currencySelectOptions}
              placeholder={m.currency}
            />
            <input
              type="number"
              step="0.01"
              id="rate_currency_from_amount"
              className="transaction-input"
              placeholder={m.amount}
              value={rateCurrencyFromAmount}
              disabled={mutationsBlocked}
              onChange={(e) => setRateCurrencyFromAmount(e.target.value)}
              aria-label={m.fromAccount}
            />
            <input
              type="text"
              inputMode="decimal"
              id="rate_exchange_rate"
              className="transaction-input"
              placeholder={m.rate}
              value={rateExchangeRateRaw}
              disabled={mutationsBlocked}
              onChange={(e) => setRateExchangeRateRaw(e.target.value)}
              aria-label={m.rate}
            />
            <SimpleSelect
              id="rate_currency_to"
              className="transaction-select"
              value={rateCurrencyTo}
              disabled={mutationsBlocked}
              onChange={setRateCurrencyTo}
              options={currencySelectOptions}
              placeholder={m.currency}
            />
            <input
              type="number"
              step="0.01"
              id="rate_currency_to_amount"
              className="transaction-input"
              placeholder={m.amount}
              readOnly
              disabled={mutationsBlocked}
              value={rateCurrencyToAmount}
              aria-label={m.toAccount}
            />
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label">{m.account}</label>
          <div className="transaction-account-inputs">
            <AccountSelect
              ariaLabel={m.toAccount}
              placeholder={m.selectToAccount}
              options={accountOptions}
              value={rateTransferToAccount}
              onChange={setRateTransferToAccount}
              disabled={mutationsBlocked}
              searchPlaceholder={m.searchAccount}
            />
            <AccountSelect
              ariaLabel={m.fromAccount}
              placeholder={m.selectFromAccount}
              options={accountOptions}
              value={rateTransferFromAccount}
              onChange={setRateTransferFromAccount}
              disabled={mutationsBlocked}
              searchPlaceholder={m.searchAccount}
            />
            <button
              type="button"
              id="rate_transfer_reverse_btn"
              className="transaction-account-reverse-btn rate-reverse-btn"
              title={m.reverseAccounts}
              aria-label={m.reverseAccounts}
              disabled={mutationsBlocked}
              onClick={() => {
                setRateTransferToAccount(rateTransferFromAccount);
                setRateTransferFromAccount(rateTransferToAccount);
              }}
            >
              {m.reverse}
            </button>
          </div>
        </div>

        <div className="transaction-form-group transaction-inline-row">
          <label className="transaction-label">{m.middleMan}</label>
          <div className="rate-row rate-row-mm">
            <div className="rate-mm-to-wrap">
              <AccountSelect
                ariaLabel={m.middleMan}
                placeholder={m.selectMiddleManAccount}
                options={accountOptions}
                value={rateMiddlemanAccount}
                onChange={setRateMiddlemanAccount}
                disabled={mutationsBlocked}
                searchPlaceholder={m.searchAccount}
              />
            </div>
            <div className="rate-mm-rest">
              <input
                type="text"
                inputMode="decimal"
                id="rate_middleman_rate"
                className="transaction-input"
                placeholder={m.rateMultiplier}
                value={rateMiddlemanRate}
                disabled={mutationsBlocked}
                onChange={(e) => setRateMiddlemanRate(e.target.value)}
                aria-label={m.rateMultiplier}
              />
              <input
                type="number"
                step="0.01"
                min="0"
                id="rate_middleman_input_amount"
                className="transaction-input"
                placeholder={m.fee}
                disabled={mutationsBlocked}
                value={rateMiddlemanInputAmount}
                onChange={(e) => setRateMiddlemanInputAmount(e.target.value.replace(/-/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "-" || e.key === "Subtract") e.preventDefault();
                }}
                aria-label={m.fee}
              />
              <input
                type="number"
                step="0.01"
                id="rate_middleman_platform_fee"
                className="transaction-input"
                placeholder={m.platformFee}
                disabled={mutationsBlocked}
                value={rateMiddlemanPlatformFee}
                onChange={(e) => {
                  const digits = e.target.value.replace(/-/g, "");
                  setRateMiddlemanPlatformFee(digits ? `-${digits}` : "");
                }}
                aria-label={m.platformFee}
              />
              <input
                type="number"
                step="0.01"
                id="rate_middleman_amount"
                className="transaction-input"
                placeholder={m.amount}
                readOnly
                disabled={mutationsBlocked}
                value={rateMiddlemanAmount}
                aria-label={m.middleMan}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="transaction-form-group" style={{ display: "none" }}>
        <label className="transaction-label" htmlFor="action_description">
          {m.descriptionField}
        </label>
        <input type="text" id="action_description" className="transaction-input text-uppercase" />
      </div>

      <div
        className="transaction-form-group"
        id="remark_form_group"
        style={{ display: txType === "RATE" ? "none" : undefined }}
      >
        <label className="transaction-label" htmlFor="action_sms">
          {m.remark}
        </label>
        <input
          type="text"
          id="action_sms"
          className="transaction-input text-uppercase"
          value={txRemark}
          disabled={mutationsBlocked}
          onChange={(e) => setTxRemark(e.target.value)}
        />
      </div>

      <div className="transaction-confirm-actions">
        <label className="transaction-checkbox-label transaction-confirm-label">
          <input
            type="checkbox"
            id="confirm_submit"
            className="transaction-checkbox"
            checked={txConfirm}
            disabled={mutationsBlocked}
            onChange={(e) => setTxConfirm(e.target.checked)}
          />
          {m.confirmSubmit}
        </label>
        <div className="transaction-action-btns">
          <button
            type="button"
            id="submit_btn"
            className="transaction-submit-btn"
            disabled={!txConfirm || submitting || mutationsBlocked}
            onClick={onSubmitTx}
          >
            {submitting ? m.submitting : m.submit}
          </button>
          <button type="button" id="action_search_btn" className="transaction-search-btn" onClick={onTypeSearch} disabled={searchLoading}>
            {m.search}
          </button>
          {typeSearchActive ? (
            <button
              type="button"
              id="action_refresh_btn"
              className="transaction-refresh-btn"
              onClick={onExitTypeSearch}
              disabled={searchLoading}
              title={m.exitTypeSearchAndRefreshTitle}
              aria-label={m.exitTypeSearchAndRefreshTitle}
              aria-busy={searchLoading || undefined}
            >
              <img
                src={assetUrl("images/refresh.svg")}
                alt=""
                aria-hidden="true"
                style={{ width: "clamp(23px, 1.8vw, 35px)", height: "clamp(23px, 1.8vw, 35px)" }}
              />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
