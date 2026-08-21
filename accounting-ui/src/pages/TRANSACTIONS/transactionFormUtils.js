// Checkpoint 7A: extracted verbatim from TransactionFormLayout.jsx so the
// new sub-components (EntryTotals, CurrencySummary) and the parent share
// one definition instead of drifting copies. No behavior change - same
// formatting as before.
export function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
