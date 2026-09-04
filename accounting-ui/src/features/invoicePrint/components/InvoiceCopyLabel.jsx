import { resolveCopyLabel } from "../utils/invoicePrintFormatters";

// Renders nothing at all when the Accounting System has no print_count
// column (current state - see invoicePrintDataService.js), per the
// migration's explicit "hide the copy label, don't add a DB field" rule.
export default function InvoiceCopyLabel({ printCount }) {
  const label = resolveCopyLabel(printCount);
  if (!label) return null;
  return <div className="invoice-copy-label">{label}</div>;
}
