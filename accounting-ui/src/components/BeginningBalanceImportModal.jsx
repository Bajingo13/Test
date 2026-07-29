import { useEffect, useRef, useState } from "react";
import "./BeginningBalanceImportModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const MODULE_LABELS = { gl: "GL", ar: "AR", ap: "AP" };

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
  const fileInputRef = useRef(null);
  const closeButtonRef = useRef(null);

  const moduleLabel = MODULE_LABELS[module] || module?.toUpperCase();

  useEffect(() => {
    if (open) {
      setStep("upload");
      setFile(null);
      setDuplicateMode("REJECT");
      setPreviewResult(null);
      setPreviewError("");
      setCommitError("");
      setCommitResult(null);
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
                      <th>Account</th>
                      <th>Date</th>
                      <th>Debit</th>
                      <th>Credit</th>
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
                        <td>{r.data?.accountCode}</td>
                        <td>{r.data?.balanceDate}</td>
                        <td className="amount">{r.data?.debit ? formatMoney(r.data.debit) : ""}</td>
                        <td className="amount">{r.data?.credit ? formatMoney(r.data.credit) : ""}</td>
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
        </div>
      </div>
    </div>
  );
}
