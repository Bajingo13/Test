// Phase 6A (Tax File Setup hub). Pure derivation of EWT Library counts
// from the same array GET /api/ewt-library already returns - no separate
// count endpoint, no separate EWT table. Extracted so the count logic is
// unit-testable without a DOM/fetch, same reasoning as dateRangeFilter.mjs.
export function computeEwtSummary(records) {
  const total = Array.isArray(records) ? records.length : 0;
  const active = Array.isArray(records) ? records.filter((item) => item.status === "ACTIVE").length : 0;
  return { total, active, inactive: total - active };
}
