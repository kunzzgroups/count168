/**
 * Dev-only CDP loop for the mobile **login form** (dev only — not part of the build).
 *
 *   node dev-harness/login-loop.mjs
 *
 * The login page is the one screen that renders without any backend, so it is where the Android
 * "the keyboard's text disappears again" bug can be reproduced on the real page instead of a mock.
 *
 *   A) text the keyboard wrote itself must survive a re-render of the form
 *   B) the show/hide toggle must not disturb what is typed
 *   C) the hidden password field must stay `type="password"` (Android IME would otherwise offer
 *      Chinese candidates / auto-capitalise inside it — an earlier fix that must not regress)
 *
 * Zero dependencies: launches Chrome directly and talks CDP over the Node WebSocket.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const body = a.replace(/^--/, "");
    const eq = body.indexOf("=");
    return eq === -1 ? [body, true] : [body.slice(0, eq), body.slice(eq + 1)];
  }),
);

const URL_UNDER_TEST = String(argv.url || "http://localhost:5174/login");
const THROTTLE = Number(argv.throttle || 6);
/** A single backspace may take longer on slower hardware — scale with the emulated CPU. */
const DELETE_LATENCY_BUDGET_MS = Number(argv.latencyBudget || 120 + 6 * THROTTLE);
/** Kill every animation/transition/filter before the delete phase — quantifies their cost. */
const NOANIM = argv.noanim === true || argv.noanim === "1";
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

  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = mkdtempSync(path.join(tmpdir(), "login-harness-"));
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
    /* Frame + long-task instrumentation, installed before the app boots: "the delete key lags" is
       a jank report, and a phone CPU is where it shows. */
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__perf = { frames: [], longTasks: [], resetAt: 0 };
        (function track(){
          let last = performance.now();
          const tick = (t) => { window.__perf.frames.push({ t, gap: t - last }); last = t; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        })();
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__perf.longTasks.push({ t: e.startTime, duration: e.duration });
          }).observe({ entryTypes: ['longtask'] });
        } catch {}

        /* Capture what the form actually submits. The login page keeps the fields' text in refs
           (typing must not re-render it), so this is what proves the submitted body still carries
           exactly what the user typed — including the last field, which is never blurred. */
        window.__posts = [];
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('login_api.php') || url.includes('company/verify_api.php')) {
            let entries = null;
            try {
              const body = init && init.body;
              entries = body && typeof body.forEach === 'function' ? Object.fromEntries([...body.entries()]) : null;
            } catch (err) {
              entries = { error: String(err) };
            }
            window.__posts.push({ url, entries });
            /* Answer with a plain business-level failure: a rejected fetch or a !ok response makes
               the page reload itself (see tryLoginPageReloadOnce), which would navigate away
               mid-check. This keeps the app on the "wrong credentials" path. */
            return Promise.resolve(
              new Response(JSON.stringify({ status: 'error', message: 'harness: not a real login' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          return realFetch(input, init);
        };
      `,
    });

    const results = { url: URL_UNDER_TEST, checks: [] };
    const record = (name, pass, detail) => results.checks.push({ name, pass, ...detail });

    await send("Page.navigate", { url: URL_UNDER_TEST });
    await waitFor(() => evalInPage("!!document.querySelector('#company-id')"), {
      label: "login form",
      timeout: 40000,
    });
    await sleep(500);

    /* ── D-1) lite mode: `?lite=1` must actually flatten the page on the device ──
       (It is also the fastest way to test on a real phone whether the page's own paint cost is what
       makes typing lag inside the WebView — see lib/liteMode.js.) */
    const withFlag = (flag) => `${URL_UNDER_TEST}${URL_UNDER_TEST.includes("?") ? "&" : "?"}${flag}`;
    await send("Page.navigate", { url: withFlag("lite=1") });
    await waitFor(() => evalInPage("!!document.querySelector('#company-id')"), {
      label: "login form (lite)",
      timeout: 40000,
    });
    await sleep(400);
    const liteState = await evalInPage(`(() => {
      const card = document.querySelector('.sc-login-card');
      const lang = document.querySelector('.sc-login-lang-ios') || document.querySelector('.sc-login-shell');
      const glow = lang ? getComputedStyle(lang, '::after') : null;
      return {
        hasClass: document.body.classList.contains('lite'),
        backgroundImage: getComputedStyle(document.body).backgroundImage,
        cardBackground: card ? getComputedStyle(card).backgroundColor : null,
        glowHidden: !glow || glow.display === 'none',
      };
    })()`);
    record(
      "login: lite mode (?lite=1) flattens the expensive visuals",
      liteState.hasClass &&
        liteState.backgroundImage === "none" &&
        liteState.glowHidden &&
        /^rgb\(255, 255, 255\)$/.test(String(liteState.cardBackground)),
      liteState,
    );

    /* D-2) the user-discovered workaround, automated: tapping out of a field and back in clears the
       IME's composition buffer, after which a delete is immediate ("点一下屏幕再点回输入框就能删").
       So a paused composition must be handed over to the field automatically. */
    await evalInPage(
      "window.__forcedCommits = 0; window.addEventListener('ec:composition-committed', () => { window.__forcedCommits += 1; }, true); true",
    );
    await evalInPage(`(() => {
      const el = document.querySelector('#user-id');
      el.focus();
      el.value = '';
      return true;
    })()`);
    await send("Input.imeSetComposition", { text: "abc", selectionStart: 3, selectionEnd: 3 });
    await sleep(1400); /* past the 800ms idle threshold */
    const forced = await evalInPage(
      "(() => { const el = document.querySelector('#user-id'); return { count: window.__forcedCommits || 0, value: el ? el.value : null }; })()",
    );
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
    await sleep(250);
    const afterForcedDelete = await evalInPage(
      "(() => { const el = document.querySelector('#user-id'); return el ? el.value : null; })()",
    );
    record(
      "login: a paused IME composition is handed over to the field (delete hits real text)",
      forced.count >= 1 &&
        typeof afterForcedDelete === "string" &&
        afterForcedDelete.length < String(forced.value || "").length,
      {
        forcedCommits: forced.count,
        valueBeforeDelete: forced.value,
        valueAfterDelete: afterForcedDelete,
      },
    );

    /* Back to the normal variant for everything below. */
    await send("Page.navigate", { url: withFlag("lite=0") });
    await waitFor(() => evalInPage("!!document.querySelector('#company-id')"), {
      label: "login form (full)",
      timeout: 40000,
    });
    await sleep(500);

    /**
     * The phone's keyboard writes the text into the field itself (no event reaches React), and the
     * form re-renders for an unrelated reason — exactly the sequence that made characters vanish.
     */
    const probeField = async (selector, text, { rerenderVia }) => {
      const written = await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.focus();
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        el.value = ${JSON.stringify(text)};
        return el.value;
      })()`);
      if (written === null) return { missing: selector };

      /* an unrelated state change re-renders the whole form */
      await evalInPage(`(() => { const el = document.querySelector(${JSON.stringify(rerenderVia)}); if (el) el.click(); return true; })()`);
      await sleep(350);
      const after = await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.value : null;
      })()`);
      /* the keyboard commits the text (a fresh event React can see) */
      await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.value }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: el.value, inputType: 'insertText' }));
        return true;
      })()`);
      await sleep(250);
      const afterCommit = await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.value : null;
      })()`);
      return { written, afterRerender: after, afterCommit };
    };

    const fields = [
      ["#company-id", "C168", "company id"],
      ["#user-id", "alice", "user id"],
      ["#password", "Secret123", "password"],
    ];
    for (const [selector, text, label] of fields) {
      const probe = await probeField(selector, text, { rerenderVia: ".sc-login-remember-check" });
      record(
        `login: the ${label} keeps the text the keyboard typed (survives a re-render)`,
        probe.written === text && probe.afterRerender === text && probe.afterCommit === text,
        probe,
      );
    }

    /* B) the show/hide toggle must not eat the password */
    const toggle = await evalInPage(`(() => {
      const el = document.querySelector('#password');
      const btn = document.querySelector('.ec-password-toggle');
      if (!el || !btn) return { missing: true };
      el.focus();
      el.value = 'Secret123';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: 'Secret123', inputType: 'insertText' }));
      btn.click();
      return { afterToggle: el.value, typeAfterToggle: el.type };
    })()`);
    await sleep(300);
    const toggleAfter = await evalInPage(
      "(() => { const el = document.querySelector('#password'); return el ? el.value : null; })()",
    );
    record(
      "login: the show/hide toggle keeps the password",
      !toggle.missing && toggle.afterToggle === "Secret123" && toggleAfter === "Secret123",
      { ...toggle, valueAfterToggle: toggleAfter },
    );

    /* C) the hidden password field must stay a real password field */
    await evalInPage(`(() => {
      const btn = document.querySelector('.ec-password-toggle');
      const el = document.querySelector('#password');
      if (!btn || !el) return false;
      if (el.type === 'text') btn.click();          /* make sure it is hidden again */
      return true;
    })()`);
    await sleep(300);
    const typeAfter = await evalInPage(
      "(() => { const el = document.querySelector('#password'); return el ? el.type : null; })()",
    );
    record("login: the hidden password field is type=password", typeAfter === "password", {
      typeWhenHidden: typeAfter,
    });

    /* D0) the build marker: makes "which bundle is the user actually running" answerable, and it is
       also the door to the on-device typing report (WebView version + measured paint latency). */
    const buildMarker = await evalInPage(
      "(() => { const el = document.querySelector('.sc-login-build'); return el ? el.textContent.trim() : null; })()",
    );
    record(
      "login: the build marker is rendered (a bug report can name the bundle)",
      Boolean(buildMarker && /^build \S/.test(buildMarker)),
      { marker: buildMarker },
    );

    /* D) "the delete key lags" — type with the English keyboard, then hold/repeat Backspace. */
    const readMetrics = () =>
      evalInPage(`(() => {
        const since = window.__perf?.resetAt || 0;
        const frames = (window.__perf?.frames || []).filter((f) => f.t >= since);
        const tasks = (window.__perf?.longTasks || []).filter((e) => e.t >= since);
        return {
          maxFrameGap: frames.length ? Math.max(...frames.map((f) => f.gap)) : 0,
          longTaskCount: tasks.length,
          totalLongTask: Math.round(tasks.reduce((s, e) => s + e.duration, 0)),
          maxLongTask: tasks.length ? Math.round(Math.max(...tasks.map((e) => e.duration))) : 0,
        };
      })()`);

    await evalInPage(`(() => {
      const el = document.querySelector('#user-id');
      el.focus();
      el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return true;
    })()`);
    await sleep(300);
    await evalInPage("window.__perf.resetAt = performance.now(); true");

    /* type 12 characters one by one (an English keyboard) */
    const TYPED = "alicebob1234";
    const DELETES = 8;
    for (const ch of TYPED) {
      await send("Input.insertText", { text: ch });
      await sleep(110);
    }
    const typeMetrics = await readMetrics();

    /* then 8 backspaces, measuring each press -> field-value change (what a user feels as "lag") */
    await evalInPage("window.__perf.resetAt = performance.now(); true");
    if (NOANIM) {
      await evalInPage(`(() => {
        const s = document.createElement('style');
        s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;filter:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}';
        document.head.appendChild(s);
        return true;
      })()`);
      await sleep(300);
    }

    const readValue = () =>
      evalInPage("(() => { const el = document.querySelector('#user-id'); return el ? el.value : null; })()");

    const latencies = [];
    let pressesNeeded = null;
    let current = await readValue();
    for (let i = 0; i < DELETES; i += 1) {
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
      let applied = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const value = await readValue();
        if (value !== current) {
          applied = { value, at: await evalInPage("performance.now()") };
          break;
        }
        await sleep(20);
      }
      if (applied) {
        latencies.push(Math.round(applied.at - t0));
        if (pressesNeeded === null) pressesNeeded = i + 1;
        current = applied.value;
      } else {
        latencies.push(null);
      }
      await sleep(110);
    }
    await sleep(500);
    const deleteMetrics = await readMetrics();
    const valueAfterDeletes = await readValue();

    const applied = latencies.filter((l) => l !== null);
    const maxDeleteLatency = applied.length ? Math.max(...applied) : null;
    const slowDeletes = applied.filter((l) => l > DELETE_LATENCY_BUDGET_MS).length;

    const expectedAfterDeletes = TYPED.slice(0, TYPED.length - DELETES);
    record(
      `login: delete stays responsive on a throttled CPU (x${THROTTLE}${NOANIM ? ", animations off" : ""})`,
      deleteMetrics.maxFrameGap < FRAME_GAP_BUDGET_MS &&
        valueAfterDeletes === expectedAfterDeletes &&
        maxDeleteLatency !== null &&
        maxDeleteLatency < DELETE_LATENCY_BUDGET_MS,
      {
        throttle: THROTTLE,
        noAnim: NOANIM,
        budgetMs: FRAME_GAP_BUDGET_MS,
        latencyBudgetMs: DELETE_LATENCY_BUDGET_MS,
        expectedAfterDeletes,
        typeMaxFrameGap: Math.round(typeMetrics.maxFrameGap),
        deleteMaxFrameGap: Math.round(deleteMetrics.maxFrameGap),
        deleteLongTasks: deleteMetrics.longTaskCount,
        deleteTotalLongTask: deleteMetrics.totalLongTask,
        maxDeleteLatency,
        slowDeletes,
        latencies,
        pressesNeeded,
        valueAfterDeletes,
      },
    );

    /* ── E) what is submitted is what the user typed (the fields live in refs while typing) ──
       Typing must not re-render this page, so nothing guarantees the last keystroke reached React
       state — the submit path has to read the field's current text. The last field the user types in
       is never blurred before tapping Sign in, which is exactly the case that would break if the
       submit read state instead. */
    const CREDENTIALS = { company: "C168", user: "alice", password: "Secret123" };
    await evalInPage(`(() => {
      const set = (selector, text) => {
        const el = document.querySelector(selector);
        el.focus();
        el.value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: text, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('#company-id', ${JSON.stringify(CREDENTIALS.company)});
      set('#user-id', ${JSON.stringify(CREDENTIALS.user)});
      set('#password', ${JSON.stringify(CREDENTIALS.password)});
      document.querySelector('button[type="submit"]').click();
      return true;
    })()`);
    await waitFor(() => evalInPage("(window.__posts || []).length > 0"), {
      label: "login request captured",
      timeout: 15000,
    });
    await sleep(300);
    const captured = await evalInPage(
      "(() => { const p = (window.__posts || []).find((x) => x.url.includes('login_api.php')); return p ? p.entries : null; })()",
    ).catch((err) => ({ error: String(err) }));
    const sentUser = captured && !captured.error ? captured.login_id || captured.account_id : null;
    record(
      "login: the submitted body carries exactly what was typed (last field never blurred)",
      Boolean(captured) &&
        !captured.error &&
        captured.company_id === CREDENTIALS.company.toUpperCase() &&
        sentUser === CREDENTIALS.user.toUpperCase() &&
        captured.password === CREDENTIALS.password,
      { captured, expected: CREDENTIALS },
    );

    /* F) the on-device typing report — the only way to measure a real phone + Sogou */
    await evalInPage(
      "(() => { const el = document.querySelector('.sc-login-build'); if (el) el.click(); return true; })()",
    );
    await sleep(300);
    const diagText = await evalInPage(
      "(() => { const el = document.querySelector('.sc-login-diag'); return el ? el.textContent : null; })()",
    );
    record(
      "login: tapping the build marker shows the on-device typing report",
      Boolean(diagText) &&
        /webview/i.test(diagText) &&
        /paint latency/i.test(diagText) &&
        /keys? in/i.test(diagText),
      { report: diagText },
    );

    console.log(JSON.stringify(results, null, 2));    const failed = results.checks.filter((c) => !c.pass);
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
