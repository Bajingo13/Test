import { useEffect, useState } from "react";
import { History as HistoryIcon, Loader2, ExternalLink, RotateCcw } from "lucide-react";
import "./RecurringTemplateModal.css";
import "./RecurringHistoryModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const STATUS_LABELS = {
  SUCCESS: "Generated",
  FAILED: "Failed",
  SKIPPED: "Skipped",
  RATE_REVIEW_REQUIRED: "Needs Review",
};

function formatMoney(v) {
  return v == null ? "-" : Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RecurringHistoryModal({ template, onClose, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyRow, setBusyRow] = useState(null);
  const [reviewRow, setReviewRow] = useState(null);
  const [reviewRate, setReviewRate] = useState("");

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions/${template.id}/history`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load history.");
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHistory();
  }, [template.id]);

  async function retry(row, approvedRate) {
    setBusyRow(row.id);
    try {
      const body = approvedRate ? { approvedRate: Number(approvedRate) } : {};
      const res = await fetch(`${API_URL}/api/recurring-transactions/${template.id}/generate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Retry failed.");
      } else if (data.status === "ALREADY_GENERATED") {
        alert("This occurrence was already generated - no duplicate was created.");
      }
      setReviewRow(null);
      setReviewRate("");
      await loadHistory();
      onChanged && onChanged();
    } finally {
      setBusyRow(null);
    }
  }

  function openTransaction(row) {
    if (!row.generated_transaction_id || row.generated_module_type !== "invoice") return;
    window.open(`/transactions/invoice?id=${row.generated_transaction_id}`, "_blank");
  }

  return (
    <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rtm-modal" style={{ width: "min(1080px, 96vw)" }} role="dialog" aria-modal="true" aria-label="Recurring History">
        <div className="rtm-header">
          <div>
            <h2><HistoryIcon size={18} /> Generation History</h2>
            <p className="rtm-subtitle">{template.template_name}</p>
          </div>
          <button type="button" className="rtm-close" onClick={onClose}>&times;</button>
        </div>

        <div className="rtm-body">
          {loading && <div className="rtm-loading"><Loader2 className="rtm-spin" size={20} /> Loading history...</div>}
          {!loading && error && <div className="rtm-error-banner">{error}</div>}

          {!loading && !error && (
            <div className="rhm-table-wrapper">
              <table className="rhm-table">
                <thead>
                  <tr>
                    <th>Scheduled Date</th>
                    <th>Generated</th>
                    <th>Document No.</th>
                    <th>Currency</th>
                    <th>Foreign Total</th>
                    <th>Rate</th>
                    <th>Rate Eff. Date</th>
                    <th>Base Total</th>
                    <th>Status</th>
                    <th>Failure Reason</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="rhm-empty">No occurrences yet.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.occurrence_date}</td>
                      <td>{r.created_at ? new Date(r.created_at).toLocaleString("en-PH") : "-"}</td>
                      <td>{r.documentNumber || "-"}</td>
                      <td>{r.currencyCode || "PHP"}</td>
                      <td className="rhm-amount">{formatMoney(r.foreignTotal)}</td>
                      <td className="rhm-amount">{r.exchangeRate != null ? Number(r.exchangeRate).toFixed(6) : "-"}</td>
                      <td>{r.rateEffectiveDate || "-"}</td>
                      <td className="rhm-amount">{formatMoney(r.baseTotal)}</td>
                      <td><span className={`rhm-status rhm-status-${r.status}`}>{STATUS_LABELS[r.status] || r.status}</span></td>
                      <td className="rhm-reason">{r.error_message || r.reason || "-"}</td>
                      <td className="rhm-actions">
                        {r.status === "SUCCESS" && r.generated_transaction_id && (
                          <button title="Open Transaction" onClick={() => openTransaction(r)}><ExternalLink size={14} /></button>
                        )}
                        {r.status === "FAILED" && (
                          <button title="Retry" disabled={busyRow === r.id} onClick={() => retry(r)}><RotateCcw size={14} /></button>
                        )}
                        {r.status === "RATE_REVIEW_REQUIRED" && (
                          <button title="Review Rate" disabled={busyRow === r.id} onClick={() => setReviewRow(r)}>Review</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rtm-footer">
          <button className="rtm-btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>

      {reviewRow && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && setReviewRow(null)}>
          <div className="rtm-modal" style={{ width: "min(420px, 96vw)" }} role="dialog" aria-modal="true">
            <div className="rtm-header">
              <h2>Approve Rate</h2>
              <button type="button" className="rtm-close" onClick={() => setReviewRow(null)}>&times;</button>
            </div>
            <div className="rtm-body">
              <div className="rtm-field">
                <label>Occurrence Date</label>
                <input readOnly value={reviewRow.occurrence_date} />
              </div>
              <div className="rtm-field">
                <label>Approved Rate</label>
                <input type="number" step="0.000001" min="0" value={reviewRate} onChange={(e) => setReviewRate(e.target.value)} placeholder="e.g. 57.50" />
              </div>
              <p className="rtm-hint">Applies to this occurrence only. The generated transaction will be created as Draft.</p>
            </div>
            <div className="rtm-footer">
              <button className="rtm-btn-secondary" onClick={() => setReviewRow(null)}>Cancel</button>
              <button className="rtm-btn-primary" disabled={!reviewRate || busyRow === reviewRow.id} onClick={() => retry(reviewRow, reviewRate)}>
                Approve &amp; Generate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}