const {
  normalizeIdentifier,
  jaccardSimilarity,
  daysBetween,
  shiftDate,
  round2,
  scoreCandidate,
  classifyAdjustmentSuggestion,
} = require("../ConfidenceScoringService");

const baseSession = {
  dateToleranceDays: 3,
  amountVarianceType: "FIXED",
  amountVarianceValue: 1.0,
};

function stmtLine(overrides = {}) {
  return {
    txnDate: "2026-07-15",
    debit: 0,
    credit: 5000,
    referenceNo: "OR-4094",
    checkNo: null,
    description: "Juan Dela Cruz Payment",
    ...overrides,
  };
}

function bookTxn(overrides = {}) {
  return {
    id: 99,
    date: "2026-07-15",
    amount: 5000,
    referenceNo: "OR-4094",
    checkNo: null,
    receiptNo: null,
    payeeOrCustomer: "Juan Dela Cruz",
    description: "Juan Dela Cruz Payment",
    ...overrides,
  };
}

describe("normalizeIdentifier", () => {
  test("lowercases, trims, and strips leading zeros", () => {
    expect(normalizeIdentifier(" 00123 ")).toBe("123");
    expect(normalizeIdentifier("OR-4094")).toBe("or-4094");
  });

  test("returns empty string for falsy input", () => {
    expect(normalizeIdentifier(null)).toBe("");
    expect(normalizeIdentifier(undefined)).toBe("");
    expect(normalizeIdentifier("")).toBe("");
  });
});

describe("jaccardSimilarity", () => {
  test("returns 1 for identical text", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  test("returns 0 for completely disjoint text", () => {
    expect(jaccardSimilarity("apple banana", "xyz qrs")).toBe(0);
  });

  test("returns 0 when either side is empty", () => {
    expect(jaccardSimilarity("", "something")).toBe(0);
    expect(jaccardSimilarity("something", "")).toBe(0);
  });
});

describe("daysBetween", () => {
  test("computes absolute day difference between two ISO date strings", () => {
    expect(daysBetween("2026-07-15", "2026-07-18")).toBe(3);
    expect(daysBetween("2026-07-18", "2026-07-15")).toBe(3);
  });

  test("returns 0 for the same date", () => {
    expect(daysBetween("2026-07-15", "2026-07-15")).toBe(0);
  });
});

describe("shiftDate", () => {
  test("shifts forward across a month boundary", () => {
    expect(shiftDate("2026-07-30", 3)).toBe("2026-08-02");
  });

  test("shifts backward across a month boundary", () => {
    expect(shiftDate("2026-08-01", -3)).toBe("2026-07-29");
  });
});

describe("round2", () => {
  test("rounds to two decimal places", () => {
    expect(round2(1.006)).toBe(1.01);
    expect(round2(1.234)).toBe(1.23);
  });
});

describe("scoreCandidate", () => {
  test("exact amount, date, and reference number match produces an EXACT type at max score", () => {
    const result = scoreCandidate(stmtLine(), bookTxn(), baseSession);
    expect(result.matchType).toBe("EXACT");
    expect(result.breakdown.amountScore).toBe(40);
    expect(result.breakdown.dateScore).toBe(20);
    expect(result.breakdown.identifierScore).toBe(25);
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
  });

  test("amount within variance but not exact produces a SUGGESTED partial score", () => {
    const result = scoreCandidate(
      stmtLine({ credit: 5000.5 }),
      bookTxn({ amount: 5000 }),
      baseSession
    );
    expect(result).not.toBeNull();
    expect(result.matchType).toBe("SUGGESTED");
    expect(result.breakdown.amountScore).toBeGreaterThan(0);
    expect(result.breakdown.amountScore).toBeLessThan(40);
  });

  test("date within tolerance but not exact reduces the date score without excluding the candidate", () => {
    const result = scoreCandidate(
      stmtLine({ txnDate: "2026-07-17" }),
      bookTxn({ date: "2026-07-15" }),
      baseSession
    );
    expect(result).not.toBeNull();
    expect(result.matchType).toBe("SUGGESTED");
    expect(result.breakdown.dateScore).toBeGreaterThan(0);
    expect(result.breakdown.dateScore).toBeLessThan(20);
  });

  test("amount difference beyond 2x variance excludes the candidate entirely", () => {
    const result = scoreCandidate(
      stmtLine({ credit: 5100 }),
      bookTxn({ amount: 5000 }),
      baseSession
    );
    expect(result).toBeNull();
  });

  test("date difference beyond 2x tolerance excludes the candidate entirely", () => {
    const result = scoreCandidate(
      stmtLine({ txnDate: "2026-07-25" }),
      bookTxn({ date: "2026-07-15" }),
      baseSession
    );
    expect(result).toBeNull();
  });

  test("mismatched reference numbers with no other identifier overlap still allow a SUGGESTED match", () => {
    const result = scoreCandidate(
      stmtLine({ referenceNo: "OR-9999" }),
      bookTxn({ referenceNo: "OR-4094", payeeOrCustomer: "Someone Else" }),
      baseSession
    );
    expect(result).not.toBeNull();
    expect(result.matchType).toBe("SUGGESTED");
    expect(result.breakdown.identifierScore).toBe(0);
  });

  test("exact amount and date but a mismatched statement identifier is not classified EXACT", () => {
    const result = scoreCandidate(
      stmtLine({ referenceNo: "OR-9999" }),
      bookTxn({ referenceNo: "OR-4094" }),
      baseSession
    );
    expect(result.matchType).toBe("SUGGESTED");
  });

  test("exact amount and date with no identifier present on the statement line is still EXACT", () => {
    const result = scoreCandidate(
      stmtLine({ referenceNo: null, checkNo: null }),
      bookTxn(),
      baseSession
    );
    expect(result.matchType).toBe("EXACT");
  });

  test("percent-based variance is computed relative to the statement amount", () => {
    const percentSession = { ...baseSession, amountVarianceType: "PERCENT", amountVarianceValue: 5 };
    const result = scoreCandidate(
      stmtLine({ credit: 1000 }),
      bookTxn({ amount: 975 }),
      percentSession
    );
    expect(result).not.toBeNull();
    expect(result.breakdown.amountScore).toBeGreaterThan(0);
  });
});

describe("classifyAdjustmentSuggestion", () => {
  test("classifies a debit with bank-charge language as BANK_CHARGE", () => {
    const result = classifyAdjustmentSuggestion({
      description: "Monthly Service Charge",
      debit: 150,
      credit: 0,
    });
    expect(result.adjustmentType).toBe("BANK_CHARGE");
    expect(result.amount).toBe(150);
  });

  test("classifies a credit with interest language as INTEREST_INCOME", () => {
    const result = classifyAdjustmentSuggestion({
      description: "Interest Earned",
      debit: 0,
      credit: 42.5,
    });
    expect(result.adjustmentType).toBe("INTEREST_INCOME");
    expect(result.amount).toBe(42.5);
  });

  test("falls back to OTHER when no keyword matches", () => {
    const result = classifyAdjustmentSuggestion({
      description: "Unidentified Wire Transfer",
      debit: 0,
      credit: 300,
    });
    expect(result.adjustmentType).toBe("OTHER");
    expect(result.amount).toBe(300);
  });

  test("a debit never gets classified INTEREST_INCOME even if it mentions interest", () => {
    const result = classifyAdjustmentSuggestion({
      description: "Interest on Loan",
      debit: 200,
      credit: 0,
    });
    expect(result.adjustmentType).toBe("OTHER");
  });
});
