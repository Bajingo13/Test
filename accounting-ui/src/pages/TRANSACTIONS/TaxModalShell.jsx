import React from "react";
import "./TransactionFormLayout.css";

// Phase 7L: one lightweight shell for every tax-entry modal so the modern
// APV/INV VAT & EWT modals (VatEntryModal / EwtEntryModal) and the legacy
// OR/CV/PO modals (LegacyVatEntryModal / LegacyEwtEntryModal) share exactly
// one visual language - same overlay, same 18px card radius, same header
// style, same close-button, same body padding, same footer / button
// placement. Accounting behavior stays mode-specific: this component only
// owns the chrome, never the fields.
//
// The class names are the existing ones (.apv-modal-overlay /
// .apv-modal.confirm-dialog.tax-entry-modal / .apv-modal-header /
// .apv-modal-close / .tax-entry-modal-body / .apv-modal-footer) so no CSS
// changes are needed and any modal still rendering its own markup stays
// pixel-identical - this is a de-duplication, not a restyle.
export default function TaxModalShell({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  contentClassName = "",
}) {
  if (!open) return null;
  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={`tax-entry-modal-body ${contentClassName}`.trim()}>{children}</div>

        {footer ? <div className="apv-modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
