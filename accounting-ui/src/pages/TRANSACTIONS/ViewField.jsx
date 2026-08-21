import React from "react";
import "./TransactionFormLayout.css";

// Phase 7B: shared label/value presentation for read-only voucher mode -
// a compact document-like display ("Customer / HOME REPAIR NETWORK...")
// instead of a disabled input, used across the header, currency summary,
// and the tax/invoice-type cards wherever they show real saved data.
export default function ViewField({ label, value, wide = false, block = false }) {
  return (
    <div className={`transaction-view-field${wide ? " transaction-view-field-wide" : ""}`}>
      <span className="transaction-view-label">{label}</span>
      <span className={`transaction-view-value${block ? " transaction-view-value-block" : ""}`}>
        {value === null || value === undefined || value === "" ? "—" : value}
      </span>
    </div>
  );
}
