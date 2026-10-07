import { buildApiUrl } from "../utils/apiUrl.js";
import { fetchJson, assertApiOk } from "./fetchJson.js";
import MoneyDecimal from "./money/moneyDecimal.js";

/** Desktop-aligned report amount display (HALF_UP + abs < 0.005 → 0). */
export function formatReportAmount(value) {
  const zero = () => MoneyDecimal.formatThousands(MoneyDecimal.formatFixedHalfUp("0", 2), 2);
  if (value === null || value === undefined) return zero();
  const raw = String(value).trim();
  if (raw === "" || raw === "-") return zero();
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-") return zero();
  try {
    const absSmall = MoneyDecimal.cmp(MoneyDecimal.abs(cleaned), "0.005") < 0;
    const core = absSmall ? "0" : cleaned;
    return MoneyDecimal.formatThousands(MoneyDecimal.formatFixedHalfUp(core, 2), 2);
  } catch {
    return zero();
  }
}

export function reportAmountTone(value) {
  try {
    const n = MoneyDecimal.cmp(String(value ?? "0").replace(/,/g, ""), "0");
    if (n > 0) return "is-pos";
    if (n < 0) return "is-neg";
  } catch {
    /* ignore */
  }
  return "";
}

/** Append Domain/Customer report scope query params (mobile Maintenance-aligned). */
export function appendReportScopeParams(params, scope) {
  if (!scope) return params;
  if (scope.mode === "group" && scope.groupId) {
    params.set("view_group", scope.groupId);
    params.set("group_id", scope.groupId);
    params.set("group_aggregate", "1");
    params.set("report_scope", "group");
  } else if (Number(scope.companyId) > 0) {
    params.set("company_id", String(scope.companyId));
    params.set("report_scope", "company");
    if (scope.groupId) params.set("view_group", String(scope.groupId).trim().toUpperCase());
    // Match desktop transactionScopeApiParams / customerReportScopeApiParams:
    // company drill-down must use subsidiary currency pool (not group-ledger-only).
    params.set("subsidiary_accounts_only", "1");
  }
  return params;
}

export async function fetchCompanyPermissions(companyCode, signal) {
  const code = String(companyCode || "").trim();
  if (!code) return [];
  try {
    const { res, json } = await fetchJson(buildApiUrl("api/domain/domain_api.php"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_company_permissions", company_id: code }),
      signal,
    });
    if (!res.ok || !json?.success) return [];
    return Array.isArray(json?.data?.permissions) ? json.data.permissions : [];
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return [];
  }
}

/** Bank-only = has Bank and no Games/Gambling — no Domain/Customer report. */
export function isBankOnlyCategoryCompany(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return false;
  const hasBank = permissions.includes("Bank");
  const hasGames = permissions.includes("Games") || permissions.includes("Gambling");
  return hasBank && !hasGames;
}

export async function companyIsBankOnly(companyCode, signal) {
  const perms = await fetchCompanyPermissions(companyCode, signal);
  return isBankOnlyCategoryCompany(perms);
}

/** Desktop GROUP_PAYROLL_PROCESS_CODES parity. */
const DOMAIN_GROUP_CODES = ["PROFIT", "SALARY", "COMMISSION", "BONUS"];

/** High-precision add for Customer per-currency subtotals. */
export function reportAmountAdd(a, b) {
  try {
    const sum = MoneyDecimal.add(String(a || "0"), String(b || "0"));
    return MoneyDecimal.stripTrailingZeros(sum.toFixed(8));
  } catch {
    return "0";
  }
}

function normalizeProcessCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s*\(.*$/, "");
}

export function mapDomainGroupProcesses(apiList) {
  const rows = Array.isArray(apiList) ? apiList : [];
  const mapped = DOMAIN_GROUP_CODES.map((code) => {
    const row = rows.find((p) => {
      const fromProcess = normalizeProcessCode(p.process ?? p.process_id);
      const fromDisplay = normalizeProcessCode(p.display_text);
      return fromProcess === code || fromDisplay === code || fromDisplay.startsWith(`${code} `);
    });
    const id = row?.id != null ? Number(row.id) : 0;
    if (!Number.isFinite(id) || id <= 0) return null;
    return { id, process: code, display_text: code };
  }).filter(Boolean);
  return mapped.length > 0 ? mapped : rows;
}

function groupsAllChildScopes(scope) {
  if (scope?.mode !== "groupsAll") return null;
  const ids = Array.isArray(scope.groupIds) ? scope.groupIds : [];
  return ids
    .map((gid) => String(gid || "").trim().toUpperCase())
    .filter(Boolean)
    .map((groupId) => ({ mode: "group", companyId: null, groupId }));
}

