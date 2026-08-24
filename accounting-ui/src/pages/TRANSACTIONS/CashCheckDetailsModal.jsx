import React from "react";

// Transaction-entry UI standardization: this is header/payment metadata
// (payment_method/bank_account_id/check_no/check_date on or_headers/
// cv_headers), never a journal line - "+ Add Entry > Cash / Bank / Check"
// opens this same editor for the exact fields that already existed as an
// always-visible card. No new line is created; nothing new is persisted.
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
}) {
  if (!open) return null;

  return (
    <div className="apv-modal-overlay">
      <div className="apv-modal confirm-dialog tax-entry-modal">
        <div className="apv-modal-header">
          <div>
            <h2>Cash / Check Details</h2>
            <p>
              Captures the bank account and check reference this {code === "OR" ? "receipt" : "payment"}{" "}
              moved through, for bank reconciliation.
            </p>
          </div>
          <button type="button" className="apv-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="tax-entry-modal-body">
          <div className="transaction-grid">
            <div className="transaction-field">
              <label className="transaction-label">Payment Method</label>
              <select
                className="transaction-input"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                <option value="Cash">Cash</option>
                <option value="Check">Check</option>
              </select>
            </div>

            <div className="transaction-field">
              <label className="transaction-label">Bank Account</label>
              <select
                className="transaction-input"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                <option value="">Select bank account</option>
                {bankAccounts.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.bankCode} - {bank.bankName} ({bank.accountNo})
                  </option>
                ))}
              </select>
            </div>

            {paymentMethod === "Check" && (
              <>
                <div className="transaction-field">
                  <label className="transaction-label">Check No.</label>
                  <input
                    type="text"
                    className="transaction-input"
                    value={checkNumber}
                    onChange={(e) => setCheckNumber(e.target.value)}
                    placeholder="Enter check number"
                  />
                </div>

                <div className="transaction-field">
                  <label className="transaction-label">Check Date</label>
                  <input
                    type="date"
                    className="transaction-input"
                    value={checkDate}
                    onChange={(e) => setCheckDate(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="apv-modal-footer">
          <button type="button" className="transaction-primary-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
