// Phase 7C: single source of truth for VAT-inclusive gross -> net/VAT
// calculation, used by both the Input VAT and Output VAT popups (the
// backend route handlers are authoritative here - see taxEntryService.js -
// with utils/vatCalculations.js as the frontend's non-authoritative preview
// mirror, matching the exact same pattern ewtCalculationService.js /
// utils/ewtCalculations.js already established for EWT).
//
// Prior to Phase 7C, this app had no VAT-inclusive entry mode at all - the
// old "Add VAT Line" helper only accepted an already-EXCLUSIVE taxable
// amount and multiplied by rate (see ewtCalculationService.js's own
// header comment). This is a new, separate formula for a new input mode;
// it does not replace or alter that old exclusive-amount calculation,
// which OR/CV/PO's untouched VAT card continues to use exactly as before.

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

const DEFAULT_VAT_RATE = 12;

// Gross Purchase/Gross Sale is VAT-inclusive (the figure printed on the
// actual supplier invoice or issued to the customer):
//   Net = Gross / (1 + rate/100)
//   VAT = Gross - Net
// (never Net * rate independently - VAT is defined as the remainder, so
// Net + VAT always reconstructs Gross exactly after rounding.)
function computeVatFromInclusiveGross({ gross, vatRatePercent }) {
  const g = roundMoney(gross);
  const rate = Number(vatRatePercent);

  if (!g) {
    return { grossAmount: 0, netAmount: 0, vatAmount: 0 };
  }
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error("VAT rate must be a non-negative number.");
  }

  const netAmount = roundMoney(g / (1 + rate / 100));
  // VAT is the remainder, not a second independent multiplication - this
  // guarantees Net + VAT === Gross exactly (section 37/41's "Gross = Net +
  // VAT after rounding" requirement) even where rate*net would round
  // differently by a centavo.
  const vatAmount = roundMoney(g - netAmount);

  return { grossAmount: g, netAmount, vatAmount };
}

module.exports = { roundMoney, computeVatFromInclusiveGross, DEFAULT_VAT_RATE };
