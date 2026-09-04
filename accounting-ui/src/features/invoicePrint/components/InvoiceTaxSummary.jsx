import { formatMoney } from "../utils/invoicePrintFormatters";

// Ported from the Replica's TAX SUMMARY payment-table. Each row is hidden
// (not rendered as 0.00) whenever its backing value is null - i.e. there
// were no Output VAT entries for this invoice at all (see
// transactionPrintDataService.getOutputVatSummary's own "no fabricated
// 0.00" rule, which invoicePrintDataService passes through unchanged).
function Row({ label, value, strong }) {
  if (value === null || value === undefined) return null;
  const Label = strong ? "strong" : "span";
  return (
    <tr>
      <td><Label>{label}</Label></td>
      <td>{formatMoney(value)}</td>
    </tr>
  );
}

export default function InvoiceTaxSummary({ totals, currencyCode }) {
  return (
    <table className="invoice-tax-summary">
      <thead>
        <tr>
          <th colSpan={2}>TAX SUMMARY</th>
        </tr>
      </thead>
      <tbody>
        <Row label="VATable Sales" value={totals.vatableSales} />
        <Row label="Add: VAT Amount" value={totals.vatAmount} />
        <Row label="VAT Exempt Sales" value={totals.vatExemptSales} />
        <Row label="VAT Zero Rated Sales" value={totals.zeroRatedSales} />
        <Row label="Subtotal" value={totals.subtotal} />
        <Row label="Less: Discount" value={totals.discount} />
        <Row label="Less: Withholding Tax" value={totals.withholdingAmount} />
        <Row label={`Total Amount Due (${currencyCode})`} value={totals.totalAmountDue} strong />
      </tbody>
    </table>
  );
}
