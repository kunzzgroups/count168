/**
 * Dev-only harness for the startup lock screen (`src/components/lock/BiometricLockGate.jsx`)
 * and the PIN pad (`src/components/lock/PinPad.jsx`).
 *
 * Why it exists: the lock screen only ever renders inside the **Android shell**
 * (`isNative()`), so it cannot be opened from a normal browser session — and the two things
 * this change is about (a PIN that unlocks *without* biometrics, plus the "back to login"
 * way out) can only be judged by looking at the real card.
 *
 * What it fakes (and nothing else):
 *   · `window.androidBridge` — the real test for "am I in the Capacitor shell"
 *   · a device token in `localStorage` under the plugin's own web prefix (`?bio=1`)
 *   · `device_login_api.php` — answers success, because there is no PHP here
 *
 * Everything else is the real code: real localStorage, real WebCrypto (PBKDF2 + AES-GCM),
 * real `pinStore`, real gate, real keypad.
 *
 *   /dev-harness/pin-lock.html          → PIN-only device (no biometric credential at all)
 *   /dev-harness/pin-lock.html?bio=1    → both available (biometric card, PIN as the fallback)
 *   &pin=4821&len=4                     → the PIN the harness enrols
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { BiometricAuth, BiometryType } from "@aparajita/capacitor-biometric-auth";
import BiometricLockGate from "../src/components/lock/BiometricLockGate.jsx";
import { PinSetupModal } from "../src/components/lock/PinSetupModal.jsx";
import { clearPin, createPin } from "../src/lib/pinStore.js";
import "../src/styles/tokens.css";
import "../src/styles/login.css";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const PIN = params.get("pin") || "4821";
const LEN = Number(params.get("len") || 4);
const WITH_BIOMETRIC = params.get("bio") === "1";
/** 只挂「设置 PIN」的弹窗（见下面 SetupHarness 的说明） */
const SETUP_ONLY = params.get("setup") === "1";

/** 64 hex —— 与 includes/device_token.php 里签发的形状一致 */
const DEVICE_TOKEN = "b".repeat(64);

/** 真实环境的判据：只有原生桥在，`isNative()` 才是 true */
window.androidBridge = window.androidBridge || {};

/** 插件 web 实现的前缀（见 node_modules/@aparajita/capacitor-secure-storage/dist/esm/base.js） */
const SECURE_PREFIX = "capacitor-storage_";
const TOKEN_KEY = `${SECURE_PREFIX}count168_biometric_device_token`;

/** 换会话的桩：真机上由 PHP 回这个形状 */
window.fetch = async (url) => {
  const body = String(url);
  if (body.includes("device_login_api.php")) {
    return new Response(
      JSON.stringify({ status: "success", redirect: "/dashboard", user_type: "user" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (body.includes("device_token_revoke_api.php") || body.includes("device_token_register_api.php")) {
    return new Response(JSON.stringify({ status: "success", token: DEVICE_TOKEN }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

/** 角落里的当前路由 —— 「返回登录」这个按钮无法从锁屏上看出结果，用它断言 */
function Hud() {
  const loc = useLocation();
  return (
    <div
      id="harness-hud"
      data-path={loc.pathname}
      style={{
        position: "fixed",
        right: 6,
        bottom: 6,
        zIndex: 100000,
        font: "11px/1.4 monospace",
        color: "#fff",
        background: "rgba(0,0,0,.55)",
        padding: "2px 6px",
        borderRadius: 6,
        pointerEvents: "none",
      }}
    >
      path={loc.pathname}
    </div>
  );
}

/**
 * 只挂设置 PIN 的弹窗（设置页那一个）。
 *
 * 它只有在原生壳里、登录之后才能打开，所以离开这个 harness 就看不到 ——
 * 而它比原来的弹窗高得多（多了整张键盘），小屏上「取消」会不会被挤出屏是必须看的。
 */
function SetupHarness() {
  return (
    <PinSetupModal
      open
      mode="set"
      busy={false}
      error=""
      lang="zh"
      onSubmit={(pin, len) => {
        // 给 CDP 循环读的落点：真机上这一步是“签发令牌 + 加密存起来”
        window.__setupResult = { pin, len };
      }}
      onClose={() => {
        window.__setupClosed = true;
      }}
    />
  );
}

function Harness() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      localStorage.clear();
      try {
        sessionStorage.clear();
      } catch {
        /* 无所谓 */
      }
      if (WITH_BIOMETRIC) {
        // ⚠️ 必须是 JSON 字符串（带引号）：插件的读路径会 JSON.parse，
        // 直接塞裸 hex 会解析失败→被当成“没有凭据”。
        // 真机上的 loadToken 之所以写那段宽容提取，就是因为它读到的可能带引号。
        localStorage.setItem(TOKEN_KEY, JSON.stringify(DEVICE_TOKEN));
        /**
         * 让“这台设备有指纹”这件事成立。
         *
         * 插件在 web 上提供 setBiometryType / setBiometryIsEnrolled 两个**模拟接口**，
         * 这是唯一能让能力探测说“有生物识别”的办法（真机走原生）。
         * 不设的话探测结果是 NOT_ENROLLED，锁屏会直接给出 PIN 键盘 ——
         * 那是另一种场景，已经在前面的检查里覆盖过了。
         */
        if (typeof BiometricAuth.setBiometryType === "function") {
          await BiometricAuth.setBiometryType(BiometryType.fingerprintAuthentication);
          await BiometricAuth.setBiometryIsEnrolled(true);
        }
      }
      await clearPin();
      await createPin({ pin: PIN, len: LEN, token: DEVICE_TOKEN });
      setReady(true);
    })();
  }, []);

  if (!ready) return <div id="harness-loading">seeding…</div>;
  if (SETUP_ONLY) return <SetupHarness />;

  return (
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Hud />
      <BiometricLockGate>
        <div id="app-content" style={{ padding: 24, font: "16px/1.5 sans-serif" }}>
          APP CONTENT
        </div>
      </BiometricLockGate>
    </MemoryRouter>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
