// Trial Balance page company context: pure helpers (trialBalanceCompany.mjs,
// real ESM loaded via dynamic import like the other utils tests) plus
// source checks that the page and the checker panel are wired to them.
const fs = require("fs");
const path = require("path");

let t;
beforeAll(async () => {
  t = await import("../trialBalanceCompany.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const params = (s) => Object.fromEntries(new URLSearchParams(s));

const ONE = [{ id: 7, name: "Only Co" }];
const TWO = [{ id: 3, name: "Low Co" }, { id: 9, name: "High Co" }];

describe("initial company selection", () => {
  test("a user with exactly one company gets it automatically, and it is locked", () => {
    expect(t.pickInitialCompany({ companies: ONE, isSuperAdmin: false })).toBe("7");
    expect(t.isCompanyLocked({ companies: ONE, isSuperAdmin: false })).toBe(true);
  });

  test("a multi-company user must choose - no first/lowest company", () => {
    expect(t.pickInitialCompany({ companies: TWO, isSuperAdmin: false })).toBe("");
    expect(t.isCompanyLocked({ companies: TWO, isSuperAdmin: false })).toBe(false);
  });

  test("a Super Admin must choose - even with a single company in the system", () => {
    expect(t.pickInitialCompany({ companies: ONE, isSuperAdmin: true })).toBe("");
    expect(t.pickInitialCompany({ companies: TWO, isSuperAdmin: true })).toBe("");
    expect(t.isCompanyLocked({ companies: ONE, isSuperAdmin: true })).toBe(false);
  });

  test("a still-valid current choice is kept; a vanished one is dropped", () => {
    expect(t.pickInitialCompany({ companies: TWO, isSuperAdmin: true, current: "9" })).toBe("9");
    expect(t.pickInitialCompany({ companies: TWO, isSuperAdmin: true, current: "42" })).toBe("");
    expect(t.pickInitialCompany({ companies: [], isSuperAdmin: false })).toBe("");
  });
});

describe("requests carry the selected company", () => {
  test("report query has from / to / companyId", () => {
    expect(params(t.trialBalanceQuery({ from: "2026-01-01", to: "2026-01-31", companyId: "9" }))).toEqual({ from: "2026-01-01", to: "2026-01-31", companyId: "9" });
  });

  test("status query has from / to / tolerance / companyId", () => {
    expect(params(t.trialBalanceStatusQuery({ from: "2026-01-01", to: "2026-01-31", tolerance: "0.01", companyId: 3 }))).toEqual({ from: "2026-01-01", to: "2026-01-31", tolerance: "0.01", companyId: "3" });
  });

  test("no (or an invalid) company -> no request at all", () => {
    for (const companyId of ["", null, undefined, "0", "abc", "1 OR 1=1"]) {
      expect(t.trialBalanceQuery({ from: "a", to: "b", companyId })).toBeNull();
      expect(t.trialBalanceStatusQuery({ from: "a", to: "b", tolerance: "0", companyId })).toBeNull();
    }
  });
});

describe("stale responses", () => {
  test("a company switch invalidates in-flight requests for the previous company", () => {
    const guard = t.createRequestGuard();
    const companyARequest = guard.next();
    guard.invalidate(); // user switched A -> B
    const companyBRequest = guard.next();
    expect(guard.isCurrent(companyARequest)).toBe(false);
    expect(guard.isCurrent(companyBRequest)).toBe(true);
  });

  test("a status response only counts for the company it was asked about", () => {
    expect(t.statusMatchesCompany({ companyId: 9, status: "BALANCED" }, "9")).toBe(true);
    expect(t.statusMatchesCompany({ companyId: 3, status: "UNBALANCED" }, "9")).toBe(false);
    expect(t.statusMatchesCompany(null, "9")).toBe(false);
  });
});

describe("page and panel wiring (source checks)", () => {
  const page = read("pages", "REPORTS", "TrialBalance.jsx");
  const panel = read("components", "TrialBalanceCheckerPanel.jsx");

  test("the existing Company filter is the source of truth (no static placeholder)", () => {
    expect(page).toMatch(/<select\s+id="tb-company"\s+value=\{companyId\}\s+onChange=\{\(e\) => changeCompany\(e\.target\.value\)\}/);
    expect(page).not.toMatch(/<select>\s*<option>Select Company<\/option>\s*<\/select>/);
    expect(page).toMatch(/pickInitialCompany\(\{ companies: list, isSuperAdmin, current \}\)/);
  });

  test("report and status requests are built from the selected company only", () => {
    expect(page).toMatch(/trialBalanceQuery\(\{ from: fromDate, to: toDate, companyId: forCompanyId \}\)/);
    expect(page).toMatch(/\/api\/reports\/trial-balance\?\$\{query\}/);
    expect(page).toMatch(/trialBalanceStatusQuery\(\{ from: fromDate, to: toDate, tolerance: "0\.01", companyId: forCompanyId \}\)/);
    expect(page).toMatch(/\/api\/reports\/trial-balance-checker\/status\?\$\{query\}/);
    expect(page).not.toMatch(/trial-balance\?from=\$\{fromDate\}/);
  });

  test("nothing runs until a company is selected; lookup failure blocks requests", () => {
    expect(page).toMatch(/disabled=\{loading \|\| !companyId\}/);
    expect(page).toMatch(/Select a company to continue\./);
    expect(page).toMatch(/Unable to load your companies, so the Trial Balance cannot be generated\./);
    expect(page).toMatch(/onClick=\{loadCompanies\}/);
  });

  test("switching company clears the previous company's data and drops its in-flight responses", () => {
    const change = page.slice(page.indexOf("function changeCompany"), page.indexOf("async function generateTrialBalance"));
    expect(change).toMatch(/requestGuard\.current\.invalidate\(\)/);
    expect(change).toMatch(/setRows\(\[\]\)/);
    expect(change).toMatch(/setBalanceStatus\(null\)/);
    expect(change).toMatch(/setCheckerOpen\(false\)/);
    expect(page).toMatch(/if \(!requestGuard\.current\.isCurrent\(ticket\)\) return;/);
    expect(page).toMatch(/statusMatchesCompany\(data, forCompanyId\)/);
  });

  test("the checker uses the page's company - it has no company picker of its own", () => {
    expect(page).toMatch(/<TrialBalanceCheckerPanel\s+open=\{checkerOpen\}\s+companyId=\{companyId\}/);
    expect(panel).toMatch(/function TrialBalanceCheckerPanel\(\{ open, companyId, companyName,/);
    expect(panel).not.toMatch(/\/api\/companies/);
    expect(panel).toMatch(/body: JSON\.stringify\(\{ from, to, tolerance, companyId: Number\(companyId\) \}\)/);
    expect(panel).toMatch(/disabled=\{checking \|\| !companyId\}/);
  });
});