async function mapGroupsAll(scope, mapper, { signal } = {}) {
  const children = groupsAllChildScopes(scope);
  if (!children?.length) return null;
  const settled = await Promise.all(
    children.map(async (child) => {
      try {
        return await mapper(child);
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        return null;
      }
    }),
  );
  return settled.filter(Boolean);
}

function domainRowKey(row) {
  const id = Number(row?.id ?? row?.process_id);
  if (Number.isFinite(id) && id > 0) return `id:${id}`;
  const code = normalizeProcessCode(row?.process ?? row?.display_text ?? row?.description);
  return code ? `code:${code}` : "";
}

function mergeDomainReportPayloads(payloads) {
  const byKey = new Map();
  let totals = null;
  for (const json of payloads) {
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const key = domainRowKey(row);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...row });
        continue;
      }
      byKey.set(key, {
        ...prev,
        ...row,
        turnover: reportAmountAdd(prev.turnover, row.turnover),
        win: reportAmountAdd(prev.win, row.win),
        lose: reportAmountAdd(prev.lose, row.lose),
        win_lose: reportAmountAdd(prev.win_lose, row.win_lose),
      });
    }
    const t = json?.totals;
    if (!t) continue;
    totals = totals
      ? {
          turnover: reportAmountAdd(totals.turnover, t.turnover),
          win: reportAmountAdd(totals.win, t.win),
          lose: reportAmountAdd(totals.lose, t.lose),
          win_lose: reportAmountAdd(totals.win_lose, t.win_lose),
        }
      : { ...t };
  }
  return { success: true, data: [...byKey.values()], totals };
}

function customerRowKey(row) {
  const acc = String(row?.account_id || row?.id || "").trim().toUpperCase();
  const cur = String(row?.currency || "").trim().toUpperCase();
  return acc ? `${acc}|${cur}` : "";
}

function mergeCustomerReportPayloads(payloads) {
  const byKey = new Map();
  let totalWin = "0";
  let totalLose = "0";
  let hasTotals = false;
  for (const json of payloads) {
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const key = customerRowKey(row);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...row });
        continue;
      }
      byKey.set(key, {
        ...prev,
        ...row,
        win: reportAmountAdd(prev.win, row.win),
        lose: reportAmountAdd(prev.lose, row.lose),
      });
    }
    if (json?.total_win != null || json?.total_lose != null) {
      hasTotals = true;
      totalWin = reportAmountAdd(totalWin, json.total_win);
      totalLose = reportAmountAdd(totalLose, json.total_lose);
    }
  }
  const out = { success: true, data: [...byKey.values()] };
  if (hasTotals) {
    out.total_win = totalWin;
    out.total_lose = totalLose;
  }
  return out;
}

function mergeUniqueById(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const id = Number(row?.id);
      const key = Number.isFinite(id) && id > 0 ? `id:${id}` : domainRowKey(row) || customerRowKey(row);
      if (!key || byId.has(key)) continue;
      byId.set(key, row);
    }
  }
  return [...byId.values()];
}

function mergeCurrencyRows(lists) {
  const byCode = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const code = String(row?.code || row?.currency || row)
        .trim()
        .toUpperCase();
      if (!/^[A-Z]{3}$/.test(code) || byCode.has(code)) continue;
      byCode.set(code, typeof row === "object" && row ? { ...row, code } : { code });
    }
  }
  return [...byCode.values()];
}

async function fetchDomainProcessesOnce(scope, { signal } = {}) {
  const params = new URLSearchParams();
  params.set("action", "processes");
  appendReportScopeParams(params, scope);
  const { res, json } = await fetchJson(
    buildApiUrl(`api/reports/domain_report_api.php?${params.toString()}`),
    { signal },
  );
  assertApiOk(res, json);
  const list = Array.isArray(json.data) ? json.data : [];
  if (scope?.mode === "group") return mapDomainGroupProcesses(list);
  return list;
}

export async function fetchDomainProcesses(scope, { signal } = {}) {
  const merged = await mapGroupsAll(
    scope,
    (child) => fetchDomainProcessesOnce(child, { signal }),
    { signal },
  );
  if (merged !== null) return mapDomainGroupProcesses(mergeUniqueById(merged));
  return fetchDomainProcessesOnce(scope, { signal });
}

async function fetchDomainReportOnce({ scope, dateFrom, dateTo, processId }, { signal } = {}) {
  const params = new URLSearchParams();
  params.set("date_from", dateFrom);
  params.set("date_to", dateTo);
  if (processId) params.set("process_id", String(processId));
  appendReportScopeParams(params, scope);
  const { res, json } = await fetchJson(
    buildApiUrl(`api/reports/domain_report_api.php?${params.toString()}`),
    { signal },
  );
  assertApiOk(res, json, "Failed to load report");
  return json;
}

