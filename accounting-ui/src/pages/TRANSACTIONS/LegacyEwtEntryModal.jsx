import React from "react";
import { formatMoney } from "./transactionFormUtils";

// Transaction-entry UI standardization: OR/CV/PO's EWT stays on its
// pre-existing, protected behavior - header-level fields (atc_code/
// tax_type/tax_rate/tax_withheld_amount/payee_tin), never a structured
// transaction_tax_entries row. This modal is a container only: every
// field/handler/computed value here is the exact same state
// TransactionFormLayout already owned when this was an always-visible
// card. Nothing is added to transaction_tax_entries here - doing so would
// change what gets persisted and reopen the settlement-duplication risk
// Phase 7D/7E deliberately closed for these three modules.
export default function LegacyEwtEntryModal({
  open,
  onClose,
  ewtOutbound,
  atcCode,
  handleAtcCodeChange,
  ewtCodes,
  selectedEwt,
  ewtTaxableBase,
  taxWithheldAmount,
  setTaxWithheldAmount,
  setTaxWithheldTouched,
  payeeTin,
  setPayeeTin,
  hasSourceApplications,
  sourceDuplicationWarning,
}) {
  if (!open) return null;

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>{ewtOutbound ? "Withholding Tax" : "Tax Withheld by Customer"}</h2>
            <p>
              {ewtOutbound
                ? "Optional — only fill in if tax was withheld from this payment."
                : "Optional — only fill in if the customer withheld tax from this amount (per the Form 2307 they issue you)."}
              {" "}For VATable transactions, EWT is computed on the amount exclusive of VAT.
            </p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          {hasSourceApplications && (
            <p className="transaction-tax-duplication-warning" role="alert">
              ⚠ {sourceDuplicationWarning}
            </p>
          )}

          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">ATC Code</label>
              <select
                value={atcCode}
                onChange={(e) => handleAtcCodeChange(e.target.value)}
                className="transaction-input"
                disabled={hasSourceApplications}
                title={hasSourceApplications ? sourceDuplicationWarning : undefined}
              >
                <option value="">None</option>
                {ewtCodes.map((ewt) => (
                  <option key={ewt.id} value={ewt.atcCode}>
                    {ewt.atcCode} - {ewt.description} ({ewt.rate}%)
                  </option>
                ))}
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Tax Type</label>
              <input
                type="text"
                value={selectedEwt ? (selectedEwt.taxType === "FINAL" ? "Final Tax" : "Expanded Withholding Tax") : ""}
                readOnly
                placeholder="Select an ATC code"
                className="transaction-input transaction-input-readonly"
              />
            </div>

            <div className="transaction-field">
              <label
                className="transaction-label"
                title="For VATable transactions, EWT is computed on the amount exclusive of VAT."
              >
                EWT Base (VAT-exclusive)
              </label>
              <input
                type="text"
                value={atcCode ? formatMoney(ewtTaxableBase) : ""}
                readOnly
                placeholder="Select an ATC code"
                className="transaction-input transaction-input-readonly"
                title="Gross amount minus VAT posted on this transaction."
              />
            </div>

            <div className="transaction-field">
              <label
                className="transaction-label"
                title="For VATable transactions, EWT is computed on the amount exclusive of VAT."
              >
                Tax Withheld Amount
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={taxWithheldAmount}
                onChange={(e) => {
                  setTaxWithheldAmount(e.target.value);
                  setTaxWithheldTouched(true);
                }}
                disabled={!atcCode || hasSourceApplications}
                placeholder="0.00"
                className="transaction-input"
              />
            </div>

            {ewtOutbound && (
              <div className="transaction-field">
                <label className="transaction-label">Payee TIN</label>
                <input
                  type="text"
                  value={payeeTin}
                  onChange={(e) => setPayeeTin(e.target.value)}
                  placeholder="000-000-000-000"
                  className="transaction-input"
                />
              </div>
            )}
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-primary-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
