import { forwardRef, useState } from "react";

export function PasswordVisibilityIcon({ visible }) {
  return (
    <span className="ec-password-toggle-icon" aria-hidden="true">
      <svg
        className={`ec-password-toggle-icon__show${visible ? "" : " is-active"}`}
        viewBox="0 0 24 24"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M12 5c-5.5 0-9.5 4.7-10.8 7 1.3 2.3 5.3 7 10.8 7s9.5-4.7 10.8-7C21.5 9.7 17.5 5 12 5zm0 11.5A4.5 4.5 0 1 1 16.5 12 4.5 4.5 0 0 1 12 16.5zm0-7A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5z"
        />
      </svg>
      <svg
        className={`ec-password-toggle-icon__hide${visible ? " is-active" : ""}`}
        viewBox="0 0 24 24"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M3.3 2.6 2 4l3 3.1C3.5 8.4 2.2 10 1.2 12c1.3 2.3 5.3 7 10.8 7 2 0 3.8-.6 5.4-1.5l2.8 2.8 1.3-1.4-17-17.1zM12 17.5c-4.2 0-7.6-3.2-9-5.5.7-1.2 1.8-2.7 3.2-4l1.8 1.8A4.48 4.48 0 0 0 12 16.5c.6 0 1.2-.1 1.7-.4l1.6 1.6c-.9.2-1.9.3-2.9.3zm9.8-5.5c-.5-.9-1.2-1.9-2-2.8l-1.5 1.5c.7.8 1.3 1.6 1.8 2.3-1.3 2.3-5.3 7-10.8 7-.8 0-1.5-.1-2.2-.2l-1.8 1.8c1.2.4 2.5.7 4 .7 5.5 0 9.5-4.7 10.8-7 .4-.7.7-1.4.9-2.1l2.8 2.8 1.3-1.4-4.3-4.3z"
        />
      </svg>
    </span>
  );
}

const PasswordInput = forwardRef(function PasswordInput(
  {
    value,
    onChange,
    visible: visibleProp,
    onVisibleChange,
    defaultVisible = false,
    showLabel = "Show password",
    hideLabel = "Hide password",
    className = "",
    wrapClassName = "",
    disabled = false,
    ...rest
  },
  ref,
) {
  const [uncontrolledVisible, setUncontrolledVisible] = useState(defaultVisible);
  const isControlled = visibleProp !== undefined;
  const visible = isControlled ? Boolean(visibleProp) : uncontrolledVisible;

  function setVisible(next) {
    if (!isControlled) setUncontrolledVisible(next);
    onVisibleChange?.(next);
  }

  return (
    <div className={`ec-password-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`}>
      {/* 隐藏时用原生 type="password"，而不是永远 type="text"。
          为何：安卓上 type=text 会让输入法继续处于文本模式 —— 中文候选条、
          自动首字母大写、自动更正全都还在，密码会被转成汉字 / 首字母变大写，
          用户只看到“登录失败”（不同输入法表现不同，所以是“一部分用户”）。
          用原生 password 类型后系统会切到安全输入模式：无候选、无更正、不学词，
          密码管理器也认得。显示密码时才切回 text（此时用户主动要看到内容）。 */}
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        className={[className, visible ? "" : "ec-password-masked"].filter(Boolean).join(" ")}
        value={value}
        onChange={onChange}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        {...rest}
      />
      <button
        type="button"
        className="ec-password-toggle"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          if (disabled) return;
          setVisible(!visible);
        }}
      >
        <PasswordVisibilityIcon visible={visible} />
      </button>
    </div>
  );
});

export default PasswordInput;
