// R8.4-C Bank Statement History - pure helpers for the page (no React, no
// fetch). Filters are sent to the server, which filters and paginates;
// nothing here filters statement rows on the client.

export const STATUS_FILTERS = [
  { value: "ALL", label: "All statuses" },
  { value: "MATCHED", label: "Matched" },
  { value: "UNMATCHED", label: "Unmatched" },
  { value: "NEEDS_REVIEW", label: "Needs review" },
  { value: "EXCEPTION", label: "Exception" },
  { value: "CARRIED_FORWARD", label: "Carried forward" },
  { value: "IGNORED", label: "Ignored" },
  { value: "POSSIBLE_DUPLICATE", label: "Possible duplicate" },
];

export const TYPE_FILTERS = [
  { value: "ALL", label: "Debit and credit" },
  { value: "DEBIT", label: "Debit (money out)" },
  { value: "CREDIT", label: "Credit (money in)" },
];

// Display label + badge class of each server status. The label is always
// shown as text, so the status never depends on colour alone.
export const STATUS_DISPLAY = {
  MATCHED: { label: "Matched", tone: "matched" },
  UNMATCHED: { label: "Unmatched", tone: "unmatched" },
  NEEDS_REVIEW: { label: "Needs review", tone: "suggested" },
  EXCEPTION: { label: "Exception", tone: "exception" },
  IGNORED: { label: "Ignored", tone: "ignored" },
};

export const FILTER_KEYS = ["from", "to", "status", "type", "q", "amountMin", "amountMax", "sessionId", "batchId"];

export function emptyFilters() {
  return { from: "", to: "", status: "ALL", type: "ALL", q: "", amountMin: "", amountMax: "", sessionId: "", batchId: "" };
}

// Filters from the page URL (so a link from the workspace opens the same view).
export function filtersFromSearch(search) {
  const p = new URLSearchParams(search);
  const f = emptyFilters();
  for (const k of FILTER_KEYS) if (p.get(k)) f[k] = p.get(k);
  return f;
}

// Query string for GET /api/bank-recon/statement-history (empty values and
// the "ALL" defaults are left out).
export function historyQuery({ companyId, bankAccountId }, filters, page = 1, pageSize = 25) {
  const p = new URLSearchParams();
  if (companyId) p.set("companyId", String(companyId));
  if (bankAccountId) p.set("bankAccountId", String(bankAccountId));
  for (const k of FILTER_KEYS) {
    const v = filters?.[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s || ((k === "status" || k === "type") && s === "ALL")) continue;
    p.set(k, s);
  }
  if (page > 1) p.set("page", String(page));
  if (pageSize !== 25) p.set("pageSize", String(pageSize));
  return p.toString();
}

export function activeFilterCount(filters) {
  return FILTER_KEYS.filter((k) => {
    const v = String(filters?.[k] ?? "").trim();
    return v && !((k === "status" || k === "type") && v === "ALL");
  }).length;
}

// Text flags shown next to the status.
export function rowFlags(row) {
  return [
    row.carriedForward ? "Carried forward" : null,
    row.possibleDuplicate ? "Possible duplicate" : null,
    row.highConfidence ? "High confidence" : null,
  ].filter(Boolean);
}

export function statusText(row) {
  return [STATUS_DISPLAY[row.status]?.label || row.status, ...rowFlags(row)].join(" · ");
}

export function formatPeso(value) {
  return `₱ ${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function periodLabel(session) {
  return session ? `#${session.id} · ${session.periodStart} to ${session.periodEnd}` : "";
}
