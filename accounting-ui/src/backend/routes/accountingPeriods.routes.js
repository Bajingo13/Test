const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/accountingPeriods.controller");

const MODULE_KEY = "ACCOUNTING_PERIODS";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/history", authenticateToken, requirePerm("VIEW"), ctrl.history);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.get("/:id/checklist", authenticateToken, requirePerm("VIEW"), ctrl.checklist);
router.post("/generate-year", authenticateToken, requirePerm("GENERATE"), ctrl.generateYear);
router.post("/:id/soft-close", authenticateToken, requirePerm("SOFT_CLOSE"), ctrl.softClose);
router.post("/:id/close", authenticateToken, requirePerm("CLOSE"), ctrl.close);
router.post("/:id/reopen", authenticateToken, requirePerm("REOPEN"), ctrl.reopen);

module.exports = router;