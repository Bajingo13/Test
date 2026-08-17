import { useEffect, useMemo, useState } from "react";
import { Repeat, Play, Pause, History as HistoryIcon, Pencil, RotateCcw } from "lucide-react";
import "./RecurringTransactions.css";
import "../../components/RecurringTemplateModal.css";
import RecurringGenerateNowModal from "../../components/RecurringGenerateNowModal";
import RecurringHistoryModal from "../../components/RecurringHistoryModal";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const MODULE_LABELS = { invoice: "Invoice", apv: "APV", jv: "JV", po: "PO", or: "OR", cv: "CV" };
const RATE_POLICY_LABELS = {
  RESOLVE_ON_GENERATION: "Resolve on Generation",
  FIXED_RATE: "Fixed Rate",
  MANUAL_REVIEW: "Manual Review",
};

function statusBadge(t) {
  if (t.latestOccurrenceStatus === "RATE_REVIEW_REQUIRED") return { label: "Needs Review", cls: "rtx-badge-review" };
  if (t.latestOccurrenceStatus === "FAILED") return { label: "Failed", cls: "rtx-badge-failed" };
  if (t.status === "COMPLETED" || !t.is_active) return { label: "Completed", cls: "rtx-badge-completed" };
  if (t.is_paused) return { label: "Paused", cls: "rtx-badge-paused" };
  return { label: "Active", cls: "rtx-badge-active" };
}

