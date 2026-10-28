import { useEffect, useRef, useState } from "react";
import {
  APV_NO_MAX,
  CONVERT_DIALOG,
  apAccountOptions,
  formatAmount,
  initialConvertForm,
  lineAccountOptions,
  linesNeedingAccount,
  validateConvertForm,
} from "../../utils/rfpPage.mjs";

// In-app confirmation for RFP -> Draft APV (R5), never a native dialog. The
// converter confirms the APV number, the APV date and the Accounts Payable
// account, and picks an account for any RFP line that has none. The company
// is shown, never chosen: the server always uses the RFP's own company.
// Server errors (409 already converted / duplicate APV number / closed
// period, 403, 404) stay inside the dialog.
export default function RfpConvertDialog({ rfp, accounts, accountsStatus, accountsError, busy, error, onConfirm, onClose }) {
  const [form, setForm] = useState(() => initialConvertForm({ rfp, accounts }));
  const [attempted, setAttempted] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const apAccounts = apAccountOptions(accounts);
  const lineAccounts = lineAccountOptions(accounts);
  const missing = linesNeedingAccount(rfp);
  const ready = accountsStatus === "ready";
  const { valid, errors } = validateConvertForm(form);
  const shown = attempted ? errors : { lineAccounts: {} };

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setLineAccount = (lineId) => (e) =>
    setForm((f) => ({ ...f, lineAccounts: { ...f.lineAccounts, [lineId]: e.target.value } }));

  function submit(e) {
    e.preventDefault();
    setAttempted(true);
    if (!ready || !valid || busy) return;
    onConfirm(form);
  }

  return (
    <div className="rfp-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="rfp-dialog rfp-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="rfp-convert-title" onSubmit={submit} noValidate>
        <div className="rfp-dialog-header">
          <h2 id="rfp-convert-title">{CONVERT_DIALOG.title}</h2>
          <span className="rfp-dialog-ref">{rfp.rfpNo}</span>
        </div>
        <div className="rfp-dialog-body">
          <p>{CONVERT_DIALOG.message}</p>
          <dl className="rfp-convert-summary">
            <div><dt>Company</dt><dd>{rfp.companyName}</dd></div>
            <div><dt>Supplier</dt><dd>{rfp.supplierName}</dd></div>
            <div><dt>Total</dt><dd>{formatAmount(rfp.totalAmount)} {rfp.currencyCode}</dd></div>
          </dl>
          {accountsStatus === "error" ? <div className="rfp-banner rfp-banner-error" role="alert">{accountsError}</div> : null}
          {!ready && accountsStatus !== "error" ? <div className="rfp-state">Loading accounts...</div> : null}
          {ready ? (
          <div className="rfp-convert-grid">
            <label className="rfp-field">
              <span>APV Number <em className="rfp-required">*</em></span>
              <input
                ref={firstRef}
                value={form.voucherNo}
                onChange={set("voucherNo")}
                maxLength={APV_NO_MAX}
                className={shown.voucherNo ? "rfp-input-error" : ""}
                disabled={busy}
              />
              {shown.voucherNo ? <small className="rfp-field-error">{shown.voucherNo}</small> : null}
            </label>
            <label className="rfp-field">
              <span>APV Date <em className="rfp-required">*</em></span>
              <input type="date" value={form.apvDate} onChange={set("apvDate")} className={shown.apvDate ? "rfp-input-error" : ""} disabled={busy} />
              {shown.apvDate ? <small className="rfp-field-error">{shown.apvDate}</small> : null}
            </label>
            <label className="rfp-field rfp-field-wide">
              <span>Accounts Payable Account <em className="rfp-required">*</em></span>
              <select value={form.apAccountId} onChange={set("apAccountId")} className={shown.apAccountId ? "rfp-input-error" : ""} disabled={busy || !apAccounts.length}>
                <option value="">Select an account</option>
                {apAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                ))}
              </select>
              {!apAccounts.length ? (
                <small className="rfp-field-error">No account is flagged "AP CODE" in the Chart of Accounts. Ask an administrator to flag the payable account.</small>
              ) : null}
              {shown.apAccountId && apAccounts.length ? <small className="rfp-field-error">{shown.apAccountId}</small> : null}
            </label>
          </div>
          ) : null}
          {ready && missing.length ? (
            <div className="rfp-convert-lines">
              <h3>Lines without an account</h3>
              {missing.map((l) => (
                <label key={l.id} className="rfp-field rfp-field-wide">
                  <span>{l.description} <span className="rfp-subtle">({formatAmount(l.grossAmount)})</span></span>
                  <select
                    aria-label={`Account for ${l.description}`}
                    value={form.lineAccounts[String(l.id)] || ""}
                    onChange={setLineAccount(String(l.id))}
                    className={shown.lineAccounts[String(l.id)] ? "rfp-input-error" : ""}
                    disabled={busy}
                  >
                    <option value="">Select an account</option>
                    {lineAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                    ))}
                  </select>
                  {shown.lineAccounts[String(l.id)] ? <small className="rfp-field-error">{shown.lineAccounts[String(l.id)]}</small> : null}
                </label>
              ))}
            </div>
          ) : null}
          {error ? <div className="rfp-banner rfp-banner-error" role="alert">{error}</div> : null}
        </div>
        <div className="rfp-dialog-footer">
          <button type="button" className="rfp-btn rfp-btn-secondary" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="submit" className={`rfp-btn rfp-btn-${CONVERT_DIALOG.tone}`} disabled={busy || !ready}>
            {busy ? "Converting..." : CONVERT_DIALOG.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
