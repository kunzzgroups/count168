/**
 * Dev-only CDP loop for the startup lock screen + PIN pad (dev only — not part of the build).
 *
 *   npm run dev -- --port 5174 --strictPort      # in another shell
 *   node dev-harness/pin-lock-loop.mjs
 *
 * The lock screen only renders inside the Android shell (`isNative()`), so this drives the
 * harness page (`dev-harness/pin-lock.html`) which fakes that bridge and nothing else.
 * See pin-lock-harness.jsx for exactly what is faked.
 *
 * Checks:
 *   1. PIN-only device → the PIN pad is the lock screen (no biometric buttons)
 *   2. wrong PIN → error line, dots cleared, still locked
 *   3. correct PIN → gate opens (children render)
 *   4. "back to login" → navigates to /login and stays locked
 *   5. device that also has a biometric credential → biometric card, with BOTH
 *      "use PIN" and "back to login", and the pad is one tap away
 *   6. screenshots of both cards (`--shots=1`, written next to this file)
 *
 * Exit code 0 = all checks pass, 1 = a check failed, 2 = harness error.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const body = a.replace(/^--/, "");
    const eq = body.indexOf("=");
    return eq === -1 ? [body, true] : [body.slice(0, eq), body.slice(eq + 1)];
  }),
);

const BASE = String(argv.base || "http://localhost:5174/dev-harness/pin-lock.html");
const CHROME =
  process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium-1228/chrome-win64/chrome.exe");
const WANT_SHOTS = argv.shots === "1" || argv.shots === true;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `\n       ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`chrome not found at ${CHROME}`);

  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = mkdtempSync(path.join(tmpdir(), "pin-lock-harness-"));
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
      if (msg.method === "Page.javascriptDialogOpening") {
        // 插件的 web 实现用 confirm() 假装指纹弹窗；
        // 这里必须主动取消，才等价于真机上的「用户没认出来」。
        ws.send(
          JSON.stringify({
            id: nextId++,
            method: "Page.handleJavaScriptDialog",
            params: { accept: false },
          }),
        );
        return;
      }
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
      const res = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || "page eval failed");
      }
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

    const goto = async (url) => {
      await send("Page.navigate", { url });
      await waitFor(
        async () => evalInPage("document.readyState === 'complete'"),
        { label: "page load" },
      );
      // harness 先播种（PBKDF2 要跑一下）再挂载
      await waitFor(
        async () => evalInPage("!!document.querySelector('.bio-lock, #app-content, #harness-loading')"),
        { label: "harness mount", timeout: 25000 },
      );
    };

    const tap = async (testId) => {
      const ok = await evalInPage(`(() => {
        const el = document.querySelector('[data-testid="${testId}"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`no element with data-testid=${testId}`);
    };

    const typePin = async (pin) => {
      for (const digit of pin) {
        await tap(`bio-lock-pin-key-${digit}`);
        await sleep(60);
      }
    };

    const shot = async (name) => {
      if (!WANT_SHOTS) return;
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const file = path.join(HERE, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`       screenshot: ${file}`);
    };

    // ── 1. 只有 PIN 的设备（没有生物识别凭据）──────────────────────────
    console.log("PIN-only device");
    await goto(BASE);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-pin-pad\"]')"), {
      label: "PIN pad",
    });
    const pinOnly = await evalInPage(`JSON.stringify({
      pad: !!document.querySelector('[data-testid="bio-lock-pin-pad"]'),
      retry: !!document.querySelector('[data-testid="bio-lock-retry"]'),
      bio: !!document.querySelector('[data-testid="bio-lock-use-biometric"]'),
      back: !!document.querySelector('[data-testid="bio-lock-back-to-login"]'),
      app: !!document.querySelector('#app-content'),
      dots: document.querySelectorAll('.bio-pin__dot').length
    })`);
    const pinOnlyState = JSON.parse(pinOnly);
    record(
      "1. 没有生物识别凭据时，锁屏直接是 PIN 键盘（不是“重试指纹”）",
      pinOnlyState.pad && !pinOnlyState.retry && !pinOnlyState.app,
      pinOnly,
    );
    record("1b. 键盘位数 = 4 位（与设置的位数一致）", pinOnlyState.dots === 4, pinOnly);
    record("1c. 有“返回登录”出口", pinOnlyState.back === true, pinOnly);
    await shot("pin-lock-pin-only.png");

    // ── 2. 错 PIN → 报错 + 清空 + 仍然锁着 ────────────────────────────
    await typePin("0001");
    const wrong = await waitFor(
      async () =>
        evalInPage(`(() => {
          const el = document.querySelector('.bio-pin__status');
          const text = el ? el.textContent.trim() : '';
          return text ? text : '';
        })()`),
      { label: "PIN error text" },
    );
    const afterWrong = JSON.parse(
      await evalInPage(`JSON.stringify({
        filled: Number(document.querySelector('[data-testid="bio-lock-pin-dots"]').dataset.filled),
        app: !!document.querySelector('#app-content')
      })`),
    );
    record("2. 错 PIN → 出错误提示", Boolean(wrong), JSON.stringify(wrong));
    record("2b. 错 PIN → 点阵清空、仍锁着", afterWrong.filled === 0 && !afterWrong.app, JSON.stringify(afterWrong));
    await shot("pin-lock-wrong-pin.png");

    // ── 3. 对 PIN → 放行 ─────────────────────────────────────────────
    await typePin("4821");
    const unlocked = await waitFor(
      async () => evalInPage("!!document.querySelector('#app-content')"),
      { label: "gate unlock", timeout: 15000 },
    ).catch(() => false);
    record("3. 对 PIN → 换会话成功、门禁放行（渲染出 App 内容）", unlocked === true);

    // ── 4. 「返回登录」 ───────────────────────────────────────────────
    await goto(BASE);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-back-to-login\"]')"), {
      label: "back-to-login button",
    });
    await tap("bio-lock-back-to-login");
    const navigated = await waitFor(
      async () => evalInPage("document.querySelector('#harness-hud')?.dataset.path === '/login'"),
      { label: "route /login", timeout: 8000 },
    ).catch(() => false);
    const released = await evalInPage("!!document.querySelector('#app-content')");
    // 注意：「返回登录」会把门禁切成 disabled（与原来那个“用密码登录”按钮同一行为）——
    // 路由这时已经在 /login 上，所以看到的是登录页而不是 App。
    // 这里断言的是**路由**，`released` 只当参考值打出来。
    record("4. 「返回登录」→ 跳到 /login", navigated === true, `released=${released}`);

    // ── 5. 同时有生物识别凭据的设备 ────────────────────────────────────
    console.log("device with a biometric credential too");
    await goto(`${BASE}?bio=1`);
    // 自动弹一次会被取消（上面的 handleJavaScriptDialog）→ 卡片变成“未能识别，请重试”
    await waitFor(
      async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-use-pin\"]')"),
      { label: "biometric card with PIN fallback" },
    ).catch(async () => {
      const dump = await evalInPage(
        "document.querySelector('.bio-lock__card')?.innerText?.slice(0, 300) || '(no card)'",
      );
      throw new Error(`biometric card never rendered; card text = ${dump}`);
    });
    const both = JSON.parse(
      await evalInPage(`JSON.stringify({
        retry: !!document.querySelector('[data-testid="bio-lock-retry"]'),
        usePin: !!document.querySelector('[data-testid="bio-lock-use-pin"]'),
        back: !!document.querySelector('[data-testid="bio-lock-back-to-login"]'),
        pad: !!document.querySelector('[data-testid="bio-lock-pin-pad"]'),
        title: document.querySelector('.bio-lock__title')?.textContent?.trim() || ''
      })`),
    );
    record(
      "5. 有生物识别时：主卡片仍是生物识别，并同时给出「用 PIN 解锁」与「返回登录」",
      both.retry && both.usePin && both.back && !both.pad,
      JSON.stringify(both),
    );
    await shot("pin-lock-both.png");

    await tap("bio-lock-use-pin");
    const padAfterTap = await waitFor(
      async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-pin-pad\"]')"),
      { label: "PIN pad after tapping use-PIN", timeout: 8000 },
    ).catch(() => false);
    const backToBio = await evalInPage("!!document.querySelector('[data-testid=\"bio-lock-use-biometric\"]')");
    record("6. 点「用 PIN 解锁」→ 出键盘，且能回生物识别", padAfterTap === true && backToBio === true);
    await shot("pin-lock-pad-from-bio.png");
  } catch (error) {
    console.error(`\nharness error: ${error?.message || error}`);
    process.exitCode = 2;
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
}

await main();
