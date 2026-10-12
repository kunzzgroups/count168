/**
 * Dev-only harness for the mobile add-transaction account picker
 * (`src/pages/transaction/AddTransactionSheet.jsx` → AccountPicker).
 * Mounts the real sheet with a mock account list so the search field can be driven by CDP.
 */
import React, { useMemo } from "react";
import { createRoot } from "react-dom/client";
import AddTransactionSheet from "../src/pages/transaction/AddTransactionSheet.jsx";
import "../src/styles/tokens.css";
import "../src/styles/page-body.css";
import "../src/styles/bottom-sheet.css";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const N = Math.max(1, Number(params.get("n") || 2000));

/*
 * `?legacyZ=1` restores the pre-fix behaviour so the reported bug can be reproduced by hand:
 * the picker panel drops back under the row's hidden `<input type="date">` (z-index) and the
 * date inputs are re-enabled while the panel is open (the sheet's belt-and-braces guard).
 * Tap anywhere in the date row's band — the line just under the sheet header — while the panel
 * is up: legacy opens the OS date picker, fixed reaches the list.
 */
const legacyZ = params.get("legacyZ") === "1";
if (legacyZ) {
  const style = document.createElement("style");
  /*
   * Two things have to go back to the pre-fix state together:
   *  - the panel's z-index (it used to sit under the row's hidden date input),
   *  - the `--disabled` row class, whose `opacity: .5` creates a stacking context of its own
   *    and would hide the date input behind the panel all by itself.
   */
  style.textContent =
    ".m-tx-account-picker { z-index: 2 !important; }\n" +
    ".m-tx-date-row--disabled { opacity: 1 !important; }";
  document.head.appendChild(style);

  const reEnableDateInputs = () => {
    document
      .querySelectorAll('.m-tx-date-input[disabled]')
      .forEach((el) => {
        el.disabled = false;
      });
  };
  const legacyObserver = new MutationObserver(reEnableDateInputs);
  legacyObserver.observe(document.getElementById("root"), {
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
}

/* `?mark=1` outlines the date row's hit band above everything else, so the manual test knows
   where the hidden native date input sits while the picker panel covers the sheet. */
if (params.get("mark") === "1") {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:9999;border:2px dashed #ef4444;" +
    "border-radius:12px;background:rgba(239,68,68,.08)";
  document.body.appendChild(box);
  const place = () => {
    const row = document.querySelector(".m-tx-date-row");
    if (!row) return;
    const r = row.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };
  place();
  setInterval(place, 250);
  new MutationObserver(place).observe(document.getElementById("root"), {
    subtree: true,
    childList: true,
  });
}

const NAME_POOL = [
  "CASH",
  "BANK",
  "PLAYER",
  "AGENT",
  "HOUSE",
  "PROFIT",
  "LOSS",
  "COMMISSION",
  "BONUS",
  "RESERVE",
];

function buildAccounts(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const code = String(1001 + i);
    const name = `${NAME_POOL[i % NAME_POOL.length]}_${i}`;
    rows.push({
      id: String(i + 1),
      account_id: code,
      name,
      display_text: `${code} (${name})`,
      currency: "MYR",
      status: "active",
    });
  }
  return rows;
}

/* Translation stand-in: every key renders as itself. */
const m = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === "string" ? key : undefined),
  },
);

const perfState = { frames: [], longTasks: [], listUpdates: [], resetAt: 0 };

(function trackFrames() {
  let last = performance.now();
  const tick = (t) => {
    perfState.frames.push({ t, gap: t - last });
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perfState.longTasks.push({ t: entry.startTime, start: entry.startTime, duration: entry.duration });
    }
  }).observe({ entryTypes: ["longtask"] });
} catch {
  /* longtask unsupported */
}

