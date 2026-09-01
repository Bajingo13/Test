import React from "react";
import { formatMoney } from "./transactionFormUtils";

// Transaction-entry UI standardization: OR/CV/PO's Output/Input VAT stays on
// its pre-existing, protected behavior - a plain journal line stamped from
// a taxable amount x rate, with no transaction_tax_entries metadata. This
// modal is a container only: every field, handler, and computed value here
// is the exact same state TransactionFormLayout already owned when this was
// an always-visible card (vatAccountId/vatTaxableAmount/vatRate/vatAmount,
// handleAddVatLine). Do not add taxEntry tagging here - that would change
// what gets persisted, not just how it's reached, and would reopen the
// settlement-duplication risk Phase 7D/7E deliberately closed for these
// three modules.
export default function LegacyVatEntryModal({
  open,
  onClose,
  vatType,
  vatAccountId,
  setVatAccountId,
  vatTaxableAmount,
  setVatTaxableAmount,
  vatRate,
  setVatRate,
  vatAmount,
  // Accounts carrying the matching COA validation rule (OUTPUT VAT for
  // OR, INPUT VAT for CV/PO), pre-filtered by the parent from /api/coa's
  // `validations` array - never identified by title.
  accountOptions,
  // Item 10: exact message shown when accountOptions is empty.
  missingAccountMessage = "",
  hasSourceApplications,
  sourceDuplicationWarning,
  onAddLine,
}) {
  if (!open) return null;

  const noAccountConfigured = (accountOptions || []).length === 0;

  function handleAdd() {
    if (noAccountConfigured) { alert(missingAccountMessage); return; }
    onAddLine();
    onClose();
  }

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>{vatType}</h2>
            <p>Enter the taxable amount to add a {vatType} line automatically.</p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          {hasSourceApplications && (
            <p className="transaction-tax-duplication-warning" role="alert">
              ⚠ {sourceDuplicationWarning}
            </p>
          )}
          {noAccountConfigured && (
            <p className="transaction-tax-duplication-warning" role="alert">
              ⚠ {missingAccountMessage}
            </p>
          )}

          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">{vatType} Account</label>
              <select
                value={vatAccountId}
                onChange={(e) => setVatAccountId(e.target.value)}
                className="transaction-input"
                disabled={hasSourceApplications}
                title={hasSourceApplications ? sourceDuplicationWarning : undefined}
              >
                <option value="">Select account</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} - {account.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Taxable Amount</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={vatTaxableAmount}
                onChange={(e) => setVatTaxableAmount(e.target.value)}
                disabled={hasSourceApplications}
                placeholder="0.00"
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">VAT Rate (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={vatRate}
                onChange={(e) => setVatRate(e.target.value)}
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">VAT Amount</label>
              <input
                type="text"
                value={formatMoney(vatAmount)}
                readOnly
                className="transaction-input transaction-input-readonly"
              />
            </div>
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="transaction-primary-button" onClick={handleAdd} disabled={noAccountConfigured}>
            + Add {vatType} Line
          </button>
        </div>
      </div>
    </div>
  );
}
