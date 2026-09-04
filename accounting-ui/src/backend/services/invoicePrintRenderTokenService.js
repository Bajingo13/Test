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

module.exports = { signInvoicePrintRenderToken, verifyInvoicePrintRenderToken, RENDER_TOKEN_TTL_SECONDS };
