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
export const TRANSACTION_MODULES = {
  INV: { endpoint: "invoices", printModuleType: "invoice", currencyEligible: true },
  APV: { endpoint: "apv", printModuleType: "apv", currencyEligible: true },
  OR: { endpoint: "or", printModuleType: "or", currencyEligible: true },
  CV: { endpoint: "cv", printModuleType: "cv", currencyEligible: true },
  JV: { endpoint: "jv", printModuleType: "jv", currencyEligible: true },
  PO: { endpoint: "purchase-orders", printModuleType: "po", currencyEligible: true },
  // Checkpoint 6 - previously had no entry at all (fell through to apv).
  PCV: { endpoint: "petty-cash", printModuleType: "pettyCash", currencyEligible: true },
  DM: { endpoint: "debit-memos", printModuleType: "debitMemo", currencyEligible: true },
  CM: { endpoint: "credit-memos", printModuleType: "creditMemo", currencyEligible: true },
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