function Harness() {
  const accounts = useMemo(() => accountsFor(), []);
  return (
    <AddTransactionSheet
      open
      onClose={() => {}}
      m={m}
      accountOptions={accounts}
      currencyOptions={["MYR"]}
      onSubmit={() => {}}
      pushToast={() => {}}
    />
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

/* ── instrumentation surface for the CDP driver ── */
function pickerInput() {
  return document.querySelector(".m-tx-account-picker-search input");
}

function itemNodes() {
  return Array.from(document.querySelectorAll(".m-tx-account-picker-item"));
}

/* Cached: rebuilding the mock list inside snapshot() would pollute the perf numbers. */
let cachedRows = null;
let cachedIndex = null;

function accountsFor() {
  if (!cachedRows) cachedRows = buildAccounts(N);
  return cachedRows;
}

function expectedMatches(query) {
  const q = String(query || "").trim().toUpperCase();
  if (!q) return accountsFor();
  if (!cachedIndex) {
    cachedIndex = accountsFor().map((r) => ({ row: r, hay: String(r.display_text || "").toUpperCase() }));
  }
  return cachedIndex.filter((e) => e.hay.includes(q)).map((e) => e.row);
}

let lastInputTs = 0;
let observerAttached = false;

function attachListObserver() {
  const listEl = document.querySelector(".m-tx-account-picker-list");
  if (!listEl || observerAttached) return;
  observerAttached = true;
  new MutationObserver(() => {
    if (!lastInputTs) return;
    perfState.listUpdates.push({ t: performance.now(), latency: performance.now() - lastInputTs });
    lastInputTs = 0;
  }).observe(listEl, { childList: true, subtree: true });
}

function summarize() {
  const since = perfState.resetAt;
  const frames = perfState.frames.filter((f) => f.t >= since);
  const longTasks = perfState.longTasks.filter((e) => e.t >= since);
  return {
    maxFrameGap: frames.length ? Math.max(...frames.map((f) => f.gap)) : 0,
    totalLongTask: longTasks.reduce((s, e) => s + e.duration, 0),
    maxLongTask: longTasks.reduce((m, e) => Math.max(m, e.duration), 0),
    longTaskCount: longTasks.length,
  };
}

window.__harness = {
  legacyZ,
  /** Find an input/textarea by the label above it (`m` renders translation keys, so "amount" etc.). */
  formField(labelText) {
    const wanted = String(labelText || "").trim().toLowerCase();
    for (const field of document.querySelectorAll(".m-tx-form-field, .m-tx-form-section")) {
      const label = field.querySelector(".m-tx-form-label");
      if (label && label.textContent.trim().toLowerCase() === wanted) {
        const el = field.querySelector("input, textarea");
        if (el) return el;
      }
    }
    return null;
  },
  legacyZ,
  get ready() {
    return !!document.querySelector(".m-tx-account-trigger");
  },
  n: N,
  openPicker() {
    const trigger = document.querySelector(".m-tx-account-trigger");
    if (!trigger) return false;
    trigger.click();
    return true;
  },
  snapshot() {
    const input = pickerInput();
    const text = input ? input.value : null;
    const all = itemNodes().map((n) => n.textContent);
    /* With an empty query the picker prepends a "no account" row — not part of the match set. */
    const placeholderTexts = [m.selectToAccount, m.selectFromAccount];
    const rendered = String(text || "").trim()
      ? all
      : all.filter((t) => !placeholderTexts.includes(t));
    const expected = expectedMatches(text).map((r) => r.display_text);
    return {
      pickerOpen: !!document.querySelector(".m-tx-account-picker"),
      value: text,
      rendered: rendered.length,
      expected: expected.length,
      first: rendered[0] ?? null,
      prefixMatches: rendered.every((t, i) => t === expected[i]),
      focused: document.activeElement === input,
    };
  },
  metrics: summarize,
  resetMetrics() {
    perfState.frames.length = 0;
    perfState.longTasks.length = 0;
    perfState.listUpdates.length = 0;
    perfState.resetAt = performance.now();
  },
  attachListObserver,
  setQuery(text) {
    const input = pickerInput();
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, text ?? "");
    lastInputTs = performance.now();
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text ?? "", inputType: "insertText" }));
    return true;
  },
  simulateComposition(text, { commit = false } = {}) {
    const input = pickerInput();
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    lastInputTs = performance.now();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    setter.call(input, text);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true, data: text, inputType: "insertCompositionText" }),
    );
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
    if (commit) {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
    }
    return true;
  },
  scrollOptionsToEnd() {
    const el = document.querySelector(".m-tx-account-picker-list");
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    return true;
  },
};

const waitForTrigger = setInterval(() => {
  if (document.querySelector(".m-tx-account-trigger")) {
    clearInterval(waitForTrigger);
    attachListObserver();
  }
}, 200);
