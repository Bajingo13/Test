const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("./authorizePermission");
const { verifyInvoicePrintRenderToken } = require("../services/invoicePrintRenderTokenService");

const requireInvoicePrintPermission = authorizePermission("TRANSACTIONS.INVOICE", "PRINT");

// Guards the invoice print JSON view-model route (GET /api/invoice-print/:id)
// for its two legitimate callers:
//   1. A real logged-in user's browser (preview page, the viewer) - normal
//      Authorization: Bearer <session JWT>, exactly like every other
//      protected route (authenticateToken + authorizePermission).
//   2. The Puppeteer PDF renderer's headless page - a short-lived,
//      invoice-scoped renderToken (see invoicePrintRenderTokenService.js),
//      never a fresh identity and never valid for any other invoice/route.
// authenticateToken() sends its own 401 response and does not call `next()`
// on failure, so branching on renderToken presence first (rather than
// "try normal auth, fall back on failure") keeps this simple and correct.
module.exports = function authenticateInvoicePrintAccess(req, res, next) {
  const renderToken = req.query.renderToken || req.headers["x-print-render-token"];

  if (!renderToken) {
    return authenticateToken(req, res, (err) => {
      if (err) return next(err);
      return requireInvoicePrintPermission(req, res, next);
    });
  }

  let payload;
  try {
    payload = verifyInvoicePrintRenderToken(renderToken);
  } catch (err) {
    return res.status(err.statusCode || 401).json({ message: err.message || "Invalid render token" });
  }

  if (String(payload.invoiceId) !== String(req.params.id)) {
    return res.status(403).json({ message: "Render token is not valid for this invoice" });
  }

  req.user = { id: payload.userId, username: payload.username || null };
  req.printRenderToken = payload;

  // Defense in depth: still re-verifies PRINT permission for the token's
  // own user, even though the /pdf export route already checked it once
  // before minting this token.
  return requireInvoicePrintPermission(req, res, next);
};
