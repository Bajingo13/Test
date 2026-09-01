import React, { useEffect, useState } from "react";
import { computeEwtTaxableBase, computeEwtAmount } from "../../utils/ewtCalculations";
import { defaultTaxAccountId } from "./taxAccountRules.mjs";
import { formatMoney } from "./transactionFormUtils";

// Phase 7C: compact popup wrapping the EXISTING EWT engine (utils/
// ewtCalculations.js / backend's ewtCalculationService.js +
// resolveTaxWithholding, both completely unchanged by this phase - see
// spec section 18). This is a UI/workflow change only: the same ATC
// code/rate/base/withholding-amount computation that used to live in a
// permanent card now lives in a popup, and (new in Phase 7C, section 19)
// confirming it also creates a real journal line instead of leaving the
// amount as a detached header value.
export default function EwtEntryModal({
  open,
  onClose,
  ewtCodes,
  direction, // "OUTBOUND" (APV - we withhold, has a Payee TIN) | "INBOUND" (Invoice - customer already withheld)
  partyLabel,
  defaultParty, // { name, id, tin } - the transaction's own already-selected party
  // Accounts carrying a COA EWT control validation (EXPANDED TAX or FINAL
  // TAX), pre-filtered by the parent from /api/coa's `validations` array -
  // never identified by title.
  taxAccountOptions = [],
  // Item 10: exact message shown when taxAccountOptions is empty.
  missingAccountMessage = "",
  lines,
  grossAmount,
  vatAccountId,
  existingEntry,
  onConfirm, // ({ accountId, atcCode, taxType, taxRate, taxableBase, withheldAmount, partyId, partyName, partyTin, partyAddress, transactionDate }) => void
  defaultDate,
}) {
  const isOutbound = direction === "OUTBOUND";
  const noAccountConfigured = (taxAccountOptions || []).length === 0;

  const [atcCode, setAtcCode] = useState("");
  const [partyTin, setPartyTin] = useState("");
  const [partyAddress, setPartyAddress] = useState("");
  const [transactionDate, setTransactionDate] = useState(defaultDate || "");
  const [accountId, setAccountId] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existingEntry) {
      setAtcCode(existingEntry.atcCode || "");
      setPartyTin(existingEntry.partyTin || "");
      setPartyAddress(existingEntry.partyAddress || "");
      setTransactionDate(existingEntry.transactionDate || defaultDate || "");
      setAccountId(existingEntry.accountId ? String(existingEntry.accountId) : "");
      setManualAmount(existingEntry.withheldAmount != null ? String(existingEntry.withheldAmount) : "");
      setAmountTouched(true);
    } else {
      setAtcCode("");
      setPartyTin(defaultParty?.tin || "");
      setPartyAddress(defaultParty?.address || "");
      setTransactionDate(defaultDate || "");
      // Default from COA Validation Rules (EXPANDED TAX / FINAL TAX), never
      // from account title: auto-select only when exactly one exists.
      setAccountId(defaultTaxAccountId(taxAccountOptions));
      setManualAmount("");
      setAmountTouched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingEntry]);

  if (!open) return null;

  const selectedEwt = ewtCodes.find((e) => e.atcCode === atcCode);
  const taxableBase = computeEwtTaxableBase({ grossAmount, lines, vatAccountId });
  const suggestedAmount = selectedEwt ? computeEwtAmount({ taxableBase, ewtRate: selectedEwt.rate }) : 0;
  const withheldAmount = amountTouched ? Number(manualAmount) || 0 : suggestedAmount;

  function handleAtcChange(value) {
    setAtcCode(value);
    setAmountTouched(false);
  }

  function handleConfirm() {
    if (noAccountConfigured) { alert(missingAccountMessage); return; }
    if (!atcCode) { alert("ATC Code is required."); return; }
    if (!accountId) { alert("EWT account is required."); return; }
    if (!withheldAmount || withheldAmount <= 0) { alert("Withholding amount must be greater than zero."); return; }

    onConfirm({
      accountId,
      atcCode,
      taxType: selectedEwt?.taxType || null,
      taxRate: selectedEwt?.rate ?? null,
      taxableBase,
      withheldAmount,
      partyId: defaultParty?.id || null,
      partyName: defaultParty?.name || "",
      partyTin,
      partyAddress,
      transactionDate,
    });
  }

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>EWT / Withholding Tax</h2>
            <p>
              {isOutbound
                ? "Optional - only fill in if tax was withheld from this payment."
                : "Optional - only fill in if the customer withheld tax from this amount."}
            </p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          {noAccountConfigured && (
            <p className="transaction-tax-duplication-warning" role="alert">
              ⚠ {missingAccountMessage}
            </p>
          )}
          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">ATC Code</label>
              <select value={atcCode} onChange={(e) => handleAtcChange(e.target.value)} className="transaction-input">
                <option value="">Select ATC code</option>
                {ewtCodes.map((ewt) => (
                  <option key={ewt.id} value={ewt.atcCode}>{ewt.atcCode} - {ewt.description} ({ewt.rate}%)</option>
                ))}
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Tax Type / Nature</label>
              <input
                type="text"
                value={selectedEwt ? (selectedEwt.taxType === "FINAL" ? "Final Tax" : "Expanded Withholding Tax") : ""}
                readOnly
                placeholder="Select an ATC code"
                className="transaction-input transaction-input-readonly"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">{partyLabel}</label>
              <input type="text" value={defaultParty?.name || ""} readOnly className="transaction-input transaction-input-readonly" />
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
              <label className="transaction-label" title="Gross amount minus VAT posted on this transaction.">Tax Base (VAT-exclusive)</label>
              <input type="text" value={atcCode ? formatMoney(taxableBase) : ""} readOnly placeholder="Select an ATC code" className="transaction-input transaction-input-readonly" />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Withholding Amount</label>
              <input
                type="number" min="0" step="0.01"
                value={amountTouched ? manualAmount : (suggestedAmount ? String(suggestedAmount) : "")}
                onChange={(e) => { setManualAmount(e.target.value); setAmountTouched(true); }}
                disabled={!atcCode}
                placeholder="0.00"
                className="transaction-input"
              />
            </div>

            <div className="transaction-field">
              <label className="transaction-label">EWT Account</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="transaction-input"
                disabled={noAccountConfigured}
              >
                <option value="">Select account</option>
                {taxAccountOptions.map((account) => (
                  <option key={account.id} value={account.id}>{account.code} - {account.title}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="transaction-primary-button" onClick={handleConfirm} disabled={noAccountConfigured}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
