import {
  canUseGroupOnlyMode,
  companyLoginRequiresSubsidiaryWithGroup,
  getLoginIdentifier,
  isGroupLogin,
  resolveVisibleGroupIds,
} from "./loginScope.js";

export function normalizeGroupId(value) {
  return String(value || "").trim().toUpperCase();
}

function isVirtualGroupLinkCompanyRow(companyRow) {
  return Boolean(companyRow?.link_source_group);
}

function companyRowIsGroupEntityAnyShape(companyRow) {
  if (!companyRow || isVirtualGroupLinkCompanyRow(companyRow)) return false;
  const grp = normalizeGroupId(companyRow.group_id);
  if (!grp) return false;
  const code = normalizeGroupId(companyRow.company_id);
  if (code === grp) return true;
  return code === "";
}

function companyDisplayCodeIsGroupLabel(companyRow, groupIds) {
  const code = normalizeGroupId(companyRow?.company_id);
  if (!code) return false;
  const set = new Set((groupIds || []).map(normalizeGroupId).filter(Boolean));
  return set.has(code);
}

function excludeGroupLabelsFromCompanyPicker(companies, groupIds) {
  return (companies || []).filter((c) => {
    if (companyDisplayCodeIsGroupLabel(c, groupIds)) return false;
    if (companyRowIsGroupEntityAnyShape(c)) return false;
    return true;
  });
}

/** One pill per company code — prefer session / active company when duplicates exist. */
export function dedupeOwnerCompaniesByCode(companies, preferredCompanyId = null) {
  const byCode = new Map();
  for (const comp of companies || []) {
    const key = normalizeGroupId(comp.company_id);
    if (!key) continue;
    const existing = byCode.get(key);
    if (!existing) {
      byCode.set(key, comp);
      continue;
    }
    const existingIsCurrent = Number(existing.id) === Number(preferredCompanyId);
    const currentIsCurrent = Number(comp.id) === Number(preferredCompanyId);
    if (!existingIsCurrent && currentIsCurrent) byCode.set(key, comp);
  }
  return Array.from(byCode.values());
}

function companiesNativeInGroupList(companies, gid) {
  const gids = sortedUniqueGroupIds(companies);
  if (!gid) {
    return (companies || []).filter((c) => {
      if (!c?.company_id || String(c.company_id).trim() === "") return false;
      if (isVirtualGroupLinkCompanyRow(c)) return false;
      const native = normalizeGroupId(c.native_group_id ?? c.group_id);
      if (!native) return true;
      return !companyRowIsGroupEntityAnyShape(c);
    });
  }
  const g = normalizeGroupId(gid);
  return (companies || []).filter((c) => {
    if (!c?.company_id || String(c.company_id).trim() === "") return false;
    if (isVirtualGroupLinkCompanyRow(c)) return false;
    return normalizeGroupId(c.native_group_id ?? c.group_id) === g;
  });
}

function allGroupedCompaniesForPicker(companies, groupIds) {
  const set = new Set((groupIds || sortedUniqueGroupIds(companies)).map(normalizeGroupId).filter(Boolean));
  return (companies || []).filter((c) => {
    if (!c?.company_id || String(c.company_id).trim() === "") return false;
    if (isVirtualGroupLinkCompanyRow(c)) return false;
    const g = normalizeGroupId(c.group_id);
    const link = normalizeGroupId(c.link_source_group);
    return (g && set.has(g)) || (link && set.has(link));
  });
}

export function sortedUniqueGroupIds(companies) {
  const set = new Set();
  for (const c of companies || []) {
    const g = normalizeGroupId(c?.group_id);
    if (g) set.add(g);
  }
  return [...set].sort();
}

export function resolveViewGroupForCompany(companyRow, fallbackGroup = null) {
  if (!companyRow) {
    return fallbackGroup ? normalizeGroupId(fallbackGroup) : null;
  }
  const link = companyRow.link_source_group
    ? normalizeGroupId(companyRow.link_source_group)
    : "";
  if (link) return link;
  const native = normalizeGroupId(companyRow.group_id);
  if (native) return native;
  return fallbackGroup ? normalizeGroupId(fallbackGroup) : null;
}

export function companiesInGroup(companies, groupId) {
  const gid = normalizeGroupId(groupId);
  return (companies || []).filter((c) => {
    if (!c?.company_id || String(c.company_id).trim() === "") return false;
    if (!gid) {
      return !normalizeGroupId(c.group_id);
    }
    return normalizeGroupId(c.group_id) === gid;
  });
}

export function pickGroupAnchorCompany(companies, groupId) {
  const list = companiesForPicker(companies, { selectedGroup: groupId, groupsAllMode: false });
  return list.find((c) => Number(c.id) > 0) || null;
}

export function companiesForPicker(companies, { selectedGroup, groupsAllMode, preferredCompanyId = null }) {
  const groupIds = sortedUniqueGroupIds(companies);
  let list;
  if (groupsAllMode) {
    list = allGroupedCompaniesForPicker(companies, groupIds);
  } else if (selectedGroup) {
    list = companiesNativeInGroupList(companies, selectedGroup);
  } else {
    list = companiesNativeInGroupList(companies, null);
  }
  list = excludeGroupLabelsFromCompanyPicker(list, groupIds);
  return dedupeOwnerCompaniesByCode(list, preferredCompanyId);
}

function isIndependentCompanyRow(row, groupIds) {
  if (!row || isVirtualGroupLinkCompanyRow(row)) return false;
  const code = normalizeGroupId(row.company_id);
  if ((groupIds || []).some((g) => normalizeGroupId(g) === code)) return false;
  if (companyRowIsGroupEntityAnyShape(row)) return false;
  const native = normalizeGroupId(row.native_group_id ?? row.group_id);
  return !native;
}

