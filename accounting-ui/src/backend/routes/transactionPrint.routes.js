const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/transactionPrint.controller");

// mode=with_entries needs the stronger permission; everything else
// (without_entries, list printing) only needs the base PRINT action. The
// permission check itself still goes through the same fail-closed
// authorizePermission()/permissionService.can() used everywhere else - this
// just picks which action to check based on the requested mode.
function requireInvoicePrintPermission(req, res, next) {
  const mode = req.query.mode || req.body?.mode;
  const action = mode === "with_entries" ? "PRINT_WITH_ENTRIES" : "PRINT";
  return authorizePermission("TRANSACTIONS.INVOICE", action)(req, res, next);
}

router.get("/invoice/:id", authenticateToken, requireInvoicePrintPermission, ctrl.getInvoiceDocument);
router.post("/invoice-list", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "PRINT"), ctrl.getInvoiceList);

module.exports = router;
