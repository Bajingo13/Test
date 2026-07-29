const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const ctrl = require("../controllers/trialBalanceCheckerController");

router.get("/status", authenticateToken, ctrl.getStatus);
router.post("/check", authenticateToken, ctrl.runCheck);
router.get("/runs/:runId", authenticateToken, ctrl.getRun);
router.post("/runs/:runId/recheck", authenticateToken, ctrl.recheck);
router.get("/runs/:runId/export", authenticateToken, ctrl.exportRun);
router.patch("/findings/:findingId", authenticateToken, ctrl.markInvestigated);
router.post("/findings/:findingId/adjustment-draft", authenticateToken, ctrl.createAdjustmentDraft);

module.exports = router;
