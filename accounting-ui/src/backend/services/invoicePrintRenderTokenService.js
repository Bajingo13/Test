const jwt = require("jsonwebtoken");
const { HttpError } = require("../lib/httpError");

// Short-lived, single-purpose render token for the Standard Invoice
// Puppeteer PDF pipeline only.
//
// The Accounting System's real session JWT lives in the browser's
// localStorage (see TransactionPrintOptionsModal.jsx's authHeaders()) -
// Puppeteer's headless page has no access to that storage (fresh browser
// context, different origin semantics), so the React print page
// (StandardInvoicePrintPage) cannot authenticate its data fetch the normal
// way when driven by Puppeteer.
//
// This token is minted SERVER-SIDE, only inside invoicePrintPdfService,
// only after the real user has already passed authenticateToken +
// authorizePermission("TRANSACTIONS.INVOICE","PRINT") on the /pdf export
// route - it is a capability handed to the headless renderer, never a
// fresh identity. It is scoped to exactly one invoice id, one company,
// expires in RENDER_TOKEN_TTL_SECONDS, and is rejected by
// authenticateInvoicePrintAccess.js for any other invoice id or any other
// route.
const RENDER_TOKEN_TYPE = "invoice_print_render";
const RENDER_TOKEN_TTL_SECONDS = 90;

// docType "single" (one invoice, print or with-entries copy) carries
// invoiceId and is only ever accepted for that exact invoice's route.
// docType "list" (the 3 "Print List by ..." summaries) carries no
// invoiceId - it isn't scoped to one document, only to the company/
// permission already checked before minting.
function signInvoicePrintRenderToken({ userId, username, companyId, invoiceId, docType = "single" }) {
  return jwt.sign(
    {
      typ: RENDER_TOKEN_TYPE,
      userId,
      username: username || null,
      companyId,
      docType,
      invoiceId: invoiceId != null ? String(invoiceId) : null,
    },
    process.env.JWT_SECRET,
    { expiresIn: RENDER_TOKEN_TTL_SECONDS }
  );
}

// Public-verification variant: minted only by
// invoicePrintPdfService.renderVerifiedInvoicePdf, only after the public
// /api/verify/:token controller has already independently confirmed the
// token is valid, unaltered, and not voided (invoiceVerificationService).
// There is no real user here (the visitor never authenticated), so this
// payload carries `public: true` instead of a userId - the ONLY effect
// that flag has is telling authenticateInvoicePrintAccess to skip the
// normal authorizePermission re-check for this one request (see that
// file's comment). Everything else about this token is identical to the
// normal one: signed with the same server-only JWT_SECRET, expires in the
// same short TTL, and is rejected outright for any invoice id other than
// the one it was minted for or for the with-entries (internal accounting)
// copy - it can never become a general "print any invoice" credential.
function signPublicVerifiedInvoiceRenderToken({ invoiceId, companyId }) {
  return jwt.sign(
    {
      typ: RENDER_TOKEN_TYPE,
      public: true,
      companyId,
      docType: "single",
      invoiceId: String(invoiceId),
    },
    process.env.JWT_SECRET,
    { expiresIn: RENDER_TOKEN_TTL_SECONDS }
  );
}

function verifyInvoicePrintRenderToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(401, "Invalid or expired render token");
  }
  if (!decoded || decoded.typ !== RENDER_TOKEN_TYPE) {
    throw new HttpError(401, "Invalid render token");
  }
  return decoded;
}

module.exports = {
  signInvoicePrintRenderToken,
  signPublicVerifiedInvoiceRenderToken,
  verifyInvoicePrintRenderToken,
  RENDER_TOKEN_TTL_SECONDS,
};
