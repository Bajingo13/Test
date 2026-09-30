import BookReport from "./BookReport.jsx";

// Reports Phase L.1: Books of Accounts - Journal Book. Posted-only,
// company-scoped Journal Voucher lines (source_type = 'JV' from the
// canonical LedgerReportService union). Phase L.2 extracted the shared
// rendering/fetch/CSV logic into BookReport.jsx once Income Book made the
// duplication real - this wrapper is now just the explicit, literal
// configuration for Journal Book; behavior is unchanged from Phase L.1.
export default function JournalBook() {
  return (
    <BookReport
      title="Journal Book"
      apiPath="/api/reports/books/journal"
      referenceLabel="JV Number"
      filenamePrefix="Journal_Book"
      emptyMessage="No Posted Journal Vouchers found for the selected dates."
    />
  );
}
