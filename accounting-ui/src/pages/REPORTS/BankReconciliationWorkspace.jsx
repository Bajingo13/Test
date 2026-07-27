import { Fragment, useEffect, useState } from "react";
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

const MAPPING_FIELDS = [
  { key: "date", label: "Date", required: true },
  { key: "description", label: "Description" },
  { key: "referenceNo", label: "Reference No." },
  { key: "checkNo", label: "Check No." },
  { key: "debit", label: "Debit" },
  { key: "credit", label: "Credit" },
  { key: "amount", label: "Amount (single signed column)" },
  { key: "runningBalance", label: "Running Balance" },
];

export default function BankReconciliationWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [session, setSession] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const [importBatches, setImportBatches] = useState([]);
  const [statementLines, setStatementLines] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [mappingHeaders, setMappingHeaders] = useState(null);
  const [mappingSelections, setMappingSelections] = useState({});

  const [runningMatching, setRunningMatching] = useState(false);
  const [expandedLineId, setExpandedLineId] = useState(null);
  const [candidatesByLine, setCandidatesByLine] = useState({});
  const [bookItems, setBookItems] = useState([]);

  useEffect(() => {
    loadSession();
    loadImportBatches();
    loadStatementLines();
    loadBookItems();
  }, [id]);

  async function loadBookItems() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/book-items`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setBookItems(data);
    } catch (err) {
      console.error("LOAD BOOK ITEMS ERROR:", err);
    }
  }

  async function runMatching() {
    setRunningMatching(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/run-matching`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to run matching.");
        return;
      }

      alert(data.message);
      setExpandedLineId(null);
      setCandidatesByLine({});
      await loadStatementLines();
      await loadBookItems();
    } catch (err) {
      console.error("RUN MATCHING ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setRunningMatching(false);
    }
  }

  async function toggleCandidates(lineId) {
    if (expandedLineId === lineId) {
      setExpandedLineId(null);
      return;
    }

    setExpandedLineId(lineId);

    if (candidatesByLine[lineId]) return;

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/statement-lines/${lineId}/candidates`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setCandidatesByLine((prev) => ({ ...prev, [lineId]: data }));
    } catch (err) {
      console.error("LOAD MATCH CANDIDATES ERROR:", err);
    }
  }

  async function loadImportBatches() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/import-batches`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setImportBatches(data);
    } catch (err) {
      console.error("LOAD IMPORT BATCHES ERROR:", err);
    }
  }

  async function loadStatementLines() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/statement-lines`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setStatementLines(data);
    } catch (err) {
      console.error("LOAD STATEMENT LINES ERROR:", err);
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0] || null;
    setPendingFile(file);
    setMappingHeaders(null);
    setMappingSelections({});
  }

  async function performImport(file, columnMapping) {
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (columnMapping) {
        formData.append("columnMapping", JSON.stringify(columnMapping));
      }

      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/import`, {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;

        if (data.headers) {
          setMappingHeaders(data.headers);
          alert(data.message || "Please map the statement columns below and try again.");
          return;
        }

        alert(data.message || "Failed to import statement.");
        return;
      }

      let message = data.message || "Statement imported.";
      if (data.skippedRows?.length) {
        message += `\n\nSkipped rows:\n${data.skippedRows
          .map((r) => `Row ${r.row}: ${r.reason}`)
          .join("\n")}`;
      }
      alert(message);

      setPendingFile(null);
      setMappingHeaders(null);
      setMappingSelections({});
      await loadImportBatches();
      await loadStatementLines();
    } catch (err) {
      console.error("IMPORT BANK STATEMENT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setUploading(false);
    }
  }

  function handleUploadClick() {
    if (!pendingFile) return alert("Choose a CSV or Excel file first.");
    performImport(pendingFile, null);
  }

  function handleMappingSubmit() {
    if (!mappingSelections.date) {
      return alert("Date column is required.");
    }
    if (!mappingSelections.debit && !mappingSelections.credit && !mappingSelections.amount) {
      return alert("Map at least a Debit/Credit pair or a single Amount column.");
    }

    performImport(pendingFile, mappingSelections);
  }

  async function deleteBatch(batchId) {
    if (!confirm("Delete this import batch and all its statement lines?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/import-batches/${batchId}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete import batch.");
        return;
      }

      await loadImportBatches();
      await loadStatementLines();
    } catch (err) {
      console.error("DELETE IMPORT BATCH ERROR:", err);
      alert("Unable to connect to server.");
    }
  }

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

      {!isFinalized && (
        <div className="brc-card">
          <h2>Import Bank Statement</h2>

          <div className="brc-import-row">
            <input
              type="file"
              accept=".csv,.xls,.xlsx"
              onChange={handleFileChange}
              disabled={uploading}
            />
            <button
              onClick={handleUploadClick}
              className="brc-btn primary"
              disabled={uploading || !pendingFile}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </div>

          {mappingHeaders && (
            <div className="brc-mapping-box">
              <h3>Map Columns</h3>
              <p style={{ color: "#64748b", marginTop: 0 }}>
                We couldn't automatically detect all required columns. Match each field to a
                column from your file.
              </p>

              <div className="brc-grid">
                {MAPPING_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label>
                      {field.label}
                      {field.required ? " *" : ""}
                    </label>
                    <select
                      value={mappingSelections[field.key] || ""}
                      onChange={(e) =>
                        setMappingSelections({
                          ...mappingSelections,
                          [field.key]: e.target.value,
                        })
                      }
                    >
                      <option value="">-- none --</option>
                      {mappingHeaders.map((h, idx) => (
                        <option key={idx} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="brc-actions">
                <button onClick={() => setMappingHeaders(null)}>Cancel</button>
                <button
                  onClick={handleMappingSubmit}
                  className="brc-btn primary"
                  disabled={uploading}
                >
                  {uploading ? "Importing..." : "Import with This Mapping"}
                </button>
              </div>
            </div>
          )}

          <h3>Import Batches</h3>
          <div className="brc-table-wrap">
            <table className="brc-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Rows</th>
                  <th>Imported At</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {importBatches.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="brc-empty">
                      No statements imported yet.
                    </td>
                  </tr>
                ) : (
                  importBatches.map((b) => (
                    <tr key={b.id}>
                      <td>{b.fileName}</td>
                      <td>{b.fileType}</td>
                      <td>{b.rowCount}</td>
                      <td>{new Date(b.importedAt).toLocaleString("en-PH")}</td>
                      <td>{b.status}</td>
                      <td>
                        <button onClick={() => deleteBatch(b.id)} className="danger">
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="brc-card">
        <div className="brc-import-row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Statement Lines ({statementLines.length})</h2>
          {!isFinalized && (
            <button onClick={runMatching} className="brc-btn primary" disabled={runningMatching}>
              {runningMatching ? "Running Matching..." : "Run Matching"}
            </button>
          )}
        </div>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Reference</th>
                <th>Check No.</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {statementLines.length === 0 ? (
                <tr>
                  <td colSpan="8" className="brc-empty">
                    No statement lines yet. Import a bank statement above.
                  </td>
                </tr>
              ) : (
                statementLines.map((line) => (
                  <Fragment key={line.id}>
                    <tr>
                      <td>{line.txnDate}</td>
                      <td>{line.description}</td>
                      <td>{line.referenceNo}</td>
                      <td>{line.checkNo}</td>
                      <td className="amount">₱ {formatMoney(line.debit)}</td>
                      <td className="amount">₱ {formatMoney(line.credit)}</td>
                      <td>
                        <span className={`brc-match-badge ${line.matchStatus.toLowerCase()}`}>
                          {line.matchStatus}
                        </span>
                      </td>
                      <td>
                        {line.matchStatus === "SUGGESTED" && (
                          <button onClick={() => toggleCandidates(line.id)}>
                            {expandedLineId === line.id ? "Hide" : "View"} Matches
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedLineId === line.id && (
                      <tr>
                        <td colSpan="8" style={{ background: "#f8fafc" }}>
                          {!candidatesByLine[line.id] ? (
                            "Loading candidates..."
                          ) : candidatesByLine[line.id].length === 0 ? (
                            "No candidates found."
                          ) : (
                            <table className="brc-table" style={{ minWidth: "auto" }}>
                              <thead>
                                <tr>
                                  <th>Type</th>
                                  <th>Source</th>
                                  <th>Voucher No.</th>
                                  <th>Payee/Customer</th>
                                  <th>Date</th>
                                  <th>Amount</th>
                                  <th>Score</th>
                                </tr>
                              </thead>
                              <tbody>
                                {candidatesByLine[line.id].map((c) => (
                                  <tr key={c.id}>
                                    <td>{c.matchType}</td>
                                    <td>{c.bookSourceType}</td>
                                    <td>{c.detail?.voucherNo}</td>
                                    <td>
                                      {c.detail?.payeeName ||
                                        c.detail?.customerName ||
                                        c.detail?.preparedFor}
                                    </td>
                                    <td>{c.detail?.txnDate}</td>
                                    <td className="amount">₱ {formatMoney(c.amount)}</td>
                                    <td>{c.confidenceScore}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="brc-card">
        <h2>Unmatched Book Items ({bookItems.length})</h2>
        <p style={{ color: "#64748b", marginTop: 0 }}>
          CV, OR, and posted JV entries touching this bank account that have no confirmed
          match yet.
        </p>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Voucher No.</th>
                <th>Payee/Customer</th>
                <th>Date</th>
                <th>Direction</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {bookItems.length === 0 ? (
                <tr>
                  <td colSpan="6" className="brc-empty">
                    No unmatched book items for this bank account/period.
                  </td>
                </tr>
              ) : (
                bookItems.map((item) => (
                  <tr key={`${item.sourceType}-${item.sourceId}-${item.lineId || 0}`}>
                    <td>{item.sourceType}</td>
                    <td>{item.voucherNo}</td>
                    <td>{item.payeeOrCustomer}</td>
                    <td>{item.date}</td>
                    <td>{item.direction === "OUT" ? "Money Out" : "Money In"}</td>
                    <td className="amount">₱ {formatMoney(item.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="brc-card">
        <h2>Reconciliation Workflow</h2>
        <p style={{ color: "#64748b" }}>
          Match confirmation, adjustments, and finalization are being rolled out in upcoming
          phases of this module. This session's statement balances (
          <strong>₱ {formatMoney(session.statementBeginningBalance)}</strong> to{" "}
          <strong>₱ {formatMoney(session.statementEndingBalance)}</strong>) are recorded and
          ready for those steps once available.
        </p>
      </div>
    </div>
  );
}
