import { useCallback, useEffect, useRef } from "react";
import {
  loadStoredRemoveWordChips,
  mergeRemoveWordChips,
  parseRemoveWordChips,
  saveStoredRemoveWordChips,
  serializeRemoveWordChips,
} from "../lib/removeWordChips.js";

/** Plain text Remove Word field (`sad,aa,aaa`). Normalize only on blur so commas can be typed. */
export default function RemoveWordChipInput({
  value,
  onChange,
  processId = null,
  scopeCompanyId = null,
  id = "capture_remove_word",
  name = "remove_word",
  placeholder = "",
  disabled = false,
}) {
  const hydratedProcessRef = useRef(null);

  const commitNormalized = useCallback(
    (raw) => {
      if (disabled) return;
      const next = serializeRemoveWordChips(parseRemoveWordChips(raw));
      onChange?.(next);
      if (processId) {
        // Always sync, including empty: saveStored removes the key when no chips remain,
        // otherwise stale chips get re-merged on the next open.
        saveStoredRemoveWordChips(scopeCompanyId, processId, parseRemoveWordChips(next));
      }
    },
    [disabled, onChange, processId, scopeCompanyId],
  );

  // Merge stored chips once per process; do not re-normalize while typing.
  useEffect(() => {
    if (!processId || disabled) return;
    if (hydratedProcessRef.current === processId) return;
    hydratedProcessRef.current = processId;

    const fromValue = parseRemoveWordChips(value);
    const stored = loadStoredRemoveWordChips(scopeCompanyId, processId);
    const merged = mergeRemoveWordChips(fromValue, stored);
    const next = serializeRemoveWordChips(merged);
    if (next !== String(value ?? "")) {
      onChange?.(next);
    }
    if (merged.length) {
      saveStoredRemoveWordChips(scopeCompanyId, processId, merged);
    }
  }, [processId, scopeCompanyId, value, onChange, disabled]);

  return (
    <input
      type="text"
      id={id}
      name={name}
      className="dc-remove-word-chip-input__field"
      value={value ?? ""}
      disabled={disabled}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        if (disabled) return;
        onChange?.(event.target.value);
      }}
      onBlur={(event) => commitNormalized(event.target.value)}
      style={{ textTransform: "uppercase" }}
    />
  );
}
