import React from "react";
import { formatMoney } from "./transactionFormUtils";
import TaxModalShell from "./TaxModalShell";
import SearchableAccountSelect from "./SearchableAccountSelect";

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
//
// Phase 7L: adopts the shared TaxModalShell + SearchableAccountSelect so it
// is visually identical to the modern APV/INV VatEntryModal (same overlay,
// radius, header, close button, field height, footer). Accounting behavior
// is unchanged. When the voucher is settling a source document
// (hasSourceApplications), the tax-recognition controls are not merely
// warned about - they are disabled AND the "Add ... Line" action is
// blocked, so a second Input VAT/EWT cannot be recorded through the UI
// (Phase 7L Part F section 9).
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
  const noAccountConfigured = (accountOptions || []).length === 0;
  const blocked = !!hasSourceApplications;

  function handleAdd() {
    if (blocked) return; // Part F section 9: no second Input VAT via the UI
    if (noAccountConfigured) { alert(missingAccountMessage); return; }
    onAddLine();
    onClose();
  }

  return (
    <TaxModalShell
      open={open}
      onClose={onClose}
      title={vatType}
      subtitle={`Enter the taxable amount to add a ${vatType} line automatically.`}
      footer={
        <>
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="transaction-primary-button"
            onClick={handleAdd}
            disabled={noAccountConfigured || blocked}
            title={blocked ? sourceDuplicationWarning : undefined}
          >
            + Add {vatType} Line
          </button>
        </>
      }
    >
      <>
          {blocked && (
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
              <SearchableAccountSelect
                value={vatAccountId}
                onChange={(next) => setVatAccountId(next)}
                accounts={accountOptions || []}
                disabled={blocked}
                ariaLabel={`${vatType} account`}
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Taxable Amount</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={vatTaxableAmount}
                onChange={(e) => setVatTaxableAmount(e.target.value)}
                disabled={blocked}
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
                disabled={blocked}
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
      </>
    </TaxModalShell>
  );
}
