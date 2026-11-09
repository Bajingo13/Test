const fs = require("fs");
const path = require("path");
const backend = require("../lib/reportPeriod");

// Global report date standard - pure logic and source guards. The repo's jest
// config is node-only (no jsdom), so the page wiring is checked at source
// level; what each mode returns is covered by reportPeriod.http.test.js.

const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

// Every report page that owns a reporting-period date selection. The Books of
// Accounts all render through BookReport.jsx; both prepaid lists and the
// lapsing report through PrepaidListReportBase.jsx.
const REPORT_PAGES = [
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

describe("reportPeriod.mjs", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportPeriod.mjs");
  });

  describe("validation", () => {
    const range = (from, to) => ({ mode: M.RANGE, from, to, asOf: "" });

    test("RANGE requires Date From and Date To, in order", () => {
      expect(M.validatePeriod(range("", "2026-06-30")).message).toBe("Date From is required.");
      expect(M.validatePeriod(range("2026-06-01", "")).message).toBe("Date To is required.");
      expect(M.validatePeriod(range("2026-06-30", "2026-06-01")).message).toBe("Date From cannot be later than Date To.");
      expect(M.validatePeriod(range("2026-06-30", "2026-06-30"))).toBeNull();
      expect(M.validatePeriod(range("2026-06-01", "2026-06-30"))).toBeNull();
    });

    test("RANGE rejects dates that do not exist", () => {
      expect(M.validatePeriod(range("2026-02-31", "2026-06-30")).code).toBe("FROM_REQUIRED");
    });

    test("DATE / AS OF requires only the As Of Date", () => {
      expect(M.validatePeriod({ mode: M.AS_OF, asOf: "" }).message).toBe("As Of Date is required.");
      expect(M.validatePeriod({ mode: M.AS_OF, from: "2026-07-01", to: "2026-01-01", asOf: "2026-06-30" })).toBeNull();
    });
  });

  describe("printed labels", () => {
    test("RANGE: REPORT PERIOD plus DATE FROM / DATE TO", () => {
      const period = M.resolvePeriod({ mode: M.RANGE, from: "2026-06-01", to: "2026-06-30" });
      expect(M.reportPeriodLines(period)).toEqual({
        primary: "REPORT PERIOD: June 1, 2026 - June 30, 2026",
        secondary: "DATE FROM: JUNE 1, 2026 | DATE TO: JUNE 30, 2026",
      });
      expect(M.reportPeriodText(period)).toBe("REPORT PERIOD: June 1, 2026 - June 30, 2026");
    });

    test("DATE / AS OF: AS OF only", () => {
      const period = M.resolvePeriod({ mode: M.AS_OF, asOf: "2026-06-30" });
      expect(M.reportPeriodLines(period)).toEqual({ primary: "AS OF: June 30, 2026", secondary: "" });
      expect(M.reportPeriodLineList(period)).toEqual(["AS OF: June 30, 2026"]);
    });

    test("a label is never shifted a day by the browser's time zone", () => {
      expect(M.formatLongDate("2026-01-01")).toBe("January 1, 2026");
      expect(M.formatLongDate("2026-12-31")).toBe("December 31, 2026");
    });

    test("no snapshot, no label", () => {
      expect(M.reportPeriodText(null)).toBe("");
    });
  });

  describe("snapshots", () => {
    test("RANGE sends dateMode, from and to", () => {
      expect(M.resolvePeriod({ mode: M.RANGE, from: "2026-06-01", to: "2026-06-30", asOf: "2026-01-01" })).toMatchObject({
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        asOfDate: "2026-06-30",
        params: { dateMode: "range", from: "2026-06-01", to: "2026-06-30" },
      });
    });

    test("AS OF sends dateMode and asOf, and reads from the beginning of records", () => {
      expect(M.resolvePeriod({ mode: M.AS_OF, from: "2026-01-01", to: "2026-02-01", asOf: "2026-06-30" })).toMatchObject({
        fromDate: M.BEGINNING_OF_RECORDS,
        toDate: "2026-06-30",
        params: { dateMode: "asof", asOf: "2026-06-30" },
      });
    });

    test("the Income Statement's AS OF starts at January 1", () => {
      const period = M.resolvePeriod({ mode: M.AS_OF, asOf: "2026-06-30" }, { asOfStart: "year" });
      expect(period.fromDate).toBe("2026-01-01");
    });

    test("frontend and backend agree on the beginning of records", () => {
      expect(M.BEGINNING_OF_RECORDS).toBe(backend.BEGINNING_OF_RECORDS);
    });

    test("periodModeQuery adds the mode without repeating from/to", () => {
      expect(M.periodModeQuery(M.resolvePeriod({ mode: M.AS_OF, asOf: "2026-06-30" }))).toBe("dateMode=asof&asOf=2026-06-30");
      expect(M.periodModeQuery(M.resolvePeriod({ mode: M.RANGE, from: "2026-06-01", to: "2026-06-30" }))).toBe("dateMode=range");
    });

    test("a drill-down link from an AS OF report reopens as AS OF", () => {
      expect(M.selectionFromLink(M.BEGINNING_OF_RECORDS, "2026-06-30")).toEqual({ mode: M.AS_OF, asOf: "2026-06-30" });
      expect(M.selectionFromLink("2026-06-01", "2026-06-30")).toEqual({ mode: M.RANGE, from: "2026-06-01", to: "2026-06-30" });
    });
  });
});

