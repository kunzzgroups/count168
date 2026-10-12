import { useCallback, useState } from "react";
import {
  getDeviceId,
  getDeviceName,
  loadToken,
  withTimeout,
} from "../../lib/biometricStore.js";
import { registerDeviceToken, revokeDeviceToken } from "../../lib/deviceTokenApi.js";
import { PIN_LENGTHS, createPin, readPinSettings } from "../../lib/pinStore.js";
import { pinFormat, pinText } from "../../translateFile/pinTranslate.js";
import PinPad from "./PinPad.jsx";

/**
 * 设置 / 修改 PIN。三处共用：
 *   · 设置页的那一行
 *   · 登录成功后的引导（这台设备没有生物识别时，改问 PIN）
 *   · 以后若加「PIN 过期后重设」
 *
 * ── 令牌从哪来（关键，改动前先读完）────────────────────────────────
 *
 * PIN 加密的**就是那张设备令牌**，所以设置 PIN 时必须先有一张：
 *
 *   本机已有（指纹用户在用）→ **复用**，绝不重新签发
 *   本机没有（没指纹/人脸）→ 走 registerDeviceToken 新签一张
 *
 * 为什么绝不在已有令牌时重新签发：
 * 服务端按 (user, device_id, kind) **同一行**处理（`ON DUPLICATE KEY UPDATE`，
 * 见 includes/device_token.php 的 device_token_issue），重新签发会把这把
 * 正在用的令牌换掉 —— 用户下次用指纹就变成「此设备已失效」。
 *
 * 新签发的令牌**只存在于 PIN 密文里**，不回写 Keystore：
 * 回写就等于「没指纹的人也有了明文凭据」，那正是我们要避免的状态。
 */

/** pinStore 的错误码 → 用户能看懂的一句话 */
function messageFor(code, t) {
  switch (code) {
    case "TOO_SIMPLE":
      return t.setupTooSimple;
    case "BAD_FORMAT":
      return t.setupBadFormat;
    case "NO_CRYPTO":
      return t.setupNoCrypto;
    case "DEVICE_LIMIT":
      return t.setupDeviceLimit;
    default:
      return t.setupSaveFailed;
  }
}

/**
 * @param {{lang: string}} params
 */
