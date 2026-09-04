const TransactionPrintDataService = require("./transactionPrintDataService");

// The 3 UI "Print List by ..." options map 1:1 onto
// transactionPrintDataService.getTransactionList's existing grouping
// vocabulary for INV - no new query, just a whitelist so an arbitrary
// value can't reach the shared list query.
const ALLOWED_GROUPINGS = ["number", "date", "party"];

async function getInvoiceListPrintViewModel({ companyId, from, to, grouping }) {
  const safeGrouping = ALLOWED_GROUPINGS.includes(grouping) ? grouping : "number";

  const result = await TransactionPrintDataService.getTransactionList("invoice", {
    from: from || null,
    to: to || null,
    grouping: safeGrouping,
    companyId,
  });

  return {
    grouping: safeGrouping,
    from: from || null,
    to: to || null,
    seller: {
      name: result.company?.name || "",
      address: [result.company?.address, result.company?.zip].filter(Boolean).join(" "),
      tin: result.company?.tin || "",
    },
    // Flat listing (grouping "number"/"date") comes back as `rows`;
    // grouped listing ("party" - "Print List by Customer") comes back as
    // `groups` - both passed through unchanged, exactly as
    // transactionPrintDataService already built them.
    rows: result.rows || null,
    groups: result.groups || null,
    grandTotal: result.grandTotal,
    count: result.count,
  };
}

module.exports = { getInvoiceListPrintViewModel, ALLOWED_GROUPINGS };
