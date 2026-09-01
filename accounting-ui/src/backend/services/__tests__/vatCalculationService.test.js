const {
  computeVatFromInclusiveGross,
  computeVatByTreatment,
  roundMoney,
  DEFAULT_VAT_RATE,
  VAT_TREATMENTS,
  normalizeVatTreatment,
  isValidVatTreatment,
  isZeroVatTreatment,
  isTreatmentRateConsistent,
} = require("../vatCalculationService");

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

// Phase 7E: VAT treatment classification. ZERO_RATED and EXEMPT must stay
// distinct from each other and from a genuine 0% STANDARD line, and the
// treatment is carried as data - never re-derived from the rate.
describe("VAT treatment (STANDARD / ZERO_RATED / EXEMPT)", () => {
  test("VAT_TREATMENTS is exactly the three supported values", () => {
    expect(VAT_TREATMENTS).toEqual(["STANDARD", "ZERO_RATED", "EXEMPT"]);
  });

  test("normalizeVatTreatment: blank/null/unknown-case -> STANDARD, valid values pass through", () => {
    expect(normalizeVatTreatment(null)).toBe("STANDARD");
    expect(normalizeVatTreatment("")).toBe("STANDARD");
    expect(normalizeVatTreatment("  zero_rated ")).toBe("ZERO_RATED");
    expect(normalizeVatTreatment("Exempt")).toBe("EXEMPT");
  });

  test("isValidVatTreatment / isZeroVatTreatment", () => {
    expect(isValidVatTreatment("STANDARD")).toBe(true);
    expect(isValidVatTreatment("ZERO_RATED")).toBe(true);
    expect(isValidVatTreatment("EXEMPT")).toBe(true);
    expect(isValidVatTreatment("REDUCED")).toBe(false);
    expect(isZeroVatTreatment("STANDARD")).toBe(false);
    expect(isZeroVatTreatment("ZERO_RATED")).toBe(true);
    expect(isZeroVatTreatment("EXEMPT")).toBe(true);
  });

  test("isTreatmentRateConsistent: STANDARD any rate ok; ZERO_RATED/EXEMPT must be 0", () => {
    expect(isTreatmentRateConsistent("STANDARD", 12)).toBe(true);
    expect(isTreatmentRateConsistent("STANDARD", 0)).toBe(true);
    expect(isTreatmentRateConsistent("ZERO_RATED", 0)).toBe(true);
    expect(isTreatmentRateConsistent("ZERO_RATED", 12)).toBe(false);
    expect(isTreatmentRateConsistent("EXEMPT", 0)).toBe(true);
    expect(isTreatmentRateConsistent("EXEMPT", 5)).toBe(false);
  });

  test("STANDARD: amount is a VAT-inclusive gross - 1120 @ 12% -> net 1000 / VAT 120 (unchanged)", () => {
    const r = computeVatByTreatment({ amount: 1120, vatRatePercent: 12, treatment: "STANDARD" });
    expect(r).toEqual({ grossAmount: 1120, netAmount: 1000, vatAmount: 120, treatment: "STANDARD" });
  });

  test("ZERO_RATED: amount 1000 -> base/net 1000, VAT 0, treatment preserved", () => {
    const r = computeVatByTreatment({ amount: 1000, vatRatePercent: 0, treatment: "ZERO_RATED" });
    expect(r).toEqual({ grossAmount: 1000, netAmount: 1000, vatAmount: 0, treatment: "ZERO_RATED" });
  });

  test("EXEMPT: amount 1000 -> base/net 1000, VAT 0, treatment preserved", () => {
    const r = computeVatByTreatment({ amount: 1000, vatRatePercent: 0, treatment: "EXEMPT" });
    expect(r).toEqual({ grossAmount: 1000, netAmount: 1000, vatAmount: 0, treatment: "EXEMPT" });
  });

  test("ZERO_RATED and EXEMPT are NOT collapsed into one generic '0% VAT' state", () => {
    const zr = computeVatByTreatment({ amount: 500, vatRatePercent: 0, treatment: "ZERO_RATED" });
    const ex = computeVatByTreatment({ amount: 500, vatRatePercent: 0, treatment: "EXEMPT" });
    expect(zr.vatAmount).toBe(0);
    expect(ex.vatAmount).toBe(0);
    expect(zr.treatment).not.toBe(ex.treatment);
  });

  test("a missing treatment computes as STANDARD (historical rows / EWT entries)", () => {
    const r = computeVatByTreatment({ amount: 1120, vatRatePercent: 12, treatment: undefined });
    expect(r.treatment).toBe("STANDARD");
    expect(r.vatAmount).toBe(120);
  });

  test("ZERO_RATED / EXEMPT base is rounded to 2dp and gross === net", () => {
    const r = computeVatByTreatment({ amount: 1234.5, vatRatePercent: 0, treatment: "EXEMPT" });
    expect(r.netAmount).toBe(1234.5);
    expect(r.grossAmount).toBe(1234.5);
    expect(r.vatAmount).toBe(0);
  });
});
