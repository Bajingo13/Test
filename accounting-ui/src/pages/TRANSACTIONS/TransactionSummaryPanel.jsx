import React from "react";
import ViewField from "./ViewField";
import CurrencySummary from "./CurrencySummary";
import "./TransactionFormLayout.css";

// Phase 7A/7F: introduced as the Invoice-only "InvoiceSummaryPanel".
//
// Phase 7G: generalized into a single reusable compact transaction-header
// panel shared by every module that opts into the compact top section
// (see TransactionFormLayout.jsx's `COMPACT_HEADER_MODULES` set - INV/OR/
// APV/CV/PO/JV, plus PCV/DM/CM). Reference No. / Date are MOVED here from
// TransactionVoucherHeader.jsx for those modules (not duplicated - the
// parent hides them there via hideDateAndReference, so every module NOT
// in that set keeps TransactionVoucherHeader byte-for-byte unchanged).
// Currency stays a REAL editable control (handleCurrencyChange/
// currencyOptions, same as the old standalone CurrencySummary card),
// never a read-only echo; the full rate meta/Refresh/Override sub-flow
// is still 100% owned by CurrencySummary.jsx (rendered here in `compact`
// mode - no second exchange-rate implementation). Invoice-only extras
// (Due Date, Invoice Type, Recurrence) are gated by explicit boolean
// props (`showDueDate`/`showInvoiceType`) rather than an internal
// `code === "INV"` check, so this component has no Invoice-specific
// knowledge baked in - any future module could opt into those same
// extras by passing the same props. Status intentionally stays in
// transaction-topbar for every module, per the Phase 7A spec's explicit
// allowance ("Status may remain where it already is").
const REFERENCE_LABELS = {
  INV: "Invoice No.",
  OR: "OR No.",
  APV: "APV No.",
  CV: "CV No.",
  PO: "PO No.",
  JV: "JV No.",
  PCV: "PCV No.",
  DM: "DM No.",
  CM: "CM No.",
};

export default function TransactionSummaryPanel({
  code,
  viewOnly = false,
  form,
  updateForm,
  dueDate,
  onDateChange,
  onDueDateChange,
  showDueDate = false,
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
  showInvoiceType = false,
  invoiceType,
  setInvoiceType,
  recurrenceFrequency,
  setRecurrenceFrequency,
}) {
  const referenceLabel = REFERENCE_LABELS[code] || `${code} No.`;
  const referencePlaceholder = `${code}-000001`;

  const currency = currencyOptions?.find((c) => String(c.id) === String(selectedCurrencyId));
  const isBaseCurrency = !currency || String(selectedCurrencyId) === String(baseCurrency?.id || "");
  const currencyLabel = currency ? `${currency.currencyCode}${isBaseCurrency ? " (Base)" : ""}` : "—";
  const rate = Number(currencySnapshot?.exchangeRate || 0);
  const rateLabel = isBaseCurrency ? "1.000000" : rate ? rate.toFixed(6) : "—";
  const showRateField = currencyEligible && !isBaseCurrency;

  if (viewOnly) {
    return (
      <div className="transaction-summary-panel-wrap">
        <div className="transaction-card transaction-summary-panel">
          <div className="transaction-view-grid">
            <ViewField label={referenceLabel} value={form.referenceNo} />
            <ViewField label="Date" value={form.date} />
            {currencyEligible && <ViewField label="Currency" value={currencyLabel} />}
            {showDueDate && <ViewField label="Due Date" value={dueDate} />}
            {showRateField && <ViewField label="Exchange Rate" value={rateLabel} />}
            {showInvoiceType && <ViewField label="Type" value={invoiceType} />}
            {showInvoiceType && invoiceType === "Recurring" && (
              <ViewField label="Recurrence" value={recurrenceFrequency} />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="transaction-summary-panel-wrap">
      <div className="transaction-card transaction-summary-panel">
        <div className="transaction-grid transaction-summary-grid">
          <div className="transaction-field">
            <label className="transaction-label">{referenceLabel}</label>
            <input
              type="text"
              value={form.referenceNo}
              onChange={(e) => updateForm("referenceNo", e.target.value)}
              placeholder={referencePlaceholder}
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

          {/* Invoice-only (showDueDate). Every other module in scope keeps
              sending dueDate === transactionDate exactly as before this
              checkpoint (unchanged, non-scope). */}
          {showDueDate && (
            <div className="transaction-field">
              <label className="transaction-label">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => onDueDateChange(e.target.value)}
                className="transaction-input"
              />
            </div>
          )}

          {/* When Exchange Rate is hidden (base currency or not currency-
              eligible), this cell is simply omitted - CSS grid auto-flow
              lets the next field occupy the freed slot cleanly, no empty
              gap. */}
          {showRateField && (
            <div className="transaction-field">
              <label className="transaction-label">Exchange Rate</label>
              <input type="text" value={rateLabel} readOnly className="transaction-input transaction-input-readonly" />
            </div>
          )}

          {/* Invoice-only (showInvoiceType) - the same dormant Standard/
              Recurring cosmetic field this checkpoint's layout-only scope
              leaves untouched (see the Phase 7C audit's own note on it). */}
          {showInvoiceType && (
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
          )}

          {showInvoiceType && invoiceType === "Recurring" && (
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
            headline), never how it resolves/refreshes/overrides a rate.
            Rendered for every currency-eligible module in the compact set
            (all six today - see transactionModuleConfig.js), not just
            Invoice. */}
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
