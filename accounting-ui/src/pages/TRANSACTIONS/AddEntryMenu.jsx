import React from "react";
import "./TransactionFormLayout.css";

// Phase 7C: "+ Add Entry" (spec section 4) - replaces the plain "+ Add
// Line" button on Invoice/APV with a small menu. Regular Journal Entry
// behaves exactly like the old "+ Add Line" (onRegular === addLine,
// untouched). Tax options are module-aware - only the entries the caller
// actually supports are passed in via `taxOptions`, never a fixed set for
// every module (spec: "Do not add these tax popups to JV/Petty Cash/
// Debit Memo/Credit Memo... unless they already have equivalent supported
// tax behavior" - OR/CV/PO/JV/PCV/DM/CM keep using the old "+ Add Line"
// button entirely instead of rendering this menu at all).
export default function AddEntryMenu({ onRegular, taxOptions }) {
  return (
    <div className="print-dropdown add-entry-menu">
      <button type="button" className="transaction-add-button">+ Add Entry</button>
      <div className="print-dropdown-menu">
        <button type="button" onClick={onRegular}>Regular Journal Entry</button>
        {taxOptions.map((opt) => (
          <button key={opt.key} type="button" onClick={opt.onClick}>{opt.label}</button>
        ))}
      </div>
    </div>
  );
}
