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

    const results = { url: URL_UNDER_TEST, checks: [] };
    const record = (name, pass, detail) => results.checks.push({ name, pass, ...detail });

    await send("Page.navigate", { url: URL_UNDER_TEST });
    await waitFor(() => evalInPage("!!document.querySelector('#company-id')"), {
      label: "login form",
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
