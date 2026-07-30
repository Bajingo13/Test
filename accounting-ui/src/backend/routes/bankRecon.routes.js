const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { bankStatementUpload, handleUpload } = require("../services/StatementImportService");
const ctrl = require("../controllers/BankReconController");

router.get("/sessions", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listSessions);
router.post("/sessions", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.createSession);
router.get("/sessions/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getSession);
router.patch("/sessions/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.updateSession);
router.post(
  "/sessions/:id/import",
  authenticateToken,
  authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"),
  handleUpload(bankStatementUpload.single("file")),
  ctrl.importStatement
);
router.get("/sessions/:id/import-batches", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listImportBatches);
router.get("/sessions/:id/statement-lines", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listStatementLines);
router.delete("/import-batches/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.deleteImportBatch);
router.post("/sessions/:id/run-matching", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.runMatching);
router.get("/statement-lines/:id/candidates", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getMatchCandidates);
router.get("/sessions/:id/book-items", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listBookItems);
router.post("/matches/:id/confirm", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.confirmMatch);
router.post("/matches/bulk-confirm", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.bulkConfirmMatches);
router.post("/matches", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.createManualMatch);
router.delete("/matches/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.unmatch);
router.post("/statement-lines/:id/ignore", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.ignoreStatementLine);
router.get("/sessions/:id/outstanding-items", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getOutstandingItems);
router.get("/sessions/:id/adjustments", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listAdjustments);
router.post("/sessions/:id/adjustments", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.createAdjustment);
router.post("/adjustments/:id/approve", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), ctrl.approveAdjustment);
router.post("/adjustments/:id/reject", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), ctrl.rejectAdjustment);
router.post("/adjustments/:id/post", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), ctrl.postAdjustment);
router.get("/sessions/:id/summary", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getSessionSummary);
router.post("/sessions/:id/finalize", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), ctrl.finalizeSession);
router.post("/sessions/:id/reopen", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), ctrl.reopenSession);
router.get("/sessions/:id/audit-log", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getSessionAuditLog);
router.get("/sessions/:id/report", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getSessionReport);

module.exports = router;
