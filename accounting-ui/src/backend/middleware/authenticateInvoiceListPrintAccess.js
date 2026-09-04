const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("./authorizePermission");
const { verifyInvoicePrintRenderToken } = require("../services/invoicePrintRenderTokenService");

const requireInvoicePrintPermission = authorizePermission("TRANSACTIONS.INVOICE", "PRINT");

// Same shape as authenticateInvoicePrintAccess.js, for the 3 "Print List
// by ..." summaries instead of a single invoice - a list isn't scoped to
// one document id, so the only extra check here is docType === "list"
// (never accepted on the single-invoice route or vice versa).
module.exports = function authenticateInvoiceListPrintAccess(req, res, next) {
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

  if (payload.docType !== "list") {
    return res.status(403).json({ message: "Render token is not valid for a list print." });
  }

  req.user = { id: payload.userId, username: payload.username || null };
  req.printRenderToken = payload;

  return requireInvoicePrintPermission(req, res, next);
};