describe("statementModel.mjs carries the selected period to screen, print and CSV", () => {
  let S;
  beforeAll(async () => {
    S = await import("../../pages/REPORTS/statementModel.mjs");
  });

  const model = (statement, columns, extra) => ({ statement, columns, nodes: [], meta: {}, ...extra });

  test("the selected period replaces the line derived from the columns", () => {
    const m = model("INCOME_STATEMENT", [{ key: "current", label: "FOR THE PERIOD", periodLabel: "2026-01-01 to 2026-06-30" }], {
      reportPeriodLines: ["AS OF: June 30, 2026"],
    });
    expect(S.serializeStatement(m).subtitleLines).toEqual(["AS OF: June 30, 2026"]);
    expect(S.statementToCsv(m)).toContain("AS OF: June 30, 2026");
  });

  test("a Balance Sheet range keeps its comparative line", () => {
    const m = model(
      "BALANCE_SHEET",
      [
        { key: "current", label: "AS OF", periodLabel: "June 30, 2026" },
        { key: "comparative", label: "AS OF", periodLabel: "May 31, 2026" },
      ],
      { reportPeriodLines: ["REPORT PERIOD: June 1, 2026 - June 30, 2026"] }
    );
    expect(S.serializeStatement(m).subtitleLines).toEqual([
      "REPORT PERIOD: June 1, 2026 - June 30, 2026",
      "With comparative figures as of May 31, 2026",
    ]);
  });

  test("a model with no selected period keeps its existing lines", () => {
    const m = model("BALANCE_SHEET", [{ key: "current", label: "AS OF", periodLabel: "June 30, 2026" }]);
    expect(S.serializeStatement(m).subtitleLines).toEqual(["June 30, 2026"]);
  });

  test("the Income Statement screen params tolerate an incomplete selection", () => {
    expect(() => S.incomeStatementScreenParams({ from: undefined, to: undefined, mode: "condensed" })).not.toThrow();
  });
});

