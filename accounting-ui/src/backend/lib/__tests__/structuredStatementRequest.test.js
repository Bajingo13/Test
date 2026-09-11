const {
  parseIncomeStatementParams,
  parseBalanceSheetParams,
  evaluateStrict,
  evaluateBalanceSheetStrict,
  isWholeCalendarMonth,
  previousMonthRange,
  monthLabel,
  asOfLabel,
} = require("../structuredStatementRequest");

// Reports Phase B: pure-function coverage for structured-request parsing,
// period derivation and the strict-mode gate. No DB, no Express.

describe("isWholeCalendarMonth", () => {
  test("true for a full month, false otherwise", () => {
    expect(isWholeCalendarMonth("2027-06-01", "2027-06-30")).toBe(true);
    expect(isWholeCalendarMonth("2027-02-01", "2027-02-28")).toBe(true); // 2027 not a leap year
    expect(isWholeCalendarMonth("2024-02-01", "2024-02-29")).toBe(true); // leap year
    expect(isWholeCalendarMonth("2027-06-01", "2027-06-29")).toBe(false);
    expect(isWholeCalendarMonth("2027-06-02", "2027-06-30")).toBe(false);
    expect(isWholeCalendarMonth("2027-06-01", "2027-07-31")).toBe(false);
  });
});

