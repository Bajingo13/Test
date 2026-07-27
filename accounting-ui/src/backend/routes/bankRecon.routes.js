const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const { bankStatementUpload, handleUpload } = require("../services/StatementImportService");
const ctrl = require("../controllers/BankReconController");

router.get("/sessions", authenticateToken, ctrl.listSessions);
router.post("/sessions", authenticateToken, ctrl.createSession);
router.get("/sessions/:id", authenticateToken, ctrl.getSession);
router.patch("/sessions/:id", authenticateToken, ctrl.updateSession);
router.post(
  "/sessions/:id/import",
  authenticateToken,
  handleUpload(bankStatementUpload.single("file")),
  ctrl.importStatement
);
router.get("/sessions/:id/import-batches", authenticateToken, ctrl.listImportBatches);
router.get("/sessions/:id/statement-lines", authenticateToken, ctrl.listStatementLines);
router.delete("/import-batches/:id", authenticateToken, ctrl.deleteImportBatch);
router.post("/sessions/:id/run-matching", authenticateToken, ctrl.runMatching);
router.get("/statement-lines/:id/candidates", authenticateToken, ctrl.getMatchCandidates);
router.get("/sessions/:id/book-items", authenticateToken, ctrl.listBookItems);
router.post("/matches/:id/confirm", authenticateToken, ctrl.confirmMatch);
router.post("/matches/bulk-confirm", authenticateToken, ctrl.bulkConfirmMatches);
router.post("/matches", authenticateToken, ctrl.createManualMatch);
router.delete("/matches/:id", authenticateToken, ctrl.unmatch);
router.post("/statement-lines/:id/ignore", authenticateToken, ctrl.ignoreStatementLine);
router.get("/sessions/:id/outstanding-items", authenticateToken, ctrl.getOutstandingItems);
router.get("/sessions/:id/adjustments", authenticateToken, ctrl.listAdjustments);
router.post("/sessions/:id/adjustments", authenticateToken, ctrl.createAdjustment);
router.post("/adjustments/:id/approve", authenticateToken, ctrl.approveAdjustment);
router.post("/adjustments/:id/reject", authenticateToken, ctrl.rejectAdjustment);
router.post("/adjustments/:id/post", authenticateToken, ctrl.postAdjustment);
router.get("/sessions/:id/summary", authenticateToken, ctrl.getSessionSummary);
router.post("/sessions/:id/finalize", authenticateToken, ctrl.finalizeSession);
router.post("/sessions/:id/reopen", authenticateToken, ctrl.reopenSession);
router.get("/sessions/:id/audit-log", authenticateToken, ctrl.getSessionAuditLog);
router.get("/sessions/:id/report", authenticateToken, ctrl.getSessionReport);

module.exports = router;
