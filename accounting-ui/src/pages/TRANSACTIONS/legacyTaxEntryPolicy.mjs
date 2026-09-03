// Phase 7L Part F: one place that decides whether a legacy (OR/CV/PO)
// voucher may record its OWN VAT / EWT.
//
// A SETTLEMENT voucher - an OR applying to one or more Invoices, or a CV
// applying to one or more APVs - must NOT recognize VAT/EWT again: the
// source document (Invoice / APV) already owns that tax. This is the
// architectural boundary Phase 7D/7D.1/7E established and Phase 7L keeps
// intact - CV stays a legacy settlement path, it is NOT modernized here.
//
// The legacy tax modals disable their inputs AND block their "Add ... Line"
// / ATC-select actions when this returns true, so a second Input VAT/EWT
// cannot be entered through the normal UI (not merely warned about).
//
// jest runs testEnvironment: "node" with no jsdom, so this lives here as a
// pure predicate the component + TransactionFormLayout both call - unit
// tested directly, the pattern used by voucherToolbarRules.mjs etc.

export function hasSettlementSourceApplications({
  code,
  invoiceApplications = [],
  apvApplications = [],
} = {}) {
  return (
    (code === "OR" && (invoiceApplications || []).length > 0) ||
    (code === "CV" && (apvApplications || []).length > 0)
  );
}

// True when the voucher is allowed to record its own legacy VAT/EWT.
export function canRecordLegacyTax(ctx) {
  return !hasSettlementSourceApplications(ctx);
}

export const SETTLEMENT_TAX_WARNING = {
  OR: "Tax is recognized on the source Invoice. Additional Output VAT on this settlement may duplicate tax.",
  CV: "Tax is recognized on the source APV. Additional Input VAT/EWT may duplicate tax.",
};

export function settlementTaxWarning(code) {
  return SETTLEMENT_TAX_WARNING[code] || "";
}
