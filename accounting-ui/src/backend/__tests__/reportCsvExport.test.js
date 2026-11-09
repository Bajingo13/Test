const fs = require("fs");
const path = require("path");

// Report CSV export: every report's CSV is built from its generated data (never
// the HTML table), carries the period it was generated for, keeps amounts
// numeric, escapes text safely and is named after the report and its period.
// The repo's jest config is node-only (no jsdom), so the page wiring is checked
// at source level; the files themselves are checked in a real browser.

const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

// Page -> the file-name stem its CSV uses. Statements name their file through
// statementFilename(model); BookReport, the prepaid lists and the pinned
// legacy patterns pass their stem through a variable.
const CSV_PAGES = [
  "TrialBalance.jsx",
  "GeneralLedger.jsx",
  "AccountAnalysis.jsx",
  "SummaryOfBooksByTotals.jsx",
  "NetSummaryOfBooks.jsx",
  "IncomeStatement.jsx",
  "BalanceSheet.jsx",
  "CashFlowStatement.jsx",
  "DailyCashPositionReport.jsx",
  "ARAging.jsx",
  "ARAgingSummary.jsx",
  "APAging.jsx",
  "APAgingSummary.jsx",
  "SubsidiaryLedger.jsx",
  "ArStatementOfAccounts.jsx",
  "ArBillingsAndCollections.jsx",
  "ArOverdueAccounts.jsx",
  "ApListOfPayablesAndPayments.jsx",
  "ApOverdueAccounts.jsx",
  "BookReport.jsx",
  "FixedAssetReport.jsx",
  "FixedAssetLapsing.jsx",
  "PrepaidListReportBase.jsx",
  "PrepaidSubsidiary.jsx",
  "InputVAT.jsx",
  "OutputVAT.jsx",
  "EwtAudit.jsx",
];
const STATEMENTS = ["IncomeStatement.jsx", "BalanceSheet.jsx"];

