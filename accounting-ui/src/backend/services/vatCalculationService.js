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

// Phase 7E: explicit VAT treatment classification. ZERO_RATED and EXEMPT
// are legally distinct from each other and from a genuine 0% STANDARD
// line, even though all three compute VAT = 0 - the treatment is carried
// as data, never re-derived from the rate.
const VAT_TREATMENTS = ["STANDARD", "ZERO_RATED", "EXEMPT"];
const ZERO_VAT_TREATMENTS = ["ZERO_RATED", "EXEMPT"];

function normalizeVatTreatment(value) {
  const t = String(value == null ? "" : value).trim().toUpperCase();
  return t || "STANDARD"; // a missing snapshot (historical rows / EWT) reads as STANDARD
}

function isValidVatTreatment(value) {
  return VAT_TREATMENTS.includes(normalizeVatTreatment(value));
}

function isZeroVatTreatment(value) {
  return ZERO_VAT_TREATMENTS.includes(normalizeVatTreatment(value));
}

// A ZERO_RATED / EXEMPT code (or entry) must never carry a non-zero rate -
// that would be a contradiction (a "12% exempt" line is meaningless).
function isTreatmentRateConsistent(treatment, ratePercent) {
  if (!isZeroVatTreatment(treatment)) return true;
  return Number(ratePercent || 0) === 0;
}

// Single dispatch point for "amount + rate + treatment -> {gross, net, vat}".
// STANDARD: the amount is a VAT-INCLUSIVE gross, split by the formula above.
// ZERO_RATED / EXEMPT: the amount IS the net/base; VAT is 0; gross == net
// (there is no VAT component to add). The base is still recorded so BIR
// reporting can show Zero-Rated / Exempt sales separately from VATable.
function computeVatByTreatment({ amount, vatRatePercent, treatment }) {
  const t = normalizeVatTreatment(treatment);

  if (isZeroVatTreatment(t)) {
    const base = roundMoney(amount);
    return { grossAmount: base, netAmount: base, vatAmount: 0, treatment: t };
  }

  const result = computeVatFromInclusiveGross({ gross: amount, vatRatePercent });
  return { ...result, treatment: "STANDARD" };
}

module.exports = {
  roundMoney,
  computeVatFromInclusiveGross,
  computeVatByTreatment,
  DEFAULT_VAT_RATE,
  VAT_TREATMENTS,
  ZERO_VAT_TREATMENTS,
  normalizeVatTreatment,
  isValidVatTreatment,
  isZeroVatTreatment,
  isTreatmentRateConsistent,
};
