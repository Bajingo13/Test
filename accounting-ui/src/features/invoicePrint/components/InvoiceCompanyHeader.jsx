import InvoiceCopyLabel from "./InvoiceCopyLabel";
import { formatDate } from "../utils/invoicePrintFormatters";

// Layout structure ported from the Replica's .header (logo | company-info |
// invoice-box three-column row). Per-company logo/header alignment
// (data-logo-align etc. in the original) has no equivalent stored anywhere
// in the Accounting System today, so this always renders the fixed
// three-column Standard arrangement - no per-company override exists to
// apply.
export default function InvoiceCompanyHeader({ seller, document }) {
  return (
    <div className="invoice-header">
      <div className="invoice-header__logo">
        {seller.logoUrl ? <img src={seller.logoUrl} alt="Company logo" /> : null}
      </div>

      <div className="invoice-header__company">
        <strong>{seller.businessName || seller.name}</strong>
        <br />
        {seller.address ? <span>{seller.address}</span> : null}
        {seller.phone ? <><br />Tel. No.: <span>{seller.phone}</span></> : null}
        <br />
        VAT Reg. TIN: <span>{seller.tin}</span>
      </div>

      <div className="invoice-header__meta">
        <InvoiceCopyLabel printCount={document.printCount} />
        {document.accountingStatus ? (
          <div className={`invoice-status invoice-status--${document.accountingStatus.toLowerCase()}`}>
            {document.accountingStatus}
          </div>
        ) : null}
        <div className="invoice-title">{(document.invoiceType || "Sales Invoice").toUpperCase()}</div>
        <div>
          <strong>Invoice No.:</strong> <span>{document.invoiceNumber}</span>
        </div>
        <div>
          <strong>Date:</strong> <span>{formatDate(document.invoiceDate)}</span>
        </div>
        {document.dueDate ? (
          <div>
            <strong>Due Date:</strong> <span>{formatDate(document.dueDate)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
