// Phase 7C: single source of truth for VAT-inclusive gross -> net/VAT
// calculation, used by both the Input VAT and Output VAT popups (the
// backend route handlers are authoritative here - see taxEntryService.js -
// with utils/vatCalculations.js as the frontend's non-authoritative preview
// mirror, matching the exact same pattern ewtCalculationService.js /
// utils/ewtCalculations.mjs already established for EWT).
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

// Phase 7J: VAT entry mode (INCLUSIVE / EXCLUSIVE) - an INPUT-interpretation
// snapshot only. INCLUSIVE (the historical, until-now-only behavior): the
// amount the user typed is the VAT-inclusive gross. EXCLUSIVE: the amount
// is the pre-VAT base and the modal derives gross = base + round(base*rate)
// before sending the SAME {grossAmount, netAmount, vatAmount, vatRate,
// vatCode, vatTreatment} payload. NULL / missing / unknown all read as
// INCLUSIVE (every pre-7J row). This never alters a stored amount, a
// report figure, or a print value - vatCalculationService's formulas are
// unchanged; this is metadata the backend validates and persists.
const VAT_ENTRY_MODES = ["INCLUSIVE", "EXCLUSIVE"];

function normalizeVatEntryMode(value) {
  const m = String(value == null ? "" : value).trim().toUpperCase();
  return m === "EXCLUSIVE" ? "EXCLUSIVE" : "INCLUSIVE";
}

// Strict check for backend validation: only the two canonical strings (or
// null/empty, which mean "default INCLUSIVE") are acceptable. Anything else
// is a client error, not silently coerced.
function isValidVatEntryMode(value) {
  if (value == null || String(value).trim() === "") return true;
  const m = String(value).trim().toUpperCase();
  return m === "INCLUSIVE" || m === "EXCLUSIVE";
}

// Mirror of utils/vatCalculations.js's computeVatByMode - same
// non-authoritative-preview relationship the rest of this file already has
// with its frontend twin. INCLUSIVE delegates to computeVatByTreatment
// unchanged (amount IS the inclusive gross). EXCLUSIVE + STANDARD: amount
// is the pre-VAT base -> vat = round(base * rate/100), gross = round(base
// + vat), net === base, net + vat === gross by construction. EXCLUSIVE +
// ZERO_RATED/EXEMPT: mode has no numeric effect (VAT 0, amount is the
// base). The payload shape is identical to the inclusive path, so the
// route handlers - which recompute from grossAmount - need no change.
function computeVatByMode({ amount, vatRatePercent, treatment, mode }) {
  const t = normalizeVatTreatment(treatment);
  const m = normalizeVatEntryMode(mode);

  if (m === "EXCLUSIVE" && !isZeroVatTreatment(t)) {
    const base = roundMoney(amount);
    const rate = Number(vatRatePercent);
    if (!base || !Number.isFinite(rate) || rate < 0) {
      return { grossAmount: base || 0, netAmount: 0, vatAmount: 0, treatment: "STANDARD" };
    }
    const vatAmount = roundMoney((base * rate) / 100);
    const grossAmount = roundMoney(base + vatAmount);
    return { grossAmount, netAmount: base, vatAmount, treatment: "STANDARD" };
  }

  return computeVatByTreatment({ amount, vatRatePercent, treatment: t });
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
  VAT_ENTRY_MODES,
  normalizeVatEntryMode,
  isValidVatEntryMode,
  computeVatByMode,
};
