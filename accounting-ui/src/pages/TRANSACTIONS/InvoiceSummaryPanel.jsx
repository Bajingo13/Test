import React from "react";
import ViewField from "./ViewField";
import CurrencySummary from "./CurrencySummary";
import "./TransactionFormLayout.css";

// Phase 7A: Invoice-only compact upper-right summary (Invoice No. / Date /
// Currency / Exchange Rate / Due Date). Invoice No. and Date are MOVED
// here from TransactionVoucherHeader.jsx (not duplicated - the parent
// hides them there via hideDateAndReference for code === "INV" only, so
// every other module's header card is byte-for-byte unchanged).
//
// Phase 7F: Currency and Invoice Type are now MOVED here too (not
// duplicated) - the parent no longer renders a separate CurrencySummary
// card or a separate "Invoice Type" card for code === "INV" (see
// TransactionFormLayout.jsx's `code === "INV" ?` branch). Currency stays
// a REAL editable control (same handleCurrencyChange/currencyOptions the
// old card used) rather than a read-only echo - "reuse, don't duplicate"
// now applies to state AND to the control itself. The full rate
// meta/Refresh/Override sub-flow is still 100% owned by CurrencySummary.jsx
// (rendered here in `compact` mode - no second exchange-rate
// implementation), just merged into this one card instead of forming a
// second card below it. Status intentionally stays in transaction-topbar,
// per the Phase 7A spec's explicit allowance ("Status may remain where it
// already is").
export default function InvoiceSummaryPanel({
  viewOnly = false,
  form,
  updateForm,
  dueDate,
  onDateChange,
  onDueDateChange,
  currencyEligible,
  currencyOptions,
  selectedCurrencyId,
  baseCurrency,
  currencySnapshot,
  handleCurrencyChange,
  rateError,
  rateResolving,
  pendingRateAction,
  handleRefreshRateClick,
  canCurrency,
  currencyModuleKey,
  showOverrideForm,
  setShowOverrideForm,
  refreshPreview,
  setRefreshPreview,
  confirmRefresh,
  overrideRateValue,
  setOverrideRateValue,
  overrideReason,
  setOverrideReason,
  submitOverride,
  totals,
  invoiceType,
  setInvoiceType,
  recurrenceFrequency,
  setRecurrenceFrequency,
}) {
  const currency = currencyOptions?.find((c) => String(c.id) === String(selectedCurrencyId));
  const isBaseCurrency = !currency || String(selectedCurrencyId) === String(baseCurrency?.id || "");
  const currencyLabel = currency ? `${currency.currencyCode}${isBaseCurrency ? " (Base)" : ""}` : "—";
  const rate = Number(currencySnapshot?.exchangeRate || 0);
  const rateLabel = isBaseCurrency ? "1.000000" : rate ? rate.toFixed(6) : "—";
  const showRateField = currencyEligible && !isBaseCurrency;

  if (viewOnly) {
    return (
      <div className="invoice-summary-panel-wrap">
        <div className="transaction-card invoice-summary-panel">
          <div className="transaction-view-grid">
            <ViewField label="Invoice No." value={form.referenceNo} />
            <ViewField label="Date" value={form.date} />
            {currencyEligible && <ViewField label="Currency" value={currencyLabel} />}
            <ViewField label="Due Date" value={dueDate} />
            {showRateField && <ViewField label="Exchange Rate" value={rateLabel} />}
            <ViewField label="Type" value={invoiceType} />
            {invoiceType === "Recurring" && (
              <ViewField label="Recurrence" value={recurrenceFrequency} />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="invoice-summary-panel-wrap">
      <div className="transaction-card invoice-summary-panel">
        <div className="transaction-grid invoice-summary-grid">
          <div className="transaction-field">
            <label className="transaction-label">Invoice No.</label>
            <input
              type="text"
              value={form.referenceNo}
              onChange={(e) => updateForm("referenceNo", e.target.value)}
              placeholder="INV-000001"
              className="transaction-input"
            />
          </div>

          <div className="transaction-field">
            <label className="transaction-label">Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => onDateChange(e.target.value)}
              className="transaction-input"
            />
          </div>

          {currencyEligible && (
            <div className="transaction-field">
              <label className="transaction-label">Currency</label>
              <select
                value={selectedCurrencyId}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                disabled={currencySnapshot?.rateLocked}
                className="transaction-input"
              >
                {currencyOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.currencySymbol} {c.currencyCode} — {c.currencyName}
                    {c.isBaseCurrency ? " (Base)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="transaction-field">
            <label className="transaction-label">Due Date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => onDueDateChange(e.target.value)}
              className="transaction-input"
            />
          </div>

          {/* Section 9: when Exchange Rate is hidden (base currency), this
              cell is simply omitted - CSS grid auto-flow lets Invoice Type
              occupy the freed slot cleanly, no empty gap. */}
          {showRateField && (
            <div className="transaction-field">
              <label className="transaction-label">Exchange Rate</label>
              <input type="text" value={rateLabel} readOnly className="transaction-input transaction-input-readonly" />
            </div>
          )}

          <div className="transaction-field">
            <label className="transaction-label">Invoice Type</label>
            <select
              className="transaction-input"
              value={invoiceType}
              onChange={(e) => setInvoiceType(e.target.value)}
            >
              <option value="Standard">Standard</option>
              <option value="Recurring">Recurring</option>
            </select>
          </div>

          {invoiceType === "Recurring" && (
            <div className="transaction-field">
              <label className="transaction-label">Recurrence</label>
              <select
                className="transaction-input"
                value={recurrenceFrequency}
                onChange={(e) => setRecurrenceFrequency(e.target.value)}
              >
                <option value="Weekly">Weekly</option>
                <option value="Monthly">Monthly</option>
                <option value="Quarterly">Quarterly</option>
                <option value="Annually">Annually</option>
              </select>
            </div>
          )}
        </div>

        {/* The richer rate meta/Refresh/Override sub-flow - same component,
            same props, same logic as the old standalone Currency card;
            `compact` only changes what it renders (no select, no repeated
            headline), never how it resolves/refreshes/overrides a rate. */}
        {currencyEligible && (
          <CurrencySummary
            compact
            currencySnapshot={currencySnapshot}
            selectedCurrencyId={selectedCurrencyId}
            handleCurrencyChange={handleCurrencyChange}
            currencyOptions={currencyOptions}
            baseCurrency={baseCurrency}
            rateError={rateError}
            rateResolving={rateResolving}
            pendingRateAction={pendingRateAction}
            handleRefreshRateClick={handleRefreshRateClick}
            canCurrency={canCurrency}
            currencyModuleKey={currencyModuleKey}
            showOverrideForm={showOverrideForm}
            setShowOverrideForm={setShowOverrideForm}
            refreshPreview={refreshPreview}
            setRefreshPreview={setRefreshPreview}
            confirmRefresh={confirmRefresh}
            overrideRateValue={overrideRateValue}
            setOverrideRateValue={setOverrideRateValue}
            overrideReason={overrideReason}
            setOverrideReason={setOverrideReason}
            submitOverride={submitOverride}
            totals={totals}
          />
        )}
      </div>
    </div>
  );
}
