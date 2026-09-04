import InvoiceTaxSummary from "./InvoiceTaxSummary";
import { formatMoney } from "../utils/invoicePrintFormatters";

// Ported from the Replica's .print-summary-layout row. The Replica's
// left-hand "Payment Terms & Conditions" rich-text box has no backing
// column on invoice_headers (only a plain, currently-null `terms` value
// exists - see InvoiceDocumentDetails) so it is not rendered here; the tax
// summary box simply takes the full width, matching the Replica's own
// `.no-payment-terms` state for invoices without payment-terms content.
export default function InvoiceTotalsSection({ totals, currencyCode }) {
  const hasPaidBalance = totals.paidAmount !== null || totals.balanceAmount !== null;

  return (
    <div className="invoice-summary-layout invoice-summary-layout--no-payment-terms">
      <div className="invoice-tax-summary-wrap">
        <InvoiceTaxSummary totals={totals} currencyCode={currencyCode} />
        {hasPaidBalance ? (
          <table className="invoice-tax-summary invoice-tax-summary--paid-balance">
            <tbody>
              {totals.paidAmount !== null ? (
                <tr>
                  <td>Paid Amount</td>
                  <td>{formatMoney(totals.paidAmount)}</td>
                </tr>
              ) : null}
              {totals.balanceAmount !== null ? (
                <tr>
                  <td><strong>Balance</strong></td>
                  <td><strong>{formatMoney(totals.balanceAmount)}</strong></td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
