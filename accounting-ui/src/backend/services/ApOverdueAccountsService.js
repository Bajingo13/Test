const AgingReportService = require("./agingReportService");

// AP List of Overdue Accounts - a thin filter/composition layer over the
// EXISTING, UNCHANGED AgingReportService (the same engine that already
// powers AP Aging, AP Aging Summary, and - via its own mirrored predicate
// text, not a call into this file - AP List of Payables and Payments). No
// new recognition SQL, no new balance-reconstruction logic, no
// modification to agingReportService.js at all: this file calls the
// unchanged getAgingRows("AP", ...) and adds exactly one new selection
// criterion - dropping the "current" bucket (bucket !== "current",
// equivalently daysOutstanding >= 1) - since "List of Overdue Accounts"
// is by definition the strictly-overdue subset of AP Aging's inclusive
// row set (which deliberately also shows not-yet-due documents).
// getBucketTotals/getSummaryByParty are then reused unchanged on the
// filtered rows. The exact AR mirror of this file is
// ArOverdueAccountsService.js.
//
// Everything AP Aging already established is inherited as-is, not
// reinvented here: balance reconstruction from transaction_applications
// as of the given date (self-correcting for a voided/cancelled/reversed
// CV, whose transaction_applications rows unwindCvApplications already
// deletes), the days-overdue/bucket formulas, the VOID/CANCELLED +
// reversal-JV (source_module='APV_REVERSAL') exclusion already baked into
// the AP branch of fetchRawRows, the party/currency/status filters, and
// two documented existing characteristics - (1) Draft APVs ARE included
// (only VOID/CANCELLED plus reversed APVs are excluded), (2) Debit/Credit
// Memos never appear (Aging's row source never joins memo_headers).
// Neither is "fixed" here; doing so would require modifying
// agingReportService.js itself, which is out of scope for this report.
async function getOverdueAccounts({ companyId, asOfDate, currencyCode, partyId, status }) {
  const allRows = await AgingReportService.getAgingRows("AP", {
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
