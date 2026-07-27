const {
  isValidIsoDate,
  resolveDateRange,
  findBankAccount,
  parsePrompt,
  INTENTS,
} = require("../PromptParser");

const BANK_ACCOUNTS = [
  { id: 1, bankCode: "BDO", bankName: "Banco de Oro", accountNo: "001" },
  { id: 2, bankCode: "BPI", bankName: "BPI Payroll Account", accountNo: "002" },
  { id: 3, bankCode: "MBTC", bankName: "Metrobank Savings", accountNo: "003" },
];

describe("isValidIsoDate", () => {
  test("accepts a real YYYY-MM-DD date", () => {
    expect(isValidIsoDate("2026-07-31")).toBe(true);
  });

  test("rejects malformed or impossible dates", () => {
    expect(isValidIsoDate("2026/07/31")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });
});

describe("resolveDateRange", () => {
  test("resolves explicit periodStart/periodEnd", () => {
    expect(resolveDateRange({ periodStart: "2026-07-01", periodEnd: "2026-07-31" })).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("resolves month+year to first/last day, handling 31-day months", () => {
    expect(resolveDateRange({ month: 7, year: 2026 })).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  test("resolves February in a leap year", () => {
    expect(resolveDateRange({ month: 2, year: 2028 })).toEqual({
      periodStart: "2028-02-01",
      periodEnd: "2028-02-29",
    });
  });

  test("resolves February in a non-leap year", () => {
    expect(resolveDateRange({ month: 2, year: 2026 })).toEqual({
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
    });
  });

  test("throws when periodEnd is before periodStart", () => {
    expect(() =>
      resolveDateRange({ periodStart: "2026-07-31", periodEnd: "2026-07-01" })
    ).toThrow();
  });

  test("throws when neither explicit range nor month+year is given", () => {
    expect(() => resolveDateRange({})).toThrow();
  });

  test("throws on an out-of-range month", () => {
    expect(() => resolveDateRange({ month: 13, year: 2026 })).toThrow();
  });
});

describe("findBankAccount", () => {
  test("matches on account number containment", () => {
    const result = findBankAccount(BANK_ACCOUNTS, "BDO Account 001");
    expect(result.account.id).toBe(1);
  });

  test("matches on full bank name containment", () => {
    const result = findBankAccount(BANK_ACCOUNTS, "Reconcile BPI Payroll Account");
    expect(result.account.id).toBe(2);
  });

  test("matches on token overlap when no exact code/name substring", () => {
    const result = findBankAccount(BANK_ACCOUNTS, "the metrobank savings book");
    expect(result.account.id).toBe(3);
  });

  test("returns null for unrecognized bank text", () => {
    expect(findBankAccount(BANK_ACCOUNTS, "totally unrelated text")).toBeNull();
  });

  test("returns null for empty query", () => {
    expect(findBankAccount(BANK_ACCOUNTS, "")).toBeNull();
  });
});

describe("parsePrompt", () => {
  test('parses "Generate the bank reconciliation for BDO Account 001 as of July 31, 2026."', () => {
    const { intent, params } = parsePrompt(
      "Generate the bank reconciliation for BDO Account 001 as of July 31, 2026.",
      { bankAccounts: BANK_ACCOUNTS }
    );

    expect(intent).toBe(INTENTS.GENERATE);
    expect(params.bankAccountId).toBe(1);
    expect(params.month).toBe(7);
    expect(params.year).toBe(2026);
    expect(params.periodEnd).toBe("2026-07-31");
  });

  test('parses "Match transactions within 3 days and allow a ₱1.00 variance."', () => {
    const { intent, params } = parsePrompt(
      "Match transactions within 3 days and allow a ₱1.00 variance.",
      { bankAccounts: BANK_ACCOUNTS, sessionId: 42 }
    );

    expect(intent).toBe(INTENTS.RERUN_TOLERANCE);
    expect(params.dateToleranceDays).toBe(3);
    expect(params.amountVarianceValue).toBe(1.0);
    expect(params.amountVarianceType).toBe("FIXED");
    expect(params.sessionId).toBe(42);
  });

  test('parses "Reconcile BPI Payroll Account using a 3-day tolerance and ₱1.00 variance."', () => {
    const { intent, params } = parsePrompt(
      "Reconcile BPI Payroll Account using a 3-day tolerance and ₱1.00 variance.",
      { bankAccounts: BANK_ACCOUNTS }
    );

    expect(intent).toBe(INTENTS.GENERATE);
    expect(params.bankAccountId).toBe(2);
    expect(params.dateToleranceDays).toBe(3);
    expect(params.amountVarianceValue).toBe(1.0);
  });

  test("recognizes percent-based variance", () => {
    const { params } = parsePrompt("Allow a variance of 2%", { bankAccounts: BANK_ACCOUNTS });
    expect(params.amountVarianceType).toBe("PERCENT");
    expect(params.amountVarianceValue).toBe(2);
  });

  test('classifies "show outstanding checks" as OUTSTANDING_CHECKS', () => {
    const { intent } = parsePrompt("Show me the outstanding checks", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.OUTSTANDING_CHECKS);
  });

  test('classifies "deposits in transit" as DEPOSITS_IN_TRANSIT', () => {
    const { intent } = parsePrompt("List deposits in transit", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.DEPOSITS_IN_TRANSIT);
  });

  test('classifies "items below 80% confidence" as LOW_CONFIDENCE with threshold extracted', () => {
    const { intent, params } = parsePrompt("Show items below 80% confidence", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.LOW_CONFIDENCE);
    expect(params.confidenceThreshold).toBe(80);
  });

  test('classifies "suggest adjusting entries" as ADJUSTING_ENTRIES', () => {
    const { intent } = parsePrompt("Suggest adjusting journal entries for bank charges", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.ADJUSTING_ENTRIES);
  });

  test('classifies "why is this not balanced" as EXPLAIN_UNBALANCED', () => {
    const { intent } = parsePrompt("Explain why this session is not balanced", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.EXPLAIN_UNBALANCED);
  });

  test('classifies "confirm all exact matches" as CONFIRM_ALL_EXACT', () => {
    const { intent } = parsePrompt("Confirm all exact matches", {
      bankAccounts: BANK_ACCOUNTS,
      sessionId: 5,
    });
    expect(intent).toBe(INTENTS.CONFIRM_ALL_EXACT);
  });

  test("falls back to UNKNOWN for unrecognized, unrelated prompts", () => {
    const { intent, params } = parsePrompt("What's the weather like today?", {
      bankAccounts: BANK_ACCOUNTS,
    });
    expect(intent).toBe(INTENTS.UNKNOWN);
    expect(params.bankAccountId).toBeNull();
  });

  test("handles a missing bank account gracefully (no bankAccounts in context)", () => {
    const { params } = parsePrompt("Generate the reconciliation for July 2026", {});
    expect(params.bankAccountId).toBeNull();
    expect(params.month).toBe(7);
    expect(params.year).toBe(2026);
  });

  test("does not invent an intent when the prompt has no bank match and no keywords", () => {
    const { intent } = parsePrompt("hello there", { bankAccounts: BANK_ACCOUNTS });
    expect(intent).toBe(INTENTS.UNKNOWN);
  });
});
