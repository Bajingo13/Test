import BookReport from "./BookReport.jsx";

// Reports Phase L.3: Books of Accounts - Cash Receipt Book. Posted-only,
// company-scoped Official Receipt lines (source_type = 'OR' from the
// canonical LedgerReportService union) - the same shared BookReport renderer
// Journal Book / Income Book use, configured with Cash Receipt Book's own
// literal title/endpoint/labels. Payment method, bank, check number, and
// invoice-application detail are intentionally NOT shown - none of those are
// authoritative fields on the canonical union; they are not independently
// joined here. Document as a future enhancement if useful.
export default function CashReceiptBook() {
  return (
    <BookReport
      title="Cash Receipt Book"
      apiPath="/api/reports/books/cash-receipt"
      referenceLabel="OR Number"
      filenamePrefix="Cash_Receipt_Book"
      emptyMessage="No Posted Official Receipts found for the selected dates."
    />
  );
}
