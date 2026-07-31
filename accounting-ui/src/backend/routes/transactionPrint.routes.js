const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/transactionPrint.controller");
const { MODULE_CONFIG } = require("../services/transactionPrintDataService");

// mode=with_entries needs the stronger permission; everything else
// (without_entries, list printing) only needs the base PRINT action. The
// permission check itself still goes through the same fail-closed
// authorizePermission()/permissionService.can() used everywhere else - this
// just picks which module_key/action to check based on the URL/mode.
function requirePrintPermission(req, res, next) {
  const cfg = MODULE_CONFIG[req.params.transactionType];
  if (!cfg) {
    return res.status(400).json({ message: `Unsupported print module: ${req.params.transactionType}` });
  }
  const mode = req.query.mode || req.body?.mode;
  const action = mode === "with_entries" ? "PRINT_WITH_ENTRIES" : "PRINT";
  return authorizePermission(cfg.moduleKey, action)(req, res, next);
}

router.get("/:transactionType/:id", authenticateToken, requirePrintPermission, ctrl.getDocument);
router.post("/:transactionType/list", authenticateToken, requirePrintPermission, ctrl.getList);

module.exports = router;
