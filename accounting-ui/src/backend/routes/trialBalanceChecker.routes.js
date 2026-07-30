const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/trialBalanceCheckerController");

router.get("/status", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.getStatus);
router.post("/check", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.runCheck);
router.get("/runs/:runId", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.getRun);
router.post("/runs/:runId/recheck", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.recheck);
router.get("/runs/:runId/export", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.exportRun);
router.patch("/findings/:findingId", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "VIEW"), ctrl.markInvestigated);
router.post("/findings/:findingId/adjustment-draft", authenticateToken, authorizePermission("REPORTS.TRIAL_BALANCE_CHECKER", "CONFIGURE"), ctrl.createAdjustmentDraft);

module.exports = router;
