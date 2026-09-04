const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const authenticateInvoicePrintAccess = require("../middleware/authenticateInvoicePrintAccess");
const authenticateInvoiceListPrintAccess = require("../middleware/authenticateInvoiceListPrintAccess");
const ctrl = require("../controllers/invoicePrint.controller");

// Dedicated to the Standard Letter Invoice React printable only - additive,
// invoice-only routes. Do not touch transactionPrint.routes.js or any of
// the other 8 transaction modules it serves.

// Mirrors transactionPrint.routes.js's own rule: the internal accounting
// copy (?mode=with_entries) needs the stronger PRINT_WITH_ENTRIES action.
function requirePrintPermission(req, res, next) {
  const action = req.query.mode === "with_entries" ? "PRINT_WITH_ENTRIES" : "PRINT";
  return authorizePermission("TRANSACTIONS.INVOICE", action)(req, res, next);
}

// PDF export/preview (single invoice) - always the real logged-in user's
// own session; this is the only route that ever mints a Puppeteer render
// token internally.
router.get("/:id/pdf", authenticateToken, requirePrintPermission, ctrl.exportInvoicePrintPdf);

// The 3 "Print List by ..." summaries - JSON view model + PDF export.
// Declared before "/:id" so "list" is never captured by that param route.
router.get("/list", authenticateInvoiceListPrintAccess, ctrl.getInvoiceListPrintDocument);
router.get("/list/pdf", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "PRINT"), ctrl.exportInvoiceListPrintPdf);

// JSON view-model for the single-invoice React printable - accepts either
// the real user's session (browser) or a short-lived, invoice-scoped
// render token (Puppeteer only). See authenticateInvoicePrintAccess.js.
router.get("/:id", authenticateInvoicePrintAccess, ctrl.getInvoicePrintDocument);

module.exports = router;
