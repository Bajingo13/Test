import { useEffect, useState } from "react";
import "./AccountingPeriodLocking.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const STATUS_LABEL = { OPEN: "Open", SOFT_CLOSED: "Soft Closed", CLOSED: "Closed" };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function fmtDate(d) {
  if (!d) return "-";
  return String(d).slice(0, 10);
}

export default function AccountingPeriodLocking() {
  const [access, setAccess] = useState(null); // null=loading, then { view, generate, softClose, close, reopen }
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [modal, setModal] = useState(null); // { type: 'close'|'reopen'|'history'|'checklist', period }
  const [checklist, setChecklist] = useState(null);
  const [history, setHistory] = useState([]);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setAccess({ view: false }); return; }
      const has = (action) => data.permissions?.some((p) => p.moduleKey === "ACCOUNTING_PERIODS" && p.action === action && p.granted);
      setAccess({
        view: has("VIEW"), generate: has("GENERATE"),
        softClose: has("SOFT_CLOSE"), close: has("CLOSE"), reopen: has("REOPEN"),
      });
      const companiesRes = await fetch(`${API_URL}/api/companies`, { headers: authHeaders() });
      if (companiesRes.ok) setCompanies(await companiesRes.json());
    })();
  }, []);

  useEffect(() => {
    if (access?.view) loadPeriods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, companyId, year]);

  async function loadPeriods() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ year: String(year) });
      if (companyId) params.set("companyId", companyId);
      const res = await fetch(`${API_URL}/api/accounting-periods?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setError(data.message || "Failed to load accounting periods"); return; }
      setPeriods(data);
    } catch (err) {
      console.error("LOAD ACCOUNTING PERIODS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateYear() {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/accounting-periods/generate-year`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ year: Number(year), companyId: companyId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.message || "Failed to generate periods"); return; }
      loadPeriods();
    } catch (err) {
      console.error("GENERATE PERIODS ERROR:", err);
      alert("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function openChecklist(period) {
    setModal({ type: "checklist", period });
    setChecklist(null);
    const res = await fetch(`${API_URL}/api/accounting-periods/${period.id}/checklist?companyId=${period.company_id}`, { headers: authHeaders() });
    const data = await res.json();
    if (res.ok) setChecklist(data);
  }

  async function openHistory(period) {
    setModal({ type: "history", period });
    setHistory([]);
    const params = new URLSearchParams({ periodId: String(period.id), companyId: String(period.company_id) });
    const res = await fetch(`${API_URL}/api/accounting-periods/history?${params}`, { headers: authHeaders() });
    const data = await res.json();
    if (res.ok) setHistory(data);
  }

  function openClose(period) { setModal({ type: "close", period }); setNotes(""); }
  function openSoftClose(period) { setModal({ type: "softClose", period }); setNotes(""); }
  function openReopen(period) { setModal({ type: "reopen", period }); setReason(""); }

  async function submitTransition(action) {
    const period = modal.period;
    setSubmitting(true);
    try {
      const body = action === "reopen"
        ? { companyId: period.company_id, reason }
        : { companyId: period.company_id, notes };
      const res = await fetch(`${API_URL}/api/accounting-periods/${period.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.message || `Failed to ${action} period`); return; }
      setModal(null);
      loadPeriods();
    } catch (err) {
      console.error(`${action.toUpperCase()} PERIOD ERROR:`, err);
      alert("Unable to connect to the server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (access === null) {
    return <div className="apl-page"><p className="apl-muted">Loading...</p></div>;
  }
  if (!access.view) {
    return (
      <div className="apl-page">
        <div className="apl-card">
          <h1>Accounting Period Locking</h1>
          <div className="apl-error-banner">You do not have permission to view accounting periods.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="apl-page">
      <h1>Accounting Period Locking</h1>
      <p className="apl-intro">
        Once a period is closed, no transaction dated into it can be created, edited, deleted, or posted -
        by anyone, including Super Admin - until it is explicitly reopened with a reason. Locking controls
        mutation only; reports and printing for closed periods remain fully available.
      </p>

      <div className="apl-card apl-toolbar">
        {companies.length > 0 && (
          <div className="apl-field">
            <label>Company</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">My company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="apl-field">
          <label>Year</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {access.generate && (
          <button className="apl-btn-primary" disabled={submitting} onClick={handleGenerateYear}>
            {submitting ? "Generating..." : `Generate ${year} Periods`}
          </button>
        )}
      </div>

      <div className="apl-card">
        {error && <div className="apl-error-banner">{error}</div>}
        {loading ? (
          <p className="apl-muted">Loading...</p>
        ) : periods.length === 0 ? (
          <p className="apl-muted">No accounting periods generated for {year} yet.</p>
        ) : (
          <div className="apl-table-wrap">
            <table className="apl-table">
              <thead>
                <tr>
                  <th>Period</th><th>Start</th><th>End</th><th>Status</th>
                  <th>Closed By</th><th>Closed At</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td>{MONTH_NAMES[p.period_month - 1]} {p.year}</td>
                    <td>{fmtDate(p.start_date)}</td>
                    <td>{fmtDate(p.end_date)}</td>
                    <td><span className={`apl-badge apl-badge-${p.status.toLowerCase()}`}>{STATUS_LABEL[p.status]}</span></td>
                    <td>{p.closed_by ? (p.closed_by_username || `User #${p.closed_by}`) : "-"}</td>
                    <td>{p.closed_at ? fmtDate(p.closed_at) : "-"}</td>
                    <td className="apl-actions">
                      <button className="apl-link-btn" onClick={() => openHistory(p)}>History</button>
                      {p.status === "OPEN" && access.softClose && (
                        <button className="apl-link-btn" onClick={() => openSoftClose(p)}>Soft Close</button>
                      )}
                      {p.status !== "CLOSED" && access.close && (
                        <button className="apl-link-btn" onClick={() => openChecklist(p)}>Close</button>
                      )}
                      {p.status !== "OPEN" && access.reopen && (
                        <button className="apl-link-btn apl-link-danger" onClick={() => openReopen(p)}>Reopen</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal?.type === "checklist" && (
        <div className="apl-modal-backdrop" onClick={() => setModal(null)}>
          <div className="apl-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Close {MONTH_NAMES[modal.period.period_month - 1]} {modal.period.year}?</h2>
            <p className="apl-modal-warning">
              Posting, editing, deleting, or backdating accounting transactions into this period will be
              blocked immediately. This can only be undone by an authorized user explicitly reopening the
              period with a reason.
            </p>
            {!checklist ? (
              <p className="apl-muted">Loading checklist...</p>
            ) : (
              <div className="apl-checklist">
                <div className="apl-checklist-row">
                  <span>Draft transactions in this period</span>
                  <strong>{checklist.draftTransactions.total}</strong>
                </div>
                <div className="apl-checklist-row">
                  <span>Unposted FX revaluation sessions</span>
                  <strong>{checklist.fxRevaluationPending}</strong>
                </div>
                {checklist.warnings.length > 0 && (
                  <ul className="apl-warning-list">
                    {checklist.warnings.map((w) => <li key={w.code}>{w.message}</li>)}
                  </ul>
                )}
              </div>
            )}
            <div className="apl-field apl-field-wide">
              <label>Close Notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <div className="apl-modal-actions">
              <button className="apl-btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="apl-btn-primary" disabled={submitting} onClick={() => submitTransition("close")}>
                {submitting ? "Closing..." : "Close Period"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "softClose" && (
        <div className="apl-modal-backdrop" onClick={() => setModal(null)}>
          <div className="apl-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Soft Close {MONTH_NAMES[modal.period.period_month - 1]} {modal.period.year}?</h2>
            <p className="apl-modal-warning">
              Normal users will no longer be able to post or edit into this period. Users with the
              "Post Into Soft-Closed Period" permission may still make approved adjustments.
            </p>
            <div className="apl-field apl-field-wide">
              <label>Notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <div className="apl-modal-actions">
              <button className="apl-btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="apl-btn-primary" disabled={submitting} onClick={() => submitTransition("soft-close")}>
                {submitting ? "Saving..." : "Soft Close Period"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "reopen" && (
        <div className="apl-modal-backdrop" onClick={() => setModal(null)}>
          <div className="apl-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Reopen {MONTH_NAMES[modal.period.period_month - 1]} {modal.period.year}?</h2>
            <p className="apl-modal-warning">
              Accounting data for this period may change once reopened, and previously issued reports may
              no longer match. This action is recorded permanently in the lock history.
            </p>
            <div className="apl-field apl-field-wide">
              <label>Reason (required)</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
            </div>
            <div className="apl-modal-actions">
              <button className="apl-btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button
                className="apl-btn-primary"
                disabled={submitting || !reason.trim()}
                onClick={() => submitTransition("reopen")}
              >
                {submitting ? "Reopening..." : "Reopen Period"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "history" && (
        <div className="apl-modal-backdrop" onClick={() => setModal(null)}>
          <div className="apl-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Lock History - {MONTH_NAMES[modal.period.period_month - 1]} {modal.period.year}</h2>
            {history.length === 0 ? (
              <p className="apl-muted">No lock history yet.</p>
            ) : (
              <div className="apl-table-wrap">
                <table className="apl-table">
                  <thead>
                    <tr><th>Action</th><th>From</th><th>To</th><th>User</th><th>When</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>{h.action}</td>
                        <td>{h.previous_status || "-"}</td>
                        <td>{h.new_status}</td>
                        <td>{h.username || "-"}</td>
                        <td>{fmtDate(h.created_at)}</td>
                        <td>{h.reason || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="apl-modal-actions">
              <button className="apl-btn-secondary" onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}