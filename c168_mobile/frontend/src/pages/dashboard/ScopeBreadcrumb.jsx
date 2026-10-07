/**
 * Compact Group › Company path for the sticky filter bar.
 * Modes: groups-all | group-only | group-all | company
 */
export default function ScopeBreadcrumb({
  i18n,
  groupId = "",
  companyCode = "",
  groupsAllMode = false,
  groupAllMode = false,
  groupOnlyMode = false,
}) {
  const g = String(groupId || "").trim().toUpperCase();
  const c = String(companyCode || "").trim().toUpperCase();

  if (groupsAllMode) {
    return (
      <span className="m-scope m-scope--gap-md">
        <ScopeGlyph tone="violet" icon="fa-layer-group" />
        <span className="m-scope-text m-scope-text--violet">{i18n.allGroups || `${i18n.all} Groups`}</span>
      </span>
    );
  }

  if (groupOnlyMode && g) {
    return (
      <span className="m-scope m-scope--gap-md">
        <ScopeGlyph tone="violet" icon="fa-layer-group" />
        <span className="m-scope-text m-scope-text--violet">{g}</span>
        <span className="m-scope-badge">{i18n.groupIdShort || "Group"}</span>
      </span>
    );
  }

  if (groupAllMode && g) {
    return (
      <span className="m-scope">
        <ScopeGlyph tone="violet" icon="fa-layer-group" />
        <span className="m-scope-text m-scope-text--violet">{g}</span>
        <Chevron />
        <ScopeGlyph tone="blue" icon="fa-building" />
        <span className="m-scope-text m-scope-text--blue">{i18n.all}</span>
      </span>
    );
  }

  if (g && c) {
    return (
      <span className="m-scope">
        <ScopeGlyph tone="violet" icon="fa-layer-group" />
        <span className="m-scope-text m-scope-text--violet m-scope-text--group-narrow">{g}</span>
        <Chevron />
        <ScopeGlyph tone="blue" icon="fa-building" />
        <span className="m-scope-text m-scope-text--blue m-scope-text--company-narrow">{c}</span>
      </span>
    );
  }

  /* Company "All" with no group (independents merge) — nothing to show on the left. */
  if (groupAllMode) {
    return (
      <span className="m-scope m-scope--gap-md">
        <ScopeGlyph tone="blue" icon="fa-building" />
        <span className="m-scope-text m-scope-text--blue">{i18n.all}</span>
      </span>
    );
  }

  if (c) {
    return (
      <span className="m-scope m-scope--gap-md">
        <ScopeGlyph tone="blue" icon="fa-building" />
        <span className="m-scope-text m-scope-text--blue">{c}</span>
      </span>
    );
  }

  if (g) {
    return (
      <span className="m-scope m-scope--gap-md">
        <ScopeGlyph tone="violet" icon="fa-layer-group" />
        <span className="m-scope-text m-scope-text--violet">{g}</span>
      </span>
    );
  }

  return <span className="m-scope-text m-scope-text--muted">{i18n.filter}</span>;
}

function Chevron() {
  return <i className="fas fa-chevron-right m-scope-chevron" aria-hidden="true" />;
}

function ScopeGlyph({ tone, icon }) {
  return (
    <span className={`m-scope-glyph m-scope-glyph--${tone}`} aria-hidden="true">
      <i className={`fas ${icon}`} />
    </span>
  );
}
