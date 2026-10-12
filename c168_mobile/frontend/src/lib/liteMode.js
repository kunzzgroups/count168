/**
 * "Lite" mode — strip the expensive visuals so a slow WebView has almost nothing to paint while the
 * user types.
 *
 * Why this exists: the same page on the same phone is smooth in Chrome but lags inside the app. The
 * phone app renders in the device's **Android System WebView**, which shares the app's process — so
 * anything that keeps our main thread or rasteriser busy also delays the keyboard's own calls
 * (`deleteSurroundingText`, `getTextBeforeCursor`). Chrome isolates the page in a renderer process,
 * which is why it stays responsive.
 *
 * So this is deliberately also an *experiment*: `?lite=1` / `?lite=0` on the login page flips it on
 * the real device in one tap. If lite mode fixes the lag, the page's own paint cost was the problem
 * and slow devices should get lite automatically (see `noteTypingReport`). If it does not fix it, the
 * cost is not in our page at all — which is equally useful to know.
 */
const STORAGE_KEY = "ec_lite";
const SLOW_KEY = "ec_slow_typing";

/** Average paint latency (ms) above which a device is considered too slow for the full visuals. */
export const SLOW_AVG_MS = 150;
/** Worst-case paint latency (ms) that also marks a device as slow (spikes hurt more than averages). */
export const SLOW_MAX_MS = 400;

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — mode still applies for this session */
  }
}

/** Device heuristics used when the user has no preference and nothing has been measured yet. */
function slowByHardware() {
  const cores = navigator.hardwareConcurrency || 0;
  const memory = navigator.deviceMemory || 0;
  return (cores > 0 && cores <= 4) || (memory > 0 && memory <= 2);
}

/**
 * Resolve the mode: an explicit user choice wins, then an explicit `?lite=` flag, then a previously
 * measured slow session, then the device heuristics.
 */
export function isLiteMode(search = typeof window !== "undefined" ? window.location.search : "") {
  const stored = readStored(STORAGE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;

  const param = new URLSearchParams(search).get("lite");
  if (param === "1") return true;
  if (param === "0") return false;

  if (readStored(SLOW_KEY) === "1") return true;
  try {
    return slowByHardware();
  } catch {
    return false;
  }
}

/** Apply the mode to the document (`body.lite`), which is what the CSS keys off. */
export function applyLiteMode(on = isLiteMode()) {
  if (typeof document === "undefined") return on;
  document.body.classList.toggle("lite", Boolean(on));
  return Boolean(on);
}

/** Remember an explicit user choice (the diagnostics panel toggle). */
export function setLiteMode(on) {
  writeStored(STORAGE_KEY, on ? "1" : "0");
  return applyLiteMode(on);
}

/**
 * Called with each typing report. Returns true when this report made us switch to lite mode, so the
 * caller can tell the user what just happened.
 */
export function noteTypingReport(report) {
  const session = report && report.session;
  const latency = session && session.paintLatency;
  if (!latency) return false;
  if (latency.avg <= SLOW_AVG_MS && latency.max <= SLOW_MAX_MS) return false;

  /* Slow typing measured on this device: remember it and switch, unless the user explicitly asked
     for the full version. */
  if (readStored(SLOW_KEY) === "1") return false;
  writeStored(SLOW_KEY, "1");
  if (readStored(STORAGE_KEY) === "0") return false;
  applyLiteMode(true);
  return true;
}
