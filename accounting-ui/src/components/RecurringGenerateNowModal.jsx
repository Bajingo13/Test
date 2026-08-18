import { useEffect, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import "./RecurringTemplateModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const MODULE_LABELS = { invoice: "Invoice", apv: "APV", jv: "JV", po: "PO", or: "OR", cv: "CV" };

export default function RecurringGenerateNowModal({ template, onClose, onGenerated }) {
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [approvedRate, setApprovedRate] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/recurring-transactions/${template.id}/preview?count=1`, {
          credentials: "include",
          headers: authHeaders(),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to preview occurrence.");
        setPreview(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [template.id]);

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const body = {};
      if (template.rate_policy === "MANUAL_REVIEW" && approvedRate) {
        body.approvedRate = Number(approvedRate);
      }
      const res = await fetch(`${API_URL}/api/recurring-transactions/${template.id}/generate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to generate.");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const occurrenceDate = preview?.dates?.[0] || null;
  const cp = preview?.currencyPreview;
  const rateNeedsApproval = template.rate_policy === "MANUAL_REVIEW" && (!cp || cp.rate == null);

  return (
    <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rtm-modal" style={{ width: "min(560px, 96vw)" }} role="dialog" aria-modal="true" aria-label="Generate Now">
        <div className="rtm-header">
          <div>
            <h2><Play size={18} /> Generate Now</h2>
            <p className="rtm-subtitle">{template.template_name}</p>
          </div>
          <button type="button" className="rtm-close" onClick={onClose}>&times;</button>
        </div>

        <div className="rtm-body">
          {loading && (
            <div className="rtm-loading"><Loader2 className="rtm-spin" size={20} /> Loading preview...</div>
          )}

          {!loading && error && !result && <div className="rtm-error-banner">{error}</div>}

          {!loading && !result && preview && (
            <>
              {preview.isPaused && (
                <div className="rtm-error-banner" style={{ marginBottom: 14 }}>
                  This template is currently paused. Generating now will not resume the schedule.
                </div>
              )}

              <div className="rtm-field"><label>Transaction Type</label><input readOnly value={MODULE_LABELS[preview.moduleType] || preview.moduleType} /></div>
              <div className="rtm-field-row">
                <div className="rtm-field"><label>Occurrence Date</label><input readOnly value={occurrenceDate || "-"} /></div>
                <div className="rtm-field"><label>Currency</label><input readOnly value={cp?.currencyCode || "PHP (base)"} /></div>
              </div>

              {cp && (
                <>
                  <div className="rtm-field-row">
                    <div className="rtm-field"><label>Foreign Total</label><input readOnly value={cp.foreignTotal != null ? Number(cp.foreignTotal).toFixed(2) : "-"} /></div>
                    <div className="rtm-field"><label>Rate Policy</label><input readOnly value={cp.ratePolicy} /></div>
                  </div>

                  {cp.rate != null ? (
                    <>
                      <div className="rtm-field-row">
                        <div className="rtm-field"><label>Available Rate</label><input readOnly value={Number(cp.rate).toFixed(6)} /></div>
                        <div className="rtm-field"><label>Rate Effective Date</label><input readOnly value={cp.rateEffectiveDate || occurrenceDate || "-"} /></div>
                      </div>
                      <div className="rtm-field"><label>Estimated Base Total</label><input readOnly value={cp.estimatedBaseAmount != null ? Number(cp.estimatedBaseAmount).toFixed(2) : "-"} /></div>
                      {cp.rateWillChange && (
                        <p className="rtm-hint">This rate is subject to final resolution at the moment of generation - it may differ slightly if resolved later.</p>
                      )}
                    </>
                  ) : (
                    <p className="rtm-hint">No rate currently available to preview{cp.ratePolicy === "MANUAL_REVIEW" ? " - this policy requires a manually approved rate." : "."}</p>
                  )}
                </>
              )}

              {rateNeedsApproval && (
                <div className="rtm-field">
                  <label>Approved Rate (required for Manual Review)</label>
                  <input type="number" step="0.000001" min="0" value={approvedRate} onChange={(e) => setApprovedRate(e.target.value)} placeholder="e.g. 57.50" />
                  <p className="rtm-hint">Approving here applies to THIS occurrence only - never persisted onto the template.</p>
                </div>
              )}

              <p className="rtm-hint" style={{ marginTop: 10, fontWeight: 700 }}>Generated transaction will be created as Draft.</p>
            </>
          )}

          {result && (
            <>
              {result.status === "SUCCESS" && (
                <div className="rtm-success-banner">
                  Generated {MODULE_LABELS[template.module_type] || template.module_type} <strong>{result.voucherNo}</strong> for {result.occurrenceDate} (Draft).
                </div>
              )}
              {result.status === "ALREADY_GENERATED" && (
                <div className="rtm-error-banner">This occurrence has already been generated. No duplicate was created.</div>
              )}
              {result.status === "RATE_REVIEW_REQUIRED" && (
                <div className="rtm-error-banner">This occurrence requires rate review. Supply an approved rate and try again.</div>
              )}
              {result.status === "PERIOD_CLOSED" && (
                <div className="rtm-error-banner">
                  {result.message || "The accounting period for this occurrence is closed."} No transaction was generated - the occurrence is recorded for review and can be retried once the period reopens.
                </div>
              )}
            </>
          )}

          {!loading && error && result === null && !preview && (
            <p className="rtm-hint">{error}</p>
          )}
        </div>

        <div className="rtm-footer">
          {result ? (
            <button className="rtm-btn-primary" onClick={() => { onGenerated(); }}>Done</button>
          ) : (
            <>
              <button className="rtm-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="rtm-btn-primary" onClick={handleGenerate} disabled={busy || loading || (rateNeedsApproval && !approvedRate)}>
                {busy ? "Generating..." : "Generate"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}