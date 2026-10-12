/**
 * Typing performance probe — measures what a keystroke actually costs on the device it runs on.
 *
 * Why this exists: the Android/WebView input lag reported by users (old phone + Sogou) cannot be
 * reproduced in CI or on a desktop Chrome, and we are not willing to guess at fixes. This records,
 * per focus session, the two numbers that matter:
 *
 *   - **paint latency**: `input` event → next `requestAnimationFrame`. That is how long the page took
 *     before the character could appear on screen, i.e. what the user feels as "the delete key lags".
 *   - **long tasks**: main-thread blocks longer than 50ms during the session.
 *
 * It also reports the WebView/Chrome version, since the phone app is a remote SPA rendered by the
 * device's Android System WebView — an old WebView is a real, updatable cause of jank.
 *
 * Cost when idle: zero (nothing is recorded unless a field is focused). Per keystroke: one
 * `requestAnimationFrame`, which is negligible compared to the work being measured.
 *
 * Usage: `startTypingProbe()` once at startup, then show `formatTypingReport(readTypingReport())`
 * behind an explicit gesture — on the login page that is a tap on the build marker.
 */

const MAX_SESSIONS = 5;

let installed = false;
const sessions = [];
let current = null;
/** Last known value length per field, to tell a real delete from an IME-internal one. */
const lastLengths = new WeakMap();

function isField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

/** Install the document-level listeners. Safe to call more than once. */
export function startTypingProbe() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;

  const begin = () => {
    current = {
      startedAt: performance.now(),
      keystrokes: 0,
      latencies: [],
      longTaskMs: 0,
      compositions: 0,
      /*
       * Delete attribution: the reported symptom is specific — typing is fine, but the delete key has
       * to be pressed several times before anything happens. Comparing how many times the user
       * pressed backspace against how many delete events actually reached the page tells us whether
       * the presses are being consumed by the IME/WebView (page never sees them) or by us.
       */
      backspaces: 0,
      insertInputs: 0,
      deleteInputs: 0,
      beforeInputs: 0,
      /*
       * When the events *do* arrive, the next question is what they did: if the IME keeps the text in
       * its own composition buffer, the delete events arrive while the field's value does not shrink.
       * `valueShrinks` counts deletes that actually shortened the field; `composingDeletes` counts
       * deletes that arrived mid-composition.
       */
      valueShrinks: 0,
      composingDeletes: 0,
      /** Compositions this page handed over to the field (commitCompositionOnIdleMs). */
      forcedCommits: 0,
      /*
       * And when they arrive: a "press six times, then it deletes" experience where the page receives
       * all six at once means the IME/WebView batched them. `firstInputDelayMs` is keydown -> first
       * input event; `maxInputGapMs` the largest quiet period between two input events; `bursts`
       * counts catch-up groups (an event arriving right after a long gap).
       */
      firstKeydownAt: 0,
      firstInputAt: 0,
      lastInputAt: 0,
      /** Gap between the two input events before the last one (to detect catch-up pairs). */
      prevInputGapMs: 0,
      maxInputGapMs: 0,
      bursts: 0,
    };
  };
  const finish = () => {
    if (!current || current.keystrokes === 0) {
      current = null;
      return;
    }
    sessions.unshift({ ...current, endedAt: performance.now() });
    if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
    current = null;
  };

  document.addEventListener(
    "focusin",
    (event) => {
      if (isField(event.target) && !current) begin();
    },
    true,
  );
  document.addEventListener(
    "focusout",
    () => {
      /* Focus can move between fields: only finish once nothing is focused any more. */
      window.setTimeout(() => {
        if (!isField(document.activeElement)) finish();
      }, 0);
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (!current) return;
      current.keystrokes += 1;

      const now = performance.now();
      if (!current.firstInputAt) current.firstInputAt = now;
      if (current.lastInputAt) {
        const gap = now - current.lastInputAt;
        if (gap > current.maxInputGapMs) current.maxInputGapMs = gap;
        /* A catch-up pair: two events arriving almost together right after a long silence. That is
           the signature of a keyboard holding edits and then flushing them in one go. */
        if (current.prevInputGapMs > 500 && gap < 60) current.bursts += 1;
        current.prevInputGapMs = gap;
      }
      current.lastInputAt = now;

      const inputType = String(event.inputType || "");
      const target = event.target;
      const isDelete = inputType.indexOf("delete") === 0;
      if (isDelete) current.deleteInputs += 1;
      else current.insertInputs += 1;
      if (event.isComposing) current.composingDeletes += isDelete ? 1 : 0;

      /* Did the delete actually shorten the field? (An IME can fire delete events while editing its
         own composition, in which case the text the user sees does not change.) */
      try {
        if (target && typeof target.value === "string") {
          const before = lastLengths.get(target);
          const after = target.value.length;
          if (isDelete && before !== undefined && after < before) current.valueShrinks += 1;
          lastLengths.set(target, after);
        }
      } catch {
        /* ignore */
      }

      const startedAt = performance.now();
      requestAnimationFrame(() => {
        if (!current) return;
        current.latencies.push(Math.round(performance.now() - startedAt));
      });
    },
    true,
  );
  document.addEventListener(
    "beforeinput",
    () => {
      if (current) current.beforeInputs += 1;
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!current) return;
      if (!current.firstKeydownAt) current.firstKeydownAt = performance.now();
      if (event.key === "Backspace" || event.keyCode === 8) current.backspaces += 1;
    },
    true,
  );
  document.addEventListener(
    "compositionstart",
    () => {
      if (current) current.compositions += 1;
    },
    true,
  );
  /* KeyboardOwnedInput reports every composition it hands over to the field (see
     `commitCompositionOnIdleMs`) — on a device this is how we see the workaround actually firing. */
  document.addEventListener(
    "ec:composition-committed",
    () => {
      if (current) current.forcedCommits += 1;
    },
    true,
  );

  try {
    new PerformanceObserver((list) => {
      if (!current) return;
      for (const entry of list.getEntries()) current.longTaskMs += Math.round(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported — the paint latency above is the main signal anyway */
  }
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))],
  };
}

