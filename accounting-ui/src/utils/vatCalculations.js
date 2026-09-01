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
