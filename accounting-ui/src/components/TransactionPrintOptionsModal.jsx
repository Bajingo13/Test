import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Printer, Download, Eye } from "lucide-react";
import usePermissions from "../hooks/usePermissions";
import { PRINT_OPTIONS_BY_MODULE } from "../print/printOptionsConfig";
import { buildDocumentPdf } from "../print/pdf/documentPdfBuilder";
import { buildDocumentListPdf } from "../print/pdf/documentListPdfBuilder";
import { COPY_TYPES, DEFAULT_COPY_TYPE, MAX_COPIES } from "../print/copyTypes";
import "./TransactionPrintOptionsModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

// Phase 2 (Document Print Template Infrastructure) - only invoice/or have
// any print templates to select from. Every other module keeps printing
// exactly as before (no selector shown at all), matching
// printTemplateService.SUPPORTED_MODULE_TYPES on the backend.
const PRINT_TEMPLATE_MODULE_TYPES = ["invoice", "or"];

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Reusable across every transaction module opted into the framework
// (Invoice, OR, APV, CV today; JV/PO in Phase 3) - which options/
// permissions apply is looked up from transactionType via
// printOptionsConfig.js, and both the single-document and list PDFs are
// built by the same two generic functions (documentPdfBuilder.js /
// documentListPdfBuilder.js) - nothing here is Invoice-specific.
export default function TransactionPrintOptionsModal({ open, onClose, transactionType, transactionId, companyId, currentUser }) {
  const { can, loading: permsLoading } = usePermissions();

  const config = PRINT_OPTIONS_BY_MODULE[transactionType];

  const [selectedId, setSelectedId] = useState(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [copyType, setCopyType] = useState(DEFAULT_COPY_TYPE);
  const [copies, setCopies] = useState(1);
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState("");

  const [busy, setBusy] = useState(false);
  const [busyIntent, setBusyIntent] = useState(null);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewUrlRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setError(null);
    setPreviewUrl(null);
    setCopyType(DEFAULT_COPY_TYPE);
    setCopies(1);
    setTemplateId("");
    setTemplates([]);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    // Phase 2: fetch the active print templates for this module (if any)
    // so the user can optionally pick one instead of the resolved
    // default. Backend already scopes strictly by company + moduleType
    // (see printTemplateService.listTemplates) - never shows another
    // company's or module's templates. Silently skipped (not surfaced as
    // an error) if the fetch fails - the print flow still works via the
    // company-default/built-in fallback either way.
    if (PRINT_TEMPLATE_MODULE_TYPES.includes(transactionType)) {
      const templatesParams = new URLSearchParams({ moduleType: transactionType });
      if (companyId) templatesParams.set("companyId", companyId);
      fetch(`${API_URL}/api/print-templates?${templatesParams.toString()}`, { credentials: "include", headers: authHeaders() })
        .then((res) => (res.ok ? res.json() : []))
        .then((list) => setTemplates(Array.isArray(list) ? list.filter((t) => t.isActive) : []))
        .catch(() => setTemplates([]));
    }
  }, [open, transactionType, transactionId, companyId]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const selectedOption = useMemo(
    () => config?.options.find((o) => o.id === selectedId) || null,
    [config, selectedId]
  );

  if (!open) return null;

  if (!config) {
    return (
      <div className="tpom-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="tpom-modal tpom-modal-narrow" role="dialog" aria-modal="true" aria-label="Printing Options">
          <div className="tpom-header">
            <h2>Printing Options</h2>
            <button type="button" className="tpom-close" onClick={onClose} aria-label="Close">&times;</button>
          </div>
          <div className="tpom-body">
            <div className="tpom-error-banner">Printing options for "{transactionType}" are not available yet.</div>
          </div>
        </div>
      </div>
    );
  }

  async function fetchDocumentData(mode, intent) {
    const params = new URLSearchParams({ mode, intent, copyType, copies: String(copies) });
    if (templateId) params.set("templateId", templateId);
    if (companyId) params.set("companyId", companyId);
    const res = await fetch(
      `${API_URL}/api/print/${transactionType}/${transactionId}?${params.toString()}`,
      { credentials: "include", headers: authHeaders() }
    );
    return handleResponse(res);
  }

  async function fetchListData(grouping, intent) {
    const res = await fetch(`${API_URL}/api/print/${transactionType}/list`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ grouping, from: fromDate || null, to: toDate || null, intent, copyType, copies, companyId: companyId || undefined }),
    });
    return handleResponse(res);
  }

  async function handleResponse(res) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("You don't have permission to print this document.");
    }
    if (res.status === 404) {
      throw new Error("The requested transaction or print endpoint was not found.");
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.message || `The server returned an error (${res.status}).`);
    }
    return data;
  }

  // INV only (Standard Letter Invoice migration): every option here is
  // rendered server-side by Puppeteer against the real React printable
  // (StandardInvoicePrintPage / InvoiceListPrintPage) instead of the
  // client-side pdf-lib builders below. Every other module (OR/APV/CV/JV/
  // PO/PettyCash/DebitMemo/CreditMemo) is untouched and keeps using
  // buildDocumentPdf/buildDocumentListPdf exactly as before.
  async function fetchInvoicePdfBlob() {
    if (selectedOption.scope === "single") {
      const params = new URLSearchParams({ disposition: "inline" });
      if (selectedOption.mode === "with_entries") params.set("mode", "with_entries");
      if (templateId) params.set("templateId", templateId);
      if (companyId) params.set("companyId", companyId);
      const res = await fetch(`${API_URL}/api/invoice-print/${transactionId}/pdf?${params.toString()}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readPdfErrorMessage(res));
      return res.blob();
    }

    const params = new URLSearchParams({ disposition: "inline", grouping: selectedOption.grouping });
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (companyId) params.set("companyId", companyId);
    const res = await fetch(`${API_URL}/api/invoice-print/list/pdf?${params.toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await readPdfErrorMessage(res));
    return res.blob();
  }

  async function readPdfErrorMessage(res) {
    try {
      const body = await res.json();
      return body?.message || `The server returned an error (${res.status}).`;
    } catch {
      return `The server returned an error (${res.status}).`;
    }
  }

  async function buildPdfBlob(intent) {
    if (!selectedOption) throw new Error("Select a print option first.");

    if (transactionType === "invoice") {
      return fetchInvoicePdfBlob();
    }

    const generatedBy = currentUser?.username || currentUser?.fullName || "Unknown User";

    if (selectedOption.scope === "single") {
      const data = await fetchDocumentData(selectedOption.mode, intent);
      const bytes = await buildDocumentPdf({ ...data, transactionType, mode: selectedOption.mode, generatedBy, copyType, copies });
      return new Blob([bytes], { type: "application/pdf" });
    }

    const data = await fetchListData(selectedOption.grouping, intent);
    const bytes = await buildDocumentListPdf({
      ...data,
      title: selectedOption.listTitle,
      columns: selectedOption.listColumns,
      filters: { from: fromDate, to: toDate },
      generatedBy,
      copyType,
      copies,
    });
    return new Blob([bytes], { type: "application/pdf" });
  }

  async function runAction(intent) {
    if (!selectedOption) {
      setError("Select a print option first.");
      return;
    }
    setBusy(true);
    setBusyIntent(intent);
    setError(null);

    try {
      const blob = await buildPdfBlob(intent);
      const url = URL.createObjectURL(blob);

      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;

      if (intent === "preview") {
        setPreviewUrl(url);
      } else if (intent === "print") {
        setPreviewUrl(url);
        const win = window.open(url, "_blank");
        if (win) {
          win.addEventListener("load", () => {
            win.focus();
            win.print();
          });
        } else {
          setError("Pop-up blocked - allow pop-ups for this site to print, or use Export PDF instead.");
        }
      } else if (intent === "export_pdf") {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${transactionType}-${selectedOption.id}-${transactionId || "list"}.pdf`;
        link.click();
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("PRINT OPTIONS MODAL ERROR:", err);
      setError(err.message || "Failed to generate the document.");
    } finally {
      setBusy(false);
      setBusyIntent(null);
    }
  }

  return (
    <div className="tpom-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tpom-modal" role="dialog" aria-modal="true" aria-label={`${config.title} Printing Options`}>
        <div className="tpom-header">
          <div>
            <h2>{config.title} — Printing Options</h2>
            <p className="tpom-subtitle">Choose what to print, then preview, print, or export a PDF.</p>
          </div>
          <button type="button" className="tpom-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="tpom-body">
          <div className="tpom-columns">
            <div className="tpom-options-col">
              {config.options.map((option) => {
                const allowed = permsLoading || can(config.moduleKey, option.requiredPermissionAction);
                const Icon = option.icon;
                const selected = option.id === selectedId;
                return (
                  <button
                    type="button"
                    key={option.id}
                    className={`tpom-option-card${selected ? " tpom-option-selected" : ""}${!allowed ? " tpom-option-disabled" : ""}`}
                    disabled={!allowed}
                    onClick={() => {
                      setSelectedId(option.id);
                      setPreviewUrl(null);
                      setError(null);
                    }}
                  >
                    <div className="tpom-option-icon">{allowed ? <Icon size={18} /> : <Lock size={16} />}</div>
                    <div className="tpom-option-text">
                      <div className="tpom-option-label">{option.label}</div>
                      <div className="tpom-option-desc">
                        {allowed ? option.description : "You don't have permission for this option."}
                      </div>
                    </div>
                    <div className="tpom-option-radio" aria-hidden="true">
                      <span className={selected ? "tpom-radio-dot" : ""} />
                    </div>
                  </button>
                );
              })}

              {selectedOption?.needsFilters && (
                <div className="tpom-filters">
                  <div>
                    <label>Date From</label>
                    <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                  </div>
                  <div>
                    <label>Date To</label>
                    <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
                  </div>
                </div>
              )}

              {selectedOption?.scope === "single" && templates.length > 0 && (
                <div className="tpom-filters">
                  <div>
                    <label>Print Template</label>
                    <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                      <option value="">Default</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.templateName}{t.isDefault ? " (Default)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {selectedOption && (
                <div className="tpom-filters">
                  <div>
                    <label>Copy Type</label>
                    <select value={copyType} onChange={(e) => setCopyType(e.target.value)}>
                      {COPY_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label>Number of Copies</label>
                    <input
                      type="number"
                      min={1}
                      max={MAX_COPIES}
                      value={copies}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setCopies(Number.isFinite(v) ? Math.min(Math.max(v, 1), MAX_COPIES) : 1);
                      }}
                    />
                  </div>
                </div>
              )}

              {error && <div className="tpom-error-banner">{error}</div>}
            </div>

            <div className="tpom-preview-col">
              {previewUrl ? (
                <iframe title="Print preview" src={previewUrl} className="tpom-preview-frame" />
              ) : (
                <div className="tpom-preview-placeholder">
                  {busy ? "Generating document..." : "Select a print option, then click Preview to see it here."}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="tpom-footer">
          <button type="button" className="tpom-btn-secondary" onClick={onClose}>Close</button>
          <div className="tpom-footer-right">
            <button
              type="button"
              className="tpom-btn-secondary"
              disabled={!selectedOption || busy}
              onClick={() => runAction("preview")}
            >
              <Eye size={15} /> {busy && busyIntent === "preview" ? "Loading..." : "Preview"}
            </button>
            <button
              type="button"
              className="tpom-btn-secondary"
              disabled={!selectedOption || busy}
              onClick={() => runAction("print")}
            >
              <Printer size={15} /> {busy && busyIntent === "print" ? "Preparing..." : "Print"}
            </button>
            <button
              type="button"
              className="tpom-btn-primary"
              disabled={!selectedOption || busy}
              onClick={() => runAction("export_pdf")}
            >
              <Download size={15} /> {busy && busyIntent === "export_pdf" ? "Exporting..." : "Export PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