function webViewLine() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  const android = ua.match(/Android\s([\d.]+)/);
  /* In the APK the WebView reports itself as Chrome/xx — that version is the device's updatable
     Android System WebView, not the app. */
  return {
    chrome: chrome ? chrome[1] : null,
    android: android ? android[1] : null,
    cores: (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || null,
    memoryGb: (typeof navigator !== "undefined" && navigator.deviceMemory) || null,
    /* Authoritative values from the shell (MainActivity exposes EazyCountNative). The user-agent
       string cannot tell us *which package* is rendering: this can. */
    nativeWebView: readNative("version"),
    nativeDevice: readNative("device"),
  };
}

function readNative(method) {
  try {
    const bridge = typeof window !== "undefined" ? window.EazyCountNative : null;
    if (!bridge || typeof bridge[method] !== "function") return null;
    return String(bridge[method]());
  } catch {
    return null;
  }
}

/** Everything a bug report needs, as plain data. */
export function readTypingReport() {
  /* Prefer the session in progress: tapping the marker usually happens *while* a field is still
     focused, and the focusout that would archive the session only runs afterwards. */
  const session =
    current && current.keystrokes > 0
      ? { ...current, endedAt: performance.now() }
      : sessions[0] || null;
  return {
    ...webViewLine(),
    session: session
      ? {
          seconds: Math.round((session.endedAt - session.startedAt) / 100) / 10,
          keystrokes: session.keystrokes,
          compositions: session.compositions,
          backspaces: session.backspaces,
          insertInputs: session.insertInputs,
          deleteInputs: session.deleteInputs,
          beforeInputs: session.beforeInputs,
          valueShrinks: session.valueShrinks,
          composingDeletes: session.composingDeletes,
          forcedCommits: session.forcedCommits,
          /* Only meaningful when a key press preceded the first event: the harness (and some IMEs)
             can deliver inserts without any keydown at all. */
          firstInputDelayMs:
            session.firstKeydownAt && session.firstInputAt > session.firstKeydownAt
              ? Math.round(session.firstInputAt - session.firstKeydownAt)
              : null,
          maxInputGapMs: Math.round(session.maxInputGapMs),
          bursts: session.bursts,
          paintLatency: stats(session.latencies),
          longTaskMs: session.longTaskMs,
        }
      : null,
  };
}