describe("backend selection parsing", () => {
  const params = (reportPath, query) => backend.routeParams(reportPath, backend.parseSelection(query).value);

  test("a selection is translated for each kind of report", () => {
    const range = { dateMode: "range", from: "2026-06-01", to: "2026-06-30" };
    const asOf = { dateMode: "asof", asOf: "2026-06-30" };

    expect(params("/trial-balance", range)).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(params("/trial-balance", asOf)).toEqual({ from: "1900-01-01", to: "2026-06-30" });
    expect(params("/income-statement", asOf)).toEqual({ from: "2026-01-01", to: "2026-06-30" });
    expect(params("/balance-sheet", asOf)).toEqual({ to: "2026-06-30" });
    expect(params("/balance-sheet", range)).toEqual({ to: "2026-06-30", compareTo: "2026-05-31" });
    expect(params("/daily-cash-position", asOf)).toEqual({ date: "2026-06-30" });
    expect(params("/ar-aging", asOf)).toEqual({ asOf: "2026-06-30" });
    expect(params("/ar-aging", range)).toEqual({ asOf: "2026-06-30", documentFrom: "2026-06-01", documentTo: "2026-06-30" });
  });

  test("the day before Date From crosses month and year boundaries", () => {
    expect(backend.dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(backend.dayBefore("2026-01-01")).toBe("2025-12-31");
  });

  test("filterByDocumentPeriod keeps everything without a document period", () => {
    const rows = [{ d: "2026-05-01" }, { d: "2026-06-15" }];
    expect(backend.filterByDocumentPeriod(rows, {}, "d")).toEqual(rows);
    expect(backend.filterByDocumentPeriod(rows, { documentFrom: "2026-06-01", documentTo: "2026-06-30" }, "d")).toEqual([rows[1]]);
  });
});

describe("source guards", () => {
  test("the filter offers exactly two options: Range and Date / As Of", () => {
    const src = read("ReportPeriodFilter.jsx");
    expect(src.match(/type="radio"/g)).toHaveLength(2);
    expect(src).toMatch(/<span>Range<\/span>/);
    expect(src).toMatch(/<span>Date \/ As Of<\/span>/);
    expect(src).toMatch(/Date From/);
    expect(src).toMatch(/Date To/);
    expect(src).toMatch(/As Of Date/);
  });

  test("no report page offers a Range with Beginning Balance option", () => {
    for (const file of fs.readdirSync(REPORTS).filter((f) => /\.(jsx|mjs|js)$/.test(f))) {
      expect(read(file)).not.toMatch(/Range with Beginning Balance/i);
    }
  });

  test.each(REPORT_PAGES)("%s uses the shared period control and validates through it", (file) => {
    const src = read(file);
    expect(src).toMatch(/import ReportPeriodFilter/);
    expect(src).toMatch(/<ReportPeriodFilter period=\{period\} idPrefix="[a-z]+" \/>/);
    expect(src).toMatch(/useReportPeriod\(/);
    expect(src).toMatch(/period\.(apply|select)\(/);
    expect(src).not.toMatch(/type="date"[^>]*(?:fromDate|toDate|asOfDate)/);
  });

  test.each(REPORT_PAGES.filter((f) => !["IncomeStatement.jsx", "BalanceSheet.jsx"].includes(f)))(
    "%s prints the applied period, so a later edit cannot relabel the report",
    (file) => {
      expect(read(file)).toMatch(/<ReportPeriodLabel period=\{period\.applied\} \/>/);
    }
  );

  test.each(["IncomeStatement.jsx", "BalanceSheet.jsx"])("%s attaches the applied period to the model it prints", (file) => {
    expect(read(file)).toMatch(/reportPeriodLines: reportPeriodLineList\(applied\)/);
  });

  test("the period label survives print: no stylesheet hides it", () => {
    for (const file of fs.readdirSync(REPORTS).filter((f) => f.endsWith(".css"))) {
      expect(read(file)).not.toMatch(/\.rpl[^{]*\{[^}]*display:\s*none/);
    }
  });

  test("the printed statement header overrides the global print rule that hides <header>", () => {
    const globalCss = fs.readFileSync(path.join(__dirname, "../../pages/TRANSACTIONS/TransactionFormLayout.css"), "utf8");
    expect(globalCss).toMatch(/@media print[\s\S]*\bheader,/);
    expect(read("StatementPrintView.jsx")).toMatch(/<header className="spv-head">/);
    expect(read("StatementPrintView.css")).toMatch(/body\.printing-statement \.spv-head \{[^}]*display: block !important/);
  });

  test("the migration list is unchanged by this feature", () => {
    const order = fs.readFileSync(path.join(__dirname, "../scripts/migrationOrder.js"), "utf8");
    expect(order).not.toMatch(/report_period|date_mode/i);
  });
});
