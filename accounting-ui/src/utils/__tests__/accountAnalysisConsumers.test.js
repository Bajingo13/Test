// Account Analysis entry points (Phase 8): source checks that every page
// reaching Account Analysis hands over an explicit company, plus the link
// helper with the server-provided statement company.
const fs = require("fs");
const path = require("path");

let a;
beforeAll(async () => {
  a = await import("../accountAnalysisCompany.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const linkCompany = (link) => new URL(link, "http://x").searchParams.get("companyId");

describe("statement drill-down link", () => {
  test("the statement's own company (a number from the server) is carried; A stays A, B stays B", () => {
    expect(linkCompany(a.accountAnalysisLink({ accountCode: "1001", from: "f", to: "t", companyId: 3 }))).toBe("3");
    expect(linkCompany(a.accountAnalysisLink({ accountCode: "1001", from: "f", to: "t", companyId: 9 }))).toBe("9");
  });

  test("no statement yet / no company in its meta -> no companyId (Account Analysis then asks)", () => {
    expect(linkCompany(a.accountAnalysisLink({ accountCode: "1001", from: "f", to: "t", companyId: undefined }))).toBeNull();
  });
});

describe("entry points (source checks)", () => {
  test("Balance Sheet and Income Statement link with the displayed statement's company", () => {
    for (const f of ["BalanceSheet.jsx", "IncomeStatement.jsx"]) {
      const src = read("pages", "REPORTS", f);
      expect(src).toMatch(/navigate\(accountAnalysisLink\(\{ accountCode, from: [^}]*, companyId: model\?\.meta\?\.companyId \}\)\)/);
      expect(src).not.toMatch(/`\/reports\/account-analysis\?accountCode=/);
    }
  });

  test("Input VAT requests Account Analysis data with its selected company, guarded against stale responses", () => {
    const src = read("pages", "REPORTS", "InputVAT.jsx");
    expect(src).toMatch(/accountAnalysisQuery\(\{ from: fromDate, to: toDate, accountCode, companyId \}\)/);
    expect(src).toMatch(/\/api\/reports\/account-analysis\?\$\{query\}/);
    expect(src).not.toMatch(/account-analysis\?from=\$\{fromDate\}/);
    expect(src).toMatch(/pickInitialCompany\(\{ companies: list, isSuperAdmin, current \}\)/);
    expect(src).toMatch(/if \(!requestGuard\.current\.isCurrent\(ticket\)\) return;/);
    expect(src).toMatch(/disabled=\{loading \|\| !companyId\}/);
    expect(src).toMatch(/Select a company to continue\./);
  });

  test("Account Analysis CSV and Excel exports name the displayed company", () => {
    const src = read("pages", "REPORTS", "AccountAnalysis.jsx");
    expect(src).toMatch(/\[`Company: \$\{selectedCompany\?\.name \|\| ""\}`\]/);
    expect(src).toMatch(/<tr><th colspan="5">Company: \$\{selectedCompany\?\.name \|\| ""\}<\/th><\/tr>/);
  });

  // The Dashboard now has a company context (its own Company filter, same
  // rules as Trial Balance), so its Account Analysis button follows the
  // Income Statement / Balance Sheet rule: the displayed summary's company,
  // and none before a summary is on screen (Account Analysis then asks).
  test("Dashboard links Account Analysis with the displayed summary's company only", () => {
    const src = read("pages", "DASHBOARD", "dashboard.jsx");
    expect(src).toMatch(/navigate\(accountAnalysisLink\(\{ accountCode: "", from: summary\?\.meta\?\.from, to: summary\?\.meta\?\.to, companyId: summary\?\.meta\?\.companyId \}\)\)/);
    expect(src).not.toMatch(/navigate\("\/reports\/account-analysis/);
    expect(src).not.toMatch(/companies\[0\]/);
  });
});
