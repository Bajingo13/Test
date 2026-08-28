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

// Phase 7B: client-side column sorting - the list is already fully loaded
// in memory (see the header comment above on why filtering is client-side
// too), so sorting the same array adds no new request and no pagination
// risk. Generic across every module using this shared list (Invoice/OR/
// APV/CV/PO/JV all map into the identical {referenceNo, date, party,
// amount, status} shape in TransactionFormLayout.jsx's loadTransactions()),
// not Invoice-specific - confirmed safe by that shared mapping shape, not
// assumed.

// referenceNo/voucher_no is 100% free-text (no real auto-numbering scheme
// exists anywhere in this codebase - confirmed by reading every module's
// POST handler in server.js), so its format can't be assumed to be
// consistently zero-padded. A natural comparator (numeric runs compared as
// numbers, non-numeric runs compared as text) handles both "INV-000001"-
// style padded numbers and unpadded ones like "INV-2" vs "INV-10"
// correctly, where plain lexical comparison would put "INV-10" before
// "INV-2".
function naturalCompare(a, b) {
  const strA = String(a ?? "");
  const strB = String(b ?? "");
  const chunk = /(\d+|\D+)/g;
  const partsA = strA.match(chunk) || [];
  const partsB = strB.match(chunk) || [];
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;

    const numA = /^\d+$/.test(pa) ? Number(pa) : null;
    const numB = /^\d+$/.test(pb) ? Number(pb) : null;

    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
    } else {
      const cmp = pa.localeCompare(pb, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

const SORT_COMPARATORS = {
  referenceNo: (a, b) => naturalCompare(a.referenceNo, b.referenceNo),
  // Both dates are already 'YYYY-MM-DD' strings (see the header comment on
  // matchesDateRange's own reasoning) - lexicographic comparison is already
  // chronologically correct for that format, no Date object needed.
  date: (a, b) => String(a.date || "").localeCompare(String(b.date || "")),
  party: (a, b) => String(a.party || "").localeCompare(String(b.party || ""), undefined, { sensitivity: "base" }),
  status: (a, b) => String(a.status || "").localeCompare(String(b.status || ""), undefined, { sensitivity: "base" }),
  amount: (a, b) => Number(a.amount || 0) - Number(b.amount || 0),
};

// sortBy=null (or unrecognized) returns the array UNCHANGED - the original
// loaded order is preserved until the user explicitly sorts (spec section
// 13), and clearing the sort (the 3rd click state) returns to it exactly,
// not a re-derived "default" order.
export function sortTransactions(transactions, { sortBy, sortDirection } = {}) {
  const list = transactions || [];
  const comparator = SORT_COMPARATORS[sortBy];
  if (!comparator) return list;

  const sorted = [...list].sort(comparator);
  return sortDirection === "desc" ? sorted.reverse() : sorted;
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
