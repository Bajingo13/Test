import React from "react";
import ViewField from "./ViewField";
import { formatMoney } from "./transactionFormUtils";

// Phase 7C spec section 26: a small read-only "View Tax Details" popup for
// a tax-generated journal row - available in both Draft and Posted view
// mode (section 24/25), never Edit/Remove. Keeps the main voucher/grid
// free of a giant tax block.
export default function TaxDetailsViewModal({ open, onClose, entry }) {
  if (!open || !entry) return null;

  const isVat = entry.entryType === "INPUT_VAT" || entry.entryType === "OUTPUT_VAT";
  const title =
    entry.entryType === "INPUT_VAT" ? "Input VAT Details" :
    entry.entryType === "OUTPUT_VAT" ? "Output VAT Details" : "EWT Details";

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div><h2>{title}</h2></div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          <div className="transaction-view-grid">
            <ViewField label={isVat ? "Supplier / Customer" : "Party"} value={entry.partyName} />
            <ViewField label="TIN" value={entry.partyTin} />
            <ViewField label="Address" value={entry.partyAddress} wide />
            <ViewField label="Transaction Date" value={entry.transactionDate} />
            {isVat ? (
              <>
                <ViewField label="Gross Amount" value={formatMoney(entry.grossAmount)} />
                <ViewField label="Net Amount" value={formatMoney(entry.netAmount)} />
                <ViewField label="VAT Rate" value={entry.vatRate != null ? `${entry.vatRate}%` : null} />
                <ViewField label="VAT Amount" value={formatMoney(entry.vatAmount)} />
                {entry.purchaseClassification && <ViewField label="Purchase Classification" value={entry.purchaseClassification} />}
              </>
            ) : (
              <>
                <ViewField label="ATC Code" value={entry.atcCode} />
                <ViewField label="Tax Type" value={entry.taxType} />
                <ViewField label="Taxable Base" value={formatMoney(entry.taxableBase)} />
                <ViewField label="Withheld Amount" value={formatMoney(entry.withheldAmount)} />
              </>
            )}
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
