// Ported from the Replica's signature card + BIR compliance footer +
// print-footer-meta (timestamp/system logo). birPermitNumber/atpDate/
// serialNumbers now come from company_profile's ATP columns (see
// invoicePrintDataService.js's birComplianceInfo block); atpNumber has no
// backing column and stays null. preparedBy/approvedBy/signature still
// have no backing columns on invoice_headers. Every field here is hidden
// cleanly (not shown blank) whenever its value is null.
export default function InvoicePrintFooter({ footer }) {
  const hasBirInfo = footer.birPermitNumber || footer.atpNumber || footer.atpDate || footer.serialNumbers;
  const hasSignOff = footer.preparedBy || footer.approvedBy;

  return (
    <>
      {footer.remarks ? (
        <div className="invoice-remarks">
          <strong>Remarks:</strong> {footer.remarks}
        </div>
      ) : null}

      <div className="invoice-signature-wrap">
        <div className="invoice-signature-card">
          {footer.signature ? (
            <>
              <img src={footer.signature} alt="Signature" className="invoice-signature-image" />
              <div className="invoice-signature-line" />
            </>
          ) : (
            <div className="invoice-signature-fallback">
              THIS IS SYSTEM GENERATED. NO SIGNATURE REQUIRED.
            </div>
          )}
        </div>
      </div>

      {hasSignOff ? (
        <div className="invoice-signoff">
          {footer.preparedBy ? (
            <div>
              <strong>Prepared by:</strong> {footer.preparedBy}
            </div>
          ) : null}
          {footer.approvedBy ? (
            <div>
              <strong>Approved by:</strong> {footer.approvedBy}
            </div>
          ) : null}
        </div>
      ) : null}

      {hasBirInfo ? (
        <footer className="invoice-bir-footer">
          {footer.atpNumber ? <div>ATP No.: {footer.atpNumber}</div> : null}
          {footer.birPermitNumber ? <div>BIR Permit No.: {footer.birPermitNumber}</div> : null}
          {footer.atpDate ? <div>Date Issued: {footer.atpDate}</div> : null}
          {footer.serialNumbers ? (
            <div>
              Approved Serial Nos.: {footer.serialNumbers.from || "—"} to {footer.serialNumbers.to || "—"}
            </div>
          ) : null}
        </footer>
      ) : null}

      <div className="invoice-print-footer-meta">
        <span className="invoice-print-timestamp" />
        <span className="invoice-print-page" />
      </div>
    </>
  );
}
