// Company context for Account Analysis (pages/REPORTS/AccountAnalysis.jsx)
// and the Trial Balance -> Account Analysis drill-down. Pure helpers,
// unit-tested in utils/__tests__/accountAnalysisCompany.test.js. The server
// validates every companyId; these helpers only make sure the company
// travels with the link and is never replaced by another one.

function validCompanyId(companyId) {
  return /^\d+$/.test(String(companyId ?? "").trim()) && Number(companyId) > 0;
}

// Drill-down link from a report (Trial Balance) for one account, carrying
// the report's selected company. No company -> no companyId in the link
// (Account Analysis then asks for one; it never picks one).
export function accountAnalysisLink({ accountCode, from, to, companyId }) {
  const params = new URLSearchParams({ accountCode: accountCode || "", from: from || "", to: to || "" });
  if (validCompanyId(companyId)) params.set("companyId", String(companyId).trim());
  return `/reports/account-analysis?${params.toString()}`;
}

// Query string for GET /api/reports/account-analysis. null = do not send
// (no company or no account).
export function accountAnalysisQuery({ from, to, accountCode, companyId }) {
  if (!accountCode || !validCompanyId(companyId)) return null;
  return new URLSearchParams({ from: from || "", to: to || "", accountCode, companyId: String(companyId).trim() }).toString();
}

// The company to use when the page opens. A company named in the link is
// kept only if it is one of the user's companies - otherwise it is
// rejected (never swapped for another company, not even the user's only
// one). Without one in the link, a single-company user gets theirs; a
// Super Admin or multi-company user must choose.
export function resolveIncomingCompany({ companies = [], isSuperAdmin = false, requested = "" } = {}) {
  const list = Array.isArray(companies) ? companies : [];
  const wanted = String(requested ?? "").trim();
  if (wanted) {
    const ok = list.some((c) => String(c.id) === wanted);
    return { companyId: ok ? wanted : "", rejected: !ok };
  }
  if (!isSuperAdmin && list.length === 1) return { companyId: String(list[0].id), rejected: false };
  return { companyId: "", rejected: false };
}
