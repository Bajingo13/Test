// System-wide Active Branch - pure rules (no React, no requests).
// Unit-tested in backend/__tests__/activeBranchUi.test.js.
//
// The branch list always comes from the server (GET /api/branch-scope/branches:
// the user's ACTUAL company / branch assignments). Nothing here grants
// anything: the server re-checks every request; the selected branch only
// narrows what the server already allows.

export const ALL = "ALL";
export const HEADER = "X-Active-Branch";
const STORAGE_PREFIX = "astrea.activeBranch.v1";

// Options for the selector:
//   several branches -> "All Branches" (the user covers every branch of the
//                       company) or "All Assigned Branches" (a subset) first,
//                       then each branch;
//   one branch       -> just that branch;
//   none             -> [] (company-level work, no selector).
export function buildOptions({ branches = [], totalBranches = null } = {}) {
  const list = (Array.isArray(branches) ? branches : []).map((b) => ({
    value: String(b.id),
    label: `${b.name || b.code || `Branch ${b.id}`}${String(b.status || "").toUpperCase() === "INACTIVE" ? " (inactive)" : ""}`,
    code: b.code || "",
  }));
  if (list.length <= 1) return list;
  const all = totalBranches !== null && totalBranches !== undefined && Number(totalBranches) === list.length;
  return [{ value: ALL, label: all ? "All Branches" : "All Assigned Branches", code: "" }, ...list];
}

// The value to use: the saved one while it is still offered, otherwise the
// aggregate option (several branches) or the only branch; "" without branches.
export function resolveValue(options = [], saved = "") {
  if (!options.length) return "";
  if (saved && options.some((o) => o.value === String(saved))) return String(saved);
  return options[0].value;
}

export const isAll = (value) => !value || value === ALL;

export function activeBranchId(value) {
  if (isAll(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function labelFor(options = [], value = "") {
  return options.find((o) => o.value === String(value))?.label || "";
}

// What the X-Active-Branch header carries: a specific branch id, or nothing
// (the aggregate / no branches = the server's own full scope).
export function headerValue(value) {
  const id = activeBranchId(value);
  return id ? String(id) : null;
}

// Per-viewer convenience only (never a permission): the last choice per user
// and company, plus the last one per user (applied before the branch list
// has loaded so the first requests already carry it).
export const storageKey = (userId, companyId) => `${STORAGE_PREFIX}.${userId || "anon"}.${companyId || "default"}`;
export const lastKey = (userId) => `${STORAGE_PREFIX}.${userId || "anon"}.last`;

// Shown when a report needs a specific branch (matches the server's
// REPORT_BRANCH_REQUIRED message).
export const BRANCH_SELECTION_MESSAGE = "Select a specific branch to generate this report. Consolidated reporting is not available for your account.";

// Reports and the dashboard: a consolidated (several-branch) report needs the
// REPORTS.ALL_BRANCHES permission (canConsolidate). For users without it the
// aggregate selection is NOT a report scope: nothing is substituted - the
// report waits for an explicit branch (needsBranch + message). The scope is
// always exactly one of: one branch, ALL (consolidated), or none (no branches).
export function reportScope({ value, options = [], canConsolidate = false } = {}) {
  const branches = options.filter((o) => o.value !== ALL);
  const none = { param: "", label: "", note: "", needsBranch: false };
  if (!branches.length) return none;
  // a specific branch the user holds -> that branch (an unknown / stale value
  // is treated exactly like the aggregate below)
  const label = isAll(value) ? "" : labelFor(branches, value);
  if (label) return { ...none, param: String(value), label };
  if (branches.length === 1) return { ...none, param: branches[0].value, label: branches[0].label };
  if (canConsolidate) return { ...none, param: ALL, label: labelFor(options, ALL) || "All Branches" };
  return { ...none, needsBranch: true, note: BRANCH_SELECTION_MESSAGE };
}

// The branch a NEW transaction / beginning balance starts with: the active
// branch when it is one of the form's active branches, otherwise the form's
// own rule (one active branch -> it; several -> the user chooses).
export function defaultFormBranch(value, formBranches = []) {
  const active = (Array.isArray(formBranches) ? formBranches : []).filter((b) => String(b?.status || "ACTIVE").toUpperCase() === "ACTIVE");
  const id = activeBranchId(value);
  if (id && active.some((b) => Number(b.id) === id)) return String(id);
  return active.length === 1 ? String(active[0].id) : "";
}

// true for requests to this app's own API (where the header belongs); false
// for other origins (the header must never leak to a third party).
export function isOwnApiUrl(url, { origin = "", apiBase = "" } = {}) {
  const u = String(url || "");
  if (u.startsWith("/api/")) return true;
  if (origin && u.startsWith(`${origin}/api/`)) return true;
  if (apiBase && u.startsWith(`${apiBase.replace(/\/$/, "")}/api/`)) return true;
  return false;
}

// fetch() arguments with the header added - only for this app's own API, only
// when a branch is active, and never over a header the caller set explicitly
// (e.g. a picker that deliberately asks for "ALL").
export function addActiveBranchHeader(args, value, { origin = "", apiBase = "" } = {}) {
  if (!value) return args;
  const [input, init] = args;
  const url = typeof input === "string" ? input : input?.url || String(input || "");
  if (!isOwnApiUrl(url, { origin, apiBase })) return args;
  // signing in starts a new session: it never carries the previous one's branch
  if (/\/api\/login(?:[/?#]|$)/.test(url)) return args;
  const fromRequest = typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers || fromRequest);
  if (headers.has(HEADER)) return args;
  headers.set(HEADER, String(value));
  return [input, { ...(init || {}), headers }];
}