/**
 * Independent (ungrouped) companies — desktop 276125d07f `resolveIndependentAllMergeCompanyList`.
 * Used when Company "All" is picked with no Group selected: the merge then covers exactly the
 * companies that have no group, not every company the picker can show.
 */
export function independentCompaniesForPicker(companies) {
  const groupIds = sortedUniqueGroupIds(companies);
  return dedupeOwnerCompaniesByCode(
    (companies || []).filter((row) => isIndependentCompanyRow(row, groupIds)),
  );
}

/** Desktop-aligned first-login Group / Company scope for mobile filters. */
export function resolveInitialMobileGcScope(me, companies, sessionRow) {
  const groupIds = sortedUniqueGroupIds(companies);

  if (me && companyLoginRequiresSubsidiaryWithGroup(me)) {
    const cid = Number(me.company_id);
    const row =
      sessionRow ||
      (Number.isFinite(cid) && cid > 0 ? companies.find((c) => Number(c.id) === cid) : null);
    if (row && !isIndependentCompanyRow(row, groupIds)) {
      const group = normalizeGroupId(row.native_group_id ?? row.group_id);
      if (group && Number.isFinite(cid) && cid > 0) {
        return {
          companyId: cid,
          selectedGroup: group,
          groupsAllMode: false,
          groupAllMode: false,
        };
      }
    }
    const pickable = companiesForPicker(companies, { selectedGroup: null, groupsAllMode: false });
    if (pickable.length === 0) {
      return {
        companyId: null,
        selectedGroup: null,
        groupsAllMode: false,
        groupAllMode: false,
      };
    }
  }

  if (isGroupLogin(me)) {
    const group = getLoginIdentifier(me) || normalizeGroupId(sessionRow?.group_id);
    if (group) {
      if (canUseGroupOnlyMode(me, group, companies)) {
        return {
          companyId: null,
          selectedGroup: group,
          groupsAllMode: false,
          groupAllMode: false,
        };
      }
      const pick = sessionRow?.id ? sessionRow : pickGroupAnchorCompany(companies, group);
      return {
        companyId: pick?.id != null ? Number(pick.id) : null,
        selectedGroup: group,
        groupsAllMode: false,
        groupAllMode: false,
      };
    }
  }

  const cid = sessionRow?.id != null ? Number(sessionRow.id) : null;
  const group = sessionRow ? resolveViewGroupForCompany(sessionRow, null) : null;
  return {
    companyId: Number.isFinite(cid) && cid > 0 ? cid : null,
    selectedGroup: group,
    groupsAllMode: false,
    groupAllMode: false,
  };
}

export function resolveMobileGroupIds(companies, me) {
  return resolveVisibleGroupIds(sortedUniqueGroupIds(companies), me, companies);
}

/** Pick subsidiary when switching group without group-only permission (desktop-aligned). */
export function resolveCompanyPickForGroup(companies, groupId, currentCompanyId = null) {
  const g = normalizeGroupId(groupId);
  if (!g) return null;
  const cid = Number(currentCompanyId);
  if (Number.isFinite(cid) && cid > 0) {
    const row = (companies || []).find((c) => Number(c.id) === cid);
    if (row) {
      const native = normalizeGroupId(row.group_id);
      const link = row.link_source_group ? normalizeGroupId(row.link_source_group) : "";
      if (native === g || link === g) return row;
    }
  }
  return pickGroupAnchorCompany(companies, g) || companiesForPicker(companies, { selectedGroup: g, groupsAllMode: false })[0] || null;
}

export function pickCompany(companies, sessionCompanyId) {
  if (!companies?.length) return null;
  const cid = Number(sessionCompanyId);
  if (Number.isFinite(cid) && cid > 0) {
    const match = companies.find((c) => Number(c.id) === cid);
    if (match) return match;
  }
  return companies.find((c) => Number(c.id) > 0) || null;
}

export function buildBootstrapQuery({
  dateFrom,
  dateTo,
  currency,
  currencies,
  companyId,
  selectedGroup,
  groupAllMode,
  groupsAllMode,
  companies,
}) {
  const q = new URLSearchParams({
    date_from: dateFrom,
    date_to: dateTo,
    bootstrap_scope: "full",
  });

  if (currency) q.set("currency", currency);
  if (Array.isArray(currencies) && currencies.length > 1) {
    q.set("currencies", currencies.join(","));
  }

  const group = normalizeGroupId(selectedGroup);
  const cid = Number(companyId);

  if (groupsAllMode) {
    const fallback =
      Number.isFinite(cid) && cid > 0
        ? cid
        : Number(pickCompany(companies)?.id) || null;
    if (fallback) q.set("company_id", String(fallback));
    return q;
  }

  if (group && groupAllMode) {
    const anchor = pickGroupAnchorCompany(companies, group);
    if (anchor?.id) {
      q.set("company_id", String(anchor.id));
      q.set("view_group", group);
      q.set("group_id", group);
      q.set("group_aggregate", "1");
    } else {
      q.set("view_group", group);
      q.set("group_id", group);
    }
    return q;
  }

  if (Number.isFinite(cid) && cid > 0) {
    q.set("company_id", String(cid));
    if (group) {
      q.set("view_group", group);
      q.set("group_id", group);
      q.set("subsidiary_accounts_only", "1");
    }
    return q;
  }

  if (group) {
    const anchor = pickGroupAnchorCompany(companies, group);
    q.set("view_group", group);
    q.set("group_id", group);
    if (anchor?.id) {
      q.set("company_id", String(anchor.id));
      q.set("group_aggregate", "1");
    }
    return q;
  }

  const fallback = pickCompany(companies);
  if (fallback?.id) q.set("company_id", String(fallback.id));
  return q;
}
