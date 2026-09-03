import React, { useEffect, useState } from "react";
import TaxModalShell from "./TaxModalShell";
import { authHeaders, handleAuthError } from "../../utils/authSession";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Batch 8: small modal to email the customer-facing Official Receipt PDF.
// Shown only for a Posted OR when the user holds TRANSACTIONS.OR / EMAIL
// (gated by voucherToolbarRules.showEmail). Read-only on the OR - the
// backend never changes the receipt, it only renders the existing
// "without entries" PDF and does a best-effort SMTP send + audit log.
export default function OrEmailModal({
  open,
  onClose,
  endpoint,
  transactionId,
  voucherNo,
  customerName,
  defaultTo = "",
  companyId,
}) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTo(defaultTo);
    setSubject("");
    setMessage("");
    setResult(null);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function handleSend() {
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/${endpoint}/${transactionId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          to: to.trim() || undefined,
          subject: subject.trim() || undefined,
          message: message.trim() || undefined,
          companyId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setResult({ ok: false, text: data.message || "Failed to email the Official Receipt." });
        return;
      }
      setResult({
        ok: true,
        delivered: data.delivered,
        text: data.delivered
          ? `Sent to ${data.recipient}.`
          : `Queued but not delivered (${data.reason || "unknown"}). Check SMTP configuration.`,
      });
    } catch {
      setResult({ ok: false, text: "Unable to reach the server." });
    } finally {
      setSending(false);
    }
  }

  return (
    <TaxModalShell
      open={open}
      onClose={onClose}
      title={`Email Official Receipt ${voucherNo || ""}`.trim()}
      subtitle="Sends the customer-facing PDF (no accounting entries). The receipt itself is not changed."
      footer={
        <>
          <button type="button" className="transaction-secondary-button" onClick={onClose}>
            {result?.ok ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            className="transaction-primary-button"
            onClick={handleSend}
            disabled={sending || !!result?.ok}
          >
            {sending ? "Sending..." : "Send Email"}
          </button>
        </>
      }
    >
      <>
        <div className="transaction-grid">
          <div className="transaction-field transaction-field-wide">
            <label className="transaction-label">To</label>
            <input
              type="email"
              className="transaction-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={defaultTo ? defaultTo : "customer@example.com"}
            />
            {!defaultTo && (
              <p className="tax-entry-vat-rate-note">
                No email on file for {customerName || "this customer"} - enter one, or set it in General Libraries.
              </p>
            )}
          </div>

          <div className="transaction-field transaction-field-wide">
            <label className="transaction-label">Subject</label>
            <input
              type="text"
              className="transaction-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={`Official Receipt ${voucherNo || ""}`.trim()}
            />
          </div>

          <div className="transaction-field transaction-field-wide">
            <label className="transaction-label">Message (optional)</label>
            <textarea
              className="transaction-input"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Added above the standard note in the email body."
            />
          </div>
        </div>

        {result && (
          <p
            className={result.ok ? "tax-entry-vat-rate-note" : "transaction-tax-duplication-warning"}
            role={result.ok ? "status" : "alert"}
          >
            {result.ok ? (result.delivered ? "✓ " : "⚠ ") : "⚠ "}
            {result.text}
          </p>
        )}
      </>
    </TaxModalShell>
  );
}
