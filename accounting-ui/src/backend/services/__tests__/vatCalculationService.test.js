const { computeVatFromInclusiveGross, roundMoney, DEFAULT_VAT_RATE } = require("../vatCalculationService");

// Phase 7C spec section 41 - the central VAT-inclusive-gross helper's
// contract: Net = Gross / (1 + rate/100), VAT = Gross - Net (the
// remainder, not a second independent multiplication), and Gross === Net
// + VAT exactly after rounding, for every case below.

describe("computeVatFromInclusiveGross", () => {
  test("12% inclusive - the spec's own worked example", () => {
    const result = computeVatFromInclusiveGross({ gross: 434155.47, vatRatePercent: 12 });
    expect(result.netAmount).toBeCloseTo(387638.81, 2);
    expect(result.vatAmount).toBeCloseTo(46516.66, 2);
    expect(roundMoney(result.netAmount + result.vatAmount)).toBe(result.grossAmount);
  });

  test("zero gross returns all zeros, not a division error", () => {
    const result = computeVatFromInclusiveGross({ gross: 0, vatRatePercent: 12 });
    expect(result).toEqual({ grossAmount: 0, netAmount: 0, vatAmount: 0 });
  });

  test("default VAT rate constant is 12", () => {
    expect(DEFAULT_VAT_RATE).toBe(12);
  });

  test("a different valid VAT rate (e.g. 0% zero-rated / exempt-adjacent)", () => {
    const result = computeVatFromInclusiveGross({ gross: 1000, vatRatePercent: 0 });
    expect(result.netAmount).toBe(1000);
    expect(result.vatAmount).toBe(0);
  });

  test("a non-12% configurable rate (e.g. 5%)", () => {
    const result = computeVatFromInclusiveGross({ gross: 1050, vatRatePercent: 5 });
    expect(result.netAmount).toBe(1000);
    expect(result.vatAmount).toBe(50);
    expect(roundMoney(result.netAmount + result.vatAmount)).toBe(result.grossAmount);
  });

  test.each([
    [100, 12], [1, 12], [0.01, 12], [999999999.99, 12], [123456.78, 12],
    [434155.47, 15], [50000, 8.5],
  ])("rounding edge case: Gross === Net + VAT exactly (gross=%d, rate=%d)", (gross, rate) => {
    const result = computeVatFromInclusiveGross({ gross, vatRatePercent: rate });
    expect(roundMoney(result.netAmount + result.vatAmount)).toBe(roundMoney(gross));
  });

  test("large values remain precise", () => {
    const result = computeVatFromInclusiveGross({ gross: 999999999.99, vatRatePercent: 12 });
    expect(roundMoney(result.netAmount + result.vatAmount)).toBe(999999999.99);
  });

  test("negative or non-numeric rate is rejected, not silently coerced", () => {
    expect(() => computeVatFromInclusiveGross({ gross: 1000, vatRatePercent: -5 })).toThrow();
    expect(() => computeVatFromInclusiveGross({ gross: 1000, vatRatePercent: "abc" })).toThrow();
  });
});
