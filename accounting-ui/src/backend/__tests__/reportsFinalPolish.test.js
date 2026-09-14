const fs = require("fs");
const path = require("path");

// Reports Final Polish: (A) the mislabeled "Cash Flow Statement" report is
// renamed to "Bank & Cash Movement Report" - user-facing text only, route
// and API paths kept for compatibility; (B) CSV export parity is added to
// Subsidiary Ledger, Output VAT, Input VAT, and both Alphalists (via the
// shared AlphalistReportBase), all built on one shared src/pages/REPORTS/
// reportCsv.mjs helper rather than five new inline copies.
//
// jest here is testEnvironment: "node" with no jsdom - so this is a
// source-structure test for the pages plus a real logic test of the pure
// CSV helper via dynamic import(), matching the .mjs pattern used
// elsewhere (accountSearch.mjs, dateRangeFilter.mjs, ...).

const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

describe("reportCsv.mjs shared helper - CSV safety", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("csvCell always quotes and doubles embedded quotes", () => {
    expect(M.csvCell("plain")).toBe('"plain"');
    expect(M.csvCell('has "quote"')).toBe('"has ""quote"""');
    expect(M.csvCell("a,b")).toBe('"a,b"');
    expect(M.csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  test("csvCell renders null/undefined as an empty quoted cell, and numbers as-is", () => {
    expect(M.csvCell(null)).toBe('""');
    expect(M.csvCell(undefined)).toBe('""');
    expect(M.csvCell(0)).toBe('"0"');
    expect(M.csvCell("1234.50")).toBe('"1234.50"'); // caller pre-formats precision
  });

  test("rowsToCsv joins cells with commas and rows with newlines, every cell quoted", () => {
    const out = M.rowsToCsv([
      ["DATE", "REF", "AMOUNT"],
      ["2027-01-01", "INV, 001", "1000.00"],
    ]);
    expect(out).toBe(
      '"DATE","REF","AMOUNT"\n"2027-01-01","INV, 001","1000.00"'
    );
  });

  test("a value containing a comma, a quote and a newline round-trips without breaking columns", () => {
    const nasty = 'Payee "X", Inc.\nSecond line';
    const line = M.rowsToCsv([[nasty, "ok"]]);
    // exactly one row, two fully-quoted fields separated by a top-level comma
    expect(line).toBe('"Payee ""X"", Inc.\nSecond line","ok"');
  });

  test("downloadCsv is exported (browser-only, not invoked here)", () => {
    expect(typeof M.downloadCsv).toBe("function");
  });
});

describe("Cash Flow -> Bank & Cash Movement Report rename", () => {
  const cf = read("CashFlowStatement.jsx");
  const nav = fs.readFileSync(
    path.join(__dirname, "../../components/sidebar/reportsMenuConfig.js"),
    "utf8"
  );
  const app = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");

  test("page heading and report/print heading say 'Bank & Cash Movement Report'", () => {
    expect(cf).toMatch(/<h1>Bank &amp; Cash Movement Report<\/h1>/);
    expect(cf).toMatch(/<h2>BANK &amp; CASH MOVEMENT REPORT<\/h2>/);
  });

  test("CSV and Excel export titles/filenames are renamed", () => {
    expect(cf).toMatch(/\["BANK & CASH MOVEMENT REPORT"\]/);
    expect(cf).toMatch(/BANK &amp; CASH MOVEMENT REPORT<\/th>/);
    expect(cf).toMatch(/Bank_And_Cash_Movement_\$\{toDate\}\.csv/);
    expect(cf).toMatch(/Bank_And_Cash_Movement_\$\{toDate\}\.xls/);
  });

  test("no user-facing string still calls it a 'Cash Flow Statement' (the explanatory comment may)", () => {
    const userFacing = cf
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(/Cash Flow Statement/i.test(userFacing)).toBe(false);
  });

  test("it does not claim Operating/Investing/Financing or Direct/Indirect method to the user", () => {
    const userFacing = cf
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(/Operating Activities|Investing Activities|Financing Activities|Direct Method|Indirect Method/i.test(userFacing)).toBe(false);
  });

  test("a plain-language description subtitle is shown", () => {
    expect(cf).toMatch(/opening balances, cash\/bank account movements, inflows, outflows, and\s*ending balances/);
  });

  test("route and API paths are unchanged (backward compatibility)", () => {
    expect(cf).toMatch(/\/api\/reports\/cash-flow-statement/);
    expect(app).toMatch(/path="\/reports\/cash-flow-statement"/);
    expect(nav).toMatch(/path: "\/reports\/cash-flow-statement"/);
  });

  test("nav label is renamed but its path/id are not", () => {
    expect(nav).toMatch(/label: "Bank & Cash Movement Report", icon: Waves, path: "\/reports\/cash-flow-statement"/);
    expect(nav).toMatch(/id: "cash-flow"/);
  });
});

describe("CSV export parity - Subsidiary Ledger / Output VAT / Input VAT / Alphalists", () => {
  const PAGES = ["SubsidiaryLedger.jsx", "OutputVAT.jsx", "InputVAT.jsx", "AlphalistReportBase.jsx"];

  test("each newly-covered page imports the ONE shared reportCsv helper (no new inline exporters)", () => {
    for (const p of PAGES) {
      const src = read(p);
      expect(src).toMatch(/import \{ downloadCsv \} from "\.\/reportCsv"/);
      expect(src).toMatch(/function exportCSV\(\)/);
      expect(src).toMatch(/downloadCsv\(/);
      // must not have hand-rolled its own Blob/CSV builder
      expect(src).not.toMatch(/new Blob\(\[.*csv/i);
    }
  });

  test("each newly-covered page renders an 'Export CSV' button next to Export PDF", () => {
    for (const p of PAGES) {
      const src = read(p);
      expect(src).toMatch(/onClick=\{exportCSV\}>\s*Export CSV/);
      expect(src).toMatch(/window\.print\(\)/); // existing print behaviour untouched
    }
  });

  test("the two Alphalists share one CSV implementation via AlphalistReportBase", () => {
    const ewt = read("MonthlyExpandedTaxAlphalist.jsx");
    const finalTax = read("MonthlyFinalTaxAlphalist.jsx");
    expect(ewt).toMatch(/AlphalistReportBase/);
    expect(finalTax).toMatch(/AlphalistReportBase/);
    // neither wrapper defines its own exportCSV
    expect(ewt).not.toMatch(/exportCSV|downloadCsv/);
    expect(finalTax).not.toMatch(/exportCSV|downloadCsv/);
    expect(read("AlphalistReportBase.jsx")).toMatch(/BOTH the Expanded Withholding Tax Alphalist/);
  });

  test("Output VAT CSV keeps STANDARD / ZERO-RATED / EXEMPT / VAT columns and does not touch report logic", () => {
    const src = read("OutputVAT.jsx");
    expect(src).toMatch(/VATABLE SALES \(STANDARD\)/);
    expect(src).toMatch(/ZERO-RATED SALES/);
    expect(src).toMatch(/VAT-EXEMPT SALES/);
    expect(src).toMatch(/VAT AMOUNT/);
    // still the same endpoint, still structured-vs-GL fallback untouched
    expect(src).toMatch(/\/api\/reports\/output-vat\?/);
  });

  test("Input VAT still reuses the Account Analysis endpoint (no new backend)", () => {
    const src = read("InputVAT.jsx");
    expect(src).toMatch(/\/api\/reports\/account-analysis\?/);
    expect(src).not.toMatch(/\/api\/reports\/input-vat/);
  });

  test("regression: EWT Audit and the renamed Bank & Cash Movement report still have CSV", () => {
    expect(read("EwtAudit.jsx")).toMatch(/Export CSV/);
    expect(read("CashFlowStatement.jsx")).toMatch(/Export CSV/);
  });
});
