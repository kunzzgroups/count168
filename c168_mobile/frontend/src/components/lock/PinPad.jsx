import { useCallback, useEffect, useRef, useState } from "react";
import { pinFormat, pinText } from "../../translateFile/pinTranslate.js";

/**
 * PIN 键盘（锁屏输入 / 设置 / 修改 三处共用同一个组件）。
 *
 * 为什么自己画键盘、不用 <input type="password" inputMode="numeric">：
 *
 *   1. 系统数字键盘高度不可控，锁屏卡片会被顶出可视区（上面的按钮点不到）；
 *   2. 安卓 IME 会在 input 上做候选/记忆，而这是**解锁码**，不该进任何输入法历史；
 *   3. 位数固定，输满即自动校验 —— 少一次「确认」点击，也少一次“密码可见”的争论。
 *
 * 仍然接受物理键盘（数字 / Backspace / Enter）：桌面排查与开发环境要靠它，
 * 而且真机上外接键盘的用户也能用。
 *
 * @param {object} props
 * @param {number} props.len       位数（4 或 6）
 * @param {boolean} [props.busy]   校验中（此刻必须屏蔽输入，否则会并发提交两次）
 * @param {string} [props.error]   错误文案（显示在点阵下方，同时触发一次抖动）
 * @param {string} [props.hint]    正常状态下的说明（输入中）
 * @param {(pin: string) => (boolean|Promise<boolean>|void)} props.onSubmit
 *        输满后自动调用。返回 false 表示“没通过”，键盘会清空重来；
 *        返回 true / 不返回 → 也清空（锁屏成功后组件就被卸载了）。
 * @param {string} [props.lang]    zh | en
 * @param {string} [props.testId]  给 dev-harness 用的钩子前缀
 */
export default function PinPad({ len, busy = false, error = "", hint = "", onSubmit, lang, testId = "pin" }) {
  const t = pinText(lang);
  const length = Number(len) > 0 ? Number(len) : 4;
  const [value, setValue] = useState("");
  const [shake, setShake] = useState(false);
  /** 防止“输满的那一下”与上一次提交并发（慢速设备上 PBKDF2 要几百毫秒） */
  const submitting = useRef(false);

  // 出错就抖一下：不用看文字也知道“刚才那下没成”
  useEffect(() => {
    if (!error) return undefined;
    setShake(true);
    const timer = setTimeout(() => setShake(false), 420);
    return () => clearTimeout(timer);
  }, [error]);

  const submit = useCallback(
    async (pin) => {
      if (submitting.current) return;
      submitting.current = true;
      try {
        await onSubmit?.(pin);
      } finally {
        submitting.current = false;
        // 无论结果如何都清空：成功的会跳走，失败的要用户重输
        setValue("");
      }
    },
    [onSubmit],
  );

  const push = useCallback(
    (digit) => {
      if (busy || submitting.current) return;
      setValue((prev) => {
        if (prev.length >= length) return prev;
        const next = prev + digit;
        if (next.length === length) void submit(next);
        return next;
      });
    },
    [busy, length, submit],
  );

  const back = useCallback(() => {
    if (busy) return;
    setValue((prev) => prev.slice(0, -1));
  }, [busy]);

  // 物理键盘支持（桌面 / 外接键盘）。用 window 监听：焦点在哪个按钮上都管用。
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        push(event.key);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, push]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="bio-pin" data-testid={`${testId}-pad`}>
      <div
        className={`bio-pin__dots${shake ? " is-shaking" : ""}`}
        data-testid={`${testId}-dots`}
        data-filled={value.length}
        aria-hidden="true"
        key={`dots-${length}`}
      >
        {Array.from({ length }).map((_, index) => (
          <span key={index} className={`bio-pin__dot${index < value.length ? " is-on" : ""}`} />
        ))}
      </div>

      {/* 已输入位数：给读屏用户一个可听的进度（点阵对他们是不可见的） */}
      <p className="bio-pin__status" role="status" aria-live="polite">
        {error || hint || ""}
      </p>

      <div className="bio-pin__grid">
        {keys.map((digit) => (
          <button
            key={digit}
            type="button"
            className="bio-pin__key tap-scale"
            onClick={() => push(digit)}
            disabled={busy}
            aria-label={pinFormat(t.keyAria, { digit })}
            data-testid={`${testId}-key-${digit}`}
          >
            {digit}
          </button>
        ))}
        <span className="bio-pin__key bio-pin__key--spacer" aria-hidden="true" />
        <button
          type="button"
          className="bio-pin__key tap-scale"
          onClick={() => push("0")}
          disabled={busy}
          aria-label={pinFormat(t.keyAria, { digit: 0 })}
          data-testid={`${testId}-key-0`}
        >
          0
        </button>
        <button
          type="button"
          className="bio-pin__key bio-pin__key--delete tap-scale"
          onClick={back}
          disabled={busy}
          aria-label={t.keyDelete}
          data-testid={`${testId}-key-del`}
        >
          <i className="fas fa-delete-left" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
