const fs = require("fs");
const path = require("path");

// Report accessibility follow-up (integration audit), UI side - source guards
// (node-only jest; the screens are verified in a real browser separately).

const SRC = path.join(__dirname, "../..");
const REPORTS = path.join(SRC, "pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8").replace(/\r\n/g, "\n");
const readSrc = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");

describe("Prepaid Subsidiary picker", () => {
  const src = read("PrepaidSubsidiary.jsx");
  test("loads from the two report endpoints, never from the File Setup list", () => {
    expect(src).toContain('["/api/reports/prepaid-list", "/api/reports/lapsed-prepayments"]');
    expect(src).not.toMatch(/\/api\/prepaid-accounts/);
  });
  test("merges by id, newest first; a refused list is skipped without a native alert", () => {
    expect(src).toMatch(/for \(const p of lists\.flat\(\)\) byId\.set\(p\.id, p\);/);
    expect(src).toMatch(/sort\(\(x, y\) => Number\(y\.id\) - Number\(x\.id\)\)/);
    const load = src.slice(src.indexOf("async function loadPrepaidAccounts"), src.indexOf("const formatMoney"));
    expect(load).toContain("if (!res.ok) return [];");
    expect(load).not.toMatch(/alert\(/);
  });
  test("the picker still offers code - description and keeps its in-page validation", () => {
    expect(src).toMatch(/\{p\.prepaidCode\} - \{p\.description\}/);
    expect(src).toContain('id="pps-validation"');
  });
});

describe("Group Codes", () => {
  test("a 403 on load leaves the in-page permission message, with no native alert", () => {
    const src = readSrc("pages/FILESETUP/GroupCodes.jsx");
    expect(src).toMatch(/if \(res\.status === 403\) return; \/\/ the page shows its no-permission message\n\s*alert\(data\.message \|\| "Failed to load group codes\."\);/);
    expect(src).toMatch(/const canView = permsLoading \|\| can\(MODULE_KEY, "VIEW"\);/);
  });
  test("the sidebar hides mapped paths the user lacks (unmapped paths stay visible)", () => {
    expect(readSrc("components/sidebar/pathPermissionMap.js")).toMatch(/export function pathAllowed\(path, can\) \{\s*const mapping = PATH_PERMISSIONS\[path\];\s*if \(!mapping\) return true;[^\n]*\n\s*return can\(mapping\[0\], mapping\[1\]\);/);
    expect(readSrc("components/sidebar/NavTree.jsx")).toContain('import { pathAllowed } from "./pathPermissionMap";');
  });
});

describe("dark-mode report filter fields", () => {
  const css = read("ReportFilterFields.css");
  const GRIDS = ":is(.lgr-filter-grid, .aa-filter-grid, .tb-filter-grid, .is-grid)";
  test("text, placeholder and dropdown options use the theme tokens; native controls follow the dark scheme", () => {
    expect(css).toContain(`[data-theme="dark"] ${GRIDS} :is(input, select, textarea) {\n  color: var(--text-primary);`);
    expect(css).toMatch(/color-scheme: dark;/);
    expect(css).toContain(`[data-theme="dark"] ${GRIDS} :is(input, textarea)::placeholder {\n  color: var(--text-secondary);\n  opacity: 1;`);
    expect(css).toContain(`[data-theme="dark"] ${GRIDS} select option {\n  background: var(--bg-surface);\n  color: var(--text-primary);`);
  });
  test("light mode is untouched: every rule is scoped to the dark theme", () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g).map((s) => s.trim());
    expect(selectors.length).toBe(3);
    for (const s of selectors) expect(s.startsWith('[data-theme="dark"] ')).toBe(true);
  });
  test("imported first by each shared report stylesheet (so page :disabled / :focus rules still win)", () => {
    for (const f of ["LedgerReport.css", "AccountAnalysis.css", "TrialBalance.css", "IncomeStatement.css"]) {
      expect([f, read(f).split("\n")[0]]).toEqual([f, '@import "./ReportFilterFields.css"; /* shared dark-mode filter-field readability */']);
    }
  });
  test("those four grids are the field containers of the affected reports", () => {
    expect(read("ApStatementOfAccounts.jsx")).toMatch(/className="lgr-filter-grid"/);
    expect(read("GeneralLedger.jsx")).toMatch(/className="lgr-filter-grid"/);
    expect(read("TrialBalance.jsx")).toMatch(/className="tb-filter-grid"/);
    expect(read("IncomeStatement.jsx")).toMatch(/className="is-grid"/);
  });
});

describe("Income Statement / Balance Sheet: no page-level horizontal scroll", () => {
  test("Income Statement: same four columns allowed to shrink (1024px), one column under 900px, page root contained (390px)", () => {
    const css = read("IncomeStatement.css");
    const tail = css.slice(css.indexOf("/* Responsive layout (integration audit)"));
    expect(tail).toMatch(/\.is-page \{\s*contain: inline-size;\s*\}/);
    expect(tail).toMatch(/\.is-grid \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\) !important;\s*\}/);
    expect(tail).toMatch(/@media \(max-width: 900px\) \{\s*\.is-grid \{\s*grid-template-columns: 1fr !important;/);
    expect(tail).toMatch(/\.is-grid > div \{\s*min-width: 0;\s*\}/);
  });
  test("Balance Sheet: same three columns allowed to shrink, one column on phones, actions wrap, page root contained", () => {
    const css = read("BalanceSheet.css");
    const tail = css.slice(css.indexOf("/* Responsive layout (integration audit)"));
    expect(tail).toMatch(/\.bs-page \{\s*contain: inline-size;\s*\}/);
    expect(tail).toMatch(/\.bs-grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*\}/);
    expect(tail).toMatch(/@media \(max-width: 600px\) \{\s*\.bs-grid \{\s*grid-template-columns: 1fr;/);
    expect(tail).toMatch(/\.bs-actions \{\s*flex-wrap: wrap;\s*\}/);
  });
});
