import React from "react";
import ViewField from "./ViewField";
import { formatMoney } from "./transactionFormUtils";
import "./TransactionFormLayout.css";

// Checkpoint 7A: extracted verbatim from TransactionFormLayout.jsx's
// Currency card (selector + resolved-rate display + refresh/override
// sub-flows). No JSX/className/logic change - every handler/value below is
// still owned and computed by the parent, passed through as props.
export default function CurrencySummary({
  currencySnapshot,
  selectedCurrencyId,
  handleCurrencyChange,
  currencyOptions,
  baseCurrency,
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
  viewOnly = false,
  totals,
}) {
  // Phase 7B read-only summary (section 25 of the spec): Currency / Rate /
  // Rate Date / <Base> Equivalent. `lines` (and therefore `totals`,
  // computed from them) already hold the transaction's FOREIGN amounts
  // once loaded via handleView - see TransactionFormLayout's comment on
  // why foreignDebit/foreignCredit are read back into `lines` - so
  // totalDebit here is exactly the foreign total to multiply by the rate,
  // not a base amount that would double-convert.
  if (viewOnly) {
    const currency = currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId));
    const isBase = String(selectedCurrencyId) === String(baseCurrency?.id || "");

    if (isBase || !currency) {
      return (
        <div className="transaction-card">
          <div className="transaction-view-grid">
            <ViewField label="Currency" value={currency ? `${currency.currencyCode} (Base)` : "—"} />
          </div>
        </div>
      );
    }

    const rate = Number(currencySnapshot?.exchangeRate || 0);
    const baseTotal = Number(totals?.totalDebit || totals?.totalCredit || 0);
    const baseEquivalent = rate ? baseTotal * rate : null;

    return (
      <div className="transaction-card">
        <div className="transaction-view-grid">
          <ViewField label="Currency" value={currency.currencyCode} />
          <ViewField label="Rate" value={rate ? rate.toFixed(6) : "—"} />
          <ViewField label="Rate Date" value={currencySnapshot?.rateDate || "—"} />
          <ViewField
            label={`${baseCurrency?.currencyCode || "Base"} Equivalent`}
            value={baseEquivalent !== null ? `${baseCurrency?.currencySymbol || ""} ${formatMoney(baseEquivalent)}` : "—"}
          />
        </div>
        {currencySnapshot?.rateLocked && <p className="transaction-rate-locked">🔒 Locked (Posted)</p>}
      </div>
    );
  }

  return (
    <div className="transaction-card">
      <div className="transaction-grid">
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
                {c.currencySymbol} {c.currencyCode} — {c.currencyName}{c.isBaseCurrency ? " (Base)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {currencySnapshot?.rateLocked ? (
        <p className="transaction-section-subtext">
          🔒 This transaction is posted — its exchange rate is locked and cannot be changed.
        </p>
      ) : (
        String(selectedCurrencyId) === String(baseCurrency?.id || "") && (
          <p className="transaction-section-subtext">Defaults to the company base currency.</p>
        )
      )}

      {rateError && <p className="transaction-rate-error">{rateError}</p>}

      {String(selectedCurrencyId) !== String(baseCurrency?.id || "") && (
        <div className="transaction-rate-card">
          {rateResolving ? (
            <p>Resolving exchange rate…</p>
          ) : currencySnapshot ? (
            <>
              <div className="transaction-rate-headline">
                1 {currencyOptions.find((c) => String(c.id) === String(selectedCurrencyId))?.currencyCode} ={" "}
                {Number(currencySnapshot.exchangeRate).toFixed(6)} {baseCurrency?.currencyCode}
              </div>
              <div className="transaction-rate-meta">
                <span>Source: <strong>{currencySnapshot.rateSource || "—"}</strong></span>
                {currencySnapshot.rateBasis && <span>Basis: <strong>{currencySnapshot.rateBasis}</strong></span>}
                <span>Effective: <strong>{currencySnapshot.rateDate || "—"}</strong></span>
                <span>Status: <strong>{currencySnapshot.rateStatus || "—"}</strong></span>
                {currencySnapshot.rateLocked && <span className="transaction-rate-locked">🔒 Locked (Posted)</span>}
                {pendingRateAction === "override" && <span className="transaction-rate-override-badge">Manual Override</span>}
              </div>

              {!currencySnapshot.rateLocked && (
                <div className="transaction-rate-actions">
                  <button type="button" className="transaction-secondary-button" onClick={handleRefreshRateClick} disabled={rateResolving}>
                    Refresh Rate
                  </button>
                  {canCurrency(currencyModuleKey, "OVERRIDE_RATE") && (
                    <button type="button" className="transaction-secondary-button" onClick={() => setShowOverrideForm((v) => !v)}>
                      Manual Override
                    </button>
                  )}
                </div>
              )}

              {refreshPreview && (
                <div className="transaction-rate-refresh-preview">
                  <p>
                    Previous Rate: <strong>{Number(currencySnapshot.exchangeRate).toFixed(6)}</strong> (as of {currencySnapshot.rateDate}) →{" "}
                    New Rate: <strong>{Number(refreshPreview.exchangeRate).toFixed(6)}</strong> (as of {refreshPreview.rateDate}, {refreshPreview.rateSource})
                  </p>
                  <div className="transaction-rate-actions">
                    <button type="button" className="transaction-secondary-button" onClick={() => setRefreshPreview(null)}>Cancel</button>
                    <button type="button" className="transaction-primary-button" onClick={confirmRefresh}>Use New Rate</button>
                  </div>
                </div>
              )}

              {showOverrideForm && (
                <div className="transaction-rate-override-form">
                  <div className="transaction-grid">
                    <div className="transaction-field">
                      <label className="transaction-label">Override Rate</label>
                      <input
                        type="number"
                        step="0.0000000001"
                        min="0"
                        value={overrideRateValue}
                        onChange={(e) => setOverrideRateValue(e.target.value)}
                        placeholder={String(currencySnapshot.exchangeRate)}
                        className="transaction-input"
                      />
                    </div>
                    <div className="transaction-field">
                      <label className="transaction-label">Reason (required)</label>
                      <input
                        type="text"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="e.g. Bank settlement rate used"
                        className="transaction-input"
                      />
                    </div>
                  </div>
                  <div className="transaction-rate-actions">
                    <button type="button" className="transaction-secondary-button" onClick={() => setShowOverrideForm(false)}>Cancel</button>
                    <button type="button" className="transaction-primary-button" onClick={submitOverride}>Apply Override</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>No exchange rate available yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
