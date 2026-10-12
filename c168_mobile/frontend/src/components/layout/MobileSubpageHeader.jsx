import { Link } from "react-router-dom";
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
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder || ""}
            inputMode="search"
            enterKeyHint="search"
          />
          {search.value ? (
            <button
              type="button"
              onClick={() => (search.onClear ? search.onClear() : search.onChange(""))}
              aria-label={search.clearAriaLabel || "Clear"}
            >
              <i className="fas fa-xmark" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {!hasSearch && trailing ? <div className="m-subhead-trailing">{trailing}</div> : null}
    </div>
  );
}
