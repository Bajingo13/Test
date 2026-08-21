import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./BankReconciliation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function todayIso() {
  return new Date().toISOString().split("T")[0];
}

function emptySessionForm() {
  return {
    bankAccountId: "",
    periodStart: todayIso(),
    periodEnd: todayIso(),
    statementBeginningBalance: "",
    statementEndingBalance: "",
    dateToleranceDays: 3,
    amountVarianceType: "FIXED",
    amountVarianceValue: 1,
    notes: "",
  };
}

export default function BankReconciliation() {
  const navigate = useNavigate();

  const [sessions, setSessions] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showNewForm, setShowNewForm] = useState(false);
  const [form, setForm] = useState(emptySessionForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSessions();
    loadBankAccounts();
  }, []);

  async function loadSessions() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load reconciliation sessions");
        return;
      }

      setSessions(data);
    } catch (err) {
      console.error("LOAD BANK RECON SESSIONS ERROR:", err);
    }
  }

  async function loadBankAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setBankAccounts(data.filter((b) => b.status === "ACTIVE"));
    } catch (err) {
      console.error("LOAD BANK CODES ERROR:", err);
    }
  }

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();

    return sessions.filter((s) => {
      const matchesSearch =
        !q ||
        [s.bankName, s.bankCode, s.bankAccountNo, s.notes]
          .join(" ")
          .toLowerCase()
          .includes(q);

      const matchesStatus = statusFilter === "All" || s.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [sessions, search, statusFilter]);

  function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function openNewForm() {
    setForm(emptySessionForm());
    setShowNewForm(true);
  }

  async function createSession() {
    if (!form.bankAccountId) return alert("Bank account is required.");
    if (!form.periodStart || !form.periodEnd) {
      return alert("Period start and end are required.");
    }
    if (new Date(form.periodEnd) < new Date(form.periodStart)) {
      return alert("Period end cannot be before period start.");
    }

    setSaving(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions`, {
        method: "POST",
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
        alert(data.message || "Failed to create reconciliation session.");
        return;
      }

      setShowNewForm(false);
      navigate(`/reports/bank-reconciliation/${data.id}`);
    } catch (err) {
      console.error("CREATE BANK RECON SESSION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="brc-page">
      <div className="brc-header-card">
        <div>
          <h1>Bank Reconciliation</h1>
          <p>Reconcile bank statements against CV, OR, Invoice, and JV records.</p>
        </div>

        <button onClick={openNewForm} className="brc-btn primary">
          + New Session
        </button>
      </div>

      {showNewForm && (
        <div className="brc-card">
          <h2>New Reconciliation Session</h2>

          <div className="brc-grid">
            <div>
              <label>Bank Account</label>
              <select
                value={form.bankAccountId}
                onChange={(e) => setForm({ ...form, bankAccountId: e.target.value })}
              >
                <option value="">Select bank account</option>
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bankCode} - {b.bankName}
                    {b.accountNo ? ` (${b.accountNo})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label>Period Start</label>
              <input
                type="date"
                value={form.periodStart}
                onChange={(e) => setForm({ ...form, periodStart: e.target.value })}
              />
            </div>

            <div>
              <label>Period End</label>
              <input
                type="date"
                value={form.periodEnd}
                onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}
              />
            </div>

            <div>
              <label>Statement Beginning Balance</label>
              <input
                type="number"
                step="0.01"
                value={form.statementBeginningBalance}
                onChange={(e) =>
                  setForm({ ...form, statementBeginningBalance: e.target.value })
                }
                placeholder="0.00"
              />
            </div>

            <div>
              <label>Statement Ending Balance</label>
              <input
                type="number"
                step="0.01"
                value={form.statementEndingBalance}
                onChange={(e) =>
                  setForm({ ...form, statementEndingBalance: e.target.value })
                }
                placeholder="0.00"
              />
            </div>

            <div>
              <label>Date Tolerance (days)</label>
              <input
                type="number"
                min="0"
                value={form.dateToleranceDays}
                onChange={(e) =>
                  setForm({ ...form, dateToleranceDays: e.target.value })
                }
              />
            </div>

            <div>
              <label>Amount Variance Type</label>
              <select
                value={form.amountVarianceType}
                onChange={(e) =>
                  setForm({ ...form, amountVarianceType: e.target.value })
                }
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
                onChange={(e) =>
                  setForm({ ...form, amountVarianceValue: e.target.value })
                }
              />
            </div>

            <div className="brc-grid-full">
              <label>Notes</label>
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="brc-actions">
            <button onClick={() => setShowNewForm(false)}>Cancel</button>
            <button onClick={createSession} className="brc-btn primary" disabled={saving}>
              {saving ? "Creating..." : "Create Session"}
            </button>
          </div>
        </div>
      )}

      <div className="brc-card">
        <h2>Reconciliation Sessions</h2>

        <div className="brc-list-toolbar">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search bank, account no., or notes..."
            className="brc-search-input"
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="brc-status-select"
          >
            <option value="All">All Statuses</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="FINALIZED">Finalized</option>
          </select>
        </div>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Bank Account</th>
                <th>Period</th>
                <th>Statement Beginning</th>
                <th>Statement Ending</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {filteredSessions.length === 0 ? (
                <tr>
                  <td colSpan="6" className="brc-empty">
                    {sessions.length === 0
                      ? "No reconciliation sessions yet."
                      : "No sessions match your search/filter."}
                  </td>
                </tr>
              ) : (
                filteredSessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.bankCode} - {s.bankName}
                      {s.bankAccountNo ? ` (${s.bankAccountNo})` : ""}
                    </td>
                    <td>
                      {s.periodStart} to {s.periodEnd}
                    </td>
                    <td className="amount">₱ {formatMoney(s.statementBeginningBalance)}</td>
                    <td className="amount">₱ {formatMoney(s.statementEndingBalance)}</td>
                    <td>
                      <span className={`brc-status-badge ${s.status.toLowerCase()}`}>
                        {s.status === "IN_PROGRESS" ? "In Progress" : "Finalized"}
                      </span>
                    </td>
                    <td>
                      <button onClick={() => navigate(`/reports/bank-reconciliation/${s.id}`)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
