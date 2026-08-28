import React from "react";
import PartyQuickAddModal from "../../components/PartyQuickAddModal";
import ViewField from "./ViewField";
import "./TransactionFormLayout.css";

// Checkpoint 7A: extracted verbatim from TransactionFormLayout.jsx's header
// fields card (Date / Reference No. / Party / Check No. or Transaction
// Type / Description). No JSX/className/logic change - only moved to its
// own file.
export default function TransactionVoucherHeader({
  code,
  title,
  partyLabel,
  partyType,
  showCheckNo,
  form,
  updateForm,
  handlePartyChange,
  partyOptions,
  showPartyModal,
  setShowPartyModal,
  handlePartyCreated,
  viewOnly = false,
  // Phase 7A: Invoice-only. Date and Reference No./"Invoice No." move into
  // InvoiceSummaryPanel for code === "INV" - this is an explicit prop
  // (not an internal `code === "INV"` check) so this component stays
  // decoupled from any one module's layout decision; every other module
  // passes nothing here and renders exactly as before, unchanged.
  hideDateAndReference = false,
}) {
  // Phase 7B: a genuine document-like read-only presentation (label/value),
  // not the same inputs with `disabled` - see the Phase 7B spec's "target
  // Label / Value rather than disabled textbox" requirement. All data here
  // is still owned by the parent's `form` state; this branch only changes
  // how it's rendered.
  if (viewOnly) {
    return (
      <div className="transaction-card">
        <div className="transaction-view-grid">
          {!hideDateAndReference && <ViewField label="Date" value={form.date} />}
          {!hideDateAndReference && <ViewField label="Reference No." value={form.referenceNo} />}
          <ViewField label={partyLabel} value={form.party} />
          <ViewField
            label={showCheckNo ? "Check No." : "Transaction Type"}
            value={showCheckNo ? form.checkNo : title}
          />
        </div>
        <ViewField label="Description / Memo" value={form.description} wide block />
      </div>
    );
  }

  return (
    <div className="transaction-card">
      <div className="transaction-grid">
        {!hideDateAndReference && (
          <div className="transaction-field">
            <label className="transaction-label">Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => updateForm("date", e.target.value)}
              className="transaction-input"
            />
          </div>
        )}

        {!hideDateAndReference && (
          <div className="transaction-field">
            <label className="transaction-label">Reference No.</label>
            <input
              type="text"
              value={form.referenceNo}
              onChange={(e) => updateForm("referenceNo", e.target.value)}
              placeholder={`${code}-000001`}
              className="transaction-input"
            />
          </div>
        )}

        <div className="transaction-field">
          <label className="transaction-label">{partyLabel}</label>
          <div className="transaction-party-row">
            <input
              type="text"
              list={`${code}-party-list`}
              value={form.party}
              onChange={(e) => handlePartyChange(e.target.value)}
              placeholder={`Select ${partyLabel.toLowerCase()}`}
              className="transaction-input"
            />

            <datalist id={`${code}-party-list`}>
              {partyOptions.map((party) => (
                <option key={party.id} value={party.name}>
                  {party.code} - {party.type}
                </option>
              ))}
            </datalist>

            {partyType && (
              <button
                type="button"
                className="transaction-party-add-btn"
                onClick={() => setShowPartyModal(true)}
                title={
                  partyType === "BOTH"
                    ? "Add New Customer or Supplier"
                    : `Add New ${partyType === "SUPPLIER" ? "Supplier" : "Customer"}`
                }
                aria-label={
                  partyType === "BOTH"
                    ? "Add New Customer or Supplier"
                    : `Add New ${partyType === "SUPPLIER" ? "Supplier" : "Customer"}`
                }
              >
                +
              </button>
            )}
          </div>
        </div>

        {partyType && (
          <PartyQuickAddModal
            open={showPartyModal}
            partyType={partyType}
            onClose={() => setShowPartyModal(false)}
            onCreated={handlePartyCreated}
          />
        )}

        <div className="transaction-field">
          <label className="transaction-label">
            {showCheckNo ? "Check No." : "Transaction Type"}
          </label>
          <input
            type="text"
            value={showCheckNo ? form.checkNo : title}
            onChange={(e) => {
              if (showCheckNo) updateForm("checkNo", e.target.value);
            }}
            readOnly={!showCheckNo}
            placeholder={showCheckNo ? "Enter check number" : ""}
            className={`transaction-input ${
              !showCheckNo ? "transaction-input-readonly" : ""
            }`}
          />
        </div>
      </div>

      <div className="transaction-memo-wrap">
        <label className="transaction-label">Description / Memo</label>
        <textarea
          value={form.description}
          onChange={(e) => updateForm("description", e.target.value)}
          rows={3}
          placeholder="Enter transaction details"
          className="transaction-textarea"
        />
      </div>
    </div>
  );
}
