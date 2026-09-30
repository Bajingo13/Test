import BookReport from "./BookReport.jsx";

// Reports Phase L.2: Books of Accounts - Income Book. Posted-only,
// company-scoped Invoice lines (source_type = 'INV' from the canonical
// LedgerReportService union) - same shared BookReport renderer Journal Book
// uses, configured with Income Book's own literal title/endpoint/labels.
// Customer/client information is intentionally NOT shown - it is not part
// of the canonical union's authoritative fields, and is not independently
// joined here; see the Phase L.2 report for that as a documented future
// enhancement.
export default function IncomeBook() {
  return (
    <BookReport
      title="Income Book"
      apiPath="/api/reports/books/income"
      referenceLabel="Invoice Number"
      filenamePrefix="Income_Book"
      emptyMessage="No Posted Invoices found for the selected dates."
    />
  );
}
