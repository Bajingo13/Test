import { useEffect, useRef, useState } from "react";
import "./BeginningBalanceImportModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const MODULE_LABELS = { gl: "GL", ar: "AR", ap: "AP" };

// GL rows are debit/credit lines against one account; AR/AP rows are party
// documents (customer/supplier + amounts) - different enough that the
// preview table needs different columns per module rather than one
// GL-shaped table with blank cells for AR/AP.
const PREVIEW_COLUMNS = {
  gl: [
    { header: "Account", render: (d) => d?.accountCode },
    { header: "Date", render: (d) => d?.balanceDate },
    { header: "Debit", render: (d) => (d?.debit ? formatMoney(d.debit) : ""), amount: true },
    { header: "Credit", render: (d) => (d?.credit ? formatMoney(d.credit) : ""), amount: true },
  ],
  ar: [
    { header: "Customer", render: (d) => (d?.partyCode ? `${d.partyCode} - ${d.partyName || ""}` : "") },
    { header: "Account", render: (d) => d?.accountCode },
    { header: "Doc No.", render: (d) => d?.documentNumber },
    { header: "Balance Date", render: (d) => d?.balanceDate },
    { header: "Due Date", render: (d) => d?.dueDate },
    { header: "Original", render: (d) => (d?.originalAmount ? formatMoney(d.originalAmount) : ""), amount: true },
    { header: "Balance", render: (d) => (d?.balanceAmount ? formatMoney(d.balanceAmount) : ""), amount: true },
  ],
  ap: [
    { header: "Supplier", render: (d) => (d?.partyCode ? `${d.partyCode} - ${d.partyName || ""}` : "") },
    { header: "Account", render: (d) => d?.accountCode },
    { header: "Doc No.", render: (d) => d?.documentNumber },
    { header: "Balance Date", render: (d) => d?.balanceDate },
    { header: "Due Date", render: (d) => d?.dueDate },
    { header: "Original", render: (d) => (d?.originalAmount ? formatMoney(d.originalAmount) : ""), amount: true },
    { header: "Balance", render: (d) => (d?.balanceAmount ? formatMoney(d.balanceAmount) : ""), amount: true },
  ],
};

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Generate Template + Import for Beginning Balances - a two-step
// preview-then-commit flow. Preview parses+validates the file and stages
// it server-side (nothing saved yet); commit only ever sends the batchId
// back, never row data, so what gets saved is exactly what was previewed
// and then re-validated fresh at commit time. One component, parameterized
// by `module` ("gl" | "ar" | "ap"), reused by every Beginning Balance page.
export default function BeginningBalanceImportModal({ open, module, onClose, onImported }) {
  const [step, setStep] = useState("upload");
  const [file, setFile] = useState(null);
  const [duplicateMode, setDuplicateMode] = useState("REJECT");
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [commitResult, setCommitResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const fileInputRef = useRef(null);
  const closeButtonRef = useRef(null);

  const moduleLabel = MODULE_LABELS[module] || module?.toUpperCase();
  const previewColumns = PREVIEW_COLUMNS[module] || PREVIEW_COLUMNS.gl;

  useEffect(() => {
    if (open) {
      setStep("upload");
      setFile(null);
      setDuplicateMode("REJECT");
      setPreviewResult(null);
      setPreviewError("");
      setCommitError("");
      setCommitResult(null);
      setHistory([]);
      setHistoryError("");
      setTimeout(() => closeButtonRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function downloadTemplate(format) {
    try {
      const res = await fetch(
        `${API_BASE}/api/beginning-balances/${module}/template?format=${format}`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!res.ok) {
        alert("Failed to generate template");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${moduleLabel}_Beginning_Balance_Template.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOWNLOAD BB TEMPLATE ERROR:", err);
      alert("Unable to download template.");
    }
  }

  async function handlePreview() {
    if (!file || previewing) return;

    setPreviewing(true);
    setPreviewError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("duplicateMode", duplicateMode);

      const res = await fetch(`${API_BASE}/api/beginning-balances/${module}/import/preview`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setPreviewError(data.message || "Failed to preview import");
        return;
      }

      setPreviewResult(data);
      setStep("preview");
    } catch (err) {
      console.error("PREVIEW BB IMPORT ERROR:", err);
      setPreviewError("Unable to connect to server.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (committing || !previewResult) return;

    setCommitting(true);
    setCommitError("");

    try {
      const res = await fetch(`${API_BASE}/api/beginning-balances/${module}/import/commit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ batchId: previewResult.batchId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setCommitError(data.message || "Failed to commit import");
        return;
      }

      setCommitResult(data);
      setStep("done");
      onImported?.();
    } catch (err) {
      console.error("COMMIT BB IMPORT ERROR:", err);
      setCommitError("Unable to connect to server.");
    } finally {
      setCommitting(false);
    }
  }

  async function openHistory() {
    setStep("history");
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const res = await fetch(`${API_BASE}/api/beginning-balances/${module}/import-history`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        setHistoryError(data.message || "Failed to load import history");
        return;
      }

      setHistory(data.history);
    } catch (err) {
      console.error("LOAD BB IMPORT HISTORY ERROR:", err);
      setHistoryError("Unable to connect to server.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function downloadBatchErrors(batchId) {
    try {
      const res = await fetch(
        `${API_BASE}/api/beginning-balances/${module}/import/${batchId}/errors?format=csv`,
        { credentials: "include", headers: authHeaders() }
      );
      if (!res.ok) {
        alert("Failed to download error file");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${moduleLabel}_Import_Batch_${batchId}_Errors.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOWNLOAD BATCH ERRORS ERROR:", err);
      alert("Unable to download error file.");
    }
  }

  function downloadErrorFile() {
    if (!previewResult) return;

    const flagged = previewResult.rows.filter((r) => r.status !== "VALID");
    const csvRows = [["Row", "Status", "Column", "Value", "Message"]];

    for (const r of flagged) {
      for (const issue of [...r.errors, ...r.warnings]) {
        csvRows.push([r.rowNumber, r.status, issue.column, issue.value, issue.message]);
      }
    }

    const csvContent = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${moduleLabel}_Import_Validation_Report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const summary = previewResult?.summary;
  const hasBalanceInfo = summary && summary.totalDebit !== undefined;
  const canCommit = summary && summary.validRows + summary.warningRows > 0;

  return (
    <div className="bbim-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bbim-modal" role="dialog" aria-modal="true" aria-label={`Import ${moduleLabel} Beginning Balances`}>
        <div className="bbim-header">
          <h2>Import {moduleLabel} Beginning Balances</h2>
          <button type="button" className="bbim-close" onClick={onClose} aria-label="Close" ref={closeButtonRef}>
            &times;
          </button>
        </div>

        <div className="bbim-body">
          {step === "upload" && (
            <>
              <div className="bbim-template-row">
                <span>Need a template?</span>
                <button type="button" className="bbim-link-btn" onClick={() => downloadTemplate("xlsx")}>
                  Download Excel Template
                </button>
                <button type="button" className="bbim-link-btn" onClick={() => downloadTemplate("csv")}>
                  Download CSV Template
                </button>
                <button type="button" className="bbim-link-btn" onClick={openHistory}>
                  View Import History
                </button>
              </div>

              <div className="bbim-upload-box">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".xlsx,.csv"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
                {file && <span className="bbim-file-name">{file.name}</span>}
              </div>

              <div className="bbim-duplicate-mode">
                <label>
                  <input
                    type="radio"
                    checked={duplicateMode === "REJECT"}
                    onChange={() => setDuplicateMode("REJECT")}
                  />
                  Reject duplicates (default)
                </label>
                <label>
                  <input
                    type="radio"
                    checked={duplicateMode === "SKIP_EXISTING"}
                    onChange={() => setDuplicateMode("SKIP_EXISTING")}
                  />
                  Skip existing records
                </label>
              </div>

              {previewError && <div className="bbim-error-banner">{previewError}</div>}
            </>
          )}

          {step === "preview" && summary && (
            <>
              <div className="bbim-summary-grid">
                <div className="bbim-summary-item">
                  <div className="label">Total Rows</div>
                  <div className="value">{summary.totalRows}</div>
                </div>
                <div className="bbim-summary-item success">
                  <div className="label">Valid</div>
                  <div className="value">{summary.validRows}</div>
                </div>
                <div className="bbim-summary-item warning">
                  <div className="label">Warnings</div>
                  <div className="value">{summary.warningRows}</div>
                </div>
                <div className="bbim-summary-item danger">
                  <div className="label">Invalid</div>
                  <div className="value">{summary.invalidRows}</div>
                </div>
                <div className="bbim-summary-item neutral">
                  <div className="label">Duplicates</div>
                  <div className="value">{summary.duplicateRows}</div>
                </div>
                {hasBalanceInfo && (
                  <>
                    <div className="bbim-summary-item">
                      <div className="label">Total Debit</div>
                      <div className="value">₱ {formatMoney(summary.totalDebit)}</div>
                    </div>
                    <div className="bbim-summary-item">
                      <div className="label">Total Credit</div>
                      <div className="value">₱ {formatMoney(summary.totalCredit)}</div>
                    </div>
                    <div className={`bbim-summary-item ${summary.balanced ? "success" : "danger"}`}>
                      <div className="label">Difference</div>
                      <div className="value">₱ {formatMoney(summary.difference)}</div>
                    </div>
                  </>
                )}
              </div>

              {hasBalanceInfo && !summary.balanced && (
                <div className="bbim-error-banner">
                  Total Debit and Total Credit are not balanced across the valid rows. Fix the
                  file and re-upload, or invalid/duplicate rows may be excluding entries that
                  would otherwise balance.
                </div>
              )}

              <div className="bbim-row-table-wrap">
                <table className="bbim-row-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Status</th>
                      {previewColumns.map((col) => (
                        <th key={col.header}>{col.header}</th>
                      ))}
                      <th>Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewResult.rows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td>{r.rowNumber}</td>
                        <td>
                          <span className={`bbim-badge bbim-badge-${r.status.toLowerCase()}`}>{r.status}</span>
                        </td>
                        {previewColumns.map((col) => (
                          <td key={col.header} className={col.amount ? "amount" : undefined}>
                            {col.render(r.data)}
                          </td>
                        ))}
                        <td className="bbim-messages">
                          {[...r.errors, ...r.warnings].map((issue, i) => (
                            <div key={i}>{issue.message}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(summary.invalidRows > 0 || summary.duplicateRows > 0 || summary.warningRows > 0) && (
                <button type="button" className="bbim-link-btn" onClick={downloadErrorFile}>
                  Download Validation Report
                </button>
              )}

              {commitError && <div className="bbim-error-banner">{commitError}</div>}
            </>
          )}

          {step === "done" && commitResult && (
            <div className="bbim-success-banner">
              Import complete: {commitResult.imported} record(s) imported
              {commitResult.skippedDuplicates > 0 && `, ${commitResult.skippedDuplicates} duplicate(s) skipped`}.
            </div>
          )}

          {step === "history" && (
            <>
              {historyError && <div className="bbim-error-banner">{historyError}</div>}
              {historyLoading ? (
                <p className="bbim-muted">Loading import history...</p>
              ) : history.length === 0 ? (
                <p className="bbim-muted">No {moduleLabel} imports yet.</p>
              ) : (
                <div className="bbim-row-table-wrap">
                  <table className="bbim-row-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>File</th>
                        <th>Status</th>
                        <th>Total</th>
                        <th>Valid</th>
                        <th>Invalid</th>
                        <th>Warning</th>
                        <th>By</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.id}>
                          <td>{h.created_at ? new Date(h.created_at).toLocaleString() : ""}</td>
                          <td>{h.file_name}</td>
                          <td>
                            <span className={`bbim-badge bbim-badge-${h.status === "COMMITTED" ? "valid" : "warning"}`}>
                              {h.status}
                            </span>
                          </td>
                          <td>{h.total_rows}</td>
                          <td>{h.valid_rows}</td>
                          <td>{h.invalid_rows}</td>
                          <td>{h.warning_rows}</td>
                          <td>{h.created_by_username}</td>
                          <td>
                            {h.invalid_rows + h.warning_rows > 0 && (
                              <button type="button" className="bbim-link-btn" onClick={() => downloadBatchErrors(h.id)}>
                                Errors
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="bbim-footer">
          {step === "upload" && (
            <>
              <button type="button" className="bbim-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="bbim-btn-primary"
                onClick={handlePreview}
                disabled={!file || previewing}
              >
                {previewing ? "Uploading..." : "Preview Import"}
              </button>
            </>
          )}

          {step === "preview" && (
            <>
              <button
                type="button"
                className="bbim-btn-secondary"
                onClick={() => setStep("upload")}
                disabled={committing}
              >
                Back
              </button>
              <button
                type="button"
                className="bbim-btn-primary"
                onClick={handleCommit}
                disabled={committing || !canCommit}
              >
                {committing ? "Importing..." : "Confirm Import"}
              </button>
            </>
          )}

          {step === "done" && (
            <button type="button" className="bbim-btn-primary" onClick={onClose}>
              Close
            </button>
          )}

          {step === "history" && (
            <button type="button" className="bbim-btn-secondary" onClick={() => setStep("upload")}>
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
