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

function isField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

/** Install the document-level listeners. Safe to call more than once. */
export function startTypingProbe() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;

  const begin = () => {
    current = { startedAt: performance.now(), keystrokes: 0, latencies: [], longTaskMs: 0, compositions: 0 };
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
    () => {
      if (!current) return;
      current.keystrokes += 1;
      const startedAt = performance.now();
      requestAnimationFrame(() => {
        if (!current) return;
        current.latencies.push(Math.round(performance.now() - startedAt));
      });
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
  };
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
  const s = report.session;
  if (!s) {
    lines.push("typing: no keystrokes recorded yet", "type in a field, then tap this line again");
  } else {
    lines.push(
      `typing: ${s.keystrokes} key${s.keystrokes === 1 ? "" : "s"} in ${s.seconds}s` +
        `${s.compositions ? ` · ${s.compositions} IME compositions` : ""}`,
    );
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
