import React from "react";
import { formatMoney } from "./transactionFormUtils";
import { filterSelectableRegularAccounts } from "./taxAccountRules.mjs";
import "./TransactionFormLayout.css";

// Checkpoint 7A: extracted verbatim from TransactionFormLayout.jsx's
// Journal Entries table body (thead + tbody only - the surrounding card,
// "+ Add Line" button, <table> tag itself, and <tfoot> stay with the
// parent/EntryTotals respectively, since a fragment returned here still
// composes correctly as a child of the parent's <table>). No JSX,
// className, or logic changes - only moved to its own file.
// Phase 7C: subtle, stable-metadata-driven indicator for a tax-generated
// row (spec section 25/36) - never inferred from account title/particulars
// string matching, only from the presence of line.taxEntry (built from the
// new transaction_tax_entries table's entry_type, or the client's own
// popup-confirmed metadata before the first save).
const TAX_ENTRY_LABELS = { INPUT_VAT: "Input VAT", OUTPUT_VAT: "Output VAT", EWT: "EWT" };

export default function AccountingEntriesGrid({
  lines,
  accountOptions,
  partyOptions,
  updateLine,
  removeLine,
  isAPorARAccount,
  viewOnly = false,
  onEditTaxDetails,
  onViewTaxDetails,
}) {
  // Phase 7B (spec section 22): static rows, no Account/Gen Ref selects, no
  // Remove column - the posted/saved journal entries presented as a plain
  // document table.
  if (viewOnly) {
    return (
      <>
        <thead>
          <tr>
            <th>Account</th>
            <th>Particulars</th>
            <th>Gen Ref</th>
            <th>Gen Name</th>
            <th className="text-right">Debit</th>
            <th className="text-right">Credit</th>
          </tr>
        </thead>

        <tbody>
          {lines.map((line) => {
            const account = accountOptions.find(
              (acc) => String(acc.id) === String(line.accountId)
            );
            return (
              <tr key={line.id}>
                <td className="transaction-view-cell">
                  {account ? `${account.code} - ${account.title}` : "—"}
                </td>
                <td className="transaction-view-cell">
                  {line.particulars || "—"}
                  {line.taxEntry && (
                    <button
                      type="button"
                      className={`tax-entry-badge tax-entry-badge-${line.taxEntry.entryType.toLowerCase().replace("_", "-")}`}
                      onClick={() => onViewTaxDetails && onViewTaxDetails(line)}
                      title="View Tax Details"
                    >
                      {TAX_ENTRY_LABELS[line.taxEntry.entryType] || "Tax"}
                    </button>
                  )}
                </td>
                <td className="transaction-view-cell">{line.genRef || "—"}</td>
                <td className="transaction-view-cell">{line.genName || "—"}</td>
                <td className="transaction-view-cell text-right">
                  {Number(line.debit) > 0 ? formatMoney(line.debit) : ""}
                </td>
                <td className="transaction-view-cell text-right">
                  {Number(line.credit) > 0 ? formatMoney(line.credit) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </>
    );
  }

  return (
    <>
      <thead>
        <tr>
          <th>Account</th>
          <th>Particulars</th>
          <th>Gen Ref</th>
          <th>Gen Name</th>
          <th className="text-right">Debit</th>
          <th className="text-right">Credit</th>
          <th className="text-center">Action</th>
        </tr>
      </thead>

      <tbody>
        {lines.map((line) => {
          // A Regular Journal Entry row must never be able to select a COA
          // account carrying a protected tax validation (INPUT VAT /
          // OUTPUT VAT / EXPANDED TAX / FINAL TAX) - those enter the journal
          // only through the tax modal workflow. `line.accountId` is passed
          // as keepAccountId so an already-set value (legacy data, or an
          // OR/CV/PO legacy-VAT line that carries no taxEntry tag) stays
          // visible for that row without being re-selectable anywhere else.
          const selectableAccounts = filterSelectableRegularAccounts(
            accountOptions,
            line.accountId
          );
          return (
          <tr key={line.id}>
            <td>
              <select
                value={line.accountId}
                onChange={(e) =>
                  updateLine(line.id, "accountId", e.target.value)
                }
                className="transaction-table-input"
              >
                <option value="">Select account</option>
                {selectableAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} - {account.title}
                  </option>
                ))}
              </select>
            </td>

            <td>
              <input
                type="text"
                value={line.particulars}
                onChange={(e) =>
                  updateLine(line.id, "particulars", e.target.value)
                }
                placeholder="Entry description"
                className="transaction-table-input"
              />
              {line.taxEntry && (
                <button
                  type="button"
                  className={`tax-entry-badge tax-entry-badge-${line.taxEntry.entryType.toLowerCase().replace("_", "-")}`}
                  onClick={() => onEditTaxDetails && onEditTaxDetails(line)}
                  title="Edit Tax Details"
                >
                  {TAX_ENTRY_LABELS[line.taxEntry.entryType] || "Tax"} ✎
                </button>
              )}
            </td>

            <td>
              <select
                value={line.genRef || ""}
                onChange={(e) =>
                  updateLine(line.id, "genRef", e.target.value)
                }
                disabled={!isAPorARAccount(line.accountId)}
                className="transaction-table-input transaction-gen-input"
              >
                <option value="">
                  {isAPorARAccount(line.accountId)
                    ? "Select Reference"
                    : "Not required"}
                </option>

                {partyOptions.map((party) => (
                  <option key={party.id} value={party.code}>
                    {party.code}
                  </option>
                ))}
              </select>
            </td>

            <td>
              <input
                type="text"
                value={line.genName || ""}
                readOnly
                disabled={!isAPorARAccount(line.accountId)}
                placeholder={
                  isAPorARAccount(line.accountId)
                    ? "Gen Name"
                    : "Not required"
                }
                className="transaction-table-input transaction-gen-input"
              />
            </td>

            <td>
              <input
                type="number"
                min="0"
                step="0.01"
                value={line.debit}
                onChange={(e) =>
                  updateLine(line.id, "debit", e.target.value)
                }
                placeholder="0.00"
                className="transaction-table-input transaction-table-input-right"
              />
            </td>

            <td>
              <input
                type="number"
                min="0"
                step="0.01"
                value={line.credit}
                onChange={(e) =>
                  updateLine(line.id, "credit", e.target.value)
                }
                placeholder="0.00"
                className="transaction-table-input transaction-table-input-right"
              />
            </td>

            <td className="text-center">
              <button
                onClick={() => removeLine(line.id)}
                disabled={lines.length <= 2}
                className="transaction-remove-button"
              >
                Remove
              </button>
            </td>
          </tr>
          );
        })}
      </tbody>
    </>
  );
}
