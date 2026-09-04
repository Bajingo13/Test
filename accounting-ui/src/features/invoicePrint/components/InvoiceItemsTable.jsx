import { formatMoney } from "../utils/invoicePrintFormatters";

// Columns available today: description + amount only (see
// invoicePrintDataService's item-selection rule - invoice_lines has no
// qty/unit/unit-price/discount/tax-code columns). Quantity/Unit
// Price/Discount/Tax columns are omitted entirely rather than rendered
// blank, matching "hide unavailable columns cleanly" from the migration
// spec. A template's configured column labels (table.columns from the
// already-resolved printTemplateService config) are honored for
// description/amount when present; any other configured column key has no
// backing data and is skipped.
const SUPPORTED_COLUMN_KEYS = new Set(["description", "amount"]);

function resolveColumns(tableConfig) {
  const configured = Array.isArray(tableConfig?.columns) ? tableConfig.columns : null;
  const filtered = configured?.filter((c) => SUPPORTED_COLUMN_KEYS.has(c.key));
  if (filtered && filtered.length) return filtered;
  return [
    { key: "description", label: "Item Description / Nature Of Service" },
    { key: "amount", label: "Amount" },
  ];
}

export default function InvoiceItemsTable({ items, currencyCode, tableConfig }) {
  const columns = resolveColumns(tableConfig);

  return (
    <table className="invoice-items-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} className={col.key}>
              {col.key === "amount" ? `${col.label} (${currencyCode})` : col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            {columns.map((col) => (
              <td key={col.key} className={col.key}>
                {col.key === "amount" ? formatMoney(item.amount) : item.description}
              </td>
            ))}
          </tr>
        ))}
        {items.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="invoice-items-table__empty">
              No items to display.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
