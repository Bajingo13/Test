import { useMemo, useState } from "react";
import { LIMITS, VAT_TREATMENTS, emptyLine, formatAmount, sumLines, validateForm } from "../../utils/rfpPage.mjs";

// Create / edit form for one RFP. Company is fixed while the form is open
// (shown, never editable here); the requester is always the signed-in user;
// RFP number, status and supplier name/TIN come from the server. The live
// total is feedback only - the server recalculates it from the lines.
export default function RfpForm({
  mode,
  initialForm,
  lookups,
  companyName,
  requesterName,
  rfpNo,
  fallbackSupplier,
  returnNote,
  saving,
  serverError,
  onSave,
  onCancel,
}) {
  const [form, setForm] = useState(initialForm);
  const [attempted, setAttempted] = useState(false);

  const { valid, errors } = useMemo(() => validateForm(form), [form]);
  const shown = attempted ? errors : { lines: [] };
  const total = sumLines(form.lines);

  const suppliers = lookups?.suppliers || [];
  const selectedSupplier =
    suppliers.find((s) => String(s.id) === String(form.supplierId)) ||
    (fallbackSupplier && String(fallbackSupplier.id) === String(form.supplierId) ? fallbackSupplier : null);
  const supplierUnavailable = Boolean(form.supplierId) && !suppliers.some((s) => String(s.id) === String(form.supplierId));
  const branches = lookups?.branches || [];
  const currencies = lookups?.currencies || [];
  const accounts = lookups?.accounts || [];

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const setLine = (index, field) => (e) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === index ? { ...l, [field]: e.target.value } : l)) }));
  const addLine = () => setForm((f) => (f.lines.length >= LIMITS.lines ? f : { ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = (index) => setForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== index) }));

  function submit(e) {
    e.preventDefault();
    setAttempted(true);
    if (!valid || saving) return;
    onSave(form);
  }

  const fieldClass = (name) => (shown[name] ? "rfp-input-error" : "");

  return (
    <form className="rfp-card rfp-form" onSubmit={submit} noValidate>
      <div className="rfp-card-header">
        <div>
          <h2>{mode === "create" ? "New Request for Payment" : `Edit ${rfpNo}`}</h2>
          <p className="rfp-subtle">
            {mode === "create" ? "The RFP number is assigned when you save." : "The RFP number and company stay the same."}
          </p>
        </div>
      </div>

      {returnNote !== undefined ? (
        <div className="rfp-banner rfp-banner-warning rfp-returned" role="note">
          <div>
            <strong>Returned for correction</strong>
            {returnNote ? <p className="rfp-prewrap">Reason: {returnNote}</p> : null}
            <p>Saving keeps this request RETURNED. Resubmit it from the request view when the corrections are complete.</p>
          </div>
        </div>
      ) : null}
      {serverError ? <div className="rfp-banner rfp-banner-error" role="alert">{serverError}</div> : null}
      {attempted && !valid ? (
        <div className="rfp-banner rfp-banner-error" role="alert">Please fix the highlighted fields.</div>
      ) : null}

      <div className="rfp-grid">
        <div className="rfp-field">
          <span>Company</span>
          <div className="rfp-readonly">{companyName}</div>
        </div>
        <div className="rfp-field">
          <span>Requester</span>
          <div className="rfp-readonly">{requesterName}</div>
        </div>
        <label className="rfp-field">
          <span>Branch <em className="rfp-optional">(optional)</em></span>
          {branches.length ? (
            <select value={form.branchId} onChange={set("branchId")} disabled={saving}>
              <option value="">No branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          ) : (
            <div className="rfp-readonly rfp-subtle">No branches available.</div>
          )}
        </label>
        <label className="rfp-field">
          <span>RFP Date <em className="rfp-required">*</em></span>
          <input type="date" value={form.rfpDate} onChange={set("rfpDate")} className={fieldClass("rfpDate")} disabled={saving} />
          {shown.rfpDate ? <small className="rfp-field-error">{shown.rfpDate}</small> : null}
        </label>
        <label className="rfp-field">
          <span>Supplier <em className="rfp-required">*</em></span>
          <select value={form.supplierId} onChange={set("supplierId")} className={fieldClass("supplierId")} disabled={saving}>
            <option value="">Select a supplier</option>
            {supplierUnavailable && selectedSupplier ? (
              <option value={selectedSupplier.id}>{selectedSupplier.name} (no longer available)</option>
            ) : null}
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {shown.supplierId ? <small className="rfp-field-error">{shown.supplierId}</small> : null}
          {!suppliers.length ? <small className="rfp-subtle">No active suppliers for this company.</small> : null}
        </label>
        <div className="rfp-field">
          <span>Supplier TIN</span>
          <div className="rfp-readonly">{selectedSupplier ? selectedSupplier.tin || "Not on file" : "—"}</div>
        </div>
        <label className="rfp-field">
          <span>Requested Payment Date <em className="rfp-required">*</em></span>
          <input
            type="date"
            value={form.requestedPaymentDate}
            onChange={set("requestedPaymentDate")}
            className={fieldClass("requestedPaymentDate")}
            disabled={saving}
          />
          {shown.requestedPaymentDate ? <small className="rfp-field-error">{shown.requestedPaymentDate}</small> : null}
        </label>
        <label className="rfp-field">
          <span>Currency <em className="rfp-required">*</em></span>
          <select value={form.currencyId} onChange={set("currencyId")} className={fieldClass("currencyId")} disabled={saving}>
            <option value="">Select a currency</option>
            {currencies.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </select>
          {shown.currencyId ? <small className="rfp-field-error">{shown.currencyId}</small> : null}
        </label>
        <label className="rfp-field">
          <span>Supporting Reference <em className="rfp-optional">(optional)</em></span>
          <input
            type="text"
            value={form.supportingReference}
            onChange={set("supportingReference")}
            maxLength={LIMITS.supportingReference}
            placeholder="e.g. supplier invoice no."
            className={fieldClass("supportingReference")}
            disabled={saving}
          />
          {shown.supportingReference ? <small className="rfp-field-error">{shown.supportingReference}</small> : null}
        </label>
        <label className="rfp-field rfp-field-wide">
          <span>Purpose <em className="rfp-required">*</em></span>
          <textarea rows={3} value={form.purpose} onChange={set("purpose")} maxLength={LIMITS.purpose} className={fieldClass("purpose")} disabled={saving} />
          <small className="rfp-counter">{form.purpose.length}/{LIMITS.purpose}</small>
          {shown.purpose ? <small className="rfp-field-error">{shown.purpose}</small> : null}
        </label>
        <label className="rfp-field rfp-field-wide">
          <span>Remarks <em className="rfp-optional">(optional)</em></span>
          <textarea rows={2} value={form.remarks} onChange={set("remarks")} maxLength={LIMITS.remarks} className={fieldClass("remarks")} disabled={saving} />
          {shown.remarks ? <small className="rfp-field-error">{shown.remarks}</small> : null}
        </label>
      </div>

      <div className="rfp-section-title">
        <h3>Lines</h3>
        <span className="rfp-subtle">{form.lines.length} of {LIMITS.lines} max</span>
      </div>
      {shown.linesGeneral ? <div className="rfp-banner rfp-banner-error">{shown.linesGeneral}</div> : null}
      <div className="rfp-table-wrap">
        <table className="rfp-table rfp-lines-table">
          <thead>
            <tr>
              <th>Description *</th>
              <th>Account</th>
              <th className="rfp-num">Gross Amount *</th>
              <th>VAT Treatment</th>
              <th>Reference</th>
              <th aria-label="Remove line" />
            </tr>
          </thead>
          <tbody>
            {form.lines.map((line, i) => {
              const e = shown.lines?.[i] || {};
              return (
                <tr key={line.key}>
                  <td>
                    <input aria-label={`Line ${i + 1} description`} value={line.description} onChange={setLine(i, "description")} maxLength={LIMITS.lineDescription} className={e.description ? "rfp-input-error" : ""} disabled={saving} />
                    {e.description ? <small className="rfp-field-error">{e.description}</small> : null}
                  </td>
                  <td>
                    <select aria-label={`Line ${i + 1} account`} value={line.accountId} onChange={setLine(i, "accountId")} disabled={saving}>
                      <option value="">—</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.title}</option>
                      ))}
                    </select>
                  </td>
                  <td className="rfp-num">
                    <input aria-label={`Line ${i + 1} gross amount`} inputMode="decimal" placeholder="0.00" value={line.grossAmount} onChange={setLine(i, "grossAmount")} className={e.grossAmount ? "rfp-input-error rfp-num" : "rfp-num"} disabled={saving} />
                    {e.grossAmount ? <small className="rfp-field-error">{e.grossAmount}</small> : null}
                  </td>
                  <td>
                    <select aria-label={`Line ${i + 1} VAT treatment`} value={line.vatTreatment} onChange={setLine(i, "vatTreatment")} disabled={saving}>
                      <option value="">—</option>
                      {VAT_TREATMENTS.map((v) => (
                        <option key={v.value} value={v.value}>{v.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input aria-label={`Line ${i + 1} reference`} value={line.reference} onChange={setLine(i, "reference")} maxLength={LIMITS.lineReference} disabled={saving} />
                  </td>
                  <td>
                    <button type="button" className="rfp-icon-btn" onClick={() => removeLine(i)} disabled={saving || form.lines.length === 1} aria-label={`Remove line ${i + 1}`}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rfp-lines-footer">
        <button type="button" className="rfp-btn rfp-btn-secondary" onClick={addLine} disabled={saving || form.lines.length >= LIMITS.lines}>
          + Add line
        </button>
        <div className="rfp-total">
          <span>Total</span>
          <strong>{formatAmount(total.amount)}</strong>
          {total.invalid ? <small className="rfp-subtle">({total.invalid} line{total.invalid > 1 ? "s" : ""} without a valid amount)</small> : null}
        </div>
      </div>

      <div className="rfp-form-actions">
        <button type="button" className="rfp-btn rfp-btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="rfp-btn rfp-btn-primary" disabled={saving}>
          {saving ? "Saving..." : mode === "create" ? "Save Draft" : "Save Changes"}
        </button>
      </div>
    </form>
  );
}
