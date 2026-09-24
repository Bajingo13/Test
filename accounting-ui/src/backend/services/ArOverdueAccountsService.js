const AgingReportService = require("./agingReportService");

// AR List of Overdue Accounts - a thin filter/composition layer over the
// EXISTING, UNCHANGED AgingReportService (the same engine that already
// powers AR Aging and AR Aging Summary). No new recognition SQL, no new
// balance-reconstruction logic, no modification to agingReportService.js
// at all: this file calls the unchanged getAgingRows("AR", ...) and adds
// exactly one new selection criterion - dropping the "current" bucket
// (bucket !== "current", equivalently daysOutstanding >= 1) - since "List
// of Overdue Accounts" is by definition the strictly-overdue subset of AR
// Aging's inclusive row set (which deliberately also shows not-yet-due
// documents). getBucketTotals/getSummaryByParty are then reused unchanged
// on the filtered rows.
//
// Everything AR Aging already established is inherited as-is, not
// reinvented here: balance reconstruction from transaction_applications
// as of the given date, the days-overdue/bucket formulas, the party/
// currency/status filters, and two documented existing characteristics -
// (1) Draft invoices are included (the AR branch of fetchRawRows has no
// status filter of any kind), (2) Debit/Credit Memos never appear (Aging's
// row source never joins memo_headers). Neither is "fixed" here; doing so
// would require modifying agingReportService.js itself, which is out of
// scope for this report.
async function getOverdueAccounts({ companyId, asOfDate, currencyCode, partyId, status }) {
  const allRows = await AgingReportService.getAgingRows("AR", {
    companyId,
    asOfDate,
    currencyCode,
    partyId,
    status,
  });

  const overdueRows = allRows.filter((r) => r.bucket !== "current");

  return {
    rows: overdueRows,
    bucketTotals: AgingReportService.getBucketTotals(overdueRows),
    parties: AgingReportService.getSummaryByParty(overdueRows),
  };
}

module.exports = { getOverdueAccounts };
