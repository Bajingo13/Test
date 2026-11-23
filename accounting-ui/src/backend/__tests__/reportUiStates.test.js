const fs = require("fs");
const path = require("path");

// Reports part 2 (source guards; node-only jest, no jsdom - the screens are
// verified in a real browser separately):
//   - validation and generation-failure messages are in-page role="alert"
//     blocks instead of native alert() on the report pages;
//   - Trial Balance Status is informational (the Trial Balance is
//     Posted-only); its Branch filter is the real Multi-Branch selector;
//   - TC-REPORT-015 AP Statement of Accounts page is registered and wired.

const SRC = path.join(__dirname, "../..");
const REPORTS = path.join(SRC, "pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");
const readSrc = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

describe("validation messages replace the native 'Please select ...' alerts", () => {
  const PAGES = {
    "SubsidiaryLedger.jsx": ["sl-validation", 'Please select a ${ledgerType === "AR" ? "customer" : "supplier"} first.'],
    "AccountAnalysis.jsx": ["aa-validation", "Please select an account first."],
    "InputVAT.jsx": ["ivat-validation", "Please select the Input VAT account first."],
    "PrepaidSubsidiary.jsx": ["pps-validation", "Please select a prepaid account first."],
  };
  for (const [file, [id, text]] of Object.entries(PAGES)) {
    test(`${file}: same message, in-page and announced; cleared when the check passes`, () => {
      const src = read(file);
      expect(src).not.toMatch(/alert\(["`]Please select/);
      expect(src).toContain(text);
      expect(src).toMatch(new RegExp(`<p className="aa-error" role="alert" id="${id}">`));
      expect(src).toMatch(/setValidationError\([^)]+\);\s*return;\s*}\s*setValidationError\(""\);/);
    });
  }
  test("the message style uses theme tokens (readable in both themes)", () => {
    expect(read("AccountAnalysis.css")).toMatch(/\.aa-page \.aa-error \{[\s\S]*?background: var\(--danger-bg\);\s*color: var\(--danger-text\);/);
  });
});

describe("generation failures are in-page messages, not native alerts", () => {
  const PAGES = {
    "ARAging.jsx": ["generateReport", "tb-company-message error", "ara-error"],
    "APAging.jsx": ["generateReport", "tb-company-message error", "apa-error"],
    "TrialBalance.jsx": ["generateTrialBalance", "tb-company-message error", "tb-error"],
    "GeneralLedger.jsx": ["generateReport", "lgr-error", "gl-error"],
    "SubsidiaryLedger.jsx": ["generateReport", "aa-error", "sl-error"],
    "AccountAnalysis.jsx": ["generateReport", "aa-error", "aa-error"],
    "InputVAT.jsx": ["generateReport", "aa-error", "ivat-error"],
    "OutputVAT.jsx": ["generateReport", "aa-error", "ovat-error"],
    "PrepaidSubsidiary.jsx": ["generateReport", "aa-error", "pps-error"],
  };
  for (const [file, [fn, cls, id]] of Object.entries(PAGES)) {
    test(`${file}: failure shown in-page; a 400 / 403 server message (e.g. no permission) is shown instead of the generic text`, () => {
      const src = read(file);
      const gen = src.slice(src.indexOf(`async function ${fn}`));
      const body = gen.slice(0, gen.indexOf("\n  }\n") > 0 ? gen.indexOf("\n  }\n") : undefined);
      expect(body).not.toMatch(/alert\(/);
      expect(body).toMatch(/setReportError\(err\.userMessage \|\| "Failed to generate[^"]*"\);/);
      expect(body).toMatch(/res\.status === 400 \|\| res\.status === 403 \? \w+\?\.message : null/);
      expect(body).toMatch(/setReportError\(""\);/);
      expect(src).toContain(`<div className="${cls}" role="alert" id="${id}">`);
    });
  }
});

describe("Trial Balance Status is informational; Branch is the real Multi-Branch selector", () => {
  const src = read("TrialBalance.jsx");
  test("Status is disabled, described, and only offers what the report does", () => {
    expect(src).toMatch(/<select id="tb-status" disabled aria-describedby="tb-status-note">\s*<option>Posted<\/option>\s*<\/select>/);
    expect(src).not.toMatch(/<option>Draft<\/option>/);
    expect(src).toMatch(/id="tb-status-note"[\s\S]*?Only posted transactions are included/);
  });
  test("the pre-Multi-Branch hard-coded 'All Branches' control and its note are gone", () => {
    expect(src).not.toMatch(/<option>All Branches<\/option>/);
    expect(src).not.toMatch(/tb-branch-note/);
    expect(src).not.toMatch(/not tagged by branch/);
    expect(src).not.toMatch(/Branch \/ Department/);
    // the page declares no branch control of its own ...
    expect(src).not.toMatch(/id="tb-branch"/);
    expect(src).not.toMatch(/htmlFor="tb-branch"/);
  });
  test("exactly one Branch selector: the shared ReportPeriodFilter's, as tb-branch", () => {
    expect(src.match(/<ReportPeriodFilter\b/g)).toHaveLength(1);
    expect(src).toMatch(/<ReportPeriodFilter period=\{period\} idPrefix="tb" \/>/);
    const filter = read("ReportPeriodFilter.jsx");
    expect(filter).toContain("htmlFor={`${idPrefix}-branch`}");
    expect(filter).toContain("id={`${idPrefix}-branch`}");
  });
  test("the backend rule they describe: the Trial Balance union is Posted-only", () => {
    const svc = readSrc("backend/services/trialBalanceDifferenceService.js");
    expect(svc).toMatch(/postedOnlySql\("h"\)/);
  });
  test("disabled controls stay readable", () => {
    expect(read("TrialBalance.css")).toMatch(/\.tb-page \.tb-filter-grid select:disabled \{[\s\S]*?color: var\(--text-primary\);[\s\S]*?opacity: 1;/);
  });
});

describe("TC-REPORT-015 AP Statement of Accounts page", () => {
  const page = read("ApStatementOfAccounts.jsx");
  test("supplier picker, AP endpoint, in-page validation / error, export + print", () => {
    expect(page).toMatch(/p\.type === "SUPPLIER" && p\.status === "ACTIVE"/);
    expect(page).toContain("/api/reports/ap-statement-of-accounts");
    expect(page).toContain('setError("Please select a supplier.");');
    expect(page).toContain('<div className="lgr-error" role="alert">');
    expect(page).toMatch(/onPrint=\{\(\) => window\.print\(\)\}/);
    expect(page).toMatch(/onExportCsv=\{exportCSV\}/);
    expect(page).toContain("`AP_Statement_of_Accounts_${safeTo}.csv`");
    expect(page).toMatch(/<label htmlFor="aps-supplier">Supplier<\/label>/);
    expect(page).not.toMatch(/alert\(/);
  });
  test("registered: route, sidebar menu (AP reports), path permission REPORTS.AP VIEW", () => {
    expect(readSrc("App.jsx")).toMatch(/<Route path="\/reports\/ap-statement-of-accounts" element=\{<ApStatementOfAccounts \/>\} \/>/);
    expect(readSrc("components/sidebar/pathPermissionMap.js")).toMatch(/"\/reports\/ap-statement-of-accounts": \["REPORTS\.AP", "VIEW"\]/);
    const menu = readSrc("components/sidebar/reportsMenuConfig.js");
    const ap = menu.slice(menu.indexOf('id: "ap-reports"'), menu.indexOf('id: "books-of-accounts"'));
    expect(ap).toContain('path: "/reports/ap-statement-of-accounts"');
  });
  test("server route mirrors the AR statement checks under REPORTS.AP", () => {
    const server = readSrc("backend/server.js");
    expect(server).toMatch(/app\.get\("\/api\/reports\/ap-statement-of-accounts", authenticateToken, authorizePermission\("REPORTS\.AP", "VIEW"\)/);
    const route = server.slice(server.indexOf('app.get("/api/reports/ap-statement-of-accounts"'));
    expect(route.slice(0, 1600)).toMatch(/partyRows\[0\]\.company_id !== companyId/);
  });
  test("the AR statement service (P0) is not modified by the AP statement", () => {
    expect(readSrc("backend/services/ArStatementService.js")).not.toMatch(/AP STATEMENT|ApStatement/);
  });
});

describe("out of scope on purpose", () => {
  test("Form 2307 page (in-progress BIR 2307 work elsewhere) keeps its own alerts", () => {
    expect(read("Form2307.jsx")).toMatch(/alert\("Please select a payee \(supplier\) first\."\)/);
  });
});
