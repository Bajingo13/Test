import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "../styles/invoice-print-viewer.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function safeFilename(identifier) {
  return `Invoice-${String(identifier).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
}

// Standard Invoice viewer chrome only - ported from the useful part of
// InvoicePreviewViewer.html (an iframe + Print/Download). Every workflow
// control from that file (Approve/Submit/Void/Email/Sign/Files, the
// pre-printed-form toggle, compact-calibration query params) is
// intentionally NOT carried over - none of it is in scope for this
// migration, and INV has no such workflow today.
//
// Generates the PDF via GET /api/invoice-print/:id/pdf (Puppeteer, server
// side) exactly once per invoice identifier - never on an unrelated
// re-render - and loads it into the iframe as a local blob URL, the same
// pattern TransactionPrintOptionsModal.jsx already uses for its
// client-built PDFs.
export default function InvoicePrintViewer() {
  const { identifier } = useParams();
  const [pdfUrl, setPdfUrl] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const pdfUrlRef = useRef(null);
  const pdfBlobRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setPdfUrl(null);

    fetch(`${API_URL}/api/invoice-print/${encodeURIComponent(identifier)}/pdf?disposition=inline`, {
      credentials: "include",
      headers: authHeaders(),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to generate PDF.");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        pdfUrlRef.current = url;
        pdfBlobRef.current = blob;
        setPdfUrl(url);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      if (pdfUrlRef.current) {
        URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = null;
      }
    };
  }, [identifier]);

  function handlePrint() {
    if (!pdfUrl) return;
    const win = window.open(pdfUrl, "_blank");
    if (win) win.addEventListener("load", () => win.print());
  }

  function handleDownload() {
    if (!pdfBlobRef.current) return;
    const objectUrl = URL.createObjectURL(pdfBlobRef.current);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = safeFilename(identifier);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <div className="invoice-print-viewer">
      <div className="invoice-print-viewer__toolbar">
        <span className="invoice-print-viewer__title">Invoice {identifier}</span>
        <div className="invoice-print-viewer__actions">
          <button type="button" onClick={handlePrint} disabled={status !== "ready"}>
            Print
          </button>
          <button type="button" onClick={handleDownload} disabled={status !== "ready"}>
            Download PDF
          </button>
        </div>
      </div>

      <div className="invoice-print-viewer__stage">
        {status === "loading" ? <div className="invoice-print-viewer__state">Generating PDF…</div> : null}
        {status === "error" ? (
          <div className="invoice-print-viewer__state invoice-print-viewer__state--error">
            Could not generate the PDF for this invoice.
          </div>
        ) : null}
        {status === "ready" ? <iframe title="Invoice PDF" src={pdfUrl} /> : null}
      </div>
    </div>
  );
}
