import { useEffect, useState } from "react";
import { useOverlayLock } from "../../hooks/useOverlayLock.js";
import { formatTransactionGridMoneyHalfUp, toUpperDisplay } from "../../lib/transactionFormat.js";
import { moneyToneClass } from "../../lib/money/moneyToneClass.js";
import "./contra-inbox-sheet.css";

function formatContraDate(raw) {
  if (!raw || raw === "-") return "—";
  const s = String(raw).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

export default function ContraInboxSheet({
  open,
  onClose,
  m,
  items = [],
  loading,
  onApprove,
  onReject,
  mutationsBlocked,
}) {
  useOverlayLock(open, onClose);
  /** Desktop parity (b59f77174f): reject asks inside the app instead of window.confirm. */
  const [rejectTarget, setRejectTarget] = useState(null);
  /* Both hooks stay above the early return below — a hook after it would break the render order. */
  useEffect(() => {
    if (!open) setRejectTarget(null);
  }, [open]);
  if (!open) return null;

  const count = items.length;
  const awaiting =
    count === 1
      ? m.contraInboxAwaitingApproval.replace("{count}", String(count))
      : m.contraInboxAwaitingApprovalPlural.replace("{count}", String(count));

  return (
    <div className="m-contra-sheet">
      <button type="button" className="m-contra-sheet-spacer" aria-label={m.close} onClick={onClose} />
      <div className="m-contra-sheet-panel" role="dialog" aria-modal="true" aria-label={m.contraInbox}>
        <div className="m-contra-sheet-header">
          <div>
            <p className="m-contra-sheet-title">{m.contraInbox}</p>
            <p className="m-contra-sheet-sub">{awaiting}</p>
          </div>
          <button type="button" onClick={onClose} className="m-contra-sheet-close tap-scale" aria-label={m.close}>
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>

        <div className="m-contra-sheet-body">
          {rejectTarget ? (
            <div className="m-contra-sheet-empty">
              <p className="m-contra-sheet-empty-title">{m.confirmRejectContra}</p>
              <div className="m-contra-item-actions">
                <button
                  type="button"
                  disabled={mutationsBlocked}
                  onClick={() => setRejectTarget(null)}
                  className="m-contra-btn tap-scale"
                >
                  {m.backToList}
                </button>
                <button
                  type="button"
                  disabled={mutationsBlocked}
                  onClick={() => {
                    const target = rejectTarget;
                    setRejectTarget(null);
                    onReject?.(target.id);
                  }}
                  className="m-contra-btn m-contra-btn--reject tap-scale"
                >
                  {m.reject}
                </button>
              </div>
            </div>
          ) : loading ? (
            <p className="m-contra-sheet-loading">{m.loading}</p>
          ) : count === 0 ? (
            <div className="m-contra-sheet-empty">
              <p className="m-contra-sheet-empty-title">{m.contraInboxEmpty}</p>
              <p className="m-contra-sheet-empty-hint">{m.contraInboxEmptyHint}</p>
            </div>
          ) : (
            items.map((item) => {
              const id = item.transaction_id || item.id;
              const fromCode = toUpperDisplay(item.from_account_code || item.from_account_id || "-");
              const toCode = toUpperDisplay(item.to_account_code || item.account_id || item.to_account || "-");
              const currency = toUpperDisplay(item.currency || "-");
              const dateLabel = formatContraDate(item.transaction_date || item.date);
              const amountLabel = formatTransactionGridMoneyHalfUp(item.amount);
              const submittedBy = toUpperDisplay(item.submitted_by || item.created_by || "-");
              const description = toUpperDisplay(item.description || "-");
              const typeLabel = toUpperDisplay(item.transaction_type || "CONTRA");

              return (
                <article key={String(id)} className="m-contra-item">
                  <div className="m-contra-item-top">
                    <div className="m-contra-item-main">
                      <div className="m-contra-item-route" title={`${fromCode} → ${toCode}`}>
                        <span className="m-contra-item-acc m-contra-item-acc--from">{fromCode}</span>
                        <span className="m-contra-item-arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="m-contra-item-acc m-contra-item-acc--to">{toCode}</span>
                      </div>
                      <div className="m-contra-item-meta">
                        <span className="m-contra-item-badge">{typeLabel}</span>
                        <span>
                          {dateLabel} · {currency}
                        </span>
                      </div>
                    </div>
                    <div className="m-contra-item-amount-wrap">
                      <span className={`m-contra-item-amount ${moneyToneClass(item.amount)}`}>{amountLabel}</span>
                    </div>
                  </div>

                  <div className="m-contra-item-details">
                    <p className="m-contra-item-by">
                      <span className="m-contra-item-k">{m.submittedBy}</span>
                      <span className="m-contra-item-v">{submittedBy}</span>
                    </p>
                    {description && description !== "-" ? (
                      <p className="m-contra-item-desc">
                        <span className="m-contra-item-k">{m.description}</span>
                        <span className="m-contra-item-v" title={description}>
                          {description}
                        </span>
                      </p>
                    ) : null}
                  </div>

                  <div className="m-contra-item-actions">
                    <button
                      type="button"
                      disabled={mutationsBlocked}
                      onClick={() => onApprove?.(id)}
                      className="m-contra-btn m-contra-btn--approve tap-scale"
                    >
                      {m.approve}
                    </button>
                    <button
                      type="button"
                      disabled={mutationsBlocked}
                      onClick={() => setRejectTarget({ id })}
                      className="m-contra-btn m-contra-btn--reject tap-scale"
                    >
                      {m.reject}
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
