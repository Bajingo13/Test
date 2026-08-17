const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/currency.controller");

const MODULE_KEY = "FILESETUP.CURRENCY_SETUP";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

// Checkpoint 3FX - MUST be registered before the "/:id" routes below,
// otherwise Express would match "fx-accounts" as an :id param on GET/PUT
// "/:id" first and these would never be reached.
router.get("/fx-accounts", authenticateToken, requirePerm("VIEW"), ctrl.getFxAccounts);
router.put("/fx-accounts", authenticateToken, requirePerm("CONFIGURE_FX_ACCOUNTS"), ctrl.updateFxAccounts);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.post("/", authenticateToken, requirePerm("CREATE"), ctrl.create);
router.put("/:id", authenticateToken, requirePerm("EDIT"), ctrl.update);
// Activate/deactivate share one endpoint (per the spec's API design) but
// enforce two distinct permissions - the static route-level middleware
// can't branch on req.body, so the ACTIVATE-vs-DEACTIVATE check happens
// inside the controller itself via PermissionService.can().
router.patch("/:id/status", authenticateToken, ctrl.setStatus);
router.post("/:id/set-base", authenticateToken, requirePerm("SET_BASE"), ctrl.setBase);
router.post("/:id/rates", authenticateToken, ctrl.recordRate); // MANUAL_RATE vs FIXED_RATE - same reasoning as status above.
router.get("/:id/rate-history", authenticateToken, requirePerm("RATE_HISTORY"), ctrl.rateHistory);

module.exports = router;
