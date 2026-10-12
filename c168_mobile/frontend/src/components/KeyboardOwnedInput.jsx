import { startTransition, useEffect, useRef, useState } from "react";

/**
 * A text field whose text belongs to the phone's keyboard, not to React.
 *
 * Use this for anything the user types into while the value is consumed live (search/filter
 * boxes). Why not a plain `<input value={...} onChange={...}>`:
 *
 * - Android keyboards (Gboard) write the composing text into the DOM themselves, out of React's
 *   sight. A controlled `value=` then writes its own, older string back on the next render — any
 *   state change, e.g. the list window growing — so the typed characters vanish, the list keeps
 *   filtering on something else, and only a delete (a fresh event) re-aligns them. Reported as
 *   "typing finds nothing until I delete a character" / "the list shows matches for a different
 *   query than the box" (2026-10, several Android users).
 * - React de-duplicates an `input` event whose value its own tracker already saw — which is exactly
 *   the case after the keyboard wrote the text itself. The listeners here are native, so nothing
 *   is dropped.
 *
 * `onValueChange(text)` always receives the field's own text, so the caller's state (the filter
 * source) can never drift from what the user sees. Do **not** pass `value`/`onChange` — both are
 * ignored on purpose: writing the value back is the bug this component exists to prevent.
 *
 * Passing `clearLabel` renders the usual ✕ button, which clears the field itself (the DOM is the
 * source of truth, so the caller must not clear it behind our back).
 */
export default function KeyboardOwnedInput({
  initialValue = "",
  /**
   * Optional external value (prefill, a blur-time normalisation, a programmatic clear). It is
   * adopted only when it changes to something we did not just publish — a plain re-render with the
   * same text never writes into the field. That distinction is the whole point: writing on every
   * render is what ate the keyboard's characters.
   */
  value,
  onValueChange,
  clearLabel,
  /** Optional side effect for the ✕ (a page that resets more than the text). */
  onClear,
  clearButtonClassName,
  /**
   * Live-filter fields only. While the IME owns a composition — Sogou and other Chinese keyboards
   * keep one open, which is also why the first backspace looks ignored — coalesce updates to at most
   * one per N ms and hand them to React as a transition, so re-rendering the result list can never
   * stall the keyboard on a slow phone. `0` (default) keeps updates immediate: form fields are read
   * on submit and must never be a keystroke behind.
   */
  composeThrottleMs = 0,
  /** Optional outer ref (e.g. to focus the field when a panel opens). */
  inputRef: externalRef,
  ...inputProps
}) {
  const inputRef = useRef(null);
  const [text, setText] = useState(initialValue);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  /** Only maintained when a ✕ is rendered — login/password fields do not need it. */
  const needsText = Boolean(clearLabel);
  /** Coalescing clock for `composeThrottleMs`. */
  const lastCallRef = useRef(0);
  /** Trailing flush for a coalesced update, so a pause (no compositionend) still catches up. */
  const flushTimerRef = useRef(0);
  const defer = composeThrottleMs > 0;
  /** The last text we published or adopted — compared against, never written back blindly. */
  const lastTextRef = useRef(initialValue);

  const attachRef = (node) => {
    inputRef.current = node;
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef) externalRef.current = node;
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    lastTextRef.current = el.value;

    const cancelFlush = () => {
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = 0;
      }
    };

    /** Hand the field's current text to the caller (unless it is what we already published). */
    const applyNow = () => {
      cancelFlush();
      const text = el.value;
      if (text === lastTextRef.current) return;
      lastTextRef.current = text;
      lastCallRef.current = performance.now();
      if (needsText) setText(text);
      if (defer) startTransition(() => onValueChangeRef.current?.(text));
      else onValueChangeRef.current?.(text);
    };

    const publish = (event) => {
      const composing = Boolean(event && event.type === "input" && event.isComposing);
      if (defer && composing && performance.now() - lastCallRef.current < composeThrottleMs) {
        /* Coalesce, but always schedule the trailing flush: the user may simply stop typing with the
           composition still open, and the list must still catch up to what they see. */
        if (!flushTimerRef.current) {
          flushTimerRef.current = window.setTimeout(applyNow, composeThrottleMs);
        }
        return;
      }
      applyNow();
    };

    el.addEventListener("input", publish);
    el.addEventListener("compositionend", publish);
    return () => {
      cancelFlush();
      el.removeEventListener("input", publish);
      el.removeEventListener("compositionend", publish);
    };
  }, [needsText, defer, composeThrottleMs]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || value === undefined) return;
    if (value === lastTextRef.current) return; // our own echo (or already adopted)
    if (value === el.value) {
      lastTextRef.current = value;
      return;
    }
    el.value = value;
    lastTextRef.current = value;
    if (needsText) setText(value);
  }, [value, needsText]);

  const clear = () => {
    const el = inputRef.current;
    if (el) el.value = "";
    lastTextRef.current = "";
    if (needsText) setText("");
    onValueChangeRef.current?.("");
    onClear?.();
  };

  return (
    <>
      {/*
        `value`/`onChange` are deliberately dropped: see the note above. The field is uncontrolled,
        so React never overwrites what the keyboard put there.
      */}
      <input ref={attachRef} type="text" defaultValue={initialValue} {...inputProps} />
      {clearLabel && text ? (
        <button
          type="button"
          className={clearButtonClassName}
          onClick={clear}
          aria-label={clearLabel}
        >
          <i className="fas fa-xmark" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}
