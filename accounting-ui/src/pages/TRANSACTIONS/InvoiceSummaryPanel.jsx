import React from "react";
import ViewField from "./ViewField";
import "./TransactionFormLayout.css";

// Phase 7A: Invoice-only compact upper-right summary (Invoice No. / Date /
// Currency / Exchange Rate / Due Date). Invoice No. and Date are MOVED
// here from TransactionVoucherHeader.jsx (not duplicated - the parent
// hides them there via hideDateAndReference for code === "INV" only, so
// every other module's header card is byte-for-byte unchanged). Currency
// and Exchange Rate are a READ-ONLY reflection of the real values
// CurrencySummary.jsx already owns and computes - no second currency
// state, no re-derivation of the rate, exactly per the Phase 7A spec's
// "reuse existing real values" requirement. The full editable Currency
// card (selector + refresh/override sub-flows) stays exactly where it is
// today; only a compact read-only echo lives up here. Status intentionally
// stays in transaction-topbar, per the Phase 7A spec's explicit allowance
// ("Status may remain where it already is").
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
}) {
  const currency = currencyOptions?.find((c) => String(c.id) === String(selectedCurrencyId));
  const isBaseCurrency = !currency || String(selectedCurrencyId) === String(baseCurrency?.id || "");
  const currencyLabel = currency ? `${currency.currencyCode}${isBaseCurrency ? " (Base)" : ""}` : "—";
  const rate = Number(currencySnapshot?.exchangeRate || 0);
  const rateLabel = isBaseCurrency ? "1.000000" : rate ? rate.toFixed(6) : "—";

  if (viewOnly) {
    return (
      <div className="invoice-summary-panel-wrap">
        <div className="transaction-card invoice-summary-panel">
          <div className="transaction-view-grid">
            <ViewField label="Invoice No." value={form.referenceNo} />
            <ViewField label="Date" value={form.date} />
            {currencyEligible && <ViewField label="Currency" value={currencyLabel} />}
            {currencyEligible && !isBaseCurrency && <ViewField label="Exchange Rate" value={rateLabel} />}
            <ViewField label="Due Date" value={dueDate} />
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
              <input type="text" value={currencyLabel} readOnly className="transaction-input transaction-input-readonly" />
            </div>
          )}

          {currencyEligible && !isBaseCurrency && (
            <div className="transaction-field">
              <label className="transaction-label">Exchange Rate</label>
              <input type="text" value={rateLabel} readOnly className="transaction-input transaction-input-readonly" />
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
        </div>
      </div>
    </div>
  );
}
