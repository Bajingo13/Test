import { useEffect, useState } from "react";
import "./TrialBalance.css";
import "./FxRevaluation.css";
import "../../components/RecurringTemplateModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_LABELS = {
  DRAFT: "Draft",
  CALCULATED: "Ready to Post",
  RATE_REQUIRED: "Rate Required",
  POSTED: "Posted",
  REVERSED: "Reversed",
  CANCELLED: "Cancelled",
};

export default function FxRevaluation() {
  const [revaluationDate, setRevaluationDate] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [items, setItems] = useState([]);
  const [filterType, setFilterType] = useState("");
  const [filterCurrency, setFilterCurrency] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  async function calculate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/fx-revaluation/calculate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ revaluationDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to calculate FX revaluation.");
      setSession(data.session);
      setItems(data.items);
    } catch (err) {
      setError(err.message);
      setSession(null);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function doPost() {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/fx-revaluation/${session.id}/post`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to post FX revaluation.");
      setShowConfirm(false);
      // Reload the posted session so the UI reflects its final POSTED state.
      const detailRes = await fetch(`${API_URL}/api/fx-revaluation/${session.id}`, { credentials: "include", headers: authHeaders() });
      const detail = await detailRes.json();
      if (detailRes.ok) {
        setSession(detail.session);
        setItems(detail.items);
      }
      alert(data.status === "ALREADY_POSTED" ? "This revaluation was already posted." : `Posted successfully${data.voucherNo ? ` as JV ${data.voucherNo}` : " (no net movement, no JV needed)"}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch(`${API_URL}/api/fx-revaluation`, { credentials: "include", headers: authHeaders() });
      const data = await res.json();
      if (res.ok) setHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD FX REVALUATION HISTORY ERROR:", err);
    }
  }

  async function openSession(id) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/fx-revaluation/${id}`, { credentials: "include", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load session.");
      setSession(data.session);
      setItems(data.items);
      setRevaluationDate(String(data.session.revaluation_date).slice(0, 10));
      setShowHistory(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function doReverse() {
    if (!window.confirm(`Reverse this posted FX revaluation for ${session.revaluation_date}? A reversing JV will be created; the original journal is never deleted.`)) return;
    setPosting(true);
    try {
      const res = await fetch(`${API_URL}/api/fx-revaluation/${session.id}/reverse`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to reverse.");
      await openSession(session.id);
      alert(data.status === "ALREADY_REVERSED" ? "This revaluation was already reversed." : "Reversed successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  }

  useEffect(() => {
    if (showHistory) loadHistory();
  }, [showHistory]);

  const filteredItems = items.filter((it) => {
    if (filterType && it.ar_ap_type !== filterType) return false;
    if (filterCurrency && it.currency_code !== filterCurrency) return false;
    return true;
  });

  const currencies = [...new Set(items.map((it) => it.currency_code))];
  const openAr = items.filter((it) => it.ar_ap_type === "AR").reduce((s, it) => s + Number(it.foreign_balance || 0), 0);
  const openAp = items.filter((it) => it.ar_ap_type === "AP").reduce((s, it) => s + Number(it.foreign_balance || 0), 0);
  const itemsRequiringRate = items.filter((it) => it.status === "RATE_REQUIRED").length;
  const itemsEligible = items.filter((it) => it.status !== "RATE_REQUIRED").length;

  const isPosted = session?.status === "POSTED";
  const isReversed = session?.status === "REVERSED";
  const canPost = session?.status === "CALCULATED";

  return (
    <div className="tb-page">
      <div className="tb-header">
        <h1>Month-End FX Revaluation</h1>
      </div>

      <div className="tb-filters">
        <h2>Revaluation Date</h2>
        <div className="tb-filter-grid">
          <div>
            <label>Revaluation Date</label>
            <input type="date" value={revaluationDate} onChange={(e) => setRevaluationDate(e.target.value)} disabled={isPosted || isReversed} />
          </div>
        </div>
        <div className="tb-actions">
          <button className="primary" onClick={calculate} disabled={loading}>
            {loading ? "Calculating..." : "Calculate / Preview"}
          </button>
          <button className="secondary" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide History" : "Revaluation History"}
          </button>
        </div>
      </div>

      {error && <div className="fxr-error-banner">{error}</div>}

      {showHistory && (
        <div className="tb-report-card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>Revaluation History</h2>
          <table className="fxr-table">
            <thead>
              <tr><th>Date</th><th>Status</th><th className="amount">Gain</th><th className="amount">Loss</th><th className="amount">Net</th><th>Posted By</th><th>Posted At</th><th>Action</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{String(h.revaluation_date).slice(0, 10)}</td>
                  <td><span className={`fxr-badge fxr-badge-${h.status}`}>{STATUS_LABELS[h.status] || h.status}</span></td>
                  <td className="amount">{formatMoney(h.total_gain)}</td>
                  <td className="amount">{formatMoney(h.total_loss)}</td>
                  <td className="amount">{formatMoney(h.net_effect)}</td>
                  <td>{h.posted_by || "-"}</td>
                  <td>{h.posted_at ? new Date(h.posted_at).toLocaleString("en-PH") : "-"}</td>
                  <td><button className="fxr-link-btn" onClick={() => openSession(h.id)}>View</button></td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", padding: 16 }}>No revaluations yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {session && (
        <div className="tb-report-card">
          <div className="tb-report-top">
            <div></div>
            <div className="tb-report-title">
              <h2>UNREALIZED FX REVALUATION SUMMARY</h2>
              <h3>AS OF {String(session.revaluation_date).slice(0, 10)}</h3>
            </div>
            <div className="tb-run-info">
              <p><span>Status</span>: <span className={`fxr-badge fxr-badge-${session.status}`}>{STATUS_LABELS[session.status] || session.status}</span></p>
              {session.jv_id && <p><span>JV</span>: #{session.jv_id}</p>}
            </div>
          </div>

          <div className="fxr-summary-cards">
            <div className="fxr-card"><span className="fxr-card-value">{currencies.join(", ") || "-"}</span><span className="fxr-card-label">Currencies</span></div>
            <div className="fxr-card"><span className="fxr-card-value">{formatMoney(openAr)}</span><span className="fxr-card-label">Open Foreign AR</span></div>
            <div className="fxr-card"><span className="fxr-card-value">{formatMoney(openAp)}</span><span className="fxr-card-label">Open Foreign AP</span></div>
            <div className="fxr-card fxr-card-gain"><span className="fxr-card-value">{formatMoney(session.total_gain)}</span><span className="fxr-card-label">Total Unrealized Gain</span></div>
            <div className="fxr-card fxr-card-loss"><span className="fxr-card-value">{formatMoney(session.total_loss)}</span><span className="fxr-card-label">Total Unrealized Loss</span></div>
            <div className="fxr-card"><span className="fxr-card-value">{formatMoney(session.net_effect)}</span><span className="fxr-card-label">Net FX Effect</span></div>
            <div className="fxr-card"><span className="fxr-card-value">{itemsRequiringRate}</span><span className="fxr-card-label">Items Requiring Rate</span></div>
            <div className="fxr-card"><span className="fxr-card-value">{itemsEligible}</span><span className="fxr-card-label">Items Eligible to Post</span></div>
          </div>

          <div className="tb-filter-grid" style={{ margin: "16px 0" }}>
            <div>
              <label>Type</label>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                <option value="">All</option>
                <option value="AR">AR</option>
                <option value="AP">AP</option>
              </select>
            </div>
            <div>
              <label>Currency</label>
              <select value={filterCurrency} onChange={(e) => setFilterCurrency(e.target.value)}>
                <option value="">All</option>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="aging-table-wrapper">
            <table className="fxr-table">
              <thead>
                <tr>
                  <th>Type</th><th>Document</th><th>Customer/Supplier</th><th>Currency</th>
                  <th className="amount">Foreign Balance</th><th className="amount">Carrying Amount</th>
                  <th className="amount">Closing Rate</th><th className="amount">Closing Base</th>
                  <th className="amount">Difference</th><th>Gain/Loss</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((it) => (
                  <tr key={it.id}>
                    <td>{it.ar_ap_type}</td>
                    <td>{it.document_number}</td>
                    <td>{it.party_name}</td>
                    <td>{it.currency_code}</td>
                    <td className="amount">{formatMoney(it.foreign_balance)}</td>
                    <td className="amount">{formatMoney(it.carrying_base_amount)}</td>
                    <td className="amount">{it.closing_rate ? Number(it.closing_rate).toFixed(6) : "-"}</td>
                    <td className="amount">{it.closing_base_amount != null ? formatMoney(it.closing_base_amount) : "-"}</td>
                    <td className="amount">{it.unrealized_difference != null ? formatMoney(it.unrealized_difference) : "-"}</td>
                    <td>{it.direction === "UNREALIZED_GAIN" ? "Gain" : it.direction === "UNREALIZED_LOSS" ? "Loss" : "-"}</td>
                    <td><span className={`fxr-badge fxr-badge-${it.status}`}>{STATUS_LABELS[it.status] || it.status}</span></td>
                  </tr>
                ))}
                {filteredItems.length === 0 && <tr><td colSpan={11} style={{ textAlign: "center", padding: 16 }}>No eligible open foreign balances as of this date.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="tb-actions" style={{ marginTop: 16 }}>
            {canPost && (
              <button className="primary" onClick={() => setShowConfirm(true)} disabled={posting}>
                Post Revaluation
              </button>
            )}
            {session.status === "RATE_REQUIRED" && (
              <p className="fxr-error-banner" style={{ margin: 0 }}>
                {itemsRequiringRate} item(s) have no approved closing rate. Record an approved rate for these currencies, then Calculate again.
              </p>
            )}
            {isPosted && (
              <button className="dark" onClick={doReverse} disabled={posting}>
                {posting ? "Reversing..." : "Reverse Revaluation"}
              </button>
            )}
            {isReversed && <p style={{ margin: 0 }}>This revaluation was reversed on {session.reversed_date}.</p>}
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && setShowConfirm(false)}>
          <div className="rtm-modal" style={{ width: "min(520px, 96vw)" }} role="dialog" aria-modal="true">
            <div className="rtm-header">
              <h2>Confirm Post Revaluation</h2>
              <button type="button" className="rtm-close" onClick={() => setShowConfirm(false)}>&times;</button>
            </div>
            <div className="rtm-body">
              <div className="rtm-field"><label>Revaluation Date</label><input readOnly value={String(session.revaluation_date).slice(0, 10)} /></div>
              <div className="rtm-field-row">
                <div className="rtm-field"><label>Number of Documents</label><input readOnly value={session.item_count} /></div>
                <div className="rtm-field"><label>Currencies</label><input readOnly value={currencies.join(", ")} /></div>
              </div>
              <div className="rtm-field-row">
                <div className="rtm-field"><label>Unrealized Gain</label><input readOnly value={formatMoney(session.total_gain)} /></div>
                <div className="rtm-field"><label>Unrealized Loss</label><input readOnly value={formatMoney(session.total_loss)} /></div>
              </div>
              <div className="rtm-field-row">
                <div className="rtm-field"><label>Net Effect</label><input readOnly value={formatMoney(session.net_effect)} /></div>
                <div className="rtm-field"><label>Reversal Policy</label><input readOnly value={session.reversal_policy} /></div>
              </div>
              <p className="rtm-hint">This posts a Journal Voucher to the General Ledger and Trial Balance. This action cannot be edited afterward - use Reverse to correct it.</p>
            </div>
            <div className="rtm-footer">
              <button className="rtm-btn-secondary" onClick={() => setShowConfirm(false)} disabled={posting}>Cancel</button>
              <button className="rtm-btn-primary" onClick={doPost} disabled={posting}>{posting ? "Posting..." : "Post Revaluation"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}