import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Renders the same computeSessionSummary() shape the manual workspace and
// the AI providers both consume - no new report logic, just a display of
// data that already came back from the deterministic matching engine.
export default function BankReconResults({ sessionId }) {
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setSummary(null);
      return;
    }
    loadSession();
  }, [sessionId]);

  async function loadSession() {
    setLoading(true);
    try {
      const [sessionRes, summaryRes] = await Promise.all([
        fetch(`${API_BASE}/api/bank-recon/sessions/${sessionId}`, {
          credentials: "include",
          headers: authHeaders(),
        }),
        fetch(`${API_BASE}/api/bank-recon/sessions/${sessionId}/summary`, {
          credentials: "include",
          headers: authHeaders(),
        }),
      ]);

      const sessionData = await sessionRes.json();
      const summaryData = await summaryRes.json();

      if (!sessionRes.ok) {
        if (handleAuthError(sessionRes.status)) return;
      } else {
        setSession(sessionData);
      }

      if (!summaryRes.ok) {
        if (handleAuthError(summaryRes.status)) return;
      } else {
        setSummary(summaryData);
      }
    } catch (err) {
      console.error("LOAD AI RECON RESULTS ERROR:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="air-card air-results">
      <h2>Reconciliation Results</h2>

      {!sessionId && (
        <div className="air-results-empty">
          Ask the assistant to generate a reconciliation to see structured results here.
        </div>
      )}

      {sessionId && loading && !summary && (
        <div className="air-results-empty">Loading session #{sessionId}...</div>
      )}

      {sessionId && session && summary && (
        <>
          <div className="air-results-heading">
            <div>
              <div className="bank-label">
                {session.bankCode} - {session.bankName}
                {session.bankAccountNo ? ` (${session.bankAccountNo})` : ""}
              </div>
              <div className="period-label">
                Session #{session.id} - {session.periodStart} to {session.periodEnd}
              </div>
            </div>
            <button className="air-view-workspace" onClick={() => navigate(`/reports/bank-reconciliation/${session.id}`)}>
              View in Workspace
            </button>
          </div>

          <div className={`air-status-line ${summary.canFinalizeCleanly ? "balanced" : "unbalanced"}`}>
            {summary.canFinalizeCleanly
              ? "Balanced - ready to finalize (from the workspace)."
              : `Not balanced - ${summary.pendingAdjustmentsCount} pending adjustment(s), ${summary.unresolvedStatementLinesCount} unresolved statement line(s).`}
          </div>

          <div className="air-summary-grid">
            <div className="air-summary-item">
              <div className="label">Statement Ending Balance</div>
              <div className="value">₱ {formatMoney(summary.statementEndingBalance)}</div>
            </div>
            <div className="air-summary-item">
              <div className="label">Book Balance</div>
              <div className="value">₱ {formatMoney(summary.bookBalance)}</div>
            </div>
            <div className="air-summary-item">
              <div className="label">Outstanding Checks ({summary.outstandingChecks.length})</div>
              <div className="value">₱ {formatMoney(summary.outstandingChecksTotal)}</div>
            </div>
            <div className="air-summary-item">
              <div className="label">Deposits in Transit ({summary.depositsInTransit.length})</div>
              <div className="value">₱ {formatMoney(summary.depositsInTransitTotal)}</div>
            </div>
            <div className="air-summary-item">
              <div className="label">Adjusted Bank Balance</div>
              <div className="value">₱ {formatMoney(summary.adjustedBank)}</div>
            </div>
            <div className="air-summary-item">
              <div className="label">Difference</div>
              <div className="value">₱ {formatMoney(summary.difference)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
