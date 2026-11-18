const { HttpError } = require("../lib/httpError");

// Phase 7I: backend zero-line guard. Validation ONLY - a read-only pre-check
// on the raw client-submitted `lines` array. It never mutates `lines`,
// never generates or counts a VAT/EWT row, and runs BEFORE any header/line/
// transaction_tax_entries persistence and before resolveTransactionCurrency.
// The existing tax pipeline (VatEntryModal/EwtEntryModal -> line.taxEntry ->
// taxEntryService) is untouched.

const CODE = "TRANSACTION_LINES_REQUIRED";
const GL_MESSAGE = "At least one transaction line is required.";
const QUOTATION_MESSAGE = "At least one quotation item line is required.";

// A SUBSTANTIVE BUSINESS LINE is a journal line the user entered as a
// regular accounting entry: it has a positive debit or credit AND does NOT
// carry Phase 7C `taxEntry` metadata (that flag marks a VAT/EWT line built
// by the tax modal - see AccountingEntriesGrid.jsx, which likewise keys off
// `line.taxEntry` presence, never a title/particulars match). A transaction
// whose only lines are generated tax rows, empty objects, or zero-amount
// rows is NOT a valid business transaction.
function isSubstantiveBusinessLine(line) {
  if (!line || typeof line !== "object") return false;
  if (line.taxEntry) return false;
  return Number(line.debit) > 0 || Number(line.credit) > 0;
}

// A journal line's debit and credit are amounts on one side or the other -
// never negative. A negative figure (e.g. Dr -200 / Cr -200) was accepted
// and stored, which lets a "balanced" voucher carry entries that mean the
// opposite of what they show. The user enters the amount on the other side
// instead. `allowNegative` exists only for the APV reversal, which swaps an
// already-stored document's lines and must stay able to reverse historical
// data exactly as it was recorded.
const NEGATIVE_CODE = "TRANSACTION_LINE_NEGATIVE_AMOUNT";
function assertNoNegativeLineAmounts(lines) {
  if (!Array.isArray(lines)) return;
  const idx = lines.findIndex((l) => l && typeof l === "object" && (Number(l.debit) < 0 || Number(l.credit) < 0));
  if (idx !== -1) {
    throw new HttpError(
      400,
      `Line ${idx + 1}: debit and credit amounts cannot be negative. Enter the amount on the opposite side instead.`,
      NEGATIVE_CODE
    );
  }
}

function assertRequiredTransactionLines(lines, { allowNegative = false } = {}) {
  if (!allowNegative) assertNoNegativeLineAmounts(lines);
  if (!Array.isArray(lines) || !lines.some(isSubstantiveBusinessLine)) {
    throw new HttpError(400, GL_MESSAGE, CODE);
  }
}

// A quotation item line: line_type 'item' with a description, amount, or
// quantity. 'section' rows are visual separators and never count. Mirrors
// the frontend's existing "Add at least one item line." rule.
function isSubstantiveQuotationLine(line) {
  if (!line || typeof line !== "object") return false;
  if (line.lineType !== "item") return false;
  return (
    String(line.description == null ? "" : line.description).trim() !== "" ||
    Number(line.amount) > 0 ||
    Number(line.quantity) > 0
  );
}

function assertRequiredQuotationLines(lines) {
  if (!Array.isArray(lines) || !lines.some(isSubstantiveQuotationLine)) {
    throw new HttpError(400, QUOTATION_MESSAGE, CODE);
  }
}

module.exports = {
  assertRequiredTransactionLines,
  assertNoNegativeLineAmounts,
  TRANSACTION_LINE_NEGATIVE_AMOUNT_CODE: NEGATIVE_CODE,
  assertRequiredQuotationLines,
  isSubstantiveBusinessLine,
  isSubstantiveQuotationLine,
  TRANSACTION_LINES_REQUIRED_CODE: CODE,
  GL_MESSAGE,
  QUOTATION_MESSAGE,
};
