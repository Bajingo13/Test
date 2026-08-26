const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/printTemplate.controller");
const PrintTemplateService = require("../services/printTemplateService");
const DataService = require("../services/transactionPrintDataService");

const MODULE_KEY = "PRINT.DOCUMENT_TEMPLATES";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

// Phase 3B: preview must never be gated by PRINT.DOCUMENT_TEMPLATES alone -
// that would let anyone who can manage templates preview ANY company's
// transaction data merely by supplying its id. Instead this mirrors
// transactionPrint.routes.js's own requirePrintPermission exactly: the
// real transaction module's own PRINT permission (TRANSACTIONS.INVOICE /
// TRANSACTIONS.OR) is what's actually checked, so previewing can never
// see more than the normal print endpoint already allows. moduleType is
// validated against the Phase 2 whitelist FIRST (before any permission
// check even runs) so an unsupported module type never reaches the
// controller at all, and mergeAndValidateConfig() downstream never has to
// defend against a moduleType outside "invoice"/"or".
function requirePreviewPermission(req, res, next) {
  const moduleType = req.body?.moduleType;
  if (!PrintTemplateService.SUPPORTED_MODULE_TYPES.includes(moduleType)) {
    return res.status(400).json({
      message: `Unsupported print-template module type: ${moduleType}. Supported: ${PrintTemplateService.SUPPORTED_MODULE_TYPES.join(", ")}.`,
    });
  }
  const cfg = DataService.MODULE_CONFIG[moduleType];
  return authorizePermission(cfg.moduleKey, "PRINT")(req, res, next);
}

// Registered before "/:id" so "/built-in" and "/preview" are never
// swallowed by the ":id" param route.
router.get("/built-in", authenticateToken, requirePerm("VIEW"), ctrl.getBuiltIn);
router.post("/preview", authenticateToken, requirePreviewPermission, ctrl.preview);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.post("/", authenticateToken, requirePerm("CREATE"), ctrl.create);
router.put("/:id", authenticateToken, requirePerm("EDIT"), ctrl.update);
router.post("/:id/set-default", authenticateToken, requirePerm("SET_DEFAULT"), ctrl.setDefault);
router.post("/:id/activate", authenticateToken, requirePerm("ACTIVATE"), ctrl.activate);
router.post("/:id/deactivate", authenticateToken, requirePerm("DEACTIVATE"), ctrl.deactivate);

module.exports = router;