/** Compact, selectable text for an on-screen panel (screenshot-friendly). */
export function formatTypingReport(report) {
  if (!report) return "";
  const lines = [
    `webview ${report.chrome ? `Chrome/WebView ${report.chrome}` : "?"}` +
      `${report.android ? ` · Android ${report.android}` : ""}` +
      `${report.cores ? ` · ${report.cores} cores` : ""}`,
  ];
  if (report.nativeWebView) {
    /* The decisive line when comparing a laggy phone with a smooth one: which WebView *package* and
       version is actually rendering, and on which Android build. */
    lines.push(`app webview: ${report.nativeWebView}${report.nativeDevice ? ` · ${report.nativeDevice}` : ""}`);
  }
  const s = report.session;
  if (!s) {
    lines.push("typing: no keystrokes recorded yet", "type in a field, then tap this line again");
  } else {
    lines.push(
      `typing: ${s.keystrokes} key${s.keystrokes === 1 ? "" : "s"} in ${s.seconds}s` +
        `${s.compositions ? ` · ${s.compositions} IME compositions` : ""}`,
    );
    lines.push(`insert ${s.insertInputs} · delete ${s.deleteInputs} (beforeinput ${s.beforeInputs})`);
    if (s.backspaces > s.deleteInputs) {
      lines.push(
        `!! backspace pressed ${s.backspaces}x but only ${s.deleteInputs} delete event(s) reached the page`,
        "   => the missing ones were swallowed by the keyboard/WebView, not by the page",
      );
    } else {
      lines.push(`backspace presses: ${s.backspaces} (all reached the page)`);
    }
    /* Did those deletes do anything visible? */
    lines.push(
      `deletes that shortened the field: ${s.valueShrinks} of ${s.deleteInputs}` +
        (s.composingDeletes ? ` · during IME composition: ${s.composingDeletes}` : "") +
        (s.forcedCommits ? ` · compositions handed over: ${s.forcedCommits}` : ""),
    );
    if (s.forcedCommits > 0 && s.valueShrinks === s.deleteInputs && s.deleteInputs > 0) {
      lines.push("   => the pause-commit workaround is working on this device (deletes hit real text)");
    }
    if (s.deleteInputs > 0 && s.valueShrinks < s.deleteInputs) {
      lines.push(
        "   => the keyboard kept those characters in its own composition buffer;",
        "      the field text did not change (not something the page can undo)",
      );
    }
    /* And when did they arrive? */
    if (s.firstInputDelayMs !== null && (s.firstInputDelayMs > 700 || s.bursts > 0)) {
      lines.push(
        `!! events arrived late/batched: first input after ${s.firstInputDelayMs}ms · ` +
          `longest quiet gap ${s.maxInputGapMs}ms · catch-up groups ${s.bursts}`,
        "   => the keyboard held them and delivered them in bursts",
      );
    } else {
      lines.push(
        `event timing: first input after ${s.firstInputDelayMs === null ? "?" : s.firstInputDelayMs}ms · ` +
          `longest gap ${s.maxInputGapMs}ms`,
      );
    }
    lines.push(
      s.paintLatency
        ? `paint latency avg ${s.paintLatency.avg}ms · p90 ${s.paintLatency.p90}ms · max ${s.paintLatency.max}ms`
        : "paint latency: n/a",
      `main-thread blocks: ${s.longTaskMs}ms total`,
    );
    if (s.paintLatency && s.paintLatency.avg > 120) {
      lines.push("=> slow: send this screenshot to support");
    }
  }
  return lines.join("\n");
}
