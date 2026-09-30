import BookReport from "./BookReport.jsx";

// Reports Phase L.6: Books of Accounts - Petty Cash Book. Posted-only,
// company-scoped Petty Cash Voucher lines (source_type = 'PETTY CASH' from
// the canonical LedgerReportService union - "Petty Cash Voucher" is this
// repository's own terminology, confirmed via transactionsMenuConfig.js /
// PettyCashVoucher.jsx's title, not guessed) - the same shared BookReport
// renderer Journal Book / Income Book / Cash Receipt Book / Cash
// Disbursement Book / Accounts Payable Book use, configured with Petty Cash
// Book's own literal title/endpoint/labels. Payee, replenishment reference,
// receipt number, and approval data are intentionally NOT shown - none of
// those are authoritative fields on the canonical union; they are not
// independently joined here. Document as a future enhancement if useful.
//
// Petty Cash lifecycle needs no special handling: the repository has no
// void/cancel/reverse route for Petty Cash Vouchers at all - only Draft
// (freely editable/deletable) and Posted (immutable once Posted). A Posted
// PCV is already excluded from this Book if it somehow were not Posted, via
// the canonical union's Posted-only filter, and there is no reversing entry
// of any kind to account for.
export default function PettyCashBook() {
  return (
    <BookReport
      title="Petty Cash Book"
      apiPath="/api/reports/books/petty-cash"
      referenceLabel="PCV Number"
      filenamePrefix="Petty_Cash_Book"
      emptyMessage="No Posted Petty Cash Vouchers found for the selected dates."
    />
  );
}
