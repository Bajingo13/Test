// Explicit transaction-module routing (Checkpoint 6).
//
// Replaces TransactionFormLayout's old hardcoded endpoint ternary, which
// defaulted any unrecognized `code` to "apv" - the exact bug that let
// Petty Cash Voucher (code="PCV") and Debit/Credit Memo (code="DCM")
// silently save into apv_headers/apv_lines instead of having their own
// identity (see the Checkpoint 6 investigation/completion report).
//
// Every module TransactionFormLayout can render must have an entry here.
// getTransactionModuleConfig() throws a clear, specific error for an
// unmapped code instead of ever falling back to another module's
// endpoint - "fail clearly" per the Checkpoint 6 spec, not silently
// misroute.
// Phase 7B additions: moduleKey (the permission catalog's module_key, same
// one server.js's authorizePermission()/transactionPrint's MODULE_CONFIG
// already gate these routes with - see pathPermissionMap.js), delete
// (whether a DELETE route actually exists for this module - false for
// OR/CV, which structurally have none, confirmed during the Checkpoint 7
// architecture audit and re-confirmed in Phase 7A.1), and statusModel:
// "DRAFT_POSTED" for the eight modules that use the ordinary Draft/Posted
// accounting lifecycle (and therefore the Posted-immutability guard from
// Phase 7A.1), vs PO's own "OPEN_CLOSED" - Phase 7A.1 confirmed PO's PUT
// and DELETE routes apply no status restriction at all (Open/Closed/Draft
// is a procurement lifecycle, not an accounting-posting one), so PO's
// Edit/Delete toolbar buttons are gated on permission + period-lock only,
// never on status - see the Phase 7B report's "PO behavior" item.
export const TRANSACTION_MODULES = {
  INV: { endpoint: "invoices", printModuleType: "invoice", currencyEligible: true, moduleKey: "TRANSACTIONS.INVOICE", delete: true, statusModel: "DRAFT_POSTED" },
  APV: { endpoint: "apv", printModuleType: "apv", currencyEligible: true, moduleKey: "TRANSACTIONS.APV", delete: true, statusModel: "DRAFT_POSTED" },
  OR: { endpoint: "or", printModuleType: "or", currencyEligible: true, moduleKey: "TRANSACTIONS.OR", delete: false, statusModel: "DRAFT_POSTED" },
  CV: { endpoint: "cv", printModuleType: "cv", currencyEligible: true, moduleKey: "TRANSACTIONS.CV", delete: false, statusModel: "DRAFT_POSTED" },
  JV: { endpoint: "jv", printModuleType: "jv", currencyEligible: true, moduleKey: "TRANSACTIONS.JV", delete: true, statusModel: "DRAFT_POSTED" },
  PO: { endpoint: "purchase-orders", printModuleType: "po", currencyEligible: true, moduleKey: "TRANSACTIONS.PURCHASE_ORDER", delete: true, statusModel: "OPEN_CLOSED" },
  // Checkpoint 6 - previously had no entry at all (fell through to apv).
  PCV: { endpoint: "petty-cash", printModuleType: "pettyCash", currencyEligible: true, moduleKey: "TRANSACTIONS.PETTY_CASH", delete: true, statusModel: "DRAFT_POSTED" },
  DM: { endpoint: "debit-memos", printModuleType: "debitMemo", currencyEligible: true, moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" },
  CM: { endpoint: "credit-memos", printModuleType: "creditMemo", currencyEligible: true, moduleKey: "TRANSACTIONS.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" },
};

export function getTransactionModuleConfig(code) {
  const config = TRANSACTION_MODULES[code];
  if (!config) {
    throw new Error(
      `Unknown transaction module code "${code}" - no API endpoint is configured for it. ` +
        `This is a configuration error, not a data error: add an entry to TRANSACTION_MODULES in transactionModuleConfig.js before using this code.`
    );
  }
  return config;
}