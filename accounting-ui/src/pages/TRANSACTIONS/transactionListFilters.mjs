// Phase 7E: real search/status filtering for the transaction list (spec
// section 14) - the search input and status <select> existed since before
// Checkpoint 7 but had no value/onChange wired at all (confirmed during
// the original Checkpoint 7 architecture audit). Pure, framework-free
// functions - unit-testable with plain Jest, same pattern as
// voucherToolbarRules.mjs (see that file's own header comment for why
// this repo's Vite dev server needs real ESM, not CommonJS, for a file
// like this).
//
// Client-side filtering is a deliberate choice, not an oversight (spec
// section 15's "inspect first"): every transaction-list GET route
// (/api/invoices, /api/apv, etc.) already loads the full company-scoped
// result set with no LIMIT/OFFSET/pagination anywhere in server.js, and
// every one of these lists is already fetched in full into `transactions`
// state before this filter ever runs - so filtering that same in-memory
// array client-side adds no new network cost and no new large-dataset
// risk beyond what already existed.
//
// Phase 5: date-range filtering reuses the exact same architecture - the
// shared matchesDateRange() helper (utils/dateRangeFilter.js) is applied
// to each transaction's own `date` field (already normalized per-module to
// mean "Invoice Date" / "Receipt Date" / etc. by TransactionFormLayout.jsx's
// loadTransactions() mapping, itself sourced from each list route's own
// DATE_FORMAT(...,'%Y-%m-%d') column - see that file for why this is
// timezone-safe).

import { matchesDateRange } from "../../utils/dateRangeFilter.mjs";

export function matchesSearch(transaction, searchQuery) {
  if (!searchQuery || !searchQuery.trim()) return true;
  const q = searchQuery.trim().toLowerCase();
  const haystack = [transaction.referenceNo, transaction.party, transaction.form?.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function matchesStatus(transaction, statusFilter) {
  if (!statusFilter || statusFilter === "All Status") return true;
  return String(transaction.status || "") === statusFilter;
}

export function filterTransactions(transactions, { searchQuery, statusFilter, dateFrom, dateTo }) {
  return (transactions || []).filter(
    (t) =>
      matchesSearch(t, searchQuery) &&
      matchesStatus(t, statusFilter) &&
      matchesDateRange(t.date, { from: dateFrom, to: dateTo })
  );
}

// Status filter OPTIONS are derived from whatever status values are
// actually present in this module's own loaded list, never a fixed
// hardcoded set - Invoice/APV show PAYMENT status (Unpaid/Partially Paid/
// Paid) in this same column, while OR/CV/JV/PO/PCV/DM/CM show the
// transaction status (Draft/Posted/...) - a fixed Draft/Posted/Cancelled
// list (the old decorative version) would have been actively wrong for
// Invoice/APV.
export function deriveStatusOptions(transactions) {
  const distinct = [...new Set((transactions || []).map((t) => t.status).filter(Boolean))];
  distinct.sort();
  return ["All Status", ...distinct];
}
