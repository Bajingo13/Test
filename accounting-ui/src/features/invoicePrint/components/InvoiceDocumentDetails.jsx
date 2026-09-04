import { formatCurrencyLabel, formatExchangeRate } from "../utils/invoicePrintFormatters";

// Ported from the Replica's #invoiceMetaBlock (Currency / Rate / Terms
// info-grid). "Terms" has no backing column on invoice_headers today (see
// invoicePrintDataService.js) - the row still renders so the Standard
// layout stays visually stable, with an empty value rather than a
// fabricated one.
export default function InvoiceDocumentDetails({ document, currency }) {
  return (
    <div className="invoice-meta-block">
      <div className="invoice-meta-row">
        <span className="invoice-meta-label">Currency</span>
        <span className="invoice-meta-value">
          {formatCurrencyLabel(document.currencyCode, currency?.currencyName)}
        </span>
      </div>
      <div className="invoice-meta-row">
        <span className="invoice-meta-label">Rate</span>
        <span className="invoice-meta-value">{formatExchangeRate(document.exchangeRate)}</span>
      </div>
      <div className="invoice-meta-row">
        <span className="invoice-meta-label">Terms</span>
        <span className="invoice-meta-value">{document.terms || ""}</span>
      </div>
    </div>
  );
}
