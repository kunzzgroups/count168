/**
 * How eagerly the page takes a composition away from the keyboard.
 *
 * Evidence that made this necessary (on-device reports, 2026-10-12): with Sogou in its English mode
 * the field's text sits in the **IME's composition buffer**. The page then sees the deletes late — one
 * report showed a 2283ms gap with no input event at all, another showed 8 backspaces producing only 7
 * delete events (one swallowed) — while paint latency stayed at 6ms and the main thread never blocked.
 * Users discovered the workaround themselves: tap out of the field and back in, and deletion is
 * immediate (that clears the composition).
 *
 * The page already hands a composition over after a pause (`commitCompositionOnIdleMs`). This module
 * adds a device-side switch so the strength can be tried in one tap on the affected phone, without a
 * rebuild:
 *
 *   pause  (default) — hand over after a short pause (300ms). Safe for every field we enable it on.
 *   always           — hand over after every keystroke. The keyboard never gets to hold a buffer,
 *                      which is the most likely thing to make deletion instant; try this first on a
 *                      phone that still lags.
 *   none             — the original behaviour, for comparison.
 *
 * Only ever applied to fields that cannot receive Chinese text (codes, usernames, passwords, amounts):
 * forcing a commit mid-word would break pinyin candidate selection.
 */
const STORAGE_KEY = "ec_commit_mode";
const MODES = ["on-backspace", "blur-focus", "pause", "always", "none"];
/** Idle time for the `pause` mode. Short on purpose: the reported stalls are seconds long. */
export const PAUSE_MS = 300;

export function readCommitMode(search = typeof window !== "undefined" ? window.location.search : "") {
  let stored = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (MODES.includes(stored)) return stored;

  const param = new URLSearchParams(search).get("commit");
  if (MODES.includes(param)) return param;

  return "on-backspace";
}

export function writeCommitMode(mode) {
  const next = MODES.includes(mode) ? mode : "on-backspace";
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage disabled — the choice still applies for this session */
  }
  return next;
}

export function nextCommitMode(mode) {
  const index = MODES.indexOf(mode);
  return MODES[(index + 1) % MODES.length];
}

/** Props for KeyboardOwnedInput, derived from the mode. */
export function commitProps(mode) {
  if (mode === "none") {
    return {
      commitCompositionOnDeleteKey: false,
      commitCompositionOnInput: false,
      commitCompositionOnIdleMs: 0,
    };
  }
  if (mode === "always") {
    return { commitCompositionOnDeleteKey: true, commitCompositionOnInput: true, commitCompositionOnIdleMs: 0 };
  }
  if (mode === "blur-focus") {
    /* End the IME session on the delete key (the manual "tap out and back in" trick, automated). */
    return {
      commitCompositionOnDeleteKey: true,
      commitCompositionByRefocus: true,
      commitCompositionOnInput: false,
      commitCompositionOnIdleMs: 0,
    };
  }
  if (mode === "pause") {
    return { commitCompositionOnDeleteKey: true, commitCompositionOnInput: false, commitCompositionOnIdleMs: PAUSE_MS };
  }
  /* on-backspace (default): hand the composition over exactly when a delete key is pressed — the case
     users hit (type a word, immediately backspace) needs no pause at all. */
  return { commitCompositionOnDeleteKey: true, commitCompositionOnInput: false, commitCompositionOnIdleMs: 0 };
}
