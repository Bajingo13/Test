import React from "react";
import { formatMoney } from "./transactionFormUtils";
import "./TransactionFormLayout.css";

// Checkpoint 7A: extracted verbatim from TransactionFormLayout.jsx's
// Journal Entries <tfoot>. No JSX/className/logic change - `totals` is
// still the same useMemo the parent already computed from `lines`.
export default function EntryTotals({ totals, viewOnly = false }) {
  return (
    <tfoot>
      <tr>
        {/* Phase 7B: view mode's grid has no Action column (6 columns, not
            7) - colSpan must shrink by one to keep Debit/Credit/Status
            aligned under their own header cells. */}
        <td colSpan={viewOnly ? 3 : 4} className="transaction-total-label">
          Totals
        </td>
        <td className="transaction-total-amount">
          ₱ {formatMoney(totals.totalDebit)}
        </td>
        <td className="transaction-total-amount">
          ₱ {formatMoney(totals.totalCredit)}
        </td>
        <td className="transaction-total-status">
          <span
            className={`transaction-balance-badge ${
              totals.balanced ? "balanced" : "not-balanced"
            }`}
          >
            {totals.balanced ? "Balanced" : "Not Balanced"}
          </span>
        </td>
      </tr>
    </tfoot>
  );
}