describe("previousMonthRange", () => {
  test("preceding calendar month, crossing the year boundary at January", () => {
    expect(previousMonthRange("2027-06-01")).toEqual({ from: "2027-05-01", to: "2027-05-31" });
    expect(previousMonthRange("2027-01-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(previousMonthRange("2027-03-01")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });
});

describe("monthLabel", () => {
  test("human month + year", () => {
    expect(monthLabel("2027-01-31")).toBe("January 2027");
    expect(monthLabel("2026-12-01")).toBe("December 2026");
  });
});

describe("parseIncomeStatementParams", () => {
  test("defaults: condensed mode, comparePrev + ytd on, strict off; columns current/previous/ytd", () => {
    const r = parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-30" });
    expect(r.ok).toBe(true);
    expect(r.value.mode).toBe("condensed");
    expect(r.value.comparePrev).toBe(true);
    expect(r.value.ytd).toBe(true);
    expect(r.value.strict).toBe(false);
    expect(r.value.periods.map((p) => p.key)).toEqual(["current", "previous", "ytd"]);
    expect(r.value.periods.find((p) => p.key === "previous")).toMatchObject({ from: "2027-05-01", to: "2027-05-31" });
    expect(r.value.periods.find((p) => p.key === "ytd")).toMatchObject({ from: "2027-01-01", to: "2027-06-30", bandLabel: "TOTAL TO DATE" });
  });

  test("comparePrev=0 drops previous; ytd=0 drops ytd; both drop -> current only", () => {
    expect(parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-30", comparePrev: "0" }).value.periods.map((p) => p.key)).toEqual([
      "current",
      "ytd",
    ]);
    expect(parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-30", ytd: "0" }).value.periods.map((p) => p.key)).toEqual([
      "current",
      "previous",
    ]);
    expect(
      parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-30", comparePrev: "0", ytd: "0" }).value.periods.map((p) => p.key)
    ).toEqual(["current"]);
  });

  test("non-whole-month + comparePrev default -> 400 COMPARISON_REQUIRES_FULL_MONTH", () => {
    const r = parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-15" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.body.code).toBe("COMPARISON_REQUIRES_FULL_MONTH");
  });

  test("non-whole-month + comparePrev=0 -> ok, current label is the raw range", () => {
    const r = parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-15", comparePrev: "0" });
    expect(r.ok).toBe(true);
    expect(r.value.periods.find((p) => p.key === "current").periodLabel).toBe("2027-06-01 to 2027-06-15");
  });

  test("date + mode validation", () => {
    expect(parseIncomeStatementParams({ to: "2027-06-30" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseIncomeStatementParams({ from: "nope", to: "2027-06-30" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseIncomeStatementParams({ from: "2027-13-40", to: "2027-06-30" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseIncomeStatementParams({ from: "2027-06-30", to: "2027-06-01" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseIncomeStatementParams({ from: "2027-06-01", to: "2027-06-30", mode: "summary" }).body.code).toBe("INVALID_REPORT_MODE");
  });
});

describe("evaluateStrict", () => {
  const clean = {
    unclassified: { INCOME: { current: 0 }, EXPENSE: { current: 0 } },
    readiness: {
      ready: true,
      ungroupedAccountsWithBalance: [],
      groupUnclassifiedAccounts: [],
      invalidSectionMappings: [],
      unmappedAccountCodesWithBalance: [],
    },
  };

  test("clean model -> not blocked", () => {
    expect(evaluateStrict(clean).blocked).toBe(false);
  });

  test("non-zero unclassified income -> blocked 409", () => {
    const m = JSON.parse(JSON.stringify(clean));
    m.unclassified.INCOME.current = 300;
    const g = evaluateStrict(m);
    expect(g).toMatchObject({ blocked: true, status: 409 });
    expect(g.body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
  });

  test("ungrouped account -> blocked; unmapped code -> blocked", () => {
    const a = JSON.parse(JSON.stringify(clean));
    a.readiness.ungroupedAccountsWithBalance = [{ accountCode: "X" }];
    expect(evaluateStrict(a).blocked).toBe(true);

    const b = JSON.parse(JSON.stringify(clean));
    b.readiness.unmappedAccountCodesWithBalance = [{ accountCode: "GHOST", net: 250 }];
    expect(evaluateStrict(b).blocked).toBe(true);
  });
});

describe("asOfLabel", () => {
  test("human date label from the date itself", () => {
    expect(asOfLabel("2027-06-30")).toBe("June 30, 2027");
    expect(asOfLabel("2026-12-01")).toBe("December 1, 2026");
  });
});

describe("parseBalanceSheetParams", () => {
  test("to only -> current column, no difference", () => {
    const r = parseBalanceSheetParams({ to: "2027-06-30" });
    expect(r.ok).toBe(true);
    expect(r.value.withDifference).toBe(false);
    expect(r.value.columns.map((c) => c.key)).toEqual(["current"]);
    expect(r.value.columns[0]).toMatchObject({ bandLabel: "AS OF", periodLabel: "June 30, 2027", date: "2027-06-30" });
  });

  test("compareTo -> current + comparative, withDifference; later compareTo accepted verbatim", () => {
    const r = parseBalanceSheetParams({ to: "2027-01-31", compareTo: "2027-12-31" });
    expect(r.ok).toBe(true);
    expect(r.value.withDifference).toBe(true);
    expect(r.value.columns.map((c) => c.key)).toEqual(["current", "comparative"]);
    expect(r.value.columns[1]).toMatchObject({ date: "2027-12-31", periodLabel: "December 31, 2027" });
  });

  test("validation", () => {
    expect(parseBalanceSheetParams({}).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseBalanceSheetParams({ to: "nope" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseBalanceSheetParams({ to: "2027-13-40" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseBalanceSheetParams({ to: "2027-06-30", compareTo: "bad" }).body.code).toBe("INVALID_DATE_RANGE");
    expect(parseBalanceSheetParams({ to: "2027-06-30", mode: "summary" }).body.code).toBe("INVALID_REPORT_MODE");
  });
});

describe("evaluateBalanceSheetStrict", () => {
  const clean = {
    unclassified: { ASSET: { current: 0 }, LIABILITY: { current: 0 }, EQUITY: { current: 0 } },
    balanceCheck: { balanced: true, byColumn: { current: { delta: 0 } } },
    readiness: {
      ready: true,
      ungroupedAccountsWithBalance: [],
      groupUnclassifiedAccounts: [],
      invalidSectionMappings: [],
      unmappedAccountCodesWithBalance: [],
    },
  };

  test("clean + balanced -> not blocked", () => {
    expect(evaluateBalanceSheetStrict(clean).blocked).toBe(false);
  });

  test("unclassified asset -> 409 REPORT_CLASSIFICATION_INCOMPLETE", () => {
    const m = JSON.parse(JSON.stringify(clean));
    m.unclassified.ASSET.current = 7000;
    const g = evaluateBalanceSheetStrict(m);
    expect(g).toMatchObject({ blocked: true, status: 409 });
    expect(g.body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
  });

  test("clean classification but out of balance -> 409 BALANCE_SHEET_OUT_OF_BALANCE (with balanceCheck)", () => {
    const m = JSON.parse(JSON.stringify(clean));
    m.balanceCheck = { balanced: false, byColumn: { current: { delta: 500 } } };
    const g = evaluateBalanceSheetStrict(m);
    expect(g.body.code).toBe("BALANCE_SHEET_OUT_OF_BALANCE");
    expect(g.body.balanceCheck.balanced).toBe(false);
  });

  test("precedence: classification failure wins over imbalance", () => {
    const m = JSON.parse(JSON.stringify(clean));
    m.unclassified.EQUITY.current = 3000;
    m.balanceCheck = { balanced: false, byColumn: { current: { delta: 3000 } } };
    expect(evaluateBalanceSheetStrict(m).body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
  });
});
