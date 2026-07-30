import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Printer, Download, Eye } from "lucide-react";
import usePermissions from "../hooks/usePermissions";
import { PRINT_OPTIONS_BY_MODULE } from "../print/printOptionsConfig";
import { buildInvoicePdf } from "../print/pdf/invoicePdfBuilder";
import { buildInvoiceListPdf } from "../print/pdf/invoiceListPdfBuilder";
import "./TransactionPrintOptionsModal.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const PDF_BUILDERS = {
  invoice: { single: buildInvoicePdf, list: buildInvoiceListPdf },
};

// Reusable across every transaction module (Invoice today, OR/APV/CV/JV/PO
// in later phases) - which options/permissions/PDF builder apply is looked
// up from transactionType, nothing here is Invoice-specific.
export default function TransactionPrintOptionsModal({ open, onClose, transactionType, transactionId, currentUser }) {
  const { can, loading: permsLoading } = usePermissions();

  const config = PRINT_OPTIONS_BY_MODULE[transactionType];

  const [selectedId, setSelectedId] = useState(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, [open, transactionType, transactionId]);

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
    const res = await fetch(
      `${API_URL}/api/print/invoice/${transactionId}?mode=${mode}&intent=${intent}`,
      { credentials: "include", headers: authHeaders() }
    );
    return handleResponse(res);
  }

  async function fetchListData(grouping, intent) {
    const res = await fetch(`${API_URL}/api/print/invoice-list`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ grouping, from: fromDate || null, to: toDate || null, intent }),
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

  async function buildPdfBlob(intent) {
    if (!selectedOption) throw new Error("Select a print option first.");
    const builders = PDF_BUILDERS[transactionType];
    const generatedBy = currentUser?.username || currentUser?.fullName || "Unknown User";

    if (selectedOption.scope === "single") {
      const data = await fetchDocumentData(selectedOption.mode, intent);
      const bytes = await builders.single({ ...data, mode: selectedOption.mode, generatedBy });
      return new Blob([bytes], { type: "application/pdf" });
    }

    const data = await fetchListData(selectedOption.grouping, intent);
    const bytes = await builders.list({ ...data, filters: { from: fromDate, to: toDate }, generatedBy });
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
