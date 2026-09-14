import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchInvoiceVerification, verifiedInvoicePdfUrl } from "../services/invoiceVerificationApi";
import { formatMoney, formatDate } from "../utils/invoicePrintFormatters";

// Public, unauthenticated invoice-verification page - the QR scan target
// (InvoiceVerificationQr). Deliberately shows the minimum needed to
// confirm authenticity: issuer name, invoice date, total amount. Never
// the customer's name, internal id, voucher number, journal entries, or
// any other private/audit data - the backend (/api/verify/:token) already
// enforces this by only ever returning that same minimal shape, but the
// page itself is written to never even request anything more.
export default function PublicInvoiceVerificationPage() {
  const { token } = useParams();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchInvoiceVerification(token, { signal: controller.signal })
      .then((data) => setResult(data))
      .catch(() => setResult({ status: "invalid" }))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [token]);

  return (
    <div
      style={{
        maxWidth: 420,
        margin: "48px auto",
        padding: "32px 28px",
        fontFamily: "Arial, sans-serif",
        border: "1px solid #ddd",
        borderRadius: 8,
        textAlign: "center",
      }}
    >
      {loading ? (
        <p>Verifying…</p>
      ) : result?.status === "valid" ? (
        <>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <h2 style={{ margin: "0 0 4px" }}>Invoice Verified</h2>
          <p style={{ color: "#555", marginBottom: 24 }}>
            This is an authentic invoice issued by the entity below.
          </p>
          <div style={{ textAlign: "left", fontSize: 14, lineHeight: 1.8 }}>
            <div>
              <strong>Issued by:</strong> {result.issuerName || "—"}
            </div>
            <div>
              <strong>Invoice Date:</strong> {formatDate(result.invoiceDate)}
            </div>
            <div>
              <strong>Total Amount:</strong> {formatMoney(result.totalAmount)}
            </div>
          </div>
          <a
            href={verifiedInvoicePdfUrl(token)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              marginTop: 24,
              padding: "10px 20px",
              background: "#198754",
              color: "#fff",
              borderRadius: 6,
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            View / Download PDF
          </a>
        </>
      ) : (
        <>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <h2 style={{ margin: "0 0 4px" }}>Cannot Verify This Invoice</h2>
          <p style={{ color: "#555" }}>
            This verification link is invalid, expired, or does not correspond to an authentic invoice.
          </p>
        </>
      )}
    </div>
  );
}
