import React, { useEffect, useState } from "react";
import {
  computeVatByMode,
  normalizeVatTreatment,
  normalizeVatEntryMode,
  isZeroVatTreatment,
  roundMoney,
  DEFAULT_VAT_RATE,
} from "../../utils/vatCalculations";
import { defaultTaxAccountId } from "./taxAccountRules.mjs";
import { formatMoney } from "./transactionFormUtils";
import TaxModalShell from "./TaxModalShell";
import SearchableAccountSelect from "./SearchableAccountSelect";

const TREATMENT_LABEL = {
  STANDARD: "Standard VAT",
  ZERO_RATED: "Zero-Rated",
  EXEMPT: "Exempt",
};

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
  // Accounts carrying the matching COA validation rule (INPUT VAT for
  // direction INPUT, OUTPUT VAT for direction OUTPUT), pre-filtered by the
  // parent from /api/coa's `validations` array - never identified by title.
  taxAccountOptions = [],
  // Item 10: exact message shown when taxAccountOptions is empty.
  missingAccountMessage = "",
  vatRateCodes, // Phase 6D: reference-only catalog, already ACTIVE-filtered by the parent - [] is a valid, expected state (empty catalog / fetch failed), not an error
  defaultDate,
  existingEntry, // pre-fill when editing an already-added tax entry
  onConfirm, // ({ accountId, partyId, partyName, partyTin, partyAddress, transactionDate, grossAmount, netAmount, vatRate, vatAmount, purchaseClassification }) => void
}) {
  const isInput = direction === "INPUT";
  const title = isInput ? "Input VAT" : "Output VAT";
  const netLabel = isInput ? "Net Purchase" : "Net Sale";
  const vatLabel = isInput ? "VAT Paid" : "Output VAT";
  const grossTotalLabel = isInput ? "Gross Purchase" : "Gross Total";
  const noAccountConfigured = (taxAccountOptions || []).length === 0;

  const [party, setParty] = useState("");
  const [partyId, setPartyId] = useState(null);
  const [partyTin, setPartyTin] = useState("");
  const [partyAddress, setPartyAddress] = useState("");
  const [transactionDate, setTransactionDate] = useState(defaultDate || "");
  // The amount the user types. INCLUSIVE mode: it IS the VAT-inclusive
  // gross (historical behavior). EXCLUSIVE mode: it is the pre-VAT base.
  const [amountInput, setAmountInput] = useState("");
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE));
  // Phase 7E: VAT treatment, sourced from the selected VAT code (or the
  // stored snapshot when editing). Manual entry stays STANDARD.
  const [treatment, setTreatment] = useState("STANDARD");
  // Phase 7J: VAT entry mode - INCLUSIVE (default / historical) or
  // EXCLUSIVE. Remembered on the saved entry; never changes the treatment.
  const [mode, setMode] = useState("INCLUSIVE");
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
      setVatRate(existingEntry.vatRate != null ? String(existingEntry.vatRate) : String(DEFAULT_VAT_RATE));
      setClassification(existingEntry.purchaseClassification || CLASSIFICATIONS[0]);
      setAccountId(existingEntry.accountId ? String(existingEntry.accountId) : "");
      // Phase 7E: the STORED treatment snapshot is authoritative when
      // editing - never re-derived from the current VAT Rate Library. A
      // pre-7E entry has no snapshot and reads as STANDARD.
      setTreatment(normalizeVatTreatment(existingEntry.vatTreatment));
      // Phase 7J: the STORED entry-mode snapshot is authoritative when
      // editing. A pre-7J entry has vatEntryMode = null and reads as
      // INCLUSIVE. The amount field shows the stored gross for INCLUSIVE,
      // the stored net/base for EXCLUSIVE - so re-confirming without
      // changes reproduces the same entry.
      {
        const editMode = normalizeVatEntryMode(existingEntry.vatEntryMode);
        setMode(editMode);
        const shown = editMode === "EXCLUSIVE" ? existingEntry.netAmount : existingEntry.grossAmount;
        setAmountInput(shown != null ? String(shown) : "");
      }
      // An existing entry reopens in manual/free-entry state for the CODE
      // picker (it never recorded which catalog id it came from), but its
      // stored treatment/rate above are preserved.
      setSelectedVatCodeId("");
      setRateOverridden(false);
    } else {
      setParty("");
      setPartyId(null);
      setPartyTin("");
      setPartyAddress("");
      setTransactionDate(defaultDate || "");
      setAmountInput("");
      setVatRate(String(DEFAULT_VAT_RATE));
      setTreatment("STANDARD");
      setMode("INCLUSIVE");
      setClassification(CLASSIFICATIONS[0]);
      setSelectedVatCodeId("");
      setRateOverridden(false);
      // Default from the COA Validation Rules, never from account title:
      // auto-select when exactly one validated account exists, otherwise
      // leave blank and force an explicit pick.
      setAccountId(defaultTaxAccountId(taxAccountOptions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingEntry]);

  if (!open) return null;

  function handleSelectVatCode(id) {
    setSelectedVatCodeId(id);
    setRateOverridden(false);
    if (!id) {
      // Switched to manual entry: leave the typed rate, revert to STANDARD
      // treatment (manual entry has no classification of its own).
      setTreatment("STANDARD");
      return;
    }
    const chosen = applicableVatCodes.find((c) => String(c.id) === id);
    if (chosen) {
      const t = normalizeVatTreatment(chosen.treatment);
      setTreatment(t);
      // Zero-rated / exempt: rate is fixed at 0, never the code's stored
      // rate (which is already 0 anyway) or a typed value.
      setVatRate(isZeroVatTreatment(t) ? "0" : String(chosen.rate));
    }
  }

  function handleRateChange(value) {
    setVatRate(value);
    // Optional auto-clear (section 16): if the user has overridden but
    // types the exact catalog value back, treat it as no longer overridden.
    if (selectedVatCode && rateOverridden && Number(value) === Number(selectedVatCode.rate)) {
      setRateOverridden(false);
    }
  }

  // Phase 7J: switching mode CONVERTS the amount so the resulting VAT is
  // unchanged - it never silently reinterprets the same number. INCLUSIVE
  // shows the gross; EXCLUSIVE shows the base. Zero-rated / exempt: base
  // and gross are equal, so the amount is carried across unchanged.
  function handleModeChange(nextMode) {
    const m = normalizeVatEntryMode(nextMode);
    if (m === mode) return;
    const amt = Number(amountInput);
    const rate = Number(vatRate);
    if (Number.isFinite(amt) && amt > 0 && !zeroTreatment && Number.isFinite(rate) && rate >= 0) {
      if (mode === "INCLUSIVE" && m === "EXCLUSIVE") {
        setAmountInput(String(roundMoney(amt / (1 + rate / 100))));
      } else if (mode === "EXCLUSIVE" && m === "INCLUSIVE") {
        setAmountInput(String(roundMoney(amt * (1 + rate / 100))));
      }
    }
    setMode(m);
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

  const zeroTreatment = isZeroVatTreatment(treatment);
  // Phase 7J: one dispatch that honours both the treatment (7E) and the
  // entry mode (7J). EXCLUSIVE+STANDARD treats amountInput as the base and
  // derives the gross; everything else is the existing behaviour. The
  // returned payload shape is identical either way.
  const { grossAmount: computedGross, netAmount, vatAmount } = computeVatByMode({
    amount: amountInput,
    vatRatePercent: vatRate,
    treatment,
    mode,
  });
  const effectiveRate = zeroTreatment ? 0 : Number(vatRate);
  const amountLabel = zeroTreatment
    ? (isInput ? "Purchase Amount" : "Sale Amount")
    : mode === "EXCLUSIVE"
      ? "VAT-Exclusive Amount"
      : (isInput ? "Gross Purchase" : "Gross Sale");
  const amountHelper = zeroTreatment
    ? `${TREATMENT_LABEL[treatment]}: VAT is 0. The ${netLabel.toLowerCase()} is still recorded.`
    : mode === "EXCLUSIVE"
      ? "VAT will be added to this amount."
      : "Amount already includes VAT.";

  function handleConfirm() {
    if (noAccountConfigured) { alert(missingAccountMessage); return; }
    if (!party.trim()) { alert(`${partyLabel} is required.`); return; }
    if (!accountId) { alert(`${title} account is required.`); return; }
    if (!amountInput || Number(amountInput) <= 0) { alert(`${amountLabel} must be greater than zero.`); return; }

    onConfirm({
      accountId,
      partyId,
      partyName: party,
      partyTin,
      partyAddress,
      transactionDate,
      // Always the VAT-INCLUSIVE gross - for EXCLUSIVE entry this is the
      // derived base + VAT, so the backend path (which recomputes from
      // grossAmount) is unchanged.
      grossAmount: Number(computedGross),
      netAmount,
      vatRate: effectiveRate,
      vatAmount,
      // Phase 7E: transaction-time snapshot - persisted verbatim to
      // transaction_tax_entries so a later VAT Rate Library edit can never
      // reclassify this entry.
      vatCode: selectedVatCode ? selectedVatCode.code : null,
      vatTreatment: treatment,
      // Phase 7J: remembered-input snapshot. Zero-rated / exempt keep
      // whatever mode is selected but it has no numeric effect.
      vatEntryMode: mode,
      purchaseClassification: isInput ? classification : null,
    });
  }

  return (
    <TaxModalShell
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Enter the tax schedule information - the journal line amount is calculated automatically."
      footer={
        <>
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="transaction-primary-button" onClick={handleConfirm} disabled={noAccountConfigured}>Confirm</button>
        </>
      }
    >
      <>
          {noAccountConfigured && (
            <p className="transaction-tax-duplication-warning" role="alert">
              ⚠ {missingAccountMessage}
            </p>
          )}
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
              <label className="transaction-label">VAT Entry Mode</label>
              <div className="tax-entry-mode-toggle" role="radiogroup" aria-label="VAT entry mode">
                <label className={`tax-entry-mode-option${mode === "INCLUSIVE" ? " is-active" : ""}`}>
                  <input
                    type="radio"
                    name="vat-entry-mode"
                    value="INCLUSIVE"
                    checked={mode === "INCLUSIVE"}
                    onChange={() => handleModeChange("INCLUSIVE")}
                    disabled={zeroTreatment}
                  />
                  VAT Inclusive
                </label>
                <label className={`tax-entry-mode-option${mode === "EXCLUSIVE" ? " is-active" : ""}`}>
                  <input
                    type="radio"
                    name="vat-entry-mode"
                    value="EXCLUSIVE"
                    checked={mode === "EXCLUSIVE"}
                    onChange={() => handleModeChange("EXCLUSIVE")}
                    disabled={zeroTreatment}
                  />
                  VAT Exclusive
                </label>
              </div>
              {zeroTreatment && (
                <p className="tax-entry-vat-rate-note">
                  {TREATMENT_LABEL[treatment]}: VAT is 0, so the entry mode has no numeric effect.
                </p>
              )}
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{amountLabel}</label>
              <input type="number" min="0" step="0.01" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} placeholder="0.00" className="transaction-input" />
              <p className="tax-entry-vat-rate-note">{amountHelper}</p>
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
              <label className="transaction-label">VAT Treatment</label>
              <input
                type="text"
                value={TREATMENT_LABEL[treatment] || treatment}
                readOnly
                className="transaction-input transaction-input-readonly"
              />
              {zeroTreatment && (
                <p className="tax-entry-vat-rate-note">
                  {TREATMENT_LABEL[treatment]}: VAT is 0. The {netLabel.toLowerCase()} is still recorded.
                </p>
              )}
            </div>

            <div className="transaction-field">
              <label className="transaction-label">VAT Rate (%)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={zeroTreatment ? "0" : vatRate}
                onChange={(e) => handleRateChange(e.target.value)}
                readOnly={zeroTreatment || (Boolean(selectedVatCode) && !rateOverridden)}
                disabled={zeroTreatment}
                className="transaction-input"
              />
              {!zeroTreatment && selectedVatCode && !rateOverridden && (
                <p className="tax-entry-vat-rate-note">
                  Source: {selectedVatCode.code} ({Number(selectedVatCode.rate)}%){" "}
                  <button type="button" className="tax-entry-override-link" onClick={() => setRateOverridden(true)}>
                    Override Rate
                  </button>
                </p>
              )}
              {!zeroTreatment && selectedVatCode && rateOverridden && (
                <p className="tax-entry-vat-rate-note tax-entry-vat-rate-overridden">
                  Overridden from {selectedVatCode.code} ({Number(selectedVatCode.rate)}%)
                </p>
              )}
              {!selectedVatCode && !zeroTreatment && applicableVatCodes.length === 0 && (
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
              <SearchableAccountSelect
                value={accountId}
                onChange={(next) => setAccountId(next)}
                accounts={taxAccountOptions}
                disabled={noAccountConfigured}
                ariaLabel={`${title} account`}
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{netLabel}</label>
              <input type="text" value={formatMoney(netAmount)} readOnly className="transaction-input transaction-input-readonly" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{vatLabel}</label>
              <input type="text" value={formatMoney(vatAmount)} readOnly className="transaction-input transaction-input-readonly" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{grossTotalLabel}</label>
              <input type="text" value={formatMoney(computedGross)} readOnly className="transaction-input transaction-input-readonly" />
            </div>
          </div>
      </>
    </TaxModalShell>
  );
}
