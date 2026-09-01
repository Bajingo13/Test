// Structured tax-account identification, sourced ONLY from the Chart of
// Accounts "Validation Rules" already stored per account in coa_validations
// (validation_name) and already returned on every /api/coa row as
// `account.validations` (string[]). See server.js GET /api/coa and
// COA.jsx's VALIDATION_OPTIONS for the canonical vocabulary.
//
// This module deliberately does NOT look at account.title / account.code
// text, and introduces no new schema, field, or hardcoded account id - the
// validation assignment IS the source of truth. An account titled
// "Taxes Recoverable" tagged INPUT VAT is an Input VAT control account;
// an account titled "Input VAT" with no validation assigned is not.
//
// EWT mapping note (audited): the EWT accounting flow (server.js
// resolveTaxWithholding + ewt_library.tax_type) splits withholding into
// EXPANDED ("EWT"/default) and FINAL ("FINAL"). The COA validations
// EXPANDED TAX / FINAL TAX mirror that split exactly. The standard EWT
// modal flow used by INV/APV is Expanded Withholding Tax, so EXPANDED TAX
// is the primary EWT control validation; FINAL TAX is its final-withholding
// sibling. Both are tax-control accounts (neither is an ordinary posting
// account), so both are protected from the Regular Journal Entry dropdown,
// and the EWT modal sources accounts carrying either one.

export const VALIDATION_INPUT_VAT = "INPUT VAT";
export const VALIDATION_OUTPUT_VAT = "OUTPUT VAT";
export const VALIDATION_EXPANDED_TAX = "EXPANDED TAX";
export const VALIDATION_FINAL_TAX = "FINAL TAX";

// Primary validation that means "this is THE EWT control account".
export const EWT_PRIMARY_VALIDATION = VALIDATION_EXPANDED_TAX;

// Every validation that marks an account as a withholding-tax control
// account for account-sourcing purposes (the modal offers all of these).
export const EWT_CONTROL_VALIDATIONS = [VALIDATION_EXPANDED_TAX, VALIDATION_FINAL_TAX];

// Any account carrying one of these may not be picked on an ordinary
// (non-tax) journal line - it can only enter the journal through the
// matching tax modal.
export const PROTECTED_TAX_VALIDATIONS = [
  VALIDATION_INPUT_VAT,
  VALIDATION_OUTPUT_VAT,
  VALIDATION_EXPANDED_TAX,
  VALIDATION_FINAL_TAX,
];

function norm(value) {
  return String(value == null ? "" : value).trim().toUpperCase();
}

// Normalized set of an account's assigned validation names. Tolerant of a
// missing/again-shaped `validations` (older cached payloads, partial rows).
export function accountValidationSet(account) {
  const raw = account && Array.isArray(account.validations) ? account.validations : [];
  return new Set(raw.map(norm));
}

export function accountHasValidation(account, validationName) {
  return accountValidationSet(account).has(norm(validationName));
}

export function accountHasAnyValidation(account, validationNames) {
  const set = accountValidationSet(account);
  return (validationNames || []).some((name) => set.has(norm(name)));
}

// True for Input VAT / Output VAT / Expanded Tax / Final Tax control
// accounts - the ones that must never be hand-posted on a regular line.
export function isProtectedTaxAccount(account) {
  return accountHasAnyValidation(account, PROTECTED_TAX_VALIDATIONS);
}

// The account list the Regular Journal Entry dropdown may offer: every
// ordinary account (AR/AP/Cash/Income/Expense/Prepayment/Fixed Asset/
// Inventory/...) stays; only validation-marked tax-control accounts are
// removed. `keepAccountId` keeps one already-selected account visible even
// if it is protected (e.g. a legacy line, or an OR/CV/PO legacy-VAT line
// that carries no taxEntry tag) so saved data is never silently blanked -
// it stays shown for that row but cannot be newly chosen elsewhere.
export function filterSelectableRegularAccounts(accountOptions, keepAccountId = null) {
  const list = Array.isArray(accountOptions) ? accountOptions : [];
  return list.filter(
    (acc) =>
      !isProtectedTaxAccount(acc) ||
      (keepAccountId != null && String(acc.id) === String(keepAccountId))
  );
}

// Accounts a specific tax modal may use, by validation. VAT modals pass a
// single validation; the EWT modal passes EWT_CONTROL_VALIDATIONS.
export function filterAccountsByValidations(accountOptions, validationNames) {
  const list = Array.isArray(accountOptions) ? accountOptions : [];
  return list.filter((acc) => accountHasAnyValidation(acc, validationNames));
}

export function inputVatAccounts(accountOptions) {
  return filterAccountsByValidations(accountOptions, [VALIDATION_INPUT_VAT]);
}

export function outputVatAccounts(accountOptions) {
  return filterAccountsByValidations(accountOptions, [VALIDATION_OUTPUT_VAT]);
}

export function ewtControlAccounts(accountOptions) {
  return filterAccountsByValidations(accountOptions, EWT_CONTROL_VALIDATIONS);
}

// Resolve the default account for a tax modal: the single validated
// account when exactly one exists, otherwise "" (force an explicit choice
// rather than guess). Never falls back to title matching.
export function defaultTaxAccountId(matchingAccounts) {
  const list = Array.isArray(matchingAccounts) ? matchingAccounts : [];
  return list.length === 1 ? String(list[0].id) : "";
}

// Item 10: the exact message to show when a tax entry is needed but no COA
// account carries the required validation.
export function missingTaxAccountMessage(kind) {
  switch (kind) {
    case "INPUT_VAT":
      return "No Input VAT account is configured. Assign INPUT VAT in Chart of Accounts Validation Rules.";
    case "OUTPUT_VAT":
      return "No Output VAT account is configured. Assign OUTPUT VAT in Chart of Accounts Validation Rules.";
    case "EWT":
      return "No EWT account is configured. Assign EXPANDED TAX (or FINAL TAX) in Chart of Accounts Validation Rules.";
    default:
      return "No tax account is configured for this entry. Assign the matching rule in Chart of Accounts Validation Rules.";
  }
}