export async function fetchDomainReport(
  { scope, dateFrom, dateTo, processId },
  { signal } = {},
) {
  const merged = await mapGroupsAll(
    scope,
    (child) => fetchDomainReportOnce({ scope: child, dateFrom, dateTo, processId }, { signal }),
    { signal },
  );
  if (merged !== null) {
    if (!merged.length) throw new Error("Failed to load report");
    return mergeDomainReportPayloads(merged);
  }
  return fetchDomainReportOnce({ scope, dateFrom, dateTo, processId }, { signal });
}

async function fetchCustomerAccountsOnce(scope, { signal } = {}) {
  const params = new URLSearchParams();
  appendReportScopeParams(params, scope);
  const { res, json } = await fetchJson(
    buildApiUrl(`api/transactions/get_accounts_api.php?${params.toString()}`),
    { signal },
  );
  assertApiOk(res, json);
  return Array.isArray(json.data) ? json.data : [];
}

export async function fetchCustomerAccounts(scope, { signal } = {}) {
  const merged = await mapGroupsAll(
    scope,
    (child) => fetchCustomerAccountsOnce(child, { signal }),
    { signal },
  );
  if (merged !== null) return mergeUniqueById(merged);
  return fetchCustomerAccountsOnce(scope, { signal });
}

async function fetchReportCurrenciesOnce(scope, { signal } = {}) {
  const params = new URLSearchParams();
  appendReportScopeParams(params, scope);
  const { res, json } = await fetchJson(
    buildApiUrl(`api/transactions/get_scope_account_currencies_api.php?${params.toString()}`),
    { signal },
  );
  assertApiOk(res, json);
  return Array.isArray(json.data) ? json.data : [];
}

export async function fetchReportCurrencies(scope, { signal } = {}) {
  const merged = await mapGroupsAll(
    scope,
    (child) => fetchReportCurrenciesOnce(child, { signal }),
    { signal },
  );
  if (merged !== null) return mergeCurrencyRows(merged);
  return fetchReportCurrenciesOnce(scope, { signal });
}

async function fetchCustomerReportOnce(
  {
    scope,
    dateFrom,
    dateTo,
    accountId,
    showAll,
    selectedCurrencies,
    showAllCurrencies,
  },
  { signal } = {},
) {
  const params = new URLSearchParams();
  params.set("date_from", dateFrom);
  params.set("date_to", dateTo);
  if (accountId) params.set("account_id", String(accountId));
  if (showAll) params.set("show_all", "1");
  appendReportScopeParams(params, scope);
  if (!showAllCurrencies && Array.isArray(selectedCurrencies) && selectedCurrencies.length > 0) {
    params.set("currency", selectedCurrencies.join(","));
  }
  const { res, json } = await fetchJson(
    buildApiUrl(`api/reports/customer_report_api.php?${params.toString()}`),
    { signal },
  );
  assertApiOk(res, json, "Failed to load report");
  return json;
}

export async function fetchCustomerReport(
  {
    scope,
    dateFrom,
    dateTo,
    accountId,
    showAll,
    selectedCurrencies,
    showAllCurrencies,
  },
  { signal } = {},
) {
  const args = {
    dateFrom,
    dateTo,
    accountId,
    showAll,
    selectedCurrencies,
    showAllCurrencies,
  };
  const merged = await mapGroupsAll(
    scope,
    (child) => fetchCustomerReportOnce({ ...args, scope: child }, { signal }),
    { signal },
  );
  if (merged !== null) {
    if (!merged.length) throw new Error("Failed to load report");
    return mergeCustomerReportPayloads(merged);
  }
  return fetchCustomerReportOnce({ ...args, scope }, { signal });
}

/**
 * Message the scope APIs throw when the session is not assigned to the requested group ledger
 * (`api/transactions/get_scope_account_currencies_api.php`, `dashboard_api.php`).
 */
const GROUP_LEDGER_DENIED_MESSAGE = "无权访问该 Group Ledger";

/**
 * Desktop parity (36495fb2fc, `frontend/src/pages/report/shared/reportGcBoot.js`): true when a
 * report fetch failed because the session was denied access to the group ledger it asked for.
 * The frontend's group-only pre-check can wrongly allow entering such a ledger; the report pages
 * use this to fall back to a reportable subsidiary instead of stranding the page on an error.
 */
export function isGroupLedgerDeniedError(err) {
  const msg = err?.message;
  return typeof msg === "string" && msg.includes(GROUP_LEDGER_DENIED_MESSAGE);
}
