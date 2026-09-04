const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const authenticateInvoicePrintAccess = require("../middleware/authenticateInvoicePrintAccess");
const ctrl = require("../controllers/invoicePrint.controller");

const requireInvoicePrintPermission = authorizePermission("TRANSACTIONS.INVOICE", "PRINT");

// Dedicated to the Standard Letter Invoice React printable only - additive,
// invoice-only routes. Do not touch transactionPrint.routes.js or any of
// the other 8 transaction modules it serves.

// PDF export/preview - always the real logged-in user's own session; this
// is the only route that ever mints a Puppeteer render token internally.
router.get("/:id/pdf", authenticateToken, requireInvoicePrintPermission, ctrl.exportInvoicePrintPdf);

// JSON view-model for the React printable - accepts either the real
// user's session (browser) or a short-lived, invoice-scoped render token
// (Puppeteer only). See authenticateInvoicePrintAccess.js.
router.get("/:id", authenticateInvoicePrintAccess, ctrl.getInvoicePrintDocument);

module.exports = router;
