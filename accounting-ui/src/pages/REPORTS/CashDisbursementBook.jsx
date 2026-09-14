import BookReport from "./BookReport.jsx";

// Reports Phase L.4: Books of Accounts - Cash Disbursement Book. Posted-only,
// company-scoped Check Voucher lines (source_type = 'CV' from the canonical
// LedgerReportService union - "Check Voucher" is this repository's own
// terminology, confirmed via transactionsMenuConfig.js / CV.jsx's title, not
// guessed) - the same shared BookReport renderer Journal Book / Income Book
// / Cash Receipt Book use, configured with Cash Disbursement Book's own
// literal title/endpoint/labels. Supplier, APV application, check number,
// bank, EWT/VAT, and payment method are intentionally NOT shown - none of
// those are authoritative fields on the canonical union; they are not
// independently joined here. Document as a future enhancement if useful.
//
// CV lifecycle needs no special handling: a Void/Cancelled CV is already
// excluded by the canonical union's Posted-only filter, and a CV reversal
// produces a separate Posted reversing JV (shown in Journal Book) rather
// than a second CV row - the original CV simply keeps appearing here,
// unchanged, exactly once.
export default function CashDisbursementBook() {
  return (
    <BookReport
      title="Cash Disbursement Book"
      apiPath="/api/reports/books/cash-disbursement"
      referenceLabel="CV Number"
      filenamePrefix="Cash_Disbursement_Book"
      emptyMessage="No Posted Check Vouchers found for the selected dates."
    />
  );
}
