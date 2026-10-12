/**
 * Dev-only CDP loop for the mobile add-transaction account picker.
 *
 *   node dev-harness/picker-loop.mjs --n=2000 --throttle=10
 *
 * Drives the real `AddTransactionSheet` → AccountPicker in a phone-sized headless Chromium:
 *   A) IME / word-mode typing  → search must filter and must not be rewritten
 *   A2) keyboard-written text  → must survive React's next render (Android Gboard)
 *   A3) a burst of composition updates (Sogou on an old phone) → coalesced, never stale, cheap
 *   B) delete after filtering  → jank must not grow with the account count
 *   C) opening the picker      → must not freeze while mounting the list
 *   D) tapping over the panel   → must reach the panel, not the row's hidden date input
 *   E) reopening the panel      → the search field starts empty again
 * Zero dependencies: launches Chrome directly and talks CDP over the Node WebSocket.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* Values may contain "=" (URLs): split on the first one only. */
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const body = a.replace(/^--/, "");
    const eq = body.indexOf("=");
    return eq === -1 ? [body, true] : [body.slice(0, eq), body.slice(eq + 1)];
  }),
);

const N = Number(argv.n || 2000);
const FLOOR_N = Number(argv.floorN || 30);
const THROTTLE = Number(argv.throttle || 10);
const BASE = String(argv.url || "http://localhost:5200/dev-harness/account-picker.html");
const FRAME_GAP_BUDGET_MS = Number(argv.budget || 120 + 30 * THROTTLE);
const CHROME =
  process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium-1228/chrome-win64/chrome.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`chrome not found at ${CHROME}`);

  const port = 9800 + Math.floor(Math.random() * 200);
  const profile = mkdtempSync(path.join(tmpdir(), "picker-harness-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=390,844",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ws;
  const cleanup = async () => {
    try {
      ws?.close();
    } catch {}
    try {
      chrome.kill();
    } catch {}
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
    } catch {}
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };

  try {
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
        } catch {
          return false;
        }
      },
      { label: "devtools endpoint", timeout: 25000 },
    );

    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    ).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? "")}`));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };
    const evalInPage = async (expression) => {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "page eval failed");
      return res.result.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

    const results = { n: N, throttle: THROTTLE, checks: [] };
    const record = (name, pass, detail) => results.checks.push({ name, pass, ...detail });

    const loadHarness = async (n) => {
      const url = `${BASE}${BASE.includes("?") ? "&" : "?"}n=${n}`;
      await send("Page.navigate", { url });
      await waitFor(() => evalInPage("!!(window.__harness && window.__harness.ready)"), {
        label: "harness ready",
      });
    };

    /** Open the picker the way a user does: tap the account trigger. */
    const openPicker = async ({ measure = false } = {}) => {
      const box = await evalInPage(
        `(() => { const el = document.querySelector('.m-tx-account-trigger'); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      );
      if (measure) await evalInPage("window.__harness.resetMetrics(); true");
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await waitFor(async () => (await evalInPage("window.__harness.snapshot()")).pickerOpen, {
        label: "picker open",
        timeout: 20000,
      });
      await waitFor(async () => (await evalInPage("window.__harness.snapshot()")).rendered > 0, {
        label: "picker list rendered",
        timeout: 60000,
      });
      await sleep(400);
      return evalInPage("window.__harness.metrics()");
    };

    const keyEvent = async (key, code, vk) => {
      for (const type of ["rawKeyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          key,
          code,
        });
      }
    };
    const setQuery = async (text) => {
      await evalInPage("window.__harness.setQuery(''); true");
      if (text) await send("Input.insertText", { text });
      await sleep(500);
    };

    const measureDeletePhase = async () => {
      await setQuery("10015");
      const narrowed = await evalInPage("window.__harness.snapshot()");
      await evalInPage("window.__harness.resetMetrics(); true");
      for (let i = 0; i < 5; i += 1) {
        await keyEvent("Backspace", "Backspace", 8);
        await sleep(300);
      }
      await sleep(800);
      const expanded = await evalInPage("window.__harness.snapshot()");
      const metrics = await evalInPage("window.__harness.metrics()");
      return { narrowed, expanded, metrics };
    };

    await loadHarness(N);

    /* ── C) opening the picker must not freeze the sheet ── */
    const openMetrics = await openPicker({ measure: true });
    const opened = await evalInPage("window.__harness.snapshot()");
    record(
      "open: mounting the picker shows a page of the list, not every account",
      opened.rendered > 0 && opened.rendered < opened.expected,
      { renderedOnOpen: opened.rendered, expectedOnOpen: opened.expected },
    );

    /* ── D) the hidden native date input must not hijack taps aimed at the panel ──
       `DateTapRow` lays an opacity-0 `<input type="date">` over its whole row, and that row
       always sits somewhere behind the picker panel. If the input outranks the panel in paint
       order, a tap meant for the list opens the OS date picker instead (filmed repro 2026-10:
       typing "max" in To Account → tapping a result → native calendar popped over the list,
       flickering, account never selected). */
    const dateBand = await evalInPage(`(() => {
      const input = document.querySelector('.m-tx-date-input');
      const panel = document.querySelector('.m-tx-account-picker');
      if (!input || !panel) return { missing: true, hasInput: !!input, hasPanel: !!panel };
      const r = input.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        bandHeight: Math.round(r.height),
        bandInsidePanel: r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
        panelZ: getComputedStyle(panel).zIndex,
        dateInputDisabled: input.disabled,
        topmostAtBand: hit ? String(hit.className || hit.tagName) : null,
        topmostIsDateInput: hit === input,
        topmostInsidePanel: !!(hit && hit.closest && hit.closest('.m-tx-account-picker')),
      };
    })()`);

    if (!dateBand.missing) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: dateBand.x,
          y: dateBand.y,
          button: "left",
          clickCount: 1,
        });
      }
      await sleep(300);
    }
    const afterDateTap = dateBand.missing
      ? { dateInputFocused: null, pickerOpen: true, activeElement: null }
      : await evalInPage(`(() => {
          const input = document.querySelector('.m-tx-date-input');
          return {
            dateInputFocused: document.activeElement === input,
            pickerOpen: !!document.querySelector('.m-tx-account-picker'),
            activeElement: document.activeElement
              ? String(document.activeElement.className || document.activeElement.tagName)
              : null,
          };
        })()`);
    record(
      "date: a tap over the panel must not reach the row's hidden native date input",
      !dateBand.missing &&
        dateBand.bandInsidePanel &&
        dateBand.topmostInsidePanel &&
        !dateBand.topmostIsDateInput &&
        !afterDateTap.dateInputFocused,
      { ...dateBand, ...afterDateTap },
    );

    /* The probe tap may have selected a row (which closes the panel) — put the picker back
       with the search field focused before the IME phase. */
    if (!afterDateTap.pickerOpen) await openPicker();
    await evalInPage(
      "(() => { const i = document.querySelector('.m-tx-account-picker-search input'); if (i) i.focus(); return true; })()",
    );
    await sleep(200);

    /* ── A) IME composition (Chinese / word-mode keyboard path) ── */
    const compose = async (text) => {
      await send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await sleep(300);
      return evalInPage("window.__harness.snapshot()");
    };

    const composedDigits = await compose("2135");
    record(
      "ime: list filters while composing (no delete needed)",
      composedDigits.expected > 0 && composedDigits.rendered > 0 && composedDigits.prefixMatches,
      { rendered: composedDigits.rendered, expected: composedDigits.expected, value: composedDigits.value },
    );

    await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    const composedLetter = await compose("c");
    record("ime: typing is not rewritten in the DOM", composedLetter.value === "c", {
      value: composedLetter.value,
    });
    const composedWord = await compose("ca");
    record("ime: typing survives the next keystroke", composedWord.value === "ca", {
      value: composedWord.value,
    });
    await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });

    await evalInPage("window.__harness.setQuery(''); window.__harness.simulateComposition('2135', { commit: true }); true");
    await sleep(300);
    const synth = await evalInPage("window.__harness.snapshot()");
    record(
      "ime(synthetic): option list filters on composed text",
      synth.expected > 0 && synth.rendered > 0 && synth.prefixMatches,
      { rendered: synth.rendered, expected: synth.expected, value: synth.value },
    );

    /* ── A2) the text the keyboard typed must survive React's next render ──
       Android/Gboard writes the composing text into the field itself; the `input` event can
       arrive later (or be de-duplicated by React's value tracker). If React then renders — any
       state change, e.g. the list window growing — a controlled `value=` writes its own, older
       string back into the field: the typed characters disappear, the list keeps filtering on
       something else, and only a delete (which produces a fresh event) re-aligns them. On the
       phone that reads as "typing finds nothing until I delete a character". */
    await evalInPage("window.__harness.setQuery(''); true");
    await sleep(250);
    const imeWrite = await evalInPage(`(() => {
      const input = document.querySelector('.m-tx-account-picker-search input');
      if (!input) return { error: 'no search input' };
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      /* the keyboard writes the text itself — no event reaches React yet */
      input.value = '1015';
      return { valueAfterWrite: input.value };
    })()`);
    /* Force an unrelated re-render of the picker: growing the list window is a state change. */
    await evalInPage("window.__harness.scrollOptionsToEnd(); true");
    await sleep(450);
    const afterRerender = await evalInPage(`(() => {
      const input = document.querySelector('.m-tx-account-picker-search input');
      return { value: input ? input.value : null };
    })()`);
    /* the keyboard now commits the word */
    await evalInPage(`(() => {
      const input = document.querySelector('.m-tx-account-picker-search input');
      if (!input) return false;
      input.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: input.value }),
      );
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          isComposing: false,
          data: input.value,
          inputType: 'insertText',
        }),
      );
      return true;
    })()`);
    await sleep(400);
    const afterCommit = await evalInPage("window.__harness.snapshot()");
    record(
      "ime: text the keyboard typed survives the next render and still filters the list",
      imeWrite.valueAfterWrite === "1015" &&
        afterRerender.value === "1015" &&
        afterCommit.value === "1015" &&
        afterCommit.rendered > 0 &&
        afterCommit.prefixMatches,
      {
        ...imeWrite,
        valueAfterRerender: afterRerender.value,
        valueAfterCommit: afterCommit.value,
        filtered: afterCommit.rendered,
        expected: afterCommit.expected,
      },
    );
    await evalInPage("window.__harness.setQuery(''); true");
    await sleep(250);

    /* ── A3) a burst of composition updates (Sogou on an old phone) must stay cheap and catch up ──
       Four updates land in the same tick, which is what a Chinese IME under load looks like. The
       list may coalesce them, but it must end up on the text the user sees even if the composition
       is never committed (the trailing flush), and it must not cost a long frame. */
    await evalInPage("window.__harness.setQuery(''); true");
    await sleep(250);
    await evalInPage("window.__harness.resetMetrics(); true");
    const burst = await evalInPage(`(() => {
      const input = document.querySelector('.m-tx-account-picker-search input');
      if (!input) return { error: 'no search input' };
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      for (const text of ['1', '10', '101', '1015']) {
        input.value = text;
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            isComposing: true,
            data: text,
            inputType: 'insertCompositionText',
          }),
        );
      }
      return { value: input.value };
    })()`);
    await sleep(600);
    const afterBurst = await evalInPage("window.__harness.snapshot()");
    const burstMetrics = await evalInPage("window.__harness.metrics()");
    record(
      "ime: a burst of composition updates stays cheap and still catches up",
      burst.value === "1015" &&
        afterBurst.rendered > 0 &&
        afterBurst.prefixMatches &&
        burstMetrics.maxFrameGap < FRAME_GAP_BUDGET_MS,
      {
        ...burst,
        filtered: afterBurst.rendered,
        expected: afterBurst.expected,
        maxFrameGap: Math.round(burstMetrics.maxFrameGap),
      },
    );

    /* ── B) delete after filtering ── */
    const scenario = await measureDeletePhase();
    record(
      "delete: list re-expands to the full match set",
      scenario.expanded.expected === N && scenario.expanded.prefixMatches,
      {
        rendered: scenario.expanded.rendered,
        expected: scenario.expanded.expected,
        narrowedRendered: scenario.narrowed.rendered,
      },
    );
    record(
      `delete: max frame gap under ${Math.round(FRAME_GAP_BUDGET_MS)}ms (phone CPU x${THROTTLE})`,
      scenario.metrics.maxFrameGap < FRAME_GAP_BUDGET_MS,
      {
        maxFrameGap: Math.round(scenario.metrics.maxFrameGap),
        maxLongTask: Math.round(scenario.metrics.maxLongTask),
      },
    );

    /* ── selection still works ── */
    await setQuery("");
    const secondBox = await evalInPage(
      `(() => { const nodes = document.querySelectorAll('.m-tx-account-picker-item'); const el = nodes[1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: el.textContent }; })()`,
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: secondBox.x,
        y: secondBox.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(500);
    const picked = await evalInPage(
      "(() => { const el = document.querySelector('.m-tx-account-trigger-text'); return el ? el.textContent : null; })()",
    );
    record("pick: tapping an account selects it and closes the picker", picked === secondBox.text, {
      triggerText: picked,
      expected: secondBox.text,
    });

    /* ── E) reopening the panel must start from an empty field and the full list ──
       The search field is uncontrolled, so clearing it is the panel's job, not React's. */
    await openPicker();
    const reopened = await evalInPage("window.__harness.snapshot()");
    record(
      "reopen: the search field starts empty and the list is not still filtered",
      reopened.value === "" && reopened.rendered > 0 && reopened.rendered < reopened.expected,
      { value: reopened.value, rendered: reopened.rendered, expected: reopened.expected },
    );
    await evalInPage("(() => { const b = document.querySelector('.m-tx-account-picker-close'); if (b) b.click(); return true; })()");
    await sleep(300);

    /* ── perf gate: jank must not scale with the account count ── */
    await loadHarness(FLOOR_N);
    const floorOpen = await openPicker({ measure: true });
    const floor = await measureDeletePhase();
    const jankAtN = Math.round(scenario.metrics.maxLongTask);
    const jankFloor = Math.round(floor.metrics.maxLongTask);
    const totalAtN = Math.round(scenario.metrics.totalLongTask);
    const totalFloor = Math.round(floor.metrics.totalLongTask);
    const allowed = Math.max(250, Math.round(jankFloor * 4));
    record(
      `perf: delete jank at ${N} accounts (${jankAtN}ms) stays near the ${FLOOR_N}-account floor (${jankFloor}ms)`,
      jankAtN <= allowed,
      { jankAtN, jankFloor, allowed, totalAtN, totalFloor },
    );

    /* ── F) a normal form field (not a search box): typing + deleting an amount ──
       The reported complaint is that *every* input lags on an old phone, not just the picker, so the
       same per-key latency is measured here on the transaction sheet's amount field. */
    const amountSelector = "window.__harness.formField('amount')";
    const amountExists = await evalInPage(`!!${amountSelector}`);
    if (!amountExists) {
      record("form: typing an amount stays responsive", false, { error: "amount field not found" });
    } else {
      await evalInPage(`(() => {
        const el = ${amountSelector};
        el.focus();
        el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return true;
      })()`);
      await sleep(250);
      await evalInPage("window.__harness.resetMetrics(); true");

      const amountLatencies = [];
      let typed = "";
      for (const ch of "12345678") {
        const t0 = await evalInPage("performance.now()");
        await send("Input.insertText", { text: ch });
        typed += ch;
        let applied = null;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const value = await evalInPage(`(() => { const el = ${amountSelector}; return el ? el.value : null; })()`);
          if (value === typed) {
            applied = await evalInPage("performance.now()");
            break;
          }
          await sleep(20);
        }
        amountLatencies.push(applied === null ? null : Math.round(applied - t0));
        await sleep(110);
      }

      /* then four backspaces */
      const deleteLatencies = [];
      for (let i = 0; i < 4; i += 1) {
        const t0 = await evalInPage("performance.now()");
        for (const type of ["rawKeyDown", "keyUp"]) {
          await send("Input.dispatchKeyEvent", {
            type,
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
            nativeVirtualKeyCode: 8,
          });
        }
        typed = typed.slice(0, -1);
        let applied = null;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const value = await evalInPage(`(() => { const el = ${amountSelector}; return el ? el.value : null; })()`);
          if (value === typed) {
            applied = await evalInPage("performance.now()");
            break;
          }
          await sleep(20);
        }
        deleteLatencies.push(applied === null ? null : Math.round(applied - t0));
        await sleep(110);
      }

      const metrics = await evalInPage("window.__harness.metrics()");
      const finalValue = await evalInPage(`(() => { const el = ${amountSelector}; return el ? el.value : null; })()`);
      const nums = (arr) => arr.filter((n) => n !== null);
      const maxType = nums(amountLatencies).length ? Math.max(...nums(amountLatencies)) : null;
      const maxDelete = nums(deleteLatencies).length ? Math.max(...nums(deleteLatencies)) : null;
      const budget = Number(argv.formBudget || 120 + 6 * THROTTLE);

      record(
        `form: typing+deleting an amount stays responsive (x${THROTTLE}, budget ${budget}ms)`,
        finalValue === "1234" &&
          maxType !== null &&
          maxDelete !== null &&
          maxType < budget &&
          maxDelete < budget,
        {
          finalValue,
          maxTypeLatency: maxType,
          maxDeleteLatency: maxDelete,
          typeLatencies: amountLatencies,
          deleteLatencies,
          maxFrameGap: Math.round(metrics.maxFrameGap),
          totalLongTask: Math.round(metrics.totalLongTask),
        },
      );
    }

    /* Open cost is not gated in ms: the panel's own layout work dominates at every N. The
       structural check above ("a page, not every account") is the deterministic gate. */
    const openAtN = Math.round(openMetrics.maxFrameGap);
    const openFloor = Math.round(floorOpen.maxFrameGap);

    results.summary = {
      renderedOnOpen: opened.rendered,
      expectedOnOpen: opened.expected,
      openFrameGap: Math.round(openMetrics.maxFrameGap),
      openLongTask: Math.round(openMetrics.maxLongTask),
      narrowedRendered: scenario.narrowed.rendered,
      expandedRendered: scenario.expanded.rendered,
      expectedFull: scenario.expanded.expected,
      jankAtN,
      jankFloor,
      totalAtN,
      totalFloor,
      frameGapAtN: Math.round(scenario.metrics.maxFrameGap),
      dateBandTopmost: dateBand.topmostAtBand,
    };
    console.log(JSON.stringify(results, null, 2));
    const failed = results.checks.filter((c) => !c.pass);
    console.log(
      failed.length
        ? `\nRESULT: FAIL (${failed.length}/${results.checks.length})\n  - ${failed.map((f) => f.name).join("\n  - ")}`
        : `\nRESULT: PASS (${results.checks.length}/${results.checks.length})`,
    );
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("LOOP ERROR:", err.message);
  process.exitCode = 2;
});
