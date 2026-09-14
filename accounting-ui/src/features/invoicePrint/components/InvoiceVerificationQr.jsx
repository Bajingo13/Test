import { QRCodeSVG } from "qrcode.react";

// QR verification code, rendered beside the copy label (ORIGINAL COPY/
// DUPLICATE COPY/etc. - see InvoiceCopyLabel). The QR payload is the
// public verification URL the backend already built from this invoice's
// verification_token (invoicePrintDataService.js) - never the invoice
// number or internal id, and the same URL on every reprint/PDF export
// since the token is minted once at issuance and never regenerated.
// Renders nothing for an invoice created before this feature shipped
// (verificationUrl is null - no backfill, see invoice_verification_migration.sql).
export default function InvoiceVerificationQr({ verificationUrl }) {
  if (!verificationUrl) return null;

  return (
    <div className="invoice-verification-qr">
      <QRCodeSVG value={verificationUrl} size={64} level="M" marginSize={0} />
      <span className="invoice-verification-qr__label">Scan to verify</span>
    </div>
  );
}
