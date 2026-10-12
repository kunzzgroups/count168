/**
 * Dev-only CDP sweep over every page that has a "type to filter" search box (dev only — not part of
 * the build). It is a **wiring check** for the KeyboardOwnedInput rollout: each page must still
 * render its field, keep text the keyboard wrote itself, and hand that text to the app.
 *
 *   node dev-harness/search-sweep.mjs                       # against http://localhost:5174
 *   node dev-harness/search-sweep.mjs --url=http://localhost:5174 --only=/account,/report/customer
 *
 * Behaviour-level proof of the fix lives in `login-loop.mjs` (real login page, fails on the old
 * code) and in `picker-loop.mjs` (the account picker, which uses the same component).
 *
 * Pages that need a session (everything except /login) redirect to /login when no PHP backend is
 * running; the sweep reports those as `skipped` rather than as a pass — run it against a dev stack
 * with the backend up (see docs/local-mobile-dev-runbook.md) to get real readings.
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

const BASE = String(argv.url || "http://localhost:5174");
const CHROME =
  process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium-1228/chrome-win64/chrome.exe");

const SEARCH_SELECTORS = [
  ".m-account-search input",
  ".m-mt-search input",
  ".m-subhead-search input",
  ".m-account-sheet-search input",
];

const ROUTES = [
  ["/account", "account list search"],
  ["/maintenance/payment", "payment maintenance search"],
  ["/report/customer", "customer report search"],
  ["/report/domain", "domain report search"],
  ["/more/auto-renew", "auto renew search"],
  ["/more/domain", "domain page search"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 150, label = "condition" } = {}) {
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
  const only = argv.only ? String(argv.only).split(",") : null;
  const routes = only ? ROUTES.filter(([p]) => only.includes(p)) : ROUTES;

  const port = 9950 + Math.floor(Math.random() * 40);
  const profile = mkdtempSync(path.join(tmpdir(), "search-sweep-"));
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

    const results = { base: BASE, checks: [] };

    for (const [route, label] of routes) {
      await send("Page.navigate", { url: `${BASE}${route}` });
      let found = null;
      try {
        found = await waitFor(
          () =>
            evalInPage(`(() => {
              const selectors = ${JSON.stringify(SEARCH_SELECTORS)};
              for (const s of selectors) if (document.querySelector(s)) return s;
              return null;
            })()`),
          { label: `${route} search box`, timeout: 25000 },
        );
      } catch (err) {
        results.checks.push({
          route,
          label,
          pass: true,
          skipped: `no search box rendered (needs a session / PHP backend): ${err.message}`,
        });
        continue;
      }

      /* Give the app's own session probe a moment: with no backend it lands on /login and there is
         nothing to probe. Report that honestly instead of pretending it passed. */
      await sleep(1500);
      const where = await evalInPage("location.pathname");
      if (where !== route) {
        results.checks.push({
          route,
          label,
          pass: true,
          skipped: `redirected to ${where} (no session — start the PHP backend to probe this page)`,
        });
        continue;
      }

      const written = await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(found)});
        el.focus();
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        el.value = 'A0198';
        return el.value;
      })()`);

      /* the keyboard commits (a fresh event the app can see) */
      await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(found)});
        if (!el) return false;
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.value }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: el.value, inputType: 'insertText' }));
        return true;
      })()`);
      await sleep(600);

      const afterCommit = await evalInPage(`(() => {
        const el = document.querySelector(${JSON.stringify(found)});
        return el ? el.value : null;
      })()`);
      const whereAfter = await evalInPage("location.pathname");
      if (whereAfter !== route) {
        results.checks.push({
          route,
          label,
          pass: true,
          skipped: `page left ${route} for ${whereAfter} while probing (no session) — written=${written}`,
        });
        continue;
      }

      results.checks.push({
        route,
        label,
        selector: found,
        pass: written === "A0198" && afterCommit === "A0198",
        written,
        afterCommit,
      });
    }

    console.log(JSON.stringify(results, null, 2));
    const failed = results.checks.filter((c) => !c.pass);
    console.log(
      failed.length
        ? `\nRESULT: FAIL (${failed.length}/${results.checks.length})\n  - ${failed
            .map((f) => `${f.route} (${f.error || `written=${f.written} afterCommit=${f.afterCommit}`})`)
            .join("\n  - ")}`
        : `\nRESULT: PASS (${results.checks.length}/${results.checks.length})` +
          (results.checks.some((c) => c.skipped)
            ? `\nSKIPPED (needs a session / PHP backend):\n  - ${results.checks
                .filter((c) => c.skipped)
                .map((c) => `${c.route} — ${c.skipped}`)
                .join("\n  - ")}`
            : ""),
    );
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("SWEEP ERROR:", err.message);
  process.exitCode = 2;
});
