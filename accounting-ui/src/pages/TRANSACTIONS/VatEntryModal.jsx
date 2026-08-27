import React, { useEffect, useState } from "react";
import { computeVatFromInclusiveGross, DEFAULT_VAT_RATE } from "../../utils/vatCalculations";
import { formatMoney } from "./transactionFormUtils";

const CLASSIFICATIONS = ["Services", "Capital Goods", "Other than Capital Goods"];

// Phase 7C: compact popup for Input VAT (APV) / Output VAT (Invoice) - see
// TransactionFormLayout.jsx's "+ Add Entry" menu. Reuses the existing
// party source (partyOptions, already loaded from /api/genlib - no second
// supplier/customer master) and the ONE centralized VAT helper
// (utils/vatCalculations.js, mirroring backend/services/
// vatCalculationService.js). Confirming here builds a single journal line
// + its schedule metadata; the parent is responsible for inserting it into
// `lines` and, on save, sending it to the backend for independent
// re-validation.
export default function VatEntryModal({
  open,
  onClose,
  direction, // "INPUT" | "OUTPUT"
  partyLabel, // "Supplier" | "Customer"
  partyOptions,
  accountOptions,
  vatRateCodes, // Phase 6D: reference-only catalog, already ACTIVE-filtered by the parent - [] is a valid, expected state (empty catalog / fetch failed), not an error
  defaultDate,
  existingEntry, // pre-fill when editing an already-added tax entry
  onConfirm, // ({ accountId, partyId, partyName, partyTin, partyAddress, transactionDate, grossAmount, netAmount, vatRate, vatAmount, purchaseClassification }) => void
}) {
  const isInput = direction === "INPUT";
  const title = isInput ? "Input VAT" : "Output VAT";
  const grossLabel = isInput ? "Gross Purchase" : "Gross Sale";
  const netLabel = isInput ? "Net Purchase" : "Net Sale";
  const vatLabel = isInput ? "VAT Paid" : "Output VAT";
  const accountKeyword = isInput ? "input vat" : "output vat";

  const [party, setParty] = useState("");
  const [partyId, setPartyId] = useState(null);
  const [partyTin, setPartyTin] = useState("");
  const [partyAddress, setPartyAddress] = useState("");
  const [transactionDate, setTransactionDate] = useState(defaultDate || "");
  const [grossAmount, setGrossAmount] = useState("");
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE));
  const [classification, setClassification] = useState(CLASSIFICATIONS[0]);
  const [accountId, setAccountId] = useState("");

  // Phase 6D: picker/override state. `selectedVatCodeId` "" means manual
  // entry - the rate field behaves exactly as it always has. Neither of
  // these is included in onConfirm's payload (section 17 - reference/UI
  // context only, never persisted as transaction_tax_entries.vat_code).
  const [selectedVatCodeId, setSelectedVatCodeId] = useState("");
  const [rateOverridden, setRateOverridden] = useState(false);

  const applicableVatCodes = (vatRateCodes || []).filter(
    (c) => c.appliesTo === "BOTH" || c.appliesTo === (isInput ? "INPUT" : "OUTPUT")
  );
  const selectedVatCode = applicableVatCodes.find((c) => String(c.id) === selectedVatCodeId);

  useEffect(() => {
    if (!open) return;
    if (existingEntry) {
      setParty(existingEntry.partyName || "");
      setPartyId(existingEntry.partyId || null);
      setPartyTin(existingEntry.partyTin || "");
      setPartyAddress(existingEntry.partyAddress || "");
      setTransactionDate(existingEntry.transactionDate || defaultDate || "");
      setGrossAmount(existingEntry.grossAmount != null ? String(existingEntry.grossAmount) : "");
      setVatRate(existingEntry.vatRate != null ? String(existingEntry.vatRate) : String(DEFAULT_VAT_RATE));
      setClassification(existingEntry.purchaseClassification || CLASSIFICATIONS[0]);
      setAccountId(existingEntry.accountId ? String(existingEntry.accountId) : "");
      // An existing entry never recorded which catalog code (if any) it
      // came from - always reopen in manual/free-entry state, never
      // guess a code from the rate alone.
      setSelectedVatCodeId("");
      setRateOverridden(false);
    } else {
      setParty("");
      setPartyId(null);
      setPartyTin("");
      setPartyAddress("");
      setTransactionDate(defaultDate || "");
      setGrossAmount("");
      setVatRate(String(DEFAULT_VAT_RATE));
      setClassification(CLASSIFICATIONS[0]);
      setSelectedVatCodeId("");
      setRateOverridden(false);
      // Same heuristic keyword-default TransactionFormLayout already uses
      // for the (now-legacy, OR/CV/PO-only) VAT account picker - preserves
      // the existing "no hard-coded account id" mechanism (spec section 10).
      const match = accountOptions.find((acc) => String(acc.title || "").toLowerCase().includes(accountKeyword));
      setAccountId(match ? String(match.id) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingEntry]);

  if (!open) return null;

  function handleSelectVatCode(id) {
    setSelectedVatCodeId(id);
    setRateOverridden(false);
    if (!id) return; // switched to manual entry - leave whatever rate is already typed
    const chosen = applicableVatCodes.find((c) => String(c.id) === id);
    if (chosen) setVatRate(String(chosen.rate));
  }

  function handleRateChange(value) {
    setVatRate(value);
    // Optional auto-clear (section 16): if the user has overridden but
    // types the exact catalog value back, treat it as no longer overridden.
    if (selectedVatCode && rateOverridden && Number(value) === Number(selectedVatCode.rate)) {
      setRateOverridden(false);
    }
  }

  function handlePartySelect(name) {
    setParty(name);
    const selected = partyOptions.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (selected) {
      setPartyId(selected.id);
      setPartyTin(selected.tin || "");
      setPartyAddress([selected.address1, selected.address2, selected.address3].filter(Boolean).join(", "));
    } else {
      setPartyId(null);
    }
  }

  const { netAmount, vatAmount } = computeVatFromInclusiveGross({ gross: grossAmount, vatRatePercent: vatRate });

  function handleConfirm() {
    if (!party.trim()) { alert(`${partyLabel} is required.`); return; }
    if (!accountId) { alert(`${title} account is required.`); return; }
    if (!grossAmount || Number(grossAmount) <= 0) { alert(`${grossLabel} must be greater than zero.`); return; }

    onConfirm({
      accountId,
      partyId,
      partyName: party,
      partyTin,
      partyAddress,
      transactionDate,
      grossAmount: Number(grossAmount),
      netAmount,
      vatRate: Number(vatRate),
      vatAmount,
      purchaseClassification: isInput ? classification : null,
    });
  }

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>{title}</h2>
            <p>Enter the tax schedule information - the journal line amount is calculated automatically.</p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">{partyLabel}</label>
              <input
                type="text"
                list="tax-entry-party-list"
                value={party}
                onChange={(e) => handlePartySelect(e.target.value)}
                placeholder={`Select ${partyLabel.toLowerCase()}`}
                className="transaction-input"
              />
              <datalist id="tax-entry-party-list">
                {partyOptions.map((p) => (
                  <option key={p.id} value={p.name}>{p.code}</option>
                ))}
              </datalist>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{partyLabel} TIN</label>
              <input type="text" value={partyTin} onChange={(e) => setPartyTin(e.target.value)} placeholder="000-000-000-000" className="transaction-input" />
            </div>

            <div className="transaction-field transaction-field-wide">
              <label className="transaction-label">{partyLabel} Address</label>
              <input type="text" value={partyAddress} onChange={(e) => setPartyAddress(e.target.value)} className="transaction-input" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Transaction Date</label>
              <input type="date" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} className="transaction-input" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{grossLabel}</label>
              <input type="number" min="0" step="0.01" value={grossAmount} onChange={(e) => setGrossAmount(e.target.value)} placeholder="0.00" className="transaction-input" />
            </div>

            {applicableVatCodes.length > 0 && (
              <div className="transaction-field">
                <label className="transaction-label">VAT Code</label>
                <select
                  value={selectedVatCodeId}
                  onChange={(e) => handleSelectVatCode(e.target.value)}
                  className="transaction-input"
                >
                  <option value="">-- Manual Entry --</option>
                  {applicableVatCodes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.description} ({Number(c.rate)}%)
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="transaction-field">
              <label className="transaction-label">VAT Rate (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={vatRate}
                onChange={(e) => handleRateChange(e.target.value)}
                readOnly={Boolean(selectedVatCode) && !rateOverridden}
                className="transaction-input"
              />
              {selectedVatCode && !rateOverridden && (
                <p className="tax-entry-vat-rate-note">
                  Source: {selectedVatCode.code} ({Number(selectedVatCode.rate)}%){" "}
                  <button type="button" className="tax-entry-override-link" onClick={() => setRateOverridden(true)}>
                    Override Rate
                  </button>
                </p>
              )}
              {selectedVatCode && rateOverridden && (
                <p className="tax-entry-vat-rate-note tax-entry-vat-rate-overridden">
                  Overridden from {selectedVatCode.code} ({Number(selectedVatCode.rate)}%)
                </p>
              )}
              {!selectedVatCode && applicableVatCodes.length === 0 && (
                <p className="tax-entry-vat-rate-note">
                  VAT Rate Library unavailable — enter rate manually.
                </p>
              )}
            </div>

            {isInput && (
              <div className="transaction-field">
                <label className="transaction-label">Purchase Classification</label>
                <select value={classification} onChange={(e) => setClassification(e.target.value)} className="transaction-input">
                  {CLASSIFICATIONS.map((c) => (<option key={c} value={c}>{c}</option>))}
                </select>
              </div>
            )}

            <div className="transaction-field">
              <label className="transaction-label">{title} Account</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="transaction-input">
                <option value="">Select account</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>{account.code} - {account.title}</option>
                ))}
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{netLabel}</label>
              <input type="text" value={formatMoney(netAmount)} readOnly className="transaction-input transaction-input-readonly" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{vatLabel}</label>
              <input type="text" value={formatMoney(vatAmount)} readOnly className="transaction-input transaction-input-readonly" />
            </div>
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="transaction-primary-button" onClick={handleConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
