import { formatMoney } from "../utils/invoicePrintFormatters";

// The internal accounting copy ("Print With Entries") - every ledger line
// exactly as invoicePrintDataService's withEntries=true branch already
// builds it (account code/title/particulars/debit/credit), plus the same
// balanced debit=credit check transactionPrintDataService.buildEntriesSummary
// computes. Structurally different from InvoiceItemsTable (the customer-
// facing copy) on purpose - this is not a "with more columns" variant of
// that table, it's the raw journal entry.
export default function InvoiceEntriesTable({ items, currencyCode, entriesSummary }) {
  return (
    <>
      <table className="invoice-items-table invoice-entries-table">
        <thead>
          <tr>
            <th className="line-no">#</th>
            <th className="account">Account</th>
            <th className="description">Particulars</th>
            <th className="amount">Debit ({currencyCode})</th>
            <th className="amount">Credit ({currencyCode})</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="line-no">{item.lineNo}</td>
              <td className="account">
                {item.accountCode ? `${item.accountCode} - ${item.accountTitle || ""}` : item.accountTitle || ""}
              </td>
              <td className="description">{item.description}</td>
              <td className="amount">{item.debit ? formatMoney(item.debit) : ""}</td>
              <td className="amount">{item.credit ? formatMoney(item.credit) : ""}</td>
            </tr>
          ))}
          {items.length === 0 ? (
            <tr>
              <td colSpan={5} className="invoice-items-table__empty">No entries to display.</td>
            </tr>
          ) : null}
        </tbody>
        {entriesSummary ? (
          <tfoot>
            <tr>
              <td colSpan={3}><strong>Total</strong></td>
              <td className="amount"><strong>{formatMoney(entriesSummary.totalDebit)}</strong></td>
              <td className="amount"><strong>{formatMoney(entriesSummary.totalCredit)}</strong></td>
            </tr>
          </tfoot>
        ) : null}
      </table>
      {entriesSummary && !entriesSummary.balanced ? (
        <div className="invoice-entries-unbalanced-notice">
          Warning: total debit does not equal total credit for this entry.
        </div>
      ) : null}
    </>
  );
}
