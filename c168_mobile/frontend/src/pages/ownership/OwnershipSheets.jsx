import { useEffect, useMemo, useState } from "react";
import { useOverlayLock } from "../../hooks/useOverlayLock.js";
import {
  accountPickerLabel,
  accountsForRowPicker,
  getOwnershipCurrentMonthKey,
  getOwnershipMonthLabels,
  isExternalPartnerRow,
  maxAllowedOwnershipPct,
} from "../../lib/ownershipLogic.js";
import "../account/account.css";

function Sheet({ open, title, onClose, tall = false, elevate = false, children, footer = null }) {
  useOverlayLock(open, onClose);
  return (
    <div
      className={`m-sheet-overlay${elevate ? " m-sheet-overlay--high" : ""}${
        open ? " m-sheet-overlay--open" : " m-sheet-overlay--closed"
      }`}
      aria-hidden={!open}
      inert={open ? undefined : ""}
    >
      <button type="button" className="m-sheet-backdrop" onClick={onClose} aria-label="Close" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`m-sheet-panel${tall ? " m-sheet-panel--tall" : ""}${
          open ? " m-sheet-panel--open" : " m-sheet-panel--closed"
        }`}
      >
        <div className="m-sheet-handle-wrap" aria-hidden="true">
          <span className="m-sheet-handle" />
        </div>
        <header className="m-sheet-header">
          <h2 className="m-sheet-title">{title}</h2>
          <button type="button" className="m-sheet-close tap-scale" onClick={onClose} aria-label="Close">
            <i className="fas fa-xmark" aria-hidden="true" />
          </button>
        </header>
        <div className="m-sheet-body m-account-sheet-body">{children}</div>
        {footer ? <footer className="m-account-sheet-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

function normalizePct(value) {
  const p = parseFloat(String(value).replace("%", ""));
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

function EditorRow({
  idx,
  row,
  accounts,
  maxPercentage,
  onUpdate,
  onRemove,
  readOnlyMode,
  t,
}) {
  const storedPct = normalizePct(row.percentage);
  const [inputValue, setInputValue] = useState(`${storedPct}%`);
  const pctMax = Math.max(0, Math.min(100, Number(maxPercentage) || 0));
  const isPartnerRow = isExternalPartnerRow(row);
  const isPartnership = String(row.role || "").toLowerCase() === "partnership";
  const showRo = isPartnership || isPartnerRow;
  const sliderDisabled = readOnlyMode || pctMax <= 0;
  const layoutLocked = readOnlyMode;
  const picker = accountsForRowPicker(accounts, row.account_id);

  useEffect(() => {
    setInputValue(`${storedPct}%`);
  }, [storedPct, row.clientRowId, row.account_id]);

  const commitPct = (raw) => {
    const next = Math.min(normalizePct(raw), pctMax);
    setInputValue(`${next}%`);
    onUpdate(idx, "percent_input", next);
  };

  return (
    <div className="m-own-row">
      <select
        className="m-own-select"
        value={row.account_id || ""}
        disabled={layoutLocked || isPartnerRow}
        onChange={(e) => onUpdate(idx, "account_id", e.target.value)}
      >
        <option value="">{t("selectAccountPlaceholder")}</option>
        {picker.map((acc) => (
          <option key={String(acc.id)} value={acc.id}>
            {accountPickerLabel(acc)}
            {parseInt(acc.is_main_owner, 10) === 1 ? t("mainOwnerSuffix") : ""}
          </option>
        ))}
      </select>

      <div className="m-own-pct">
        <input
          type="text"
          inputMode="decimal"
          className="m-own-pct-input"
          value={inputValue}
          disabled={sliderDisabled}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={(e) => commitPct(e.target.value)}
        />
        <input
          type="range"
          className="m-own-slider"
          min={0}
          max={100}
          step={1}
          value={storedPct}
          disabled={sliderDisabled}
          onChange={(e) => commitPct(e.target.value)}
        />
      </div>

      <div className="m-own-row-actions">
        {showRo ? (
          <label className="m-own-ro">
            <span>{t("readOnly")}</span>
            <button
              type="button"
              className={`m-account-switch${row.read_only === 1 ? " is-on" : ""}`}
              disabled={layoutLocked}
              aria-pressed={row.read_only === 1}
              onClick={() => onUpdate(idx, "read_only", row.read_only === 1 ? 0 : 1)}
            >
              <span />
            </button>
          </label>
        ) : null}
        <button
          type="button"
          className="m-own-remove tap-scale"
          disabled={layoutLocked}
          onClick={() => onRemove(idx)}
          aria-label={t("remove")}
        >
          <i className="fas fa-trash-can" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function PartnerBlock({ disabled, onLink, t, descKey }) {
  const [val, setVal] = useState("");
  const [linking, setLinking] = useState(false);

  return (
    <div className="m-own-partner">
      <strong>{t("externalPartner")}</strong>
      <p>{t(descKey)}</p>
      <div className="m-own-partner-row">
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          className="m-own-partner-input"
          placeholder={t("loginOrGroupId")}
          value={val}
          disabled={disabled || linking}
          onChange={(e) => setVal(e.target.value)}
        />
        <button
          type="button"
          className="m-account-secondary-btn tap-scale"
          disabled={disabled || linking || !val.trim()}
          onClick={async () => {
            const login = val.trim().toUpperCase();
            if (!login) return;
            setLinking(true);
            const ok = await onLink(login);
            setLinking(false);
            if (ok) setVal("");
          }}
        >
          {linking ? t("linking") : t("linkPartner")}
        </button>
      </div>
    </div>
  );
}

export function OwnershipMonthSheet({ open, onClose, selectedMonth, onMonthChange, lang, t }) {
  const currentMonthKey = getOwnershipCurrentMonthKey();
  const currentYear = parseInt(currentMonthKey.slice(0, 4), 10);
  const [viewYear, setViewYear] = useState(() => parseInt(String(selectedMonth).slice(0, 4), 10) || currentYear);
  const monthLabels = useMemo(() => getOwnershipMonthLabels(lang), [lang]);

  useEffect(() => {
    if (open) setViewYear(parseInt(String(selectedMonth).slice(0, 4), 10) || currentYear);
  }, [open, selectedMonth, currentYear]);

  const pickMonth = (monthIndex) => {
    const key = `${viewYear}-${String(monthIndex).padStart(2, "0")}`;
    if (key > currentMonthKey) return;
    onMonthChange(key);
    onClose();
  };

  return (
    <Sheet open={open} title={t("viewMonth")} onClose={onClose}>
      <div className="m-own-month">
        <div className="m-own-month-year">
          <button type="button" className="m-own-year-btn tap-scale" onClick={() => setViewYear((y) => y - 1)}>
            <i className="fas fa-chevron-left" aria-hidden="true" />
          </button>
          <strong>{viewYear}</strong>
          <button
            type="button"
            className="m-own-year-btn tap-scale"
            disabled={viewYear >= currentYear}
            onClick={() => setViewYear((y) => Math.min(currentYear, y + 1))}
          >
            <i className="fas fa-chevron-right" aria-hidden="true" />
          </button>
        </div>
        <div className="m-own-month-grid">
          {monthLabels.map((label, idx) => {
            const monthIndex = idx + 1;
            const key = `${viewYear}-${String(monthIndex).padStart(2, "0")}`;
            const disabled = key > currentMonthKey;
            const selected = selectedMonth === key;
            return (
              <button
                key={label}
                type="button"
                className={`m-own-month-cell tap-scale${selected ? " is-selected" : ""}`}
                disabled={disabled}
                onClick={() => pickMonth(monthIndex)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {selectedMonth !== currentMonthKey ? (
          <button
            type="button"
            className="m-account-secondary-btn tap-scale"
            onClick={() => {
              onMonthChange(currentMonthKey);
              onClose();
            }}
          >
            {t("currentMonth")}
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}

export function OwnershipEditorSheet({
  open,
  onClose,
  title,
  loading,
  saving,
  state,
  t,
  fmtPct,
  calcTotal,
  readOnlyMode,
  partnerLocked,
  partnerDescKey,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
  onLinkPartner,
  onConfirm,
}) {
  const rows = state?.rows || [];
  const accounts = state?.accounts || [];
  const total = calcTotal(rows);
  const rem = 100 - total;
  let footerText = t("unallocated", { value: "100%" });
  let warn = null;
  let confirmDisabled = false;
  if (state) {
    if (total > 100) {
      warn = { err: true, msg: t("totalExceeds100") };
      footerText = t("overAllocated", { value: fmtPct(Math.abs(rem)) });
      confirmDisabled = true;
    } else if (total < 100) {
      warn = { err: false, msg: t("totalLessThan100") };
      footerText = t("unallocated", { value: fmtPct(rem) });
    } else {
      footerText = t("fullyAllocated");
    }
  }

  return (
    <Sheet
      open={open}
      title={title}
      onClose={onClose}
      tall
      footer={
        state ? (
          <div className="m-own-editor-footer">
            <div className={`m-own-warn${warn?.err ? " is-error" : ""}`}>
              {warn ? <span>{warn.msg}</span> : null}
              <small>{footerText}</small>
            </div>
            <button
              type="button"
              className="m-account-primary-btn tap-scale"
              disabled={readOnlyMode || confirmDisabled || saving || !state}
              onClick={() => void onConfirm()}
            >
              {saving ? t("saving") : t("confirm")}
            </button>
          </div>
        ) : null
      }
    >
      {loading && !state ? (
        <div className="m-account-loading">
          <i className="fas fa-spinner fa-spin" aria-hidden="true" />
          <span>{t("loading")}</span>
        </div>
      ) : state ? (
        <div className="m-own-editor">
          {rows.map((row, idx) => (
            <EditorRow
              key={row.clientRowId || `${row.account_id}-${idx}`}
              idx={idx}
              row={row}
              accounts={accounts}
              maxPercentage={maxAllowedOwnershipPct(rows, idx)}
              onUpdate={onUpdateRow}
              onRemove={onRemoveRow}
              readOnlyMode={readOnlyMode}
              t={t}
            />
          ))}
          <button
            type="button"
            className="m-own-add tap-scale"
            disabled={readOnlyMode}
            onClick={onAddRow}
          >
            {t("addAccount")}
          </button>
          <PartnerBlock
            disabled={partnerLocked || readOnlyMode}
            onLink={onLinkPartner}
            t={t}
            descKey={partnerDescKey}
          />
        </div>
      ) : null}
    </Sheet>
  );
}

export function OwnershipJoinGroupSheet({ open, onClose, t, groups, onPick }) {
  return (
    <Sheet open={open} title={t("joinGroupAction")} onClose={onClose}>
      <div className="m-own-join-list">
        {(groups || []).map((g) => (
          <button
            key={g}
            type="button"
            className="m-own-join-item tap-scale"
            onClick={() => {
              onPick(g);
              onClose();
            }}
          >
            {g}
            <i className="fas fa-chevron-right" aria-hidden="true" />
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function OwnershipConflictSheet({ open, conflict, onResolve, onCancel, t }) {
  return (
    <Sheet
      open={open}
      title={t("multipleMatchesFound")}
      onClose={onCancel}
      elevate
      footer={
        <button type="button" className="m-account-secondary-btn tap-scale" onClick={onCancel}>
          {t("cancel")}
        </button>
      }
    >
      <p className="m-own-conflict-desc">
        {conflict?.data?.same_owner ? t("idAmbiguousLoginOrGroup") : t("idUsedByTwoPartners")}
      </p>
      <div className="m-own-conflict-options">
        <button type="button" className="m-own-conflict-btn tap-scale" onClick={() => onResolve("login")}>
          <span>{t("linkAsLoginId")}</span>
          <strong>{conflict?.data?.login_partner || ""}</strong>
        </button>
        <button type="button" className="m-own-conflict-btn tap-scale" onClick={() => onResolve("group")}>
          <span>{t("joinAsGroup")}</span>
          <strong>{conflict?.data?.group_partner || ""}</strong>
        </button>
      </div>
    </Sheet>
  );
}
