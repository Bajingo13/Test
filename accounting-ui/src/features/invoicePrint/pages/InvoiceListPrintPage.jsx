import { useRef } from "react";
import { useSearchParams } from "react-router-dom";

import useInvoiceListPrintData from "../hooks/useInvoiceListPrintData";
import usePrintReadiness from "../hooks/usePrintReadiness";
import InvoiceListTable from "../components/InvoiceListTable";
import { formatDate } from "../utils/invoicePrintFormatters";

import "../styles/standard-invoice-print.css";
import "../styles/invoice-list-print.css";

const LIST_TITLES = {
  number: "Invoice List by Invoice Number",
  date: "Invoice List by Invoice Date",
  party: "Invoice List by Customer",
};

// One of the 3 "Print List by ..." summaries (INV only) - a multi-invoice
// list, not a single Standard Letter invoice. Shares the same Letter page
// box/typography as StandardInvoicePrintPage and the same Puppeteer
// readiness contract, but is a structurally different document (no
// watermark/signature/tax-summary-per-document - it's a report, not an
// invoice replica).
export default function InvoiceListPrintPage() {
  const [searchParams] = useSearchParams();
  const containerRef = useRef(null);

  const renderToken = searchParams.get("renderToken");
  const grouping = searchParams.get("grouping") || "number";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  const { data, loading, error } = useInvoiceListPrintData({ renderToken, grouping, from, to });

  usePrintReadiness({
    identifier: `list:${grouping}:${from}:${to}`,
    loading,
    error,
    containerRef,
  });

  if (loading) {
    return <div className="invoice-print-state">Loading invoice list…</div>;
  }
  if (error || !data) {
    return <div className="invoice-print-state invoice-print-state--error">{error || "No data."}</div>;
  }

  const { seller, rows, groups, grandTotal, count } = data;

  return (
    <div className="invoice-page invoice-list-page" ref={containerRef}>
      <div className="invoice-list-header">
        <strong>{seller.name}</strong>
        <div>{seller.address}</div>
        <div className="invoice-list-title">{LIST_TITLES[grouping] || "Invoice List"}</div>
        {from || to ? (
          <div className="invoice-list-range">
            {from ? formatDate(from) : "Beginning"} — {to ? formatDate(to) : "Present"}
          </div>
        ) : null}
        <div className="invoice-list-count">{count} invoice{count === 1 ? "" : "s"}</div>
      </div>

      <InvoiceListTable rows={rows} groups={groups} grandTotal={grandTotal} />
    </div>
  );
}