export function usePinSetup({ lang } = {}) {
  const t = pinText(lang);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("set"); // "set" | "change"
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState(() => readPinSettings());

  const refresh = useCallback(() => setState(readPinSettings()), []);

  const openSetup = useCallback((nextMode = "set") => {
    setMode(nextMode === "change" ? "change" : "set");
    setError("");
    setBusy(false);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setBusy(false);
    setError("");
  }, []);

  /**
   * 保存 PIN。
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  const save = useCallback(
    async (pin, len) => {
      setBusy(true);
      setError("");
      try {
        let token = await withTimeout(loadToken(), 4000);
        let issued = false;

        if (typeof token !== "string" || !token) {
          const registered = await registerDeviceToken({
            deviceId: getDeviceId(),
            deviceName: getDeviceName(),
          });
          if (!registered.ok) {
            setBusy(false);
            setError(messageFor(registered.code, t));
            return { ok: false, code: registered.code || "REGISTER_FAILED" };
          }
          token = registered.token;
          issued = true;
        }

        const created = await createPin({ pin, token, len });
        if (!created.ok) {
          // 为了这一步专门签发的令牌，失败就立刻回收 —— 否则它既不落在本机、
          // 又占着服务端一条记录，用户永远不知道它存在。
          if (issued) await revokeDeviceToken({ deviceId: getDeviceId() });
          setBusy(false);
          setError(messageFor(created.code, t));
          return { ok: false, code: created.code };
        }

        setBusy(false);
        setError("");
        setOpen(false);
        refresh();
        return { ok: true };
      } catch {
        setBusy(false);
        setError(t.setupSaveFailed);
        return { ok: false, code: "EXCEPTION" };
      }
    },
    [refresh, t],
  );

  return { open, mode, busy, error, state, openSetup, close, save, refresh };
}

/**
 * 键盘本体（**不含**遮罩/卡片）：引导弹窗与设置页弹窗两个外壳共用它。
 *
 * 两轮输入：输一次 → 再输一次。不一致就回到第一轮并说明原因 ——
 * 这正是用户自己改错一位时唯一能自查的手段。
 */
export function PinSetupPanel({
  lang,
  noBiometric = false,
  title,
  busy = false,
  error = "",
  onCancel,
  cancelLabel,
  onSubmit,
}) {
  const t = pinText(lang);
  const [len, setLen] = useState(PIN_LENGTHS[0]);
  const [round, setRound] = useState("enter");
  const [first, setFirst] = useState("");
  const [localError, setLocalError] = useState("");

  const reset = () => {
    setRound("enter");
    setFirst("");
  };

  const handle = (pin) => {
    setLocalError("");
    if (round === "enter") {
      setFirst(pin);
      setRound("confirm");
      return;
    }
    if (pin !== first) {
      reset();
      setLocalError(t.setupMismatch);
      return;
    }
    void onSubmit?.(pin, len);
  };

  const hint =
    round === "enter"
      ? noBiometric
        ? t.setupBodyNoBiometric
        : t.setupBody
      : t.setupConfirm;

  return (
    <div className="pin-setup" data-testid="pin-setup">
      <div className="sc-login-modal-icon-wrap">
        <i className="fas fa-key sc-login-modal-icon" aria-hidden="true" />
      </div>
      <h3 className="sc-login-modal-title">{title || t.setupTitle}</h3>
      <p className="sc-login-modal-message">{hint}</p>

      {/* 位数：产品要求 4 位或 6 位，由用户自选。第一轮才给选（第二轮改位数会前后不一致） */}
      {round === "enter" ? (
        <div className="pin-setup__lengths" role="group" aria-label={t.setupLength}>
          {PIN_LENGTHS.map((value) => (
            <button
              key={value}
              type="button"
              className={`pin-setup__length${len === value ? " is-on" : ""} tap-scale`}
              aria-pressed={len === value}
              aria-label={pinFormat(t.lenAria, { len: value })}
              onClick={() => {
                setLen(value);
                reset();
                setLocalError("");
              }}
              disabled={busy}
              data-testid={`pin-setup-len-${value}`}
            >
              {value === 4 ? t.len4 : t.len6}
            </button>
          ))}
        </div>
      ) : null}

      <PinPad
        len={len}
        busy={busy}
        lang={lang}
        error={localError || error}
        hint={busy ? t.pinBusy : ""}
        onSubmit={handle}
        testId="pin-setup"
      />

      {onCancel ? (
        <button
          type="button"
          className="sc-login-btn sc-login-btn--ghost"
          onClick={onCancel}
          disabled={busy}
          data-testid="pin-setup-cancel"
        >
          {cancelLabel || t.cancel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 设置页用的独立弹窗（沿用登录页那套 `sc-login-modal-*` 样式，
 * 目的是“弹窗”在这个 App 里长得都一样，不另发明一套）。
 */
export function PinSetupModal({ open, mode, busy, error, lang, onSubmit, onClose }) {
  const t = pinText(lang);
  if (!open) return null;

  return (
    <div className="sc-login-modal-overlay sc-login-modal-overlay--pin is-open" aria-hidden="false">
      <div
        className="sc-login-modal-box sc-login-modal-box--pin"
        role="dialog"
        aria-label={mode === "change" ? t.changeTitle : t.setupTitle}
      >
        <PinSetupPanel
          lang={lang}
          title={mode === "change" ? t.changeTitle : t.setupTitle}
          busy={busy}
          error={error}
          onCancel={onClose}
          cancelLabel={t.cancel}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
