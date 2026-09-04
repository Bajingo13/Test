import { formatDate, formatMoney } from "../utils/invoicePrintFormatters";

const COLUMNS = [
  { key: "voucherNo", label: "Invoice No." },
  { key: "transactionDate", label: "Date", isDate: true },
  { key: "partyName", label: "Customer" },
  { key: "dueDate", label: "Due Date", isDate: true },
  { key: "status", label: "Status" },
  { key: "totalAmount", label: "Amount", isMoney: true },
  { key: "paidAmount", label: "Paid", isMoney: true },
  { key: "balanceAmount", label: "Balance", isMoney: true },
];

function Cell({ row, col }) {
  const value = row[col.key];
  if (col.isMoney) return <td className="amount">{formatMoney(value)}</td>;
  if (col.isDate) return <td>{formatDate(value)}</td>;
  return <td className={col.key === "partyName" ? "party" : undefined}>{value ?? ""}</td>;
}

function RowsTable({ rows, grandTotal }) {
  return (
    <table className="invoice-list-table">
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th key={col.key} className={col.isMoney ? "amount" : undefined}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            {COLUMNS.map((col) => (
              <Cell key={col.key} row={row} col={col} />
            ))}
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td colSpan={COLUMNS.length} className="invoice-list-table__empty">No invoices to display.</td>
          </tr>
        ) : null}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={COLUMNS.length - 1}><strong>Grand Total</strong></td>
          <td className="amount"><strong>{formatMoney(grandTotal)}</strong></td>
        </tr>
      </tfoot>
    </table>
  );
}

// Flat listing (grouping "number"/"date") comes back as `rows`; grouped
// listing (grouping "party" - "Print List by Customer") comes back as
// `groups`, each with its own subtotal - both shapes are exactly what
// transactionPrintDataService.getTransactionList already builds, passed
// through unchanged by invoiceListPrintDataService.
export default function InvoiceListTable({ rows, groups, grandTotal }) {
  if (groups) {
    return (
      <>
        {groups.map((group, idx) => (
          <div key={`${group.groupLabel}-${idx}`} className="invoice-list-group">
            <div className="invoice-list-group__label">{group.groupLabel}</div>
            <table className="invoice-list-table">
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th key={col.key} className={col.isMoney ? "amount" : undefined}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id}>
                    {COLUMNS.map((col) => (
                      <Cell key={col.key} row={row} col={col} />
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={COLUMNS.length - 1}><strong>Subtotal</strong></td>
                  <td className="amount"><strong>{formatMoney(group.subtotal)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
        <div className="invoice-list-grand-total">
          <strong>Grand Total: {formatMoney(grandTotal)}</strong>
        </div>
      </>
    );
  }

  return <RowsTable rows={rows || []} grandTotal={grandTotal} />;
}
