import {
  companiesInGroup,
  normalizeGroupId,
  pickCompany,
  pickGroupAnchorCompany,
  resolveViewGroupForCompany,
} from "./dashboardScope.js";

/**
 * Resolve API scope for mobile Transaction page (mirrors desktop transactionScope.js).
 */
export function resolveMobileTransactionScope({
  companies,
  companyId,
  selectedGroup,
  groupsAllMode,
  groupAllMode,
}) {
  const snapCompanies = companies || [];
  const group = selectedGroup ? normalizeGroupId(selectedGroup) : null;
  const cidRaw = companyId;
  const hasExplicitCompany = cidRaw != null && Number(cidRaw) > 0;
  const uiCompanyId = hasExplicitCompany ? Number(cidRaw) : null;
  const groupOnlyLedger = Boolean(
    group && !groupAllMode && !groupsAllMode && !hasExplicitCompany,
  );

  const mergeCompanyIds = (() => {
    if (uiCompanyId) return [uiCompanyId];
    if (groupAllMode || (groupsAllMode && groupAllMode)) {
      const list = groupsAllMode
        ? snapCompanies.filter((c) => c?.company_id && String(c.company_id).trim() !== "")
        : companiesInGroup(snapCompanies, group);
      return list.map((c) => Number(c.id)).filter((id) => Number.isFinite(id) && id > 0);
    }
    return [];
  })();

  if ((groupAllMode || groupsAllMode) && !uiCompanyId && mergeCompanyIds.length > 0) {
    return {
      mode: "aggregate",
      scopeCompanyId: 0,
      viewGroup: groupsAllMode ? null : group,
      selectedGroup: groupsAllMode ? null : group,
      uiCompanyId: null,
      groupsAllMode,
      groupAllMode,
      mergeCompanyIds,
    };
  }

  if (group && !uiCompanyId && !groupsAllMode && !groupAllMode) {
    return {
      mode: "group",
      scopeCompanyId: 0,
      viewGroup: group,
      selectedGroup: group,
      uiCompanyId: null,
      groupOnlyLedger: true,
      resolveCompanyViaGroupId: true,
    };
  }

  if (hasExplicitCompany && uiCompanyId > 0) {
    const scopeRow = snapCompanies.find((c) => Number(c.id) === uiCompanyId) || null;
    return {
      mode: "company",
      scopeCompanyId: uiCompanyId,
      viewGroup: resolveViewGroupForCompany(scopeRow, group) || group || null,
      selectedGroup: group,
      uiCompanyId,
    };
  }

  if (group && groupAllMode) {
    return {
      mode: "aggregate",
      scopeCompanyId: 0,
      viewGroup: group,
      selectedGroup: group,
      uiCompanyId: null,
      groupAllMode: true,
      mergeCompanyIds,
    };
  }

  if (groupsAllMode && !groupAllMode) {
    return {
      mode: "aggregate",
      scopeCompanyId: 0,
      viewGroup: null,
      selectedGroup: null,
      uiCompanyId: null,
      groupsAllMode: true,
      groupAllMode: false,
      mergeCompanyIds: [],
      resolveCompanyViaGroupId: true,
    };
  }

  const fallback = pickCompany(snapCompanies);
  if (fallback?.id) {
    const fid = Number(fallback.id);
    const scopeRow = snapCompanies.find((c) => Number(c.id) === fid) || fallback;
    const viewGroup = resolveViewGroupForCompany(scopeRow, group);
    return {
      mode: "company",
      scopeCompanyId: fid,
      viewGroup: viewGroup || null,
      selectedGroup: group,
      uiCompanyId: fid,
    };
  }

  return null;
}

export function transactionScopeIsReady(scope) {
  if (!scope) return false;
  if (scope.mode === "aggregate") {
    if (scope.mergeCompanyIds?.length) return true;
    if (scope.aggregateGroupIds?.length) return true;
    return Boolean(scope.resolveCompanyViaGroupId && scope.groupsAllMode);
  }
  if (scope.scopeCompanyId > 0) return true;
  return Boolean(scope.resolveCompanyViaGroupId && scope.selectedGroup);
}

export function transactionScopeApiParams(scope) {
  if (!scope) return {};
  if (scope.mode === "aggregate") {
    return {
      companyId: undefined,
      viewGroup: scope.viewGroup || undefined,
      groupId: scope.selectedGroup || undefined,
      groupAggregate: scope.groupAllMode || scope.groupsAllMode ? true : undefined,
    };
  }
  const viewGroup = scope.viewGroup || scope.selectedGroup || undefined;
  if (scope.mode === "group") {
    return {
      companyId: undefined,
      viewGroup,
      groupId: scope.selectedGroup || undefined,
      groupAggregate: true,
    };
  }
  return {
    companyId: scope.scopeCompanyId > 0 ? scope.scopeCompanyId : scope.uiCompanyId ?? undefined,
    viewGroup,
    groupId: undefined,
    subsidiaryAccountsOnly: true,
  };
}

export function resolveTransactionCurrencyOrderCompanyId(scope, snapCompanies = []) {
  if (!scope) return null;
  // Pure Group ledger has no company — its order lives under g:GROUP (desktop 5b0455a06e).
  if (scope.mode === "group") return null;
  const ui = Number(scope.uiCompanyId);
  if (Number.isFinite(ui) && ui > 0) return ui;
  const scopeCid = Number(scope.scopeCompanyId);
  if (Number.isFinite(scopeCid) && scopeCid > 0) return scopeCid;
  const g = scope.selectedGroup ? String(scope.selectedGroup).trim().toUpperCase() : "";
  if (g && snapCompanies?.length) {
    const anchor = pickGroupAnchorCompany(snapCompanies, g);
    const aid = Number(anchor?.id);
    if (Number.isFinite(aid) && aid > 0) return aid;
  }
  if (scope.mergeCompanyIds?.length) {
    const first = Number(scope.mergeCompanyIds[0]);
    if (Number.isFinite(first) && first > 0) return first;
  }
  return null;
}

/**
 * Params for user_currency_order_api — desktop 5b0455a06e: a company ledger uses
 * company_id, a pure Group ledger uses group_id (the API stores it under g:GROUP).
 */
export function resolveTransactionCurrencyOrderParams(scope, snapCompanies = []) {
  if (!scope) return { companyId: null, groupId: null };
  if (scope.mode === "group" && scope.selectedGroup) {
    return {
      companyId: null,
      groupId: String(scope.selectedGroup).trim().toUpperCase(),
    };
  }
  return {
    companyId: resolveTransactionCurrencyOrderCompanyId(scope, snapCompanies),
    groupId: null,
  };
}