export default function RecurringTransactions() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [generateTarget, setGenerateTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [catchUpDecision, setCatchUpDecision] = useState(null); // { template, missedCount, nextRunDate }
  const [editTarget, setEditTarget] = useState(null); // { id, templateName, descriptionTemplate }

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions`, { credentials: "include", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load recurring templates.");
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  const summary = useMemo(() => {
    const counts = { active: 0, paused: 0, needsReview: 0, failed: 0 };
    for (const t of templates) {
      if (t.latestOccurrenceStatus === "RATE_REVIEW_REQUIRED") counts.needsReview++;
      else if (t.latestOccurrenceStatus === "FAILED") counts.failed++;
      else if (t.is_paused) counts.paused++;
      else if (t.is_active) counts.active++;
    }
    return counts;
  }, [templates]);

  async function callAction(id, path, options = {}) {
    setBusyId(id);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions/${id}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(options.body || {}),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, status: res.status, data };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, data: { message: err.message } };
    } finally {
      setBusyId(null);
    }
  }

  async function handlePause(t) {
    const result = await callAction(t.id, "/pause");
    if (!result.ok) return alert(result.data.message || "Failed to pause.");
    loadList();
  }

  async function handleResume(t, catchUpPolicy) {
    const result = await callAction(t.id, "/resume", { body: catchUpPolicy ? { catchUpPolicy } : {} });
    if (!result.ok) {
      if (result.status === 409 && result.data.requiresCatchUpDecision) {
        setCatchUpDecision({ template: t, missedCount: result.data.missedCount, nextRunDate: result.data.nextRunDate });
        return;
      }
      return alert(result.data.message || "Failed to resume.");
    }
    setCatchUpDecision(null);
    loadList();
  }

  async function handleStop(t) {
    if (!window.confirm(`Stop "${t.template_name}"? This ends the schedule - it will not generate any further occurrences.`)) return;
    const result = await callAction(t.id, "/stop");
    if (!result.ok) return alert(result.data.message || "Failed to stop.");
    loadList();
  }

  async function saveEdit() {
    if (!editTarget) return;
    setBusyId(editTarget.id);
    try {
      const res = await fetch(`${API_URL}/api/recurring-transactions/${editTarget.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ templateName: editTarget.templateName, descriptionTemplate: editTarget.descriptionTemplate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save.");
      setEditTarget(null);
      loadList();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rtx-page">
      <div className="rtx-header">
        <h1><Repeat size={20} /> Recurring Transactions</h1>
        <p className="rtx-subtitle">Manage scheduled recurring templates. Generated transactions always start as Draft.</p>
      </div>

      <div className="rtx-summary-cards">
        <div className="rtx-card rtx-card-active"><span className="rtx-card-value">{summary.active}</span><span className="rtx-card-label">Active</span></div>
        <div className="rtx-card rtx-card-paused"><span className="rtx-card-value">{summary.paused}</span><span className="rtx-card-label">Paused</span></div>
        <div className="rtx-card rtx-card-review"><span className="rtx-card-value">{summary.needsReview}</span><span className="rtx-card-label">Needs Review</span></div>
        <div className="rtx-card rtx-card-failed"><span className="rtx-card-value">{summary.failed}</span><span className="rtx-card-label">Failed</span></div>
      </div>

      {error && <div className="rtx-error-banner">{error}</div>}

      <div className="rtx-table-wrapper">
        <table className="rtx-table">
          <thead>
            <tr>
              <th>Template Name</th>
              <th>Type</th>
              <th>Customer/Supplier</th>
              <th>Currency</th>
              <th>Frequency</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Rate Policy</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} className="rtx-empty">Loading...</td></tr>
            )}
            {!loading && templates.length === 0 && (
              <tr><td colSpan={10} className="rtx-empty">No recurring templates yet. Open a saved Invoice and click "Make Recurring" to create one.</td></tr>
            )}
            {!loading && templates.map((t) => {
              const badge = statusBadge(t);
              return (
                <tr key={t.id}>
                  <td>{t.template_name}</td>
                  <td>{MODULE_LABELS[t.module_type] || t.module_type}</td>
                  <td>{t.party_name || "-"}</td>
                  <td>{t.currencyCode || "PHP"}</td>
                  <td>{t.frequency || "-"}</td>
                  <td>{t.next_run_date || "-"}</td>
                  <td>{t.last_run_date || "-"}</td>
                  <td>{RATE_POLICY_LABELS[t.rate_policy] || "-"}</td>
                  <td><span className={`rtx-badge ${badge.cls}`}>{badge.label}</span></td>
                  <td className="rtx-actions">
                    <button title="Edit" disabled={busyId === t.id} onClick={() => setEditTarget({ id: t.id, templateName: t.template_name, descriptionTemplate: "" })}><Pencil size={15} /></button>
                    <button title="Generate Now" disabled={busyId === t.id} onClick={() => setGenerateTarget(t)}><Play size={15} /></button>
                    {t.is_paused ? (
                      <button title="Resume" disabled={busyId === t.id} onClick={() => handleResume(t)}><RotateCcw size={15} /></button>
                    ) : (
                      <button title="Pause" disabled={busyId === t.id} onClick={() => handlePause(t)}><Pause size={15} /></button>
                    )}
                    <button title="History" disabled={busyId === t.id} onClick={() => setHistoryTarget(t)}><HistoryIcon size={15} /></button>
                    <button title="Stop" className="rtx-btn-danger" disabled={busyId === t.id} onClick={() => handleStop(t)}>Stop</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {generateTarget && (
        <RecurringGenerateNowModal
          template={generateTarget}
          onClose={() => setGenerateTarget(null)}
          onGenerated={() => { setGenerateTarget(null); loadList(); }}
        />
      )}

      {historyTarget && (
        <RecurringHistoryModal template={historyTarget} onClose={() => setHistoryTarget(null)} onChanged={loadList} />
      )}

      {catchUpDecision && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && setCatchUpDecision(null)}>
          <div className="rtm-modal" style={{ width: "min(520px, 96vw)" }} role="dialog" aria-modal="true">
            <div className="rtm-header">
              <div>
                <h2>Resume "{catchUpDecision.template.template_name}"</h2>
                <p className="rtm-subtitle">
                  This schedule was due starting {catchUpDecision.nextRunDate} ({catchUpDecision.missedCount} missed occurrence{catchUpDecision.missedCount === 1 ? "" : "s"}
                  {catchUpDecision.missedCount >= 60 ? "+" : ""}) while paused. How should it catch up?
                </p>
              </div>
              <button type="button" className="rtm-close" onClick={() => setCatchUpDecision(null)}>&times;</button>
            </div>
            <div className="rtm-body">
              <p className="rtx-catchup-option-title">Generate missed occurrences</p>
              <p className="rtm-hint">Every missed occurrence will still be generated, one at a time (via Generate Now or the scheduler), each using the correct historical rate for its own date. Nothing is generated immediately.</p>
              <p className="rtx-catchup-option-title" style={{ marginTop: 14 }}>Skip to next occurrence</p>
              <p className="rtm-hint">All missed occurrences are marked Skipped (visible in History) and the schedule resumes from the next upcoming date. No transactions are generated for the missed period.</p>
            </div>
            <div className="rtm-footer">
              <button className="rtm-btn-secondary" onClick={() => handleResume(catchUpDecision.template, "SKIP_TO_NEXT")}>Skip to Next</button>
              <button className="rtm-btn-primary" onClick={() => handleResume(catchUpDecision.template, "GENERATE_MISSED")}>Generate Missed</button>
            </div>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && setEditTarget(null)}>
          <div className="rtm-modal" style={{ width: "min(520px, 96vw)" }} role="dialog" aria-modal="true">
            <div className="rtm-header">
              <h2>Edit Template</h2>
              <button type="button" className="rtm-close" onClick={() => setEditTarget(null)}>&times;</button>
            </div>
            <div className="rtm-body">
              <div className="rtm-field">
                <label>Template Name</label>
                <input type="text" value={editTarget.templateName} onChange={(e) => setEditTarget({ ...editTarget, templateName: e.target.value })} />
              </div>
              <p className="rtm-hint">Changes apply to future occurrences only - already-generated transactions are never modified. Currency, rate policy, and schedule cannot be edited here yet.</p>
            </div>
            <div className="rtm-footer">
              <button className="rtm-btn-secondary" onClick={() => setEditTarget(null)}>Cancel</button>
              <button className="rtm-btn-primary" disabled={busyId === editTarget.id} onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}