describe("reportCsv.mjs - cells", () => {
  let C;
  beforeAll(async () => {
    C = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("plain numbers stay numeric: negatives are never prefixed by the formula guard", () => {
    expect(C.reportRowsToCsv([["-1120.00", 0, 25.5, "120000.00"]])).toBe('"-1120.00","0","25.5","120000.00"');
  });

  test("a real zero is kept, not blanked", () => {
    expect(C.reportRowsToCsv([[0, "0.00"]])).toBe('"0","0.00"');
  });

  test("commas, quotes and line breaks are escaped", () => {
    expect(C.reportRowsToCsv([['Paid "ABC, Inc."\nsecond line']])).toBe('"Paid ""ABC, Inc.""\nsecond line"');
  });

  test("text that would run as a spreadsheet formula is neutralised", () => {
    expect(C.reportRowsToCsv([["=HYPERLINK(1)", "+1+1", "@SUM(A1)", "-2+3"]])).toBe(`"'=HYPERLINK(1)","'+1+1","'@SUM(A1)","'-2+3"`);
  });

  test("dates, codes and blanks are text; empty rows stay empty lines", () => {
    expect(C.reportRowsToCsv([["2026-06-30", "1010", null, undefined, ""], []])).toBe('"2026-06-30","1010","","",""\n');
  });

  test("typed cells pass through unchanged", () => {
    expect(C.reportRowsToCsv([[{ t: "num", v: "-5.00" }, { t: "text", v: "=x" }]])).toBe(`"-5.00","'=x"`);
  });

  test("csvAmount is a two-decimal numeric cell, blank only when there is no value", () => {
    expect(C.csvAmount(1234.5)).toEqual({ t: "num", v: "1234.50" });
    expect(C.csvAmount("-80000")).toEqual({ t: "num", v: "-80000.00" });
    expect(C.csvAmount(0)).toEqual({ t: "num", v: "0.00" });
    expect(C.csvAmount(null)).toEqual({ t: "text", v: "" });
    expect(C.csvAmount("abc")).toEqual({ t: "text", v: "" });
  });

  test("every download is UTF-8 with a byte-order mark", () => {
    expect(read("reportCsv.mjs")).toMatch(/new Blob\(\[withUtf8Bom\(csvString\)\], \{ type: "text\/csv;charset=utf-8;" \}\)/);
    expect(C.withUtf8Bom("a")).toBe("﻿a");
  });
});

describe("reportPeriod.mjs - file names and period header", () => {
  let P;
  beforeAll(async () => {
    P = await import("../../pages/REPORTS/reportPeriod.mjs");
  });
  const range = () => P.resolvePeriod({ mode: P.RANGE, from: "2026-06-01", to: "2026-06-30" });
  const asOf = () => P.resolvePeriod({ mode: P.AS_OF, asOf: "2026-06-30" });

  test("file names say Range or As Of with ISO dates", () => {
    expect(P.reportCsvFilename("Trial_Balance", range())).toBe("Trial_Balance_Range_2026-06-01_to_2026-06-30.csv");
    expect(P.reportCsvFilename("Trial_Balance", asOf())).toBe("Trial_Balance_AsOf_2026-06-30.csv");
  });

  test("qualifiers are kept file-safe and empty ones are skipped", () => {
    expect(P.reportCsvFilename("Subsidiary_Ledger", range(), "AR", "C/001 Corp")).toBe("Subsidiary_Ledger_AR_C_001_Corp_Range_2026-06-01_to_2026-06-30.csv");
    expect(P.reportCsvFilename("Account_Analysis", asOf(), "", undefined)).toBe("Account_Analysis_AsOf_2026-06-30.csv");
    expect(P.reportFileStem("General_Ledger", asOf())).toBe("General_Ledger_AsOf_2026-06-30");
  });

  test("the period header is readable and machine-readable", () => {
    const cells = (rows) => rows.map((r) => r.map((c) => c.v));
    expect(cells(P.periodCsvRows(range()))).toEqual([
      ["Report Period", "June 1, 2026 - June 30, 2026"],
      ["Period Type", "Range"],
      ["Date From", "2026-06-01"],
      ["Date To", "2026-06-30"],
    ]);
    expect(cells(P.periodCsvRows(asOf()))).toEqual([
      ["Report Period", "As of June 30, 2026"],
      ["Period Type", "As Of"],
      ["As Of", "2026-06-30"],
    ]);
    expect(P.periodCsvRows(null)).toEqual([]);
  });
});

describe("statement CSV file names", () => {
  let S;
  let P;
  beforeAll(async () => {
    S = await import("../../pages/REPORTS/statementModel.mjs");
    P = await import("../../pages/REPORTS/reportPeriod.mjs");
  });

  test("a generated statement is named after its Range or As Of period", () => {
    const range = P.resolvePeriod({ mode: P.RANGE, from: "2026-06-01", to: "2026-06-30" });
    const asOf = P.resolvePeriod({ mode: P.AS_OF, asOf: "2026-06-30" });
    expect(S.statementFilename({ statement: "INCOME_STATEMENT", mode: "condensed", reportPeriod: range })).toBe("Income_Statement_Range_2026-06-01_to_2026-06-30.csv");
    expect(S.statementFilename({ statement: "BALANCE_SHEET", mode: "detailed", reportPeriod: asOf })).toBe("Balance_Sheet_Detailed_AsOf_2026-06-30.csv");
  });
});

describe("source guards - every report page", () => {
  test.each(CSV_PAGES)("%s exports CSV from its data with the period header", (file) => {
    const src = read(file);
    // From generated data, never the rendered table.
    expect(src).not.toMatch(/querySelector|innerText|outerHTML|\btable\.rows\b|tableToCsv/);
    // No hand-rolled serializer: every CSV goes through reportCsv.mjs.
    expect(src).not.toMatch(/const csvContent =/);
    expect(src).not.toMatch(/function csvEscape/);
    expect(src).toMatch(/from "\.\/reportCsv(\.mjs)?";/);
    if (STATEMENTS.includes(file)) {
      expect(src).toMatch(/reportPeriod: applied, reportPeriodLines: reportPeriodLineList\(applied\)/);
      expect(src).toMatch(/downloadCsvText\(statementFilename\(model\), statementToCsv\(model\)\)/);
    } else {
      expect(src).toMatch(/\.\.\.periodCsvRows\(period\.applied\)/);
      expect(src).toMatch(/reportCsvFilename\(|periodFileSlug\(period\.applied\)/);
    }
  });

  test.each(CSV_PAGES.filter((f) => !STATEMENTS.includes(f)))("%s offers a CSV export control", (file) => {
    expect(read(file)).toMatch(/Export CSV|onExportCsv=\{/);
  });

  test("the prepaid lists each name their own CSV file", () => {
    for (const [file, prefix] of [
      ["ListOfPrepaidAccounts.jsx", "List_of_Prepaid_Accounts"],
      ["PrepaymentLapsingReport.jsx", "Prepayment_Lapsing"],
      ["ListOfLapsedPrepayments.jsx", "List_of_Lapsed_Prepayments"],
    ]) {
      expect(read(file)).toMatch(new RegExp(`filenamePrefix="${prefix}"`));
    }
  });

  test("Form 2307 and the Alphalists are not part of this change", () => {
    expect(read("Form2307.jsx")).not.toMatch(/periodCsvRows|reportCsvFilename/);
    expect(read("AlphalistReportBase.jsx")).not.toMatch(/periodCsvRows|reportCsvFilename/);
  });
});
