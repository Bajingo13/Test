const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const InvoiceVerificationService = require("../services/invoiceVerificationService");
const InvoicePrintPdfService = require("../services/invoicePrintPdfService");

// One fixed, minimal response shape for every non-valid case (invalid
// token, wrong format, nonexistent record, voided/cancelled invoice, or a
// signature mismatch/"altered" invoice) - per spec, a visitor must never be
// able to distinguish "this token never existed" from "this token existed
// but the invoice was altered" from "this invoice was voided". All of them
// look identical on the wire.
const INVALID_RESPONSE = { status: "invalid" };

// Public lookup - GET /api/verify/:token. No authenticateToken, no
// company/session context; the token itself (found only by exact,
// cryptographically-random match - see invoiceVerificationService) is the
// only credential. Rate-limited and helmet-hardened at the router level
// (invoiceVerification.routes.js), scoped to this router only.
exports.verifyInvoice = async (req, res) => {
  const { token } = req.params;
  // A malformed token can never match a real row, but short-circuiting on
  // shape avoids a pointless DB round trip for obviously-invalid input
  // (path traversal attempts, empty string, etc.).
  if (!/^[a-f0-9]{32}$/i.test(String(token || ""))) {
    return res.json(INVALID_RESPONSE);
  }

  try {
    const invoice = await InvoiceVerificationService.findByToken(token);
    const result = InvoiceVerificationService.classifyInvoice(invoice);

    // Server-side-only audit trail of verification attempts (never
    // returned to the caller) - lets an admin later notice a token being
    // hammered, or a burst of "altered"/"voided" results worth
    // investigating. entityId is only set when a row was actually found,
    // so a random-string probe doesn't create a misleading audit row
    // pointing at entityId null.
    await logAudit(pool, {
      module: "PUBLIC.INVOICE_VERIFICATION",
      entityType: "INVOICE",
      entityId: invoice ? invoice.id : null,
      action: "VERIFY",
      description: `Public invoice verification (result=${result.reason})`,
      ...requestMeta(req),
    });

    if (!result.valid) {
      return res.json(INVALID_RESPONSE);
    }

    return res.json({
      status: "valid",
      issuerName: invoice.companyId != null ? await getIssuerName(invoice.companyId) : null,
      invoiceDate: invoice.transactionDate,
      totalAmount: Number(invoice.totalDebit) || 0,
    });
  } catch (err) {
    console.error("INVOICE VERIFICATION ERROR:", err);
    // Never leak err.message here - a stack/DB error string could reveal
    // schema/internal detail to an unauthenticated caller. Same generic
    // shape as every other non-valid outcome.
    return res.status(200).json(INVALID_RESPONSE);
  }
};

// Public verified-PDF download - GET /api/verify/:token/pdf. Re-runs the
// exact same validity check as verifyInvoice (never trusts a prior
// request) before ever touching the PDF renderer.
exports.downloadVerifiedInvoicePdf = async (req, res) => {
  const { token } = req.params;
  if (!/^[a-f0-9]{32}$/i.test(String(token || ""))) {
    return res.status(404).json({ message: "Not found" });
  }

  try {
    const invoice = await InvoiceVerificationService.findByToken(token);
    const result = InvoiceVerificationService.classifyInvoice(invoice);

    await logAudit(pool, {
      module: "PUBLIC.INVOICE_VERIFICATION",
      entityType: "INVOICE",
      entityId: invoice ? invoice.id : null,
      action: "VERIFY_PDF_DOWNLOAD",
      description: `Public verified-invoice PDF download (result=${result.reason})`,
      ...requestMeta(req),
    });

    if (!result.valid) {
      return res.status(404).json({ message: "Not found" });
    }

    const pdfBuffer = await InvoicePrintPdfService.renderVerifiedInvoicePdf({
      invoiceId: invoice.id,
      companyId: invoice.companyId,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Invoice.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("VERIFIED INVOICE PDF DOWNLOAD ERROR:", err);
    res.status(500).json({ message: "Failed to generate PDF." });
  }
};

async function getIssuerName(companyId) {
  const [rows] = await pool.execute(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  return rows[0]?.name || null;
}
