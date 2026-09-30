import BookReport from "./BookReport.jsx";

// Reports Phase L.5: Books of Accounts - Accounts Payable Book. Posted-only,
// company-scoped Accounts Payable Voucher lines (source_type = 'APV' from
// the canonical LedgerReportService union - "Accounts Payable Voucher" is
// this repository's own terminology, confirmed via transactionsMenuConfig.js
// / APV.jsx's title, not guessed) - the same shared BookReport renderer
// Journal Book / Income Book / Cash Receipt Book / Cash Disbursement Book
// use, configured with Accounts Payable Book's own literal title/endpoint/
// labels. Supplier, invoice number, due date, EWT, VAT, outstanding
// balance, payment status, CV application, and aging bucket are
// intentionally NOT shown - none of those are authoritative fields on the
// canonical union; they are not independently joined here. Document as a
// future enhancement if useful.
//
// This is an accounting book, not AP Aging: a Posted APV keeps appearing
// here with its original entries regardless of later CV settlement (CV
// settlement only updates apv_headers.payment_status/balance_amount,
// columns this report never reads). APV lifecycle needs no special
// handling either - a Void/Cancelled APV is already excluded by the
// canonical union's Posted-only filter, and an APV reversal produces a
// separate Posted reversing JV (shown in Journal Book) rather than a
// second APV row.
export default function AccountsPayableBook() {
  return (
    <BookReport
      title="Accounts Payable Book"
      apiPath="/api/reports/books/accounts-payable"
      referenceLabel="APV Number"
      filenamePrefix="Accounts_Payable_Book"
      emptyMessage="No Posted Accounts Payable Vouchers found for the selected dates."
    />
  );
}
