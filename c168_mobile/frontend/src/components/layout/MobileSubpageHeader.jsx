import { Link } from "react-router-dom";
import KeyboardOwnedInput from "../KeyboardOwnedInput.jsx";
import "./subpage-header.css";

/**
 * Hub-child sticky header: Back + Title + optional Search (or trailing action).
 * Omit `search` when desktop has no search — only Back + Title remain.
 */
export default function MobileSubpageHeader({
  backTo,
  backAriaLabel = "Back",
  title,
  subtitle = null,
  search = null,
  trailing = null,
}) {
  const hasSearch =
    search &&
    typeof search.value === "string" &&
    typeof search.onChange === "function";

  return (
    <div className={`m-subhead${hasSearch ? " m-subhead--search" : ""}`}>
      <Link to={backTo} className="m-subhead-back tap-scale" aria-label={backAriaLabel}>
        <i className="fas fa-arrow-left" aria-hidden="true" />
      </Link>

      <div className="m-subhead-copy">
        <strong className="m-subhead-title">{title}</strong>
        {subtitle ? <span className="m-subhead-sub">{subtitle}</span> : null}
      </div>

      {hasSearch ? (
        <div className="m-subhead-search">
          <i className="fas fa-magnifying-glass" aria-hidden="true" />
          {/*
           * Keyboard-owned field: the phone's keyboard writes the text into the DOM itself, and a
           * controlled `value=` used to put an older string back on the next render — Android users
           * lost characters and saw a list filtered by an older query. The ✕ is rendered by the
           * field, so clearing always wipes the DOM as well.
           */}
          <KeyboardOwnedInput
            value={search.value}
            onValueChange={search.onChange}
            onClear={search.onClear}
            composeThrottleMs={80}
            placeholder={search.placeholder || ""}
            inputMode="search"
            enterKeyHint="search"
            clearLabel={search.clearAriaLabel || "Clear"}
          />
        </div>
      ) : null}

      {!hasSearch && trailing ? <div className="m-subhead-trailing">{trailing}</div> : null}
    </div>
  );
}
