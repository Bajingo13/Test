import BookReport from "./BookReport.jsx";

// Reports Phase L.7: Books of Accounts - Debit/Credit Memo Book, the
// seventh and final individual Book. A single combined Book over two
// source types (source_type = 'DEBIT MEMO' or 'CREDIT MEMO' from the
// canonical LedgerReportService union - "Debit Memo" and "Credit Memo" are
// this repository's own terminology, confirmed via transactionsMenuConfig.js
// / DebitMemo.jsx / CreditMemo.jsx's titles, not guessed) - the same shared
// BookReport renderer the other six Books use, configured with this Book's
// own literal title/endpoint/labels. Party (customer/supplier), source
// invoice/APV reference, and correction reason are intentionally NOT shown -
// none of those are authoritative fields on the canonical union; they are
// not independently joined here. Document as a future enhancement if useful.
//
// Memo Type column (typeColumn prop): Debit Memo and Credit Memo share one
// memo_headers/memo_lines table pair with one free-typed, user-entered
// voucher_no column - manual numbering, no enforced DM-/CM- prefix (see
// voucherNumberService.js) - so two rows with the identical reference
// number could otherwise be indistinguishable as to which Memo produced
// them. This is the one genuine, minimal, optional (default-off for every
// other Book) case where showing the row's underlying source_type earns its
// place; the six single-source Books never opt into it and are completely
// unaffected (see BookReport.jsx).
//
// Lifecycle needs no special handling here either: like Petty Cash, the
// repository has no void/cancel/reverse route for either Debit or Credit
// Memo at all - only Draft (freely editable/deletable) and Posted
// (immutable once Posted). A Posted Memo is already excluded from this Book
// if it somehow were not Posted, via the canonical union's Posted-only
// filter, and there is no reversing entry of any kind to account for.
export default function DebitCreditMemoBook() {
  return (
    <BookReport
      title="Debit/Credit Memo Book"
      apiPath="/api/reports/books/debit-credit-memo"
      referenceLabel="Memo Number"
      filenamePrefix="Debit_Credit_Memo_Book"
      emptyMessage="No Posted Debit or Credit Memos found for the selected dates."
      typeColumn={{
        label: "Memo Type",
        getValue: (row) =>
          row.source_type === "DEBIT MEMO"
            ? "Debit Memo"
            : row.source_type === "CREDIT MEMO"
            ? "Credit Memo"
            : row.source_type,
      }}
    />
  );
}
