import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import BankReconMatchModal from "../../components/BankReconMatchModal.jsx";
import BankReconAuditLogPanel from "../../components/BankReconAuditLogPanel.jsx";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./BankReconciliation.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

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
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bookItems, setBookItems] = useState([]);

  const [modalLine, setModalLine] = useState(null);
  const [modalCandidates, setModalCandidates] = useState([]);
  const [modalBusy, setModalBusy] = useState(false);

  const [outstandingItems, setOutstandingItems] = useState({
    outstandingChecks: [],
    depositsInTransit: [],
  });
  const [adjustments, setAdjustments] = useState([]);
  const [coaAccounts, setCoaAccounts] = useState([]);
  const [adjustmentAccountPicks, setAdjustmentAccountPicks] = useState({});
  const [adjustmentBusyId, setAdjustmentBusyId] = useState(null);

  const [summary, setSummary] = useState(null);
  const [finalizing, setFinalizing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [auditLog, setAuditLog] = useState([]);

  useEffect(() => {
    loadSession();
    loadImportBatches();
    loadStatementLines();
    loadBookItems();
    loadOutstandingItems();
    loadAdjustments();
    loadCoaAccounts();
    loadSummary();
    loadAuditLog();
  }, [id]);

  async function loadSummary() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/summary`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setSummary(data);
    } catch (err) {
      console.error("LOAD SUMMARY ERROR:", err);
    }
  }

  async function loadAuditLog() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/audit-log`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setAuditLog(data);
    } catch (err) {
      console.error("LOAD AUDIT LOG ERROR:", err);
    }
  }

  async function finalizeSession() {
    setFinalizing(true);

    try {
      let overrideReason;

      if (summary && !summary.canFinalizeCleanly) {
        overrideReason = prompt(
          `This session isn't fully reconciled (difference: ₱ ${formatMoney(
            summary.difference
          )}, ${summary.pendingAdjustmentsCount} pending adjustment(s), ${
            summary.unresolvedStatementLinesCount
          } unresolved line(s)). Enter a reason to finalize anyway, or cancel.`
        );
        if (!overrideReason || !overrideReason.trim()) {
          setFinalizing(false);
          return;
        }
      } else if (!confirm("Finalize this reconciliation session?")) {
        setFinalizing(false);
        return;
      }

      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({ overrideReason }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to finalize session.");
        return;
      }

      await loadSession();
      await loadSummary();
      await loadAuditLog();
    } catch (err) {
      console.error("FINALIZE SESSION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setFinalizing(false);
    }
  }

  async function reopenSession() {
    const reason = prompt("Enter a reason for reopening this finalized session:");
    if (!reason || !reason.trim()) return;

    setReopening(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/reopen`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({ reason }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to reopen session.");
        return;
      }

      await loadSession();
      await loadSummary();
      await loadAuditLog();
    } catch (err) {
      console.error("REOPEN SESSION ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setReopening(false);
    }
  }

  async function downloadReportPDF() {
    setDownloadingReport(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/report`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load report.");
        return;
      }

      await renderReportPDF(data);
    } catch (err) {
      console.error("DOWNLOAD REPORT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setDownloadingReport(false);
    }
  }

  async function renderReportPDF(data) {
    const { session: s, summary: sum, confirmedMatches, postedAdjustments } = data;

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
    const marginX = 40;
    const pageWidth = 612;
    const pageHeight = 792;
    const dark = rgb(0.06, 0.09, 0.16);
    const grey = rgb(0.4, 0.46, 0.55);

    let page = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - 50;

    function ensureSpace(needed) {
      if (y - needed < 40) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - 50;
      }
    }

    function text(str, x, size, opts = {}) {
      page.drawText(String(str ?? ""), {
        x,
        y,
        size,
        font: opts.bold ? boldFont : font,
        color: opts.color || dark,
      });
    }

    function line(str, opts = {}) {
      ensureSpace(20);
      text(str, marginX, opts.size || 10, opts);
      y -= opts.gap || 16;
    }

    line("Bank Reconciliation Report", { bold: true, size: 16, gap: 22 });
    line(`${s.bankCode} - ${s.bankName}${s.bankAccountNo ? ` (${s.bankAccountNo})` : ""}`, {
      bold: true,
      size: 11,
    });
    line(`Period: ${s.periodStart} to ${s.periodEnd}`, { color: grey });
    line(`Status: ${s.status}`, { color: grey, gap: 22 });

    line("Summary", { bold: true, size: 12, gap: 18 });
    line(`Statement Ending Balance: ${formatMoney(sum.statementEndingBalance)}`);
    line(`Add: Deposits in Transit: ${formatMoney(sum.depositsInTransitTotal)}`);
    line(`Less: Outstanding Checks: ${formatMoney(sum.outstandingChecksTotal)}`);
    line(`Adjusted Bank Balance: ${formatMoney(sum.adjustedBank)}`, { bold: true });
    line(`Book Balance: ${formatMoney(sum.bookBalance)}`, { bold: true, gap: 18 });
    line(`Difference: ${formatMoney(sum.difference)}`, { bold: true, gap: 26 });

    line(`Confirmed Matches (${confirmedMatches.length})`, { bold: true, size: 12, gap: 18 });
    if (confirmedMatches.length === 0) {
      line("None", { color: grey });
    } else {
      confirmedMatches.forEach((m) => {
        line(
          `${m.txnDate}  ${m.bookSourceType} #${m.bookSourceId}  ${formatMoney(m.amount)}  (${m.matchType})`,
          { size: 9 }
        );
      });
    }

    y -= 10;
    line(`Posted Adjustments (${postedAdjustments.length})`, { bold: true, size: 12, gap: 18 });
    if (postedAdjustments.length === 0) {
      line("None", { color: grey });
    } else {
      postedAdjustments.forEach((a) => {
        line(`${a.txnDate}  ${a.adjustmentType}  ${formatMoney(a.amount)}  JV #${a.jvId}`, {
          size: 9,
        });
      });
    }

    y -= 10;
    line(`Outstanding Checks (${sum.outstandingChecks.length})`, { bold: true, size: 12, gap: 18 });
    if (sum.outstandingChecks.length === 0) {
      line("None", { color: grey });
    } else {
      sum.outstandingChecks.forEach((c) => {
        line(`${c.date}  ${c.sourceType} ${c.voucherNo}  ${c.payeeOrCustomer}  ${formatMoney(c.amount)}`, {
          size: 9,
        });
      });
    }

    y -= 10;
    line(`Deposits in Transit (${sum.depositsInTransit.length})`, { bold: true, size: 12, gap: 18 });
    if (sum.depositsInTransit.length === 0) {
      line("None", { color: grey });
    } else {
      sum.depositsInTransit.forEach((d) => {
        line(`${d.date}  ${d.sourceType} ${d.voucherNo}  ${d.payeeOrCustomer}  ${formatMoney(d.amount)}`, {
          size: 9,
        });
      });
    }

    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bank-reconciliation-session-${s.id}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function refreshBoard() {
    await Promise.all([
      loadStatementLines(),
      loadBookItems(),
      loadOutstandingItems(),
      loadAdjustments(),
      loadSummary(),
      loadAuditLog(),
    ]);
  }

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

  async function loadOutstandingItems() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/outstanding-items`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setOutstandingItems(data);
    } catch (err) {
      console.error("LOAD OUTSTANDING ITEMS ERROR:", err);
    }
  }

  async function loadAdjustments() {
    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/sessions/${id}/adjustments`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setAdjustments(data);
    } catch (err) {
      console.error("LOAD ADJUSTMENTS ERROR:", err);
    }
  }

  async function loadCoaAccounts() {
    try {
      const res = await fetch(`${API_BASE}/api/coa`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setCoaAccounts(data);
    } catch (err) {
      console.error("LOAD COA ERROR:", err);
    }
  }

  async function approveAdjustment(adj) {
    const accountId = adjustmentAccountPicks[adj.id] || adj.suggestedAccountId;

    if (!accountId) {
      alert("Select an account before approving.");
      return;
    }

    setAdjustmentBusyId(adj.id);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/adjustments/${adj.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({ suggestedAccountId: accountId }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to approve adjustment.");
        return;
      }

      await loadAdjustments();
      await loadSummary();
      await loadAuditLog();
    } catch (err) {
      console.error("APPROVE ADJUSTMENT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setAdjustmentBusyId(null);
    }
  }

  async function rejectAdjustment(adjId) {
    if (!confirm("Reject this adjustment suggestion?")) return;

    setAdjustmentBusyId(adjId);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/adjustments/${adjId}/reject`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to reject adjustment.");
        return;
      }

      await loadAdjustments();
      await loadSummary();
      await loadAuditLog();
    } catch (err) {
      console.error("REJECT ADJUSTMENT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setAdjustmentBusyId(null);
    }
  }

  async function postAdjustment(adjId) {
    if (!confirm("Post this adjustment as a Journal Voucher? This cannot be undone.")) return;

    setAdjustmentBusyId(adjId);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/adjustments/${adjId}/post`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to post adjustment.");
        return;
      }

      alert(`Posted as JV ${data.voucherNo}.`);
      await loadAdjustments();
      await loadSummary();
      await loadAuditLog();
    } catch (err) {
      console.error("POST ADJUSTMENT ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setAdjustmentBusyId(null);
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
      closeModal();
      await refreshBoard();
    } catch (err) {
      console.error("RUN MATCHING ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setRunningMatching(false);
    }
  }

  async function bulkConfirmExact() {
    setBulkConfirming(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/matches/bulk-confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({ sessionId: id }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to bulk-confirm matches.");
        return;
      }

      alert(data.message);
      await refreshBoard();
    } catch (err) {
      console.error("BULK CONFIRM ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setBulkConfirming(false);
    }
  }

  async function openModal(line) {
    setModalLine(line);
    setModalCandidates([]);

    if (line.matchStatus !== "SUGGESTED") return;

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/statement-lines/${line.id}/candidates`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        return;
      }

      setModalCandidates(data);
    } catch (err) {
      console.error("LOAD MATCH CANDIDATES ERROR:", err);
    }
  }

  function closeModal() {
    setModalLine(null);
    setModalCandidates([]);
  }

  async function confirmCandidate(matchId) {
    setModalBusy(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/matches/${matchId}/confirm`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to confirm match.");
        return;
      }

      closeModal();
      await refreshBoard();
    } catch (err) {
      console.error("CONFIRM MATCH ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setModalBusy(false);
    }
  }

  async function manualMatch(bookItem) {
    if (!modalLine) return;

    const amount =
      Number(modalLine.debit) > 0 ? Number(modalLine.debit) : Number(modalLine.credit);

    if (!confirm(`Match this statement line to ${bookItem.sourceType} ${bookItem.voucherNo}?`)) {
      return;
    }

    setModalBusy(true);

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/matches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({
          statementLineId: modalLine.id,
          bookSourceType: bookItem.sourceType,
          bookSourceId: bookItem.sourceId,
          bookLineId: bookItem.lineId || null,
          amount,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to create match.");
        return;
      }

      closeModal();
      await refreshBoard();
    } catch (err) {
      console.error("MANUAL MATCH ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setModalBusy(false);
    }
  }

  async function ignoreLine() {
    if (!modalLine) return;

    setModalBusy(true);

    try {
      const res = await fetch(
        `${API_BASE}/api/bank-recon/statement-lines/${modalLine.id}/ignore`,
        {
          method: "POST",
          credentials: "include",
          headers: authHeaders(),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to update statement line.");
        return;
      }

      closeModal();
      await refreshBoard();
    } catch (err) {
      console.error("IGNORE LINE ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setModalBusy(false);
    }
  }

  async function unmatchLine(line) {
    if (!line.confirmedMatchId) return;
    if (!confirm("Unmatch this statement line? It will return to Unmatched status.")) return;

    try {
      const res = await fetch(`${API_BASE}/api/bank-recon/matches/${line.confirmedMatchId}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to unmatch.");
        return;
      }

      await refreshBoard();
    } catch (err) {
      console.error("UNMATCH ERROR:", err);
      alert("Unable to connect to server.");
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

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={downloadReportPDF}
            className="brc-btn"
            disabled={downloadingReport}
          >
            {downloadingReport ? "Preparing..." : "Download Report (PDF)"}
          </button>
          {isFinalized ? (
            <button onClick={reopenSession} className="brc-btn" disabled={reopening}>
              {reopening ? "Reopening..." : "Reopen"}
            </button>
          ) : (
            <button
              onClick={finalizeSession}
              className="brc-btn primary"
              disabled={finalizing}
            >
              {finalizing ? "Finalizing..." : "Finalize"}
            </button>
          )}
          <button onClick={() => navigate("/reports/bank-reconciliation")} className="brc-btn">
            Back to Sessions
          </button>
        </div>
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
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={bulkConfirmExact} className="brc-btn" disabled={bulkConfirming}>
                {bulkConfirming ? "Confirming..." : "Confirm All Exact"}
              </button>
              <button onClick={runMatching} className="brc-btn primary" disabled={runningMatching}>
                {runningMatching ? "Running Matching..." : "Run Matching"}
              </button>
            </div>
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
                  <tr key={line.id}>
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
                      {!isFinalized && (line.matchStatus === "SUGGESTED" || line.matchStatus === "UNMATCHED") && (
                        <button onClick={() => openModal(line)}>
                          {line.matchStatus === "SUGGESTED" ? "Review Matches" : "Find Match"}
                        </button>
                      )}
                      {!isFinalized && line.matchStatus === "MATCHED" && line.confirmedMatchId && (
                        <button onClick={() => unmatchLine(line)} className="danger">
                          Unmatch
                        </button>
                      )}
                      {!isFinalized && line.matchStatus === "MATCHED" && !line.confirmedMatchId && (
                        <span style={{ color: "#64748b", fontSize: 13 }}>Resolved via adjustment</span>
                      )}
                      {!isFinalized && line.matchStatus === "IGNORED" && (
                        <button onClick={() => openModal(line)}>Un-ignore</button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalLine && (
        <BankReconMatchModal
          statementLine={modalLine}
          candidates={modalCandidates}
          bookItems={bookItems}
          busy={modalBusy}
          onClose={closeModal}
          onConfirmCandidate={confirmCandidate}
          onManualMatch={manualMatch}
          onIgnore={ignoreLine}
        />
      )}

      <div className="brc-card">
        <h2>Outstanding Checks ({outstandingItems.outstandingChecks.length})</h2>
        <p style={{ color: "#64748b", marginTop: 0 }}>
          CV/JV payments recorded in the books, dated on or before the period end, that
          haven't cleared the bank yet.
        </p>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Voucher No.</th>
                <th>Payee</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {outstandingItems.outstandingChecks.length === 0 ? (
                <tr>
                  <td colSpan="5" className="brc-empty">
                    No outstanding checks.
                  </td>
                </tr>
              ) : (
                outstandingItems.outstandingChecks.map((item) => (
                  <tr key={`${item.sourceType}-${item.sourceId}-${item.lineId || 0}`}>
                    <td>{item.sourceType}</td>
                    <td>{item.voucherNo}</td>
                    <td>{item.payeeOrCustomer}</td>
                    <td>{item.date}</td>
                    <td className="amount">₱ {formatMoney(item.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="brc-card">
        <h2>Deposits in Transit ({outstandingItems.depositsInTransit.length})</h2>
        <p style={{ color: "#64748b", marginTop: 0 }}>
          OR/JV receipts recorded in the books, dated on or before the period end, that
          haven't landed on the bank statement yet.
        </p>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Voucher No.</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {outstandingItems.depositsInTransit.length === 0 ? (
                <tr>
                  <td colSpan="5" className="brc-empty">
                    No deposits in transit.
                  </td>
                </tr>
              ) : (
                outstandingItems.depositsInTransit.map((item) => (
                  <tr key={`${item.sourceType}-${item.sourceId}-${item.lineId || 0}`}>
                    <td>{item.sourceType}</td>
                    <td>{item.voucherNo}</td>
                    <td>{item.payeeOrCustomer}</td>
                    <td>{item.date}</td>
                    <td className="amount">₱ {formatMoney(item.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="brc-card">
        <h2>Adjustment Suggestions ({adjustments.length})</h2>
        <p style={{ color: "#64748b", marginTop: 0 }}>
          Statement lines the matching engine couldn't explain - guessed as bank charge or
          interest income from the description, or flagged Other/Unexplained. Each needs an
          explicit Approve or Reject; approved adjustments post as a JV once Phase 8 lands.
        </p>

        <div className="brc-table-wrap">
          <table className="brc-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Account</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.length === 0 ? (
                <tr>
                  <td colSpan="7" className="brc-empty">
                    No adjustment suggestions. Run Matching to generate them.
                  </td>
                </tr>
              ) : (
                adjustments.map((adj) => (
                  <tr key={adj.id}>
                    <td>{adj.txnDate}</td>
                    <td>{adj.description}</td>
                    <td>{adj.adjustmentType}</td>
                    <td className="amount">₱ {formatMoney(adj.amount)}</td>
                    <td>
                      {adj.status === "PENDING" ? (
                        <select
                          value={adjustmentAccountPicks[adj.id] || adj.suggestedAccountId || ""}
                          onChange={(e) =>
                            setAdjustmentAccountPicks({
                              ...adjustmentAccountPicks,
                              [adj.id]: e.target.value,
                            })
                          }
                        >
                          <option value="">Select account</option>
                          {coaAccounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              {acc.code} - {acc.title}
                            </option>
                          ))}
                        </select>
                      ) : (
                        coaAccounts.find(
                          (acc) => String(acc.id) === String(adj.suggestedAccountId)
                        )?.title || "-"
                      )}
                    </td>
                    <td>
                      <span className={`brc-match-badge ${adj.status.toLowerCase()}`}>
                        {adj.status}
                      </span>
                    </td>
                    <td>
                      {adj.status === "PENDING" && !isFinalized && (
                        <>
                          <button
                            className="brc-btn primary"
                            disabled={adjustmentBusyId === adj.id}
                            onClick={() => approveAdjustment(adj)}
                          >
                            Approve
                          </button>
                          <button
                            className="danger"
                            disabled={adjustmentBusyId === adj.id}
                            onClick={() => rejectAdjustment(adj.id)}
                            style={{ marginLeft: 6 }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {adj.status === "APPROVED" && !isFinalized && (
                        <button
                          className="brc-btn primary"
                          disabled={adjustmentBusyId === adj.id}
                          onClick={() => postAdjustment(adj.id)}
                        >
                          Post as JV
                        </button>
                      )}
                      {adj.status === "POSTED" && (
                        <span style={{ color: "#64748b", fontSize: 13 }}>JV #{adj.jvId}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="brc-card">
        <h2>Reconciliation Summary</h2>

        {!summary ? (
          "Loading..."
        ) : (
          <>
            <div className="brc-grid">
              <div>
                <label>Statement Ending Balance</label>
                <input value={`₱ ${formatMoney(summary.statementEndingBalance)}`} readOnly />
              </div>
              <div>
                <label>Add: Deposits in Transit</label>
                <input value={`₱ ${formatMoney(summary.depositsInTransitTotal)}`} readOnly />
              </div>
              <div>
                <label>Less: Outstanding Checks</label>
                <input value={`₱ ${formatMoney(summary.outstandingChecksTotal)}`} readOnly />
              </div>
              <div>
                <label>Adjusted Bank Balance</label>
                <input value={`₱ ${formatMoney(summary.adjustedBank)}`} readOnly />
              </div>
              <div>
                <label>Book Balance</label>
                <input value={`₱ ${formatMoney(summary.bookBalance)}`} readOnly />
              </div>
              <div>
                <label>Difference</label>
                <input
                  value={`₱ ${formatMoney(summary.difference)}`}
                  readOnly
                  style={{
                    fontWeight: 800,
                    color: summary.difference === 0 ? "#166534" : "#991b1b",
                  }}
                />
              </div>
            </div>

            <p style={{ color: "#64748b", marginTop: 14 }}>
              {summary.canFinalizeCleanly
                ? "Fully reconciled - ready to finalize."
                : `Not yet fully reconciled: ${summary.pendingAdjustmentsCount} pending adjustment(s), ${summary.unresolvedStatementLinesCount} unresolved statement line(s). Finalizing now requires an override reason.`}
            </p>
          </>
        )}
      </div>

      <div className="brc-card">
        <h2>Audit Log</h2>
        <BankReconAuditLogPanel entries={auditLog} />
      </div>
    </div>
  );
}
