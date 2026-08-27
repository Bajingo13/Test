// Phase 5 (shared date/calendar filtering). One pure, framework-free
// function reused by every list that filters client-side against an
// already-loaded, already-scoped result set (transaction lists via
// transactionListFilters.mjs, EWT Library, Chart of Accounts) - a single
// source of truth instead of four independently-written comparisons that
// could quietly drift out of sync.
//
// Timezone safety: dateValue is expected to already be a plain
// 'YYYY-MM-DD' calendar-date string - every backend list route that feeds
// these lists formats its date column with MySQL's DATE_FORMAT(...,
// '%Y-%m-%d') before it ever reaches the client (see server.js's /api/
// invoices, /api/or, /api/coa, /api/ewt-library). This function never
// constructs a `new Date(...)`, so there is no UTC/local conversion at any
// point in the comparison - the classic "2026-08-27 becomes the 26th" bug
// class simply cannot occur here. Comparison is a plain string comparison,
// which is valid for 'YYYY-MM-DD' strings because that format sorts
// lexicographically in the same order as chronologically.
//
// Both boundaries are inclusive: a record dated exactly `from` or exactly
// `to` is included, matching the checkpoint's explicit "record exactly on
// From" / "record exactly on To" requirement.
export function matchesDateRange(dateValue, { from, to } = {}) {
  if (!from && !to) return true;
  if (!dateValue) return false;
  const key = String(dateValue).slice(0, 10);
  if (from && key < from) return false;
  if (to && key > to) return false;
  return true;
}
