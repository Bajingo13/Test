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
