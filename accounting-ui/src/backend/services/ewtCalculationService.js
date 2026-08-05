// EWT (Expanded Withholding Tax) base/amount calculation - single source of
// truth for the backend, which is the final authority on stored tax values
// (see TransactionFormLayout.jsx's ewtCalculations.js for the frontend's
// non-authoritative preview mirror of this same formula).
//
// Core rule: EWT is computed on the VAT-exclusive amount, never on the VAT
// itself. This app has no VAT-inclusive entry mode - the user always enters
// the exclusive base into the "Add VAT Line" helper, which then posts VAT as
// its own journal line (see TransactionFormLayout.jsx's handleAddVatLine).
// So the VAT-exclusive base for a transaction is simply: gross total minus
// whatever was posted to the VAT account, derived from the actual journal
// lines rather than trusted from the client.

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Sums whichever side (debit or credit) is populated on lines whose account
// title matches the VAT keyword for this module (e.g. "input vat" for
// APV/CV, "output vat" for INV/OR) - mirrors the same title-based detection
// TransactionFormLayout.jsx already uses to auto-select the VAT account, so
// a line is recognized as "the VAT line" independent of any client-supplied
// account id.
function sumVatLines(lines, vatKeyword) {
  const keyword = String(vatKeyword || "vat").toLowerCase();
  return (lines || [])
    .filter((line) => String(line.accountTitle || "").toLowerCase().includes(keyword))
    .reduce((sum, line) => sum + (Number(line.debit) || 0) + (Number(line.credit) || 0), 0);
}

// grossAmount here is the transaction's balanced total (totalCredit ===
// totalDebit) - the VAT-exclusive base is that total minus the VAT line(s).
// If no VAT line is present, the base is the gross total unchanged (a
// non-VAT, VAT-exempt, or zero-rated transaction never had VAT added in the
// first place).
function computeEwtTaxableBase({ grossAmount, lines, vatKeyword }) {
  const gross = Number(grossAmount) || 0;
  const vatLineTotal = sumVatLines(lines, vatKeyword);
  return roundMoney(gross - vatLineTotal);
}

function computeEwtAmount({ taxableBase, ewtRate }) {
  const base = Number(taxableBase) || 0;
  const rate = Number(ewtRate) || 0;
  return roundMoney((base * rate) / 100);
}

module.exports = {
  roundMoney,
  sumVatLines,
  computeEwtTaxableBase,
  computeEwtAmount,
};
