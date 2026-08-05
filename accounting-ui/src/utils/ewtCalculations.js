// EWT (Expanded Withholding Tax) base/amount preview - mirrors the
// authoritative formula in accounting-ui/src/backend/services/
// ewtCalculationService.js. This copy exists only to drive the live
// "suggested amount" the user sees while filling in the form; it is
// NOT trusted on save - the backend independently recomputes and, on
// mismatch, overrides with its own value, so this file drifting out of
// sync would only affect what's shown before saving, never what's stored.
//
// Core rule: EWT is computed on the VAT-exclusive amount, never on the VAT
// itself. This app has no VAT-inclusive entry mode - the user enters the
// exclusive base into the "Add VAT Line" helper, which posts VAT as its own
// journal line. So the VAT-exclusive base is: gross total minus whatever
// was posted to the VAT account.

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function sumVatLines(lines, vatAccountId) {
  if (!vatAccountId) return 0;
  return (lines || [])
    .filter((line) => String(line.accountId) === String(vatAccountId))
    .reduce((sum, line) => sum + (Number(line.debit) || 0) + (Number(line.credit) || 0), 0);
}

export function computeEwtTaxableBase({ grossAmount, lines, vatAccountId }) {
  const gross = Number(grossAmount) || 0;
  const vatLineTotal = sumVatLines(lines, vatAccountId);
  return roundMoney(gross - vatLineTotal);
}

export function computeEwtAmount({ taxableBase, ewtRate }) {
  const base = Number(taxableBase) || 0;
  const rate = Number(ewtRate) || 0;
  return roundMoney((base * rate) / 100);
}
