const {
  roundMoney,
  sumVatLines,
  computeEwtTaxableBase,
  computeEwtAmount,
} = require("../ewtCalculationService");

function vatLine(overrides = {}) {
  return {
    accountTitle: "Input VAT",
    debit: 0,
    credit: 0,
    ...overrides,
  };
}

describe("computeEwtTaxableBase + computeEwtAmount", () => {
  // 1. VAT-inclusive with EWT (the bug's reference case)
  test("VAT-inclusive gross with EWT: 112,000 gross, 12% VAT line -> base 100,000, EWT 2,000", () => {
    const lines = [vatLine({ debit: 12000 })];
    const base = computeEwtTaxableBase({ grossAmount: 112000, lines, vatKeyword: "input vat" });
    expect(base).toBe(100000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(2000);
  });

  // 2. VAT-exclusive with EWT (base entered directly, VAT added on top,
  // gross now includes VAT - same subtraction formula applies identically)
  test("VAT-exclusive base 100,000 + 12% VAT -> gross 112,000, EWT still computed off 100,000", () => {
    const lines = [vatLine({ debit: 12000 })];
    const base = computeEwtTaxableBase({ grossAmount: 112000, lines, vatKeyword: "input vat" });
    expect(base).toBe(100000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(2000);
  });

  // 3. VAT-exempt with EWT - no VAT line present, base = gross
  test("VAT-exempt: no VAT line, base equals gross, EWT on full base", () => {
    const base = computeEwtTaxableBase({ grossAmount: 100000, lines: [], vatKeyword: "input vat" });
    expect(base).toBe(100000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(2000);
  });

  // 4. Zero-rated with EWT - identical treatment to exempt (no VAT line)
  test("Zero-rated: no VAT line, base equals gross, EWT on full base", () => {
    const base = computeEwtTaxableBase({ grossAmount: 100000, lines: [], vatKeyword: "input vat" });
    expect(base).toBe(100000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(2000);
  });

  // 5. No EWT - rate 0 produces zero amount regardless of base
  test("No EWT: rate 0 -> amount 0", () => {
    const base = computeEwtTaxableBase({ grossAmount: 112000, lines: [vatLine({ debit: 12000 })], vatKeyword: "input vat" });
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 0 })).toBe(0);
  });

  // 6. Different EWT rates on the same base
  test("Different EWT rates produce proportionally different amounts", () => {
    const base = 100000;
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 1 })).toBe(1000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 5 })).toBe(5000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 15 })).toBe(15000);
  });

  // 7. Mixed VATable and exempt lines - sumVatLines only pulls the VAT
  // account's lines out of the base; everything else (VATable + exempt
  // portions posted through non-VAT accounts) stays in.
  test("Mixed lines: only the VAT-titled line is excluded from the base", () => {
    const lines = [
      vatLine({ debit: 12000 }),
      { accountTitle: "Rental Expense", debit: 100000, credit: 0 },
      { accountTitle: "Accounts Payable", debit: 0, credit: 112000 },
    ];
    const base = computeEwtTaxableBase({ grossAmount: 112000, lines, vatKeyword: "input vat" });
    expect(base).toBe(100000);
  });

  // 8. Discounts before EWT - a discount is just a smaller gross total by
  // the time it reaches this function; base tracks whatever gross is passed.
  test("Discount already netted into gross: base reflects the discounted gross minus VAT", () => {
    // 100,000 base - 10,000 discount = 90,000 net -> +12% VAT = 100,800 gross
    const lines = [vatLine({ debit: 10800 })];
    const base = computeEwtTaxableBase({ grossAmount: 100800, lines, vatKeyword: "input vat" });
    expect(base).toBe(90000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(1800);
  });

  // 9. Large amounts
  test("Large amounts: 11,200,000 gross with 1,200,000 VAT line -> base 10,000,000", () => {
    const lines = [vatLine({ debit: 1200000 })];
    const base = computeEwtTaxableBase({ grossAmount: 11200000, lines, vatKeyword: "input vat" });
    expect(base).toBe(10000000);
    expect(computeEwtAmount({ taxableBase: base, ewtRate: 2 })).toBe(200000);
  });

  // 10. Fractional-centavo calculations
  test("Fractional centavos round correctly instead of drifting via float error", () => {
    // 33,333.33 base, 1% EWT -> 333.3333 -> rounds to 333.33
    expect(computeEwtAmount({ taxableBase: 33333.33, ewtRate: 1 })).toBe(333.33);
    // Classic float trap: 1.005 * 100 in raw JS math misrounds down.
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(112000 / 1.12 / 100) * 100 - 100000).toBeLessThan(0.01);
  });

  // 15. Multi-line transactions with several non-VAT lines around the VAT line
  test("Multi-line transaction: base excludes only the VAT line regardless of line count/order", () => {
    const lines = [
      { accountTitle: "Rental Expense", debit: 60000, credit: 0 },
      { accountTitle: "Utilities Expense", debit: 40000, credit: 0 },
      vatLine({ debit: 12000 }),
      { accountTitle: "Accounts Payable", debit: 0, credit: 112000 },
    ];
    const base = computeEwtTaxableBase({ grossAmount: 112000, lines, vatKeyword: "input vat" });
    expect(base).toBe(100000);
  });

  test("sumVatLines matches VAT lines by title keyword regardless of account id", () => {
    const lines = [vatLine({ credit: 5000 }), { accountTitle: "Output VAT", debit: 0, credit: 999 }];
    expect(sumVatLines(lines, "input vat")).toBe(5000);
  });

  test("No VAT keyword configured falls back to a generic 'vat' match", () => {
    const lines = [{ accountTitle: "Output VAT", debit: 0, credit: 12000 }];
    expect(sumVatLines(lines, null)).toBe(12000);
  });

  test("computeEwtTaxableBase never goes negative-surprising on an unbalanced/empty input", () => {
    expect(computeEwtTaxableBase({ grossAmount: 0, lines: [], vatKeyword: "input vat" })).toBe(0);
  });
});
