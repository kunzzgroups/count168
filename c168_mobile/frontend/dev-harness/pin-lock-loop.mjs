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
/** 与 dev-harness/pin-lock-harness.jsx 的种子一致：产品默认 6 位 */
const SEED_PIN = "482917";
const SEED_LEN = SEED_PIN.length;
const WRONG_PIN = "000111";
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
        async () =>
          evalInPage(
            "!!document.querySelector('.bio-lock, #app-content, #harness-loading, #offer-harness, [data-testid=\"pin-setup\"]')",
          ),
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
    record(
      `1b. 键盘位数 = ${SEED_LEN}（产品默认 6 位，与设置的位数一致）`,
      pinOnlyState.dots === SEED_LEN,
      pinOnly,
    );
    record("1c. 有“返回登录”出口", pinOnlyState.back === true, pinOnly);
    await shot("pin-lock-pin-only.png");

    // ── 2. 错 PIN → 报错 + 清空 + 仍然锁着 ────────────────────────────
    await typePin(WRONG_PIN);
    const wrong = await waitFor(
      async () =>
        evalInPage(`(() => {
          const el = document.querySelector('.bio-pin__status');
          const text = el ? el.textContent.trim() : '';
          return text ? text : '';
        })()`),
      { label: "PIN error text" },
    );
    // 等一下再读：清空与报错是同一批状态更新，但截图/读 DOM 太快会拍到中间帧
    await sleep(500);
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
    await typePin(SEED_PIN);
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

    // 只跳路由是不够的：登录页一挂载就查会话，会话还活着的话会被直接弹回 App
    //（实机：iOS 上点 Back to login 直接进去了）。所以必须真的结束会话。
    const backState = JSON.parse(
      await evalInPage(`JSON.stringify({
        logout: (window.__fetchLog || []).filter((u) => u.includes('logout_api.php')).length,
        skipPasskey: sessionStorage.getItem('ec_skip_passkey_autologin_once'),
        pinKept: localStorage.getItem('ec_pin_unlock') ? 'kept' : 'gone'
      })`),
    );
    record(
      "4b. 「返回登录」真的结束了会话（调了 logout_api）并禁掉本次 passkey 自动登录",
      backState.logout >= 1 && backState.skipPasskey === "1",
      JSON.stringify(backState),
    );
    record(
      "4c. 同时**没有**连坐清掉本地解锁凭据（PIN 记录还在，下次冷启动照样能解）",
      backState.pinKept === "kept",
      JSON.stringify(backState),
    );

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

    // ── 7. 连错 5 次：PIN 被清掉，界面自动收回键盘并只剩密码这条路 ─────
    console.log("too many wrong PINs");
    await goto(BASE);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-pin-pad\"]')"), {
      label: "PIN pad (locked-out check)",
    });
    for (let i = 0; i < 5; i += 1) {
      await typePin(WRONG_PIN);
      await sleep(450);
    }
    const afterLockout = await waitFor(
      async () =>
        evalInPage(`(() => {
          const card = document.querySelector('.bio-lock__card');
          if (!card) return false;
          const text = card.innerText || '';
          return text.includes('turned off') ? text : false;
        })()`),
      { label: "locked-out message", timeout: 10000 },
    ).catch(() => false);
    const lockoutState = JSON.parse(
      await evalInPage(`JSON.stringify({
        pad: !!document.querySelector('[data-testid="bio-lock-pin-pad"]'),
        loginBtn: !!document.querySelector('[data-testid="bio-lock-back-to-login"]'),
        app: !!document.querySelector('#app-content'),
        pinRecord: localStorage.getItem('ec_pin_unlock')
      })`),
    );
    record(
      "7. 连错 5 次 → PIN 被清、键盘收回、只剩登录（且仍未放行）",
      lockoutState.pad === false &&
        lockoutState.loginBtn === true &&
        lockoutState.app === false &&
        lockoutState.pinRecord === null,
      `${JSON.stringify(lockoutState)} msg=${JSON.stringify(afterLockout)}`,
    );
    await shot("pin-lock-locked-out.png");

    // ── 8. 设置 PIN 的弹窗（两轮输入 + 4/6 位切换）─────────────────────
    console.log("set-up-PIN modal");
    await goto(`${BASE}?setup=1`);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"pin-setup\"]')"), {
      label: "PIN setup modal",
    });
    const setupInitial = JSON.parse(
      await evalInPage(`JSON.stringify({
        dots: document.querySelectorAll('[data-testid="pin-setup-dots"] .bio-pin__dot').length,
        cancel: !!document.querySelector('[data-testid="pin-setup-cancel"]'),
        overflow: document.documentElement.scrollHeight > window.innerHeight,
        cancelVisible: (() => {
          const el = document.querySelector('[data-testid="pin-setup-cancel"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        })()
      })`),
    );
    record(
      `8. 弹窗默认 ${SEED_LEN} 位（产品默认），取消按钮在小屏（390×844）上看得到`,
      setupInitial.dots === SEED_LEN && setupInitial.cancel === true && setupInitial.cancelVisible === true,
      `${JSON.stringify(setupInitial)}（overflow=页面高于视口，弹窗内可滚动）`,
    );
    await shot("pin-setup-6.png");

    // 4 位仍然可选
    await tap("pin-setup-len-4");
    const fourDots = await evalInPage(
      `document.querySelectorAll('[data-testid="pin-setup-dots"] .bio-pin__dot').length`,
    );
    record("8b. 切到 4 位 → 点阵变 4 个（4 位仍然可选）", fourDots === 4, `dots=${fourDots}`);

    const typeSetupPin = async (pin) => {
      for (const digit of pin) {
        await tap(`pin-setup-key-${digit}`);
        await sleep(50);
      }
      await sleep(150);
    };

    // 两次不一致 → 回到第一轮并说明原因，绝不能提交
    await typeSetupPin("9081");
    await typeSetupPin("9082");
    const mismatch = await waitFor(
      async () =>
        evalInPage(
          "document.querySelector('[data-testid=\"pin-setup-pad\"] .bio-pin__status')?.textContent?.trim() || ''",
        ),
      { label: "mismatch text" },
    );
    const submittedAfterMismatch = await evalInPage("!!window.__setupResult");
    record(
      "8c. 两次不一致 → 报错、不提交",
      Boolean(mismatch) && submittedAfterMismatch === false,
      `msg=${JSON.stringify(mismatch)} submitted=${submittedAfterMismatch}`,
    );

    // 两次一致 → 交给调用方（真机上是签发令牌 + 加密保存）
    await typeSetupPin("9081");
    await typeSetupPin("9081");
    const submitted = await waitFor(async () => evalInPage("JSON.stringify(window.__setupResult || null)"), {
      label: "setup submit",
    });
    record(
      "8d. 两次一致 → 交出 (pin, len)",
      submitted === JSON.stringify({ pin: "9081", len: 4 }),
      submitted,
    );

    // ── 9. 旧的 4 位 PIN 照样能开（位数是用户选的，不是写死的）────────
    console.log("4-digit PIN still works");
    await goto(`${BASE}?pin=4821&len=4`);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-pin-pad\"]')"), {
      label: "4-digit PIN pad",
    });
    const fourState = await evalInPage(
      `document.querySelectorAll('.bio-pin__dot').length`,
    );
    await typePin("4821");
    const fourUnlocked = await waitFor(
      async () => evalInPage("!!document.querySelector('#app-content')"),
      { label: "4-digit unlock", timeout: 15000 },
    ).catch(() => false);
    record(
      "9. 4 位 PIN：点阵 4 个并且能解开（老用户不会被默认值改动挡住）",
      fourState === 4 && fourUnlocked === true,
      `dots=${fourState} unlocked=${fourUnlocked}`,
    );

    // ── 10. iOS / 网页：设过 PIN 就要锁，且能解开 ──────────────────
    console.log("iOS / web path");
    await goto(`${BASE}?web=1`);
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"bio-lock-pin-pad\"]')"), {
      label: "web PIN pad",
    }).catch(async () => {
      const dump = await evalInPage("document.body.innerText.slice(0, 200)");
      throw new Error(`web 端设了 PIN 却没锁；页面文本 = ${dump}`);
    });
    const webState = JSON.parse(
      await evalInPage(`JSON.stringify({
        pad: !!document.querySelector('[data-testid="bio-lock-pin-pad"]'),
        retry: !!document.querySelector('[data-testid="bio-lock-retry"]'),
        app: !!document.querySelector('#app-content')
      })`),
    );
    await typePin(SEED_PIN);
    const webUnlocked = await waitFor(
      async () => evalInPage("!!document.querySelector('#app-content')"),
      { label: "web unlock", timeout: 15000 },
    ).catch(() => false);
    record(
      "10. iOS/网页：设过 PIN → 启动就锁（PIN 盘，无生物识别入口）且能解开",
      webState.pad === true && webState.retry === false && webState.app === false && webUnlocked === true,
      `${JSON.stringify(webState)} unlocked=${webUnlocked}`,
    );

    // ── 11. iOS / 网页：**没**设 PIN 的用户行为必须一点没变（不锁） ──
    await goto(`${BASE}?web=1&nopin=1`);
    const noPinState = await waitFor(
      async () =>
        evalInPage(`(() => {
          const app = !!document.querySelector('#app-content');
          const pad = !!document.querySelector('[data-testid="bio-lock-pin-pad"]');
          const lock = !!document.querySelector('.bio-lock');
          if (app || pad || lock) return JSON.stringify({ app, pad, lock });
          // 还没渲染完就先返回 false（不把“空白”当成“没锁”）
          return document.querySelector('.bio-lock, #app-content, #harness-loading')
            ? JSON.stringify({ app, pad, lock })
            : false;
        })()`),
      { label: "web without PIN", timeout: 15000 },
    );
    const parsedNoPin = JSON.parse(noPinState);
    record(
      "11. iOS/网页：没设 PIN → 不锁，行为与改动前一致（passkey 那条路不受影响）",
      parsedNoPin.app === true && parsedNoPin.pad === false && parsedNoPin.lock === false,
      noPinState,
    );
    // ── 12. iOS 登录后的引导（走登录页那条路：**不传**任何 prop）────────
    console.log("iOS post-login offer");
    await goto(`${BASE}?web=1&nopin=1&offer=1&standalone=1`);
    await waitFor(async () => evalInPage("window.__offerResult !== undefined"), {
      label: "offer() resolved",
    });
    const offerOpened = await evalInPage("window.__offerResult");
    const offerPanel = await waitFor(
      async () =>
        evalInPage(`(() => {
          const el = document.querySelector('[data-testid="pin-setup"]');
          if (!el) return false;
          return el.innerText || false;
        })()`),
      { label: "PIN setup panel from the offer", timeout: 10000 },
    ).catch(() => false);
    record(
      "12. iOS（独立 App）：登录后弹出「设置 PIN」引导（页面一个 prop 都没传也能弹）",
      offerOpened === true && Boolean(offerPanel),
      `offer()=${offerOpened} panel=${JSON.stringify(String(offerPanel).slice(0, 80))}`,
    );
    record(
      "12b. 独立 App 的文案说的是 Face ID 用不了（不是“这台手机没有人脸”）",
      typeof offerPanel === "string" && offerPanel.includes("Face ID") && !offerPanel.includes("no fingerprint or face"),
      JSON.stringify(String(offerPanel).slice(0, 200)),
    );
    await shot("pin-offer-ios.png");

    // ── 13. 输两遍 PIN → 真的存下来并跳转（验证 pendingOffer 的兜底回调）───
    const typeOfferPin = async (pin) => {
      for (const digit of pin) {
        await tap(`pin-setup-key-${digit}`);
        await sleep(50);
      }
      await sleep(150);
    };
    await typeOfferPin(SEED_PIN);
    await typeOfferPin(SEED_PIN);
    const offerSaved = await waitFor(
      async () =>
        evalInPage(`JSON.stringify({
          pin: localStorage.getItem('ec_pin_unlock') ? 'saved' : 'missing',
          done: window.__enrolDone || ''
        })`),
      { label: "PIN saved by the offer", timeout: 15000 },
    ).catch(() => "(timeout)");
    const parsedOffer = JSON.parse(offerSaved === "(timeout)" ? '{"pin":"timeout","done":""}' : offerSaved);
    record(
      "13. 输两遍后 PIN 真的落库并跳到目标页（登录页靠的就是这条兜底回调）",
      parsedOffer.pin === "saved" && parsedOffer.done === "/dashboard",
      offerSaved,
    );

    // ── 14. 「暂不开启」是持久的：不再反复问 ─────────────────────────
    await goto(`${BASE}?web=1&nopin=1&offer=1&standalone=1`);
    await waitFor(async () => evalInPage("window.__offerResult !== undefined"), {
      label: "offer() resolved (skip path)",
    });
    await waitFor(async () => evalInPage("!!document.querySelector('[data-testid=\"pin-setup-cancel\"]')"), {
      label: "PIN offer cancel button",
    });
    await tap("pin-setup-cancel");
    await sleep(300);
    const skipState = JSON.parse(
      await evalInPage(`(async () => JSON.stringify({
        optout: localStorage.getItem('ec_bio_prompt_optout'),
        again: await window.__offerAgain()
      }))()`),
    );
    record(
      "14. 「暂不开启」→ 记住拒绝，再 offer 一次不再弹",
      skipState.optout === "1" && skipState.again === false,
      JSON.stringify(skipState),
    );
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
