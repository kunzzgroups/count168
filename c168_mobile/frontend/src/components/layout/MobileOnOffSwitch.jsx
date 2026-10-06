import "./MobileLangSwitch.css";

/**
 * 紧凑的 On / Off 分段开关 —— 与 MobileLangSwitch / MobileThemeSwitch 同一套外观。
 *
 * 为什么不直接复用 MobileThemeSwitch：它的语义是 light/dark，
 * 属性名（data-theme）和 prop 名（lightLabel/darkLabel）用在开关上会误导。
 *
 * 滑块靠 `[data-on="on"] .mobile-lang-switch__thumb { translateX(100%) }` 移动，
 * 规则在同目录的 MobileLangSwitch.css 里。
 */
export default function MobileOnOffSwitch({
  on = false,
  onChange,
  ariaLabel = "Toggle",
  onLabel = "On",
  offLabel = "Off",
  disabled = false,
}) {
  return (
    <div
      className="mobile-lang-switch mobile-lang-switch--light mobile-onoff-switch"
      role="group"
      aria-label={ariaLabel}
      data-on={on ? "on" : "off"}
    >
      <span className="mobile-lang-switch__thumb" aria-hidden="true" />
      <button
        type="button"
        className={`mobile-lang-switch__seg${on ? "" : " is-active"}`}
        aria-pressed={!on}
        disabled={disabled}
        onClick={() => onChange?.(false)}
      >
        {offLabel}
      </button>
      <button
        type="button"
        className={`mobile-lang-switch__seg${on ? " is-active" : ""}`}
        aria-pressed={on}
        disabled={disabled}
        onClick={() => onChange?.(true)}
      >
        {onLabel}
      </button>
    </div>
  );
}
