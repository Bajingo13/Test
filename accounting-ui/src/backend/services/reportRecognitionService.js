// Checkpoint 6B: single definition of "financially recognized" reused by
// every report query in the app (Trial Balance, General Ledger, Account
// Analysis, Income Statement, Balance Sheet, Cash Flow, Subsidiary Ledger,
// Trial Balance Checker). A transaction with a Draft/Posted lifecycle is
// recognized only once its status is Posted.
//
// Checked case-insensitively on purpose: the audit for this checkpoint
// found the app's own save routes are inconsistent about casing - Invoice
// and APV default an omitted status to "DRAFT" while every other module
// defaults to "Draft", and the app's own isPosting logic already treats
// these as equivalent (String(status).toUpperCase() === "POSTED" appears
// throughout server.js for period-locking/currency-rate-locking purposes).
// A case-sensitive status = 'Posted' predicate here would silently exclude
// genuinely-posted rows that happen to carry an unexpected casing,
// re-introducing a correctness bug while fixing a different one.
//
// Modules with no Draft/Posted lifecycle at all (AR/AP Beginning Balance,
// GL Beginning Balance) always insert as immediately-effective 'Posted'
// (see GLBeginningBalanceService.js's own comment) - applying this same
// predicate to them is a safe no-op, not a policy change for those tables.
// Purchase Order uses an unrelated Open/Closed lifecycle and was never
// included in any financial report to begin with; this helper is not used
// for PO anywhere.
function postedOnlySql(alias) {
  const prefix = alias ? `${alias}.` : "";
  return `UPPER(${prefix}status) = 'POSTED'`;
}

module.exports = { postedOnlySql };
