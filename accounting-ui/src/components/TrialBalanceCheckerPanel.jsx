import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./TrialBalanceCheckerPanel.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Same deep-link convention AccountAnalysis.jsx uses (?id= query string,
// auto-opened by TransactionFormLayout.jsx on mount) - extended to include
// JV, which AccountAnalysis's own SOURCE_ROUTES doesn't cover today.
const SOURCE_ROUTES = {
  APV: "/transactions/apv",
  CV: "/transactions/cv",
  JV: "/transactions/jv",
  INV: "/transactions/invoice",
  OR: "/transactions/or",
};

const CATEGORY_LABELS = {
  UNBALANCED_TRANSACTIONS: "Unbalanced Transactions",
  HEADER_LINE_MISMATCH: "Header and Line Total Mismatches",
  INVALID_ACCOUNTS: "Invalid or Missing Accounts",
  ORPHANED_RECORDS: "Orphaned Records",
  DUPLICATE_POSTINGS: "Duplicate Postings",
  BEGINNING_BALANCE_ISSUES: "Beginning Balance Issues",
  DATE_PERIOD_ISSUES: "Date and Period Issues",
  ROUNDING_DIFFERENCES: "Rounding Differences",
  OTHER_SUSPICIOUS: "Other Suspicious Records",
};

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, ROUNDING_ONLY: 4 };

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function TrialBalanceCheckerPanel({ open, from, to, tolerance, onClose }) {
  const navigate = useNavigate();

  const [status, setStatus] = useState(null);
  const [runResult, setRunResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("severity");
  const [sortDir, setSortDir] = useState("asc");

  const [investigatedNoteFor, setInvestigatedNoteFor] = useState(null);
  const [investigatedNote, setInvestigatedNote] = useState("");
  const [draftFor, setDraftFor] = useState(null);
  const [draftForm, setDraftForm] = useState(null);
  const [draftSubmitting, setDraftSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRunResult(null);
    setCheckError("");
    setSearch("");
    setCategoryFilter("ALL");
    setSeverityFilter("ALL");
    loadStatus();
  }, [open, from, to, tolerance]);

  if (!open) return null;

  async function loadStatus() {
    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance-checker/status?from=${from}&to=${to}&tolerance=${tolerance}`,
        { credentials: "include", headers: authHeaders() }
      );
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch (err) {
      console.error("LOAD TB CHECKER STATUS ERROR:", err);
    }
  }

  async function runCheck() {
    if (checking) return;
    setChecking(true);
    setCheckError("");

    try {
      const res = await fetch(`${API_URL}/api/reports/trial-balance-checker/check`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ from, to, tolerance }),
      });

      const data = await res.json();

      if (!res.ok) {
        setCheckError(data.message || "Failed to run the checker");
        return;
      }

      setRunResult(data);
    } catch (err) {
      console.error("RUN TB CHECK ERROR:", err);
      setCheckError("Unable to connect to server.");
    } finally {
      setChecking(false);
    }
  }

  function viewTransaction(finding) {
    const route = SOURCE_ROUTES[finding.source_module];
    if (!route) {
      alert(`No viewer available for source module "${finding.source_module}".`);
      return;
    }
    navigate(`${route}?id=${finding.transaction_id}`);
  }

  async function submitInvestigated(findingId) {
    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance-checker/findings/${findingId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ investigated: true, note: investigatedNote }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to mark as investigated");
        return;
      }

      setRunResult((prev) => ({
        ...prev,
        findings: prev.findings.map((f) =>
          f.id === findingId ? { ...f, investigated: true, investigated_note: investigatedNote } : f
        ),
      }));
      setInvestigatedNoteFor(null);
      setInvestigatedNote("");
    } catch (err) {
      console.error("MARK INVESTIGATED ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

  function openDraftForm(finding) {
    setDraftFor(finding.id);
    setDraftForm({
      debitAccountCode: finding.account_code || "",
      creditAccountCode: "",
      amount: finding.line_difference || finding.debit || finding.credit || "0.00",
      explanation: `Adjustment draft for ${CATEGORY_LABELS[finding.category] || finding.category} - ${finding.reason || ""}`,
    });
  }

  async function submitDraft(findingId) {
    if (draftSubmitting) return;
    setDraftSubmitting(true);

    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance-checker/findings/${findingId}/adjustment-draft`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(draftForm),
        }
      );
      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to create adjustment draft");
        return;
      }

      alert(`Draft Journal Voucher ${data.voucherNo || ""} created (status: Draft). Review and post it from the JV module when ready.`);

      setRunResult((prev) => ({
        ...prev,
        findings: prev.findings.map((f) =>
          f.id === findingId ? { ...f, adjustment_jv_id: data.jvId } : f
        ),
      }));
      setDraftFor(null);
      setDraftForm(null);
    } catch (err) {
      console.error("CREATE ADJUSTMENT DRAFT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setDraftSubmitting(false);
    }
  }

  async function exportFindings() {
    if (!runResult?.runId) return;
    try {
      const res = await fetch(
        `${API_URL}/api/reports/trial-balance-checker/runs/${runResult.runId}/export?format=csv`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!res.ok) {
        alert("Failed to export findings");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Trial_Balance_Checker_Run_${runResult.runId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("EXPORT TB FINDINGS ERROR:", err);
      alert("Unable to export findings.");
    }
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const filteredFindings = useMemo(() => {
    if (!runResult?.findings) return [];
    const q = search.trim().toLowerCase();

    let rows = runResult.findings.filter((f) => {
      if (categoryFilter !== "ALL" && f.category !== categoryFilter) return false;
      if (severityFilter !== "ALL" && f.severity !== severityFilter) return false;
      if (!q) return true;
      return [
        f.source_module,
        f.transaction_number,
        f.reference_no,
        f.account_code,
        f.account_title,
        f.reason,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    rows = [...rows].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];

      if (sortKey === "severity") {
        av = SEVERITY_ORDER[a.severity] ?? 99;
        bv = SEVERITY_ORDER[b.severity] ?? 99;
      } else if (sortKey === "debit" || sortKey === "credit") {
        av = Number(av || 0);
        bv = Number(bv || 0);
      } else {
        av = String(av || "");
        bv = String(bv || "");
      }

      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }, [runResult, search, categoryFilter, severityFilter, sortKey, sortDir]);

  const categoriesPresent = useMemo(() => {
    if (!runResult?.findings) return [];
    return [...new Set(runResult.findings.map((f) => f.category))];
  }, [runResult]);

  return (
    <div className="tbcp-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tbcp-modal" role="dialog" aria-modal="true" aria-label="Unbalanced Trial Balance Checker">
        <div className="tbcp-header">
          <h2>Unbalanced Trial Balance Checker</h2>
          <button type="button" className="tbcp-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="tbcp-body">
          <div className="tbcp-summary-grid">
            <div className="tbcp-summary-item">
              <div className="label">Total Debit</div>
              <div className="value">₱ {formatMoney(status?.totalDebit)}</div>
            </div>
            <div className="tbcp-summary-item">
              <div className="label">Total Credit</div>
              <div className="value">₱ {formatMoney(status?.totalCredit)}</div>
            </div>
            <div className={`tbcp-summary-item ${status?.status === "UNBALANCED" ? "danger" : "success"}`}>
              <div className="label">Difference</div>
              <div className="value">₱ {formatMoney(Math.abs(Number(status?.difference || 0)))}</div>
            </div>
            <div className="tbcp-summary-item">
              <div className="label">Findings</div>
              <div className="value">{runResult?.findings?.length ?? "-"}</div>
            </div>
          </div>

          {checkError && <div className="tbcp-error-banner">{checkError}</div>}

          {!runResult && (
            <p className="tbcp-muted">
              This will inspect General Journal, AP Voucher, Check Voucher, and Beginning Balance
              records for the selected period and report every finding that could be contributing
              to the difference above.
            </p>
          )}

          {runResult && runResult.findings.length === 0 && (
            <div className="tbcp-success-banner">
              No findings were detected for this period. If a difference still remains, it may
              originate outside the modules this checker inspects.
            </div>
          )}

          {runResult && runResult.findings.length > 0 && (
            <>
              <div className="tbcp-toolbar">
                <input
                  type="text"
                  className="tbcp-search-input"
                  placeholder="Search by module, transaction no., account, reason..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  className="tbcp-select"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="ALL">All Categories</option>
                  {categoriesPresent.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c] || c}
                    </option>
                  ))}
                </select>
                <select
                  className="tbcp-select"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                >
                  <option value="ALL">All Severities</option>
                  <option value="CRITICAL">Critical</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                  <option value="ROUNDING_ONLY">Rounding Only</option>
                </select>
                <button type="button" className="tbcp-link-btn" onClick={exportFindings}>
                  Export Findings
                </button>
              </div>

              <div className="tbcp-table-wrap">
                <table className="tbcp-table">
                  <thead>
                    <tr>
                      <th onClick={() => toggleSort("severity")}>Severity</th>
                      <th onClick={() => toggleSort("category")}>Category</th>
                      <th onClick={() => toggleSort("source_module")}>Module</th>
                      <th onClick={() => toggleSort("transaction_number")}>Txn No.</th>
                      <th onClick={() => toggleSort("transaction_date")}>Date</th>
                      <th onClick={() => toggleSort("account_code")}>Account</th>
                      <th className="amount" onClick={() => toggleSort("debit")}>Debit</th>
                      <th className="amount" onClick={() => toggleSort("credit")}>Credit</th>
                      <th>Reason</th>
                      <th>Recommended Action</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFindings.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <span className={`tbcp-badge tbcp-badge-${f.severity.toLowerCase()}`}>
                            {f.severity.replace("_", " ")}
                          </span>
                          {f.investigated ? (
                            <div>
                              <span className="tbcp-badge tbcp-badge-investigated">Investigated</span>
                            </div>
                          ) : null}
                        </td>
                        <td>{CATEGORY_LABELS[f.category] || f.category}</td>
                        <td>{f.source_module}</td>
                        <td>{f.transaction_number}</td>
                        <td>{f.transaction_date}</td>
                        <td>
                          {f.account_code} {f.account_title ? `- ${f.account_title}` : ""}
                        </td>
                        <td className="amount">{f.debit ? formatMoney(f.debit) : ""}</td>
                        <td className="amount">{f.credit ? formatMoney(f.credit) : ""}</td>
                        <td>{f.reason}</td>
                        <td>{f.recommended_action}</td>
                        <td>
                          <div className="tbcp-row-actions">
                            {f.transaction_id && SOURCE_ROUTES[f.source_module] && (
                              <button type="button" className="tbcp-link-btn" onClick={() => viewTransaction(f)}>
                                View Transaction
                              </button>
                            )}
                            {!f.investigated && investigatedNoteFor !== f.id && (
                              <button
                                type="button"
                                className="tbcp-link-btn"
                                onClick={() => {
                                  setInvestigatedNoteFor(f.id);
                                  setInvestigatedNote("");
                                }}
                              >
                                Mark as Investigated
                              </button>
                            )}
                            {investigatedNoteFor === f.id && (
                              <div>
                                <input
                                  type="text"
                                  placeholder="Note (optional)"
                                  value={investigatedNote}
                                  onChange={(e) => setInvestigatedNote(e.target.value)}
                                  style={{ width: "100%", marginBottom: 4 }}
                                />
                                <button type="button" className="tbcp-link-btn" onClick={() => submitInvestigated(f.id)}>
                                  Save
                                </button>
                              </div>
                            )}
                            {!f.adjustment_jv_id && draftFor !== f.id && (
                              <button type="button" className="tbcp-link-btn" onClick={() => openDraftForm(f)}>
                                Create Adjustment Draft
                              </button>
                            )}
                            {f.adjustment_jv_id && <span className="tbcp-muted">Draft created</span>}
                            {draftFor === f.id && draftForm && (
                              <div>
                                <input
                                  type="text"
                                  placeholder="Debit account code"
                                  value={draftForm.debitAccountCode}
                                  onChange={(e) => setDraftForm({ ...draftForm, debitAccountCode: e.target.value })}
                                  style={{ width: "100%", marginBottom: 4 }}
                                />
                                <input
                                  type="text"
                                  placeholder="Credit account code"
                                  value={draftForm.creditAccountCode}
                                  onChange={(e) => setDraftForm({ ...draftForm, creditAccountCode: e.target.value })}
                                  style={{ width: "100%", marginBottom: 4 }}
                                />
                                <input
                                  type="number"
                                  placeholder="Amount"
                                  value={draftForm.amount}
                                  onChange={(e) => setDraftForm({ ...draftForm, amount: e.target.value })}
                                  style={{ width: "100%", marginBottom: 4 }}
                                />
                                <textarea
                                  placeholder="Explanation"
                                  value={draftForm.explanation}
                                  onChange={(e) => setDraftForm({ ...draftForm, explanation: e.target.value })}
                                  style={{ width: "100%", marginBottom: 4 }}
                                />
                                <button
                                  type="button"
                                  className="tbcp-link-btn"
                                  disabled={draftSubmitting}
                                  onClick={() => submitDraft(f.id)}
                                >
                                  {draftSubmitting ? "Submitting..." : "Submit Draft"}
                                </button>{" "}
                                <button type="button" className="tbcp-link-btn" onClick={() => setDraftFor(null)}>
                                  Cancel
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="tbcp-footer">
          <span className="tbcp-muted">
            Period: {from} to {to} · Tolerance: ₱{tolerance}
          </span>
          <div className="tbcp-footer-right">
            <button type="button" className="tbcp-btn-secondary" onClick={onClose}>
              Close
            </button>
            <button type="button" className="tbcp-btn-primary" onClick={runCheck} disabled={checking}>
              {checking ? "Checking..." : runResult ? "Re-run Check" : "Run Full Check"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
