// Company context for the Trial Balance page (pages/REPORTS/TrialBalance.jsx)
// and its checker panel. Pure helpers - no React, no fetch - unit-tested in
// utils/__tests__/trialBalanceCompany.test.js. The server validates every
// companyId (the client is never the security boundary); these helpers only
// make sure the page never picks a company on the user's behalf and that
// report, status and checker requests all carry the same one.

// The company to preselect: the user's only company, or nothing. A Super
// Admin or a user with several companies always chooses explicitly - never
// the first/lowest company. A still-valid current choice is kept.
export function pickInitialCompany({ companies = [], isSuperAdmin = false, current = "" } = {}) {
  const list = Array.isArray(companies) ? companies : [];
  if (current && list.some((c) => String(c.id) === String(current))) return String(current);
  if (!isSuperAdmin && list.length === 1) return String(list[0].id);
  return "";
}

// True when the company is fixed for this user (shown, not selectable).
export function isCompanyLocked({ companies = [], isSuperAdmin = false } = {}) {
  return !isSuperAdmin && Array.isArray(companies) && companies.length === 1;
}

function validCompanyId(companyId) {
  return /^\d+$/.test(String(companyId ?? "").trim()) && Number(companyId) > 0;
}

// Query strings for GET /api/reports/trial-balance and
// GET /api/reports/trial-balance-checker/status. null = do not send the
// request (no company selected yet).
export function trialBalanceQuery({ from, to, companyId }) {
  if (!validCompanyId(companyId)) return null;
  return new URLSearchParams({ from: from || "", to: to || "", companyId: String(companyId).trim() }).toString();
}

export function trialBalanceStatusQuery({ from, to, tolerance, companyId }) {
  if (!validCompanyId(companyId)) return null;
  return new URLSearchParams({
    from: from || "",
    to: to || "",
    tolerance: String(tolerance ?? "0"),
    companyId: String(companyId).trim(),
  }).toString();
}

// Stale-response guard: every request takes a ticket; a company change (or
// a newer request) invalidates older tickets, so a late Company A response
// can never be shown while Company B is selected.
export function createRequestGuard() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    isCurrent(ticket) {
      return ticket === current;
    },
  };
}

// A status response only counts for the company it was asked about (the
// endpoint echoes the company it resolved).
export function statusMatchesCompany(status, companyId) {
  return Boolean(status) && String(status.companyId) === String(companyId);
}
