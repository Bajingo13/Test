import React, { useEffect, useRef } from "react";

// Transaction-entry UI standardization: this is header/payment metadata
// (payment_method/bank_account_id/check_no/check_date/payment_reference/
// payment_date on or_headers/cv_headers), never a journal line - "+ Add
// Entry > Cash / Bank / Check" opens this editor. No new line is created.
//
// R9: one section per payment method, labelled after the column it saves:
//   Cash           - bank account only when the cash went straight to a bank
//   Check          - bank account, check number (check_no), check date
//   Bank Transfer  - bank account, transfer reference (payment_reference),
//                    transfer date (payment_date)
// The amount is the voucher's own total (from its entries), shown read-only.
// The server validates all of it again (paymentDetailsService); a posted
// Check / Bank Transfer needs every field of its section.
export default function CashCheckDetailsModal({
  open,
  onClose,
  code,
  paymentMethod,
  setPaymentMethod,
  bankAccountId,
  setBankAccountId,
  bankAccounts,
  checkNumber,
  setCheckNumber,
  checkDate,
  setCheckDate,
  paymentReference,
  setPaymentReference,
  paymentDate,
  setPaymentDate,
  amount,
}) {
  const firstRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    firstRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isCheck = paymentMethod === "Check";
  const isTransfer = paymentMethod === "Bank Transfer";
  const amountLabel = isCheck ? "Check Amount" : isTransfer ? "Transfer Amount" : "Cash Amount";
  const formattedAmount = Number(amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal" role="dialog" aria-modal="true" aria-labelledby="payment-details-title">
        <div className="apv-modal-header">
          <div>
            <h2 id="payment-details-title">Payment Details</h2>
            <p>
              How this {code === "OR" ? "receipt was collected" : "payment was made"} and the bank account it moved through,
              for bank reconciliation.
            </p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close payment details">×</button>
        </div>

        <div className="tax-entry-modal-body">
          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label" htmlFor="payment-method">Payment Method</label>
              <select
                id="payment-method"
                ref={firstRef}
                className="transaction-input"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                data-testid="payment-method"
              >
                <option value="Cash">Cash</option>
                <option value="Check">Check</option>
                <option value="Bank Transfer">Bank Transfer</option>
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label" htmlFor="payment-bank">
                Bank Account{isCheck || isTransfer ? "" : " (only if deposited directly)"}
              </label>
              <select
                id="payment-bank"
                className="transaction-input"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                data-testid="payment-bank"
              >
                <option value="">{isCheck || isTransfer ? "Select bank account" : "No bank account"}</option>
                {bankAccounts.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.bankCode} - {bank.bankName} ({bank.accountNo})
                  </option>
                ))}
              </select>
            </div>

            {isCheck && (
              <>
                <div className="transaction-field">
                  <label className="transaction-label" htmlFor="payment-check-no">Check Number</label>
                  <input
                    id="payment-check-no"
                    type="text"
                    inputMode="text"
                    className="transaction-input"
                    value={checkNumber}
                    onChange={(e) => setCheckNumber(e.target.value)}
                    placeholder="As printed on the check, e.g. 000123"
                    maxLength={100}
                    data-testid="payment-check-no"
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label" htmlFor="payment-check-date">Check Date</label>
                  <input
                    id="payment-check-date"
                    type="date"
                    className="transaction-input"
                    value={checkDate}
                    onChange={(e) => setCheckDate(e.target.value)}
                    data-testid="payment-check-date"
                  />
                </div>
              </>
            )}

            {isTransfer && (
              <>
                <div className="transaction-field">
                  <label className="transaction-label" htmlFor="payment-reference">Transfer Reference No.</label>
                  <input
                    id="payment-reference"
                    type="text"
                    className="transaction-input"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder="Bank / transfer reference number"
                    maxLength={100}
                    data-testid="payment-reference"
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label" htmlFor="payment-date">Transfer Date</label>
                  <input
                    id="payment-date"
                    type="date"
                    className="transaction-input"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    data-testid="payment-date"
                  />
                </div>
              </>
            )}

            <div className="transaction-field">
              <span className="transaction-label">{amountLabel}</span>
              <output className="transaction-input transaction-input-readonly" aria-live="polite" data-testid="payment-amount">
                {formattedAmount}
              </output>
            </div>
          </div>
          {(isCheck || isTransfer) && (
            <p className="transaction-label" style={{ marginTop: 10 }}>
              Posting needs the bank account, the {isCheck ? "check number and check date" : "transfer reference and transfer date"}.
            </p>
          )}
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-primary-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
