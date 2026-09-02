// Phase 7C: VAT-inclusive gross -> net/VAT preview - mirrors the
// authoritative formula in accounting-ui/src/backend/services/
// vatCalculationService.js, same non-authoritative-preview relationship
// ewtCalculations.js already has with ewtCalculationService.js. The
// backend independently recomputes on save; this only drives the live
// Net Purchase/VAT Paid (or Net Sale/Output VAT) preview in the popup.

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export const DEFAULT_VAT_RATE = 12;

export function computeVatFromInclusiveGross({ gross, vatRatePercent }) {
  const g = roundMoney(gross);
  const rate = Number(vatRatePercent);

  if (!g || !Number.isFinite(rate) || rate < 0) {
    return { grossAmount: g || 0, netAmount: 0, vatAmount: 0 };
  }

  const netAmount = roundMoney(g / (1 + rate / 100));
  const vatAmount = roundMoney(g - netAmount);

  return { grossAmount: g, netAmount, vatAmount };
}

// Phase 7E preview mirror of vatCalculationService.js's treatment logic.
// STANDARD/ZERO_RATED/EXEMPT stay distinct as data even though the last two
// both compute VAT = 0. Non-authoritative - the backend re-validates on save.
export const VAT_TREATMENTS = ["STANDARD", "ZERO_RATED", "EXEMPT"];

export function normalizeVatTreatment(value) {
  const t = String(value == null ? "" : value).trim().toUpperCase();
  return t || "STANDARD";
}

export function isZeroVatTreatment(value) {
  return normalizeVatTreatment(value) === "ZERO_RATED" || normalizeVatTreatment(value) === "EXEMPT";
}

export function computeVatByTreatment({ amount, vatRatePercent, treatment }) {
  const t = normalizeVatTreatment(treatment);
  if (isZeroVatTreatment(t)) {
    const base = roundMoney(amount);
    return { grossAmount: base, netAmount: base, vatAmount: 0, treatment: t };
  }
  return { ...computeVatFromInclusiveGross({ gross: amount, vatRatePercent }), treatment: "STANDARD" };
}

// Phase 7J: VAT entry mode - whether the amount the user typed is the
// VAT-INCLUSIVE gross (the historical, only-until-now behavior) or the
// VAT-EXCLUSIVE base. This is an INPUT-interpretation choice only; the
// returned payload shape is identical and every downstream consumer
// (backend validation, saveTaxEntries, Output VAT report, print) is
// unchanged. NULL / missing / unknown all read as INCLUSIVE.
export const VAT_ENTRY_MODES = ["INCLUSIVE", "EXCLUSIVE"];

export function normalizeVatEntryMode(value) {
  const m = String(value == null ? "" : value).trim().toUpperCase();
  return m === "EXCLUSIVE" ? "EXCLUSIVE" : "INCLUSIVE";
}

// INCLUSIVE            -> delegate to computeVatByTreatment unchanged
//                        (amount IS the inclusive gross).
// EXCLUSIVE + STANDARD -> amount is the pre-VAT base:
//                          base  = roundMoney(amount)
//                          vat   = roundMoney(base * rate / 100)
//                          gross = roundMoney(base + vat)
//                        net === base, and net + vat === gross by
//                        construction. The payload shape is identical to
//                        the inclusive path; the backend re-validates the
//                        VAT line amount against computeVatByTreatment(gross)
//                        and its existing 0.01 tolerance absorbs any
//                        sub-centavo difference between base*rate and the
//                        inclusive split.
// EXCLUSIVE + ZERO_RATED/EXEMPT -> VAT is 0 and the amount is the base
//                        either way, so the mode has no numeric effect;
//                        computeVatByTreatment already returns {base, base, 0}.
export function computeVatByMode({ amount, vatRatePercent, treatment, mode }) {
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
