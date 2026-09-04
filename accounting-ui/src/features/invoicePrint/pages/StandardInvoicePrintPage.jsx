import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import useInvoicePrintData from "../hooks/useInvoicePrintData";
import useInvoiceLayout from "../hooks/useInvoiceLayout";
import usePrintReadiness from "../hooks/usePrintReadiness";
import useAutoPrint from "../hooks/useAutoPrint";

import InvoiceWatermark from "../components/InvoiceWatermark";
import InvoiceCompanyHeader from "../components/InvoiceCompanyHeader";
import InvoiceCustomerSection from "../components/InvoiceCustomerSection";
import InvoiceDocumentDetails from "../components/InvoiceDocumentDetails";
import InvoiceItemsTable from "../components/InvoiceItemsTable";
import InvoiceTotalsSection from "../components/InvoiceTotalsSection";
import InvoicePrintFooter from "../components/InvoicePrintFooter";

import "../styles/standard-invoice-print.css";

// The Standard Letter Invoice printable (INV only). Reproduces the
// E-Invoicing Replica's visual layout and Puppeteer readiness contract
// while sourcing all data from the Accounting System's own, already-
// authoritative print pipeline (invoicePrintDataService). Read-only:
// nothing here ever calls a write endpoint.
export default function StandardInvoicePrintPage() {
  const { identifier } = useParams();
  const [searchParams] = useSearchParams();
  const containerRef = useRef(null);

  // Present only when Puppeteer's headless page loaded this route (see
  // invoicePrintPdfService.js) - a real user's browser never has this.
  const renderToken = searchParams.get("renderToken");

  const { data, loading, error } = useInvoicePrintData(identifier, renderToken);
  const layout = useInvoiceLayout(data?.layout);

  usePrintReadiness({ identifier, loading, error, containerRef });
  useAutoPrint({
    identifier,
    ready: !loading && !error && !!data,
    // Never native-print while Puppeteer is driving this page (renderToken
    // present) - window.print is already neutralized server-side too (see
    // invoicePrintPdfService.js), this is belt-and-suspenders.
    autoPrintRequested: !renderToken && searchParams.get("autoprint") === "1",
  });

  // Footer timestamp - presentation only, computed client-side like the
  // Replica's updateOnScreenFooter(), never a stored/audited value.
  useEffect(() => {
    if (!containerRef.current) return;
    const stamp = new Date().toLocaleString();
    containerRef.current.querySelectorAll(".invoice-print-timestamp").forEach((el) => {
      el.textContent = `Timestamp: ${stamp}`;
    });
    containerRef.current.querySelectorAll(".invoice-print-page").forEach((el) => {
      el.textContent = "Page 1 of 1";
    });
  }, [data]);

  if (loading) {
    return <div className="invoice-print-state">Loading invoice…</div>;
  }

  if (error || !data) {
    return <div className="invoice-print-state invoice-print-state--error">{error || "Invoice not found."}</div>;
  }

  const { document, seller, customer, items, totals, footer, currency } = data;

  return (
    <div className="invoice-page" ref={containerRef}>
      <InvoiceWatermark status={document.accountingStatus} />

      <InvoiceCompanyHeader seller={seller} document={document} />

      <div className="invoice-info-table">
        <InvoiceCustomerSection customer={customer} />
        <InvoiceDocumentDetails document={document} currency={currency} />
      </div>

      <InvoiceItemsTable items={items} currencyCode={document.currencyCode} tableConfig={layout.table} />

      <InvoiceTotalsSection totals={totals} currencyCode={document.currencyCode} />

      <InvoicePrintFooter footer={footer} />
    </div>
  );
}
