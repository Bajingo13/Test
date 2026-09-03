let P;

beforeAll(async () => {
  P = await import("../legacyTaxEntryPolicy.mjs");
});

describe("Phase 7L Part F - settlement voucher tax protection", () => {
  test("CV with APV applications cannot record its own VAT/EWT", () => {
    const ctx = { code: "CV", apvApplications: [{ sourceId: 1, amount: 100 }] };
    expect(P.hasSettlementSourceApplications(ctx)).toBe(true);
    expect(P.canRecordLegacyTax(ctx)).toBe(false);
    expect(P.settlementTaxWarning("CV")).toMatch(/recognized on the source APV/i);
    expect(P.settlementTaxWarning("CV")).toMatch(/duplicate tax/i);
  });

  test("direct CV (no APV applications) keeps legacy VAT/EWT behavior", () => {
    const ctx = { code: "CV", apvApplications: [] };
    expect(P.hasSettlementSourceApplications(ctx)).toBe(false);
    expect(P.canRecordLegacyTax(ctx)).toBe(true);
  });

  test("OR with Invoice applications cannot record its own Output VAT", () => {
    const ctx = { code: "OR", invoiceApplications: [{ sourceId: 2, amount: 50 }] };
    expect(P.hasSettlementSourceApplications(ctx)).toBe(true);
    expect(P.canRecordLegacyTax(ctx)).toBe(false);
    expect(P.settlementTaxWarning("OR")).toMatch(/source Invoice/i);
  });

  test("direct OR keeps legacy behavior", () => {
    expect(P.canRecordLegacyTax({ code: "OR", invoiceApplications: [] })).toBe(true);
  });

  test("APV / PO / other modules are never gated by this predicate", () => {
    expect(P.hasSettlementSourceApplications({ code: "APV", apvApplications: [{ x: 1 }] })).toBe(false);
    expect(P.hasSettlementSourceApplications({ code: "PO" })).toBe(false);
    expect(P.canRecordLegacyTax({ code: "APV" })).toBe(true);
  });

  test("undefined/empty context is safe (no crash, not blocked)", () => {
    expect(P.hasSettlementSourceApplications()).toBe(false);
    expect(P.hasSettlementSourceApplications({})).toBe(false);
  });
});

// LegacyVatEntryModal / LegacyEwtEntryModal wire `blocked = !!hasSourceApplications`
// to: (a) disable every tax input, (b) disable the "+ Add ... Line" button,
// (c) early-return from handleAdd. This suite pins the predicate those all
// derive from; the backend suite (phase7lApvVatEwtIntegrity) proves the
// end-to-end effect: a CV settling an APV produces zero structured tax rows.
