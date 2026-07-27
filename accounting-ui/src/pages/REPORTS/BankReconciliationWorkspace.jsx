import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./BankReconciliation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleAuthError(status) {
  if (status === 401 || status === 403) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return true;
  }
  return false;
}

export default function BankReconciliationWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [session, setSession] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSession();
  }, [id]);

  async function loadSession() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load reconciliation session");
        navigate("/reports/bank-reconciliation");
        return;
      }

      setSession(data);
      setForm({
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        statementBeginningBalance: data.statementBeginningBalance,
        statementEndingBalance: data.statementEndingBalance,
        dateToleranceDays: data.dateToleranceDays,
        amountVarianceType: data.amountVarianceType,
        amountVarianceValue: data.amountVarianceValue,
        notes: data.notes || "",
      });
    } catch (err) {
      console.error("LOAD BANK RECON SESSION ERROR:", err);
    }
  }

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  async function saveSettings() {
    setSaving(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to update reconciliation session.");
        return;
      }

      await loadSession();
      alert("Session settings updated.");
    } catch (err) {
      console.error("UPDATE BANK RECON SESSION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  if (!session || !form) {
    return (
      <div className="brc-page">
        <div className="brc-card">Loading...</div>
      </div>
    );
  }

  const isFinalized = session.status === "FINALIZED";

  return (
    <div className="brc-page">
      <div className="brc-header-card">
        <div>
          <h1>
            {session.bankCode} - {session.bankName}
            {session.bankAccountNo ? ` (${session.bankAccountNo})` : ""}
          </h1>
          <p>
            Period {session.periodStart} to {session.periodEnd} &middot;{" "}
            <span className={`brc-status-badge ${session.status.toLowerCase()}`}>
              {session.status === "IN_PROGRESS" ? "In Progress" : "Finalized"}
            </span>
          </p>
        </div>

        <button onClick={() => navigate("/reports/bank-reconciliation")} className="brc-btn">
          Back to Sessions
        </button>
      </div>

      <div className="brc-card">
        <h2>Session Settings</h2>

        <div className="brc-grid">
          <div>
            <label>Period Start</label>
            <input
              type="date"
              value={form.periodStart}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
            />
          </div>

          <div>
            <label>Period End</label>
            <input
              type="date"
              value={form.periodEnd}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
            />
          </div>

          <div>
            <label>Date Tolerance (days)</label>
            <input
              type="number"
              min="0"
              value={form.dateToleranceDays}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, dateToleranceDays: e.target.value })}
            />
          </div>

          <div>
            <label>Statement Beginning Balance</label>
            <input
              type="number"
              step="0.01"
              value={form.statementBeginningBalance}
              disabled={isFinalized}
              onChange={(e) =>
                setForm({ ...form, statementBeginningBalance: e.target.value })
              }
            />
          </div>

          <div>
            <label>Statement Ending Balance</label>
            <input
              type="number"
              step="0.01"
              value={form.statementEndingBalance}
              disabled={isFinalized}
              onChange={(e) =>
                setForm({ ...form, statementEndingBalance: e.target.value })
              }
            />
          </div>

          <div>
            <label>Amount Variance Type</label>
            <select
              value={form.amountVarianceType}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, amountVarianceType: e.target.value })}
            >
              <option value="FIXED">Fixed (₱)</option>
              <option value="PERCENT">Percent (%)</option>
            </select>
          </div>

          <div>
            <label>
              Amount Variance Value
              {form.amountVarianceType === "PERCENT" ? " (%)" : " (₱)"}
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.amountVarianceValue}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, amountVarianceValue: e.target.value })}
            />
          </div>

          <div className="brc-grid-full">
            <label>Notes</label>
            <input
              value={form.notes}
              disabled={isFinalized}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>

        {!isFinalized && (
          <div className="brc-actions">
            <button onClick={saveSettings} className="brc-btn primary" disabled={saving}>
              {saving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        )}
      </div>

      <div className="brc-card">
        <h2>Reconciliation Workflow</h2>
        <p style={{ color: "#64748b" }}>
          Statement import, matching, adjustments, and finalization are being rolled out
          in upcoming phases of this module. This session's balances (
          <strong>₱ {formatMoney(session.statementBeginningBalance)}</strong> to{" "}
          <strong>₱ {formatMoney(session.statementEndingBalance)}</strong>) are recorded
          and ready for those steps once available.
        </p>
      </div>
    </div>
  );
}
