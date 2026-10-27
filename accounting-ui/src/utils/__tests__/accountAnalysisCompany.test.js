// Account Analysis company context: pure helpers (accountAnalysisCompany.mjs,
// real ESM via dynamic import like the other utils tests) plus source checks
// that Trial Balance passes its company and Account Analysis uses it.
const fs = require("fs");
const path = require("path");

let a;
let tb;
beforeAll(async () => {
  a = await import("../accountAnalysisCompany.mjs");
  tb = await import("../trialBalanceCompany.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const linkParams = (link) => Object.fromEntries(new URL(link, "http://x").searchParams);

const TWO = [{ id: 3, name: "Low Co" }, { id: 9, name: "High Co" }];
const ONE = [{ id: 7, name: "Only Co" }];

describe("Trial Balance -> Account Analysis link", () => {
  test("Company A navigation carries A; Company B navigation carries B", () => {
    const linkA = a.accountAnalysisLink({ accountCode: "1001", from: "2026-01-01", to: "2026-03-31", companyId: "3" });
    const linkB = a.accountAnalysisLink({ accountCode: "1001", from: "2026-01-01", to: "2026-03-31", companyId: "9" });
    expect(linkA.startsWith("/reports/account-analysis?")).toBe(true);
    expect(linkParams(linkA)).toEqual({ accountCode: "1001", from: "2026-01-01", to: "2026-03-31", companyId: "3" });
    expect(linkParams(linkB).companyId).toBe("9");
  });

  test("account codes are encoded; no (or an invalid) company -> no companyId in the link", () => {
    expect(linkParams(a.accountAnalysisLink({ accountCode: "A&B 1", from: "x", to: "y", companyId: "3" })).accountCode).toBe("A&B 1");
    for (const companyId of ["", null, undefined, "abc", "0"]) {
      expect("companyId" in linkParams(a.accountAnalysisLink({ accountCode: "1", from: "x", to: "y", companyId }))).toBe(false);
    }
  });
});

describe("Account Analysis request", () => {
  test("carries the selected company", () => {
    expect(Object.fromEntries(new URLSearchParams(a.accountAnalysisQuery({ from: "f", to: "t", accountCode: "1001", companyId: 9 })))).toEqual({ from: "f", to: "t", accountCode: "1001", companyId: "9" });
  });

  test("no company or no account -> no request (never a silent fallback)", () => {
    expect(a.accountAnalysisQuery({ from: "f", to: "t", accountCode: "1001", companyId: "" })).toBeNull();
    expect(a.accountAnalysisQuery({ from: "f", to: "t", accountCode: "1001", companyId: "abc" })).toBeNull();
    expect(a.accountAnalysisQuery({ from: "f", to: "t", accountCode: "", companyId: "9" })).toBeNull();
  });
});

describe("incoming company on page open", () => {
  test("the company in the link is kept when it is one of the user's companies", () => {
    expect(a.resolveIncomingCompany({ companies: TWO, isSuperAdmin: false, requested: "9" })).toEqual({ companyId: "9", rejected: false });
    expect(a.resolveIncomingCompany({ companies: TWO, isSuperAdmin: true, requested: "3" })).toEqual({ companyId: "3", rejected: false });
  });

  test("a company the user cannot access is rejected - never swapped for another (not even their only one)", () => {
    expect(a.resolveIncomingCompany({ companies: ONE, isSuperAdmin: false, requested: "9" })).toEqual({ companyId: "", rejected: true });
    expect(a.resolveIncomingCompany({ companies: TWO, isSuperAdmin: false, requested: "42" })).toEqual({ companyId: "", rejected: true });
  });

  test("no company in the link: single-company user -> theirs; multi-company / Super Admin -> must choose", () => {
    expect(a.resolveIncomingCompany({ companies: ONE, isSuperAdmin: false })).toEqual({ companyId: "7", rejected: false });
    expect(a.resolveIncomingCompany({ companies: TWO, isSuperAdmin: false })).toEqual({ companyId: "", rejected: false });
    expect(a.resolveIncomingCompany({ companies: ONE, isSuperAdmin: true })).toEqual({ companyId: "", rejected: false });
  });

  test("a delayed Company A drill-down cannot overwrite a later Company B one", () => {
    const guard = tb.createRequestGuard();
    const companyA = guard.next(); // A's request still in flight...
    guard.invalidate(); // ...a newer link (Company B) arrives
    const companyB = guard.next();
    expect(guard.isCurrent(companyA)).toBe(false);
    expect(guard.isCurrent(companyB)).toBe(true);
  });
});

describe("page wiring (source checks)", () => {
  const trialBalance = read("pages", "REPORTS", "TrialBalance.jsx");
  const analysis = read("pages", "REPORTS", "AccountAnalysis.jsx");

  test("Trial Balance opens Account Analysis with its selected company", () => {
    expect(trialBalance).toMatch(/navigate\(accountAnalysisLink\(\{ accountCode: row\.account_code, from: fromDate, to: toDate, companyId \}\)\)/);
    expect(trialBalance).not.toMatch(/`\/reports\/account-analysis\?accountCode=/);
  });

  test("Account Analysis reads companyId from the link and resolves it without fallback", () => {
    expect(analysis).toMatch(/requested: searchParams\.get\("companyId"\) \|\| ""/);
    expect(analysis).toMatch(/resolveIncomingCompany\(\{/);
    expect(analysis).not.toMatch(/companies\[0\]/);
  });

  test("requests carry the company; stale responses are dropped; nothing runs without a company", () => {
    expect(analysis).toMatch(/accountAnalysisQuery\(\{ from: finalFromDate, to: finalToDate, accountCode: finalAccountCode, companyId: finalCompanyId \}\)/);
    expect(analysis).toMatch(/\/api\/reports\/account-analysis\?\$\{query\}/);
    expect(analysis).not.toMatch(/account-analysis\?from=\$\{finalFromDate\}/);
    expect(analysis).toMatch(/if \(!requestGuard\.current\.isCurrent\(ticket\)\) return;/);
    expect(analysis).toMatch(/disabled=\{loading \|\| !companyId\}/);
    expect(analysis).toMatch(/Select a company to continue\./);
    expect(analysis).toMatch(/The company in this link is not available to you\./);
  });
});
