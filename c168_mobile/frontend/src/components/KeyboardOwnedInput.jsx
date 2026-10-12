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
  /**
   * Force the keyboard to *commit* a composition after the user pauses for this many ms (0 = never).
   *
   * Why this exists: with Sogou (and other Chinese IMEs) the text can sit in the **IME's own
   * composition buffer** — delete presses then edit that buffer instead of the field, so a user has to
   * press backspace several times before anything visibly deletes. Tapping out of the field and back
   * in clears the buffer and "fixes" it instantly; this does the same thing without closing the
   * keyboard: collapsing the selection to the end commits an ongoing composition in Blink.
   *
   * Only for fields that never take Chinese text (codes, usernames, passwords, amounts, numeric
   * searches) — committing mid-composition would break pinyin input in a free-text field.
   */
  commitCompositionOnIdleMs = 0,
  /**
   * Apply `value` to the field once it loses focus (0 = never). Only for callers whose state holds a
   * **normalised** version of the text (amounts strip letters, the 6-digit code strips non-digits).
   *
   * Callers that keep the text in a ref while typing (the login page) must leave this off: their
   * `value` is deliberately stale during typing, so writing it on blur would erase what the user just
   * typed.
   */
  applyValueOnBlur = false,
  /** Optional outer ref (e.g. to focus the field when a panel opens). */
  inputRef: externalRef,
  ...inputProps
}) {
  const inputRef = useRef(null);
  const [text, setText] = useState(initialValue);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  /** Latest external value, readable from the native listeners without re-binding them. */
  const valueRef = useRef(value);
  valueRef.current = value;
  /** Only maintained when a ✕ is rendered — login/password fields do not need it. */
  const needsText = Boolean(clearLabel);
  /** Coalescing clock for `composeThrottleMs`. */
  const lastCallRef = useRef(0);
  /** Trailing flush for a coalesced update, so a pause (no compositionend) still catches up. */
  const flushTimerRef = useRef(0);
  const defer = composeThrottleMs > 0;
  const commitOnIdle = commitCompositionOnIdleMs > 0;
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

    /*
     * Composition-idle commit (see the prop's comment): while the keyboard holds a composition, wait
     * for a pause and then hand the text over to the field, so the next delete reaches real text.
     */
    let composing = false;
    let idleTimer = 0;
    const cancelIdle = () => {
      if (idleTimer) {
        window.clearTimeout(idleTimer);
        idleTimer = 0;
      }
    };
    const commitNow = () => {
      idleTimer = 0;
      if (!composing || !commitOnIdle) return;
      try {
        const end = el.value.length;
        el.setSelectionRange(end, end);
        window.dispatchEvent(new CustomEvent("ec:composition-committed"));
      } catch {
        /* some input types can refuse a selection change — nothing to do */
      }
    };
    const scheduleIdleCommit = () => {
      if (!commitOnIdle || !composing) return;
      cancelIdle();
      idleTimer = window.setTimeout(commitNow, commitCompositionOnIdleMs);
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
      scheduleIdleCommit();
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

    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      composing = false;
      cancelIdle();
    };

    /**
     * Silent correction on blur: callers that keep a normalised value in state (amounts strip
     * letters, the 6-digit code strips non-digits) get it applied once the user is done with the
     * field — never while they are typing (see the adoption effect for why).
     */
    const onBlur = () => {
      cancelIdle();
      if (!applyValueOnBlur) return;
      const external = valueRef.current;
      if (external === undefined || external === el.value || external === lastTextRef.current) return;
      el.value = external;
      lastTextRef.current = external;
      if (needsText) setText(external);
    };

    el.addEventListener("input", publish);
    el.addEventListener("compositionend", publish);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("blur", onBlur);
    return () => {
      cancelFlush();
      cancelIdle();
      el.removeEventListener("input", publish);
      el.removeEventListener("compositionend", publish);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("blur", onBlur);
    };
  }, [needsText, defer, composeThrottleMs, commitOnIdle, commitCompositionOnIdleMs, applyValueOnBlur]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || value === undefined) return;
    if (value === lastTextRef.current) return; // our own echo (or already adopted)
    if (value === el.value) {
      lastTextRef.current = value;
      return;
    }
    /*
     * Hard rule: never write into a field the user is editing right now.
     *
     * Some callers deliberately keep a *normalised* value in state (amounts strip letters, the 6-digit
     * code strips non-digits). Writing that back mid-typing moves the caret and can drop the keyboard's
     * composition — the same class of bug that ate characters on the login page. The normalised value
     * is applied when the field loses focus (or when the sheet is reset/closed), which is where a
     * silent correction belongs.
     */
    if (document.activeElement === el) return;
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
