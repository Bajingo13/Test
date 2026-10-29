const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { bankStatementUpload, handleUpload } = require("../services/StatementImportService");
const ctrl = require("../controllers/BankReconController");
const { requireAccess } = require("../services/bankReconAccessService");

// Company isolation: every route that names a session (or a child record of
// one) passes through requireAccess, which resolves record -> session ->
// company and answers out-of-scope ids with the same 404 as unknown ones.
const session = requireAccess("session");
const batch = requireAccess("batch");
const line = requireAccess("line");
const match = requireAccess("match");
const adjustment = requireAccess("adjustment");

router.get("/sessions", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.listSessions);
router.post("/sessions", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), ctrl.createSession);
// R8.4-A: opening balance a new session would get (before /sessions/:id).
router.get("/sessions/opening-balance", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), ctrl.getOpeningBalance);
router.get("/sessions/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getSession);
router.patch("/sessions/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), session, ctrl.updateSession);
router.post(
  "/sessions/:id/import",
  authenticateToken,
  authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"),
  session,
  handleUpload(bankStatementUpload.single("file")),
  ctrl.importStatement
);
router.post(
  "/sessions/:id/import/preview",
  authenticateToken,
  authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"),
  session,
  handleUpload(bankStatementUpload.single("file")),
  ctrl.previewStatement
);
router.get("/sessions/:id/import-batches", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.listImportBatches);
router.get("/sessions/:id/statement-lines", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.listStatementLines);
router.delete("/import-batches/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), batch, ctrl.deleteImportBatch);
router.post("/sessions/:id/run-matching", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), session, ctrl.runMatching);
router.get("/sessions/:id/queue", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getQueue);
router.get("/statement-lines/:id/candidates", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), line, ctrl.getMatchCandidates);
router.get("/sessions/:id/book-items", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.listBookItems);
router.post("/matches/:id/confirm", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), match, ctrl.confirmMatch);
router.post("/matches/bulk-confirm", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), requireAccess("session", { from: "body", field: "sessionId" }), ctrl.bulkConfirmMatches);
router.post("/matches", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), requireAccess("line", { from: "body", field: "statementLineId" }), ctrl.createManualMatch);
router.delete("/matches/:id", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), match, ctrl.unmatch);
router.post("/statement-lines/:id/ignore", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), line, ctrl.ignoreStatementLine);
router.get("/sessions/:id/outstanding-items", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getOutstandingItems);
router.get("/sessions/:id/adjustments", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.listAdjustments);
router.post("/sessions/:id/adjustments", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "CREATE"), session, ctrl.createAdjustment);
router.post("/adjustments/:id/approve", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), adjustment, ctrl.approveAdjustment);
router.post("/adjustments/:id/reject", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), adjustment, ctrl.rejectAdjustment);
router.post("/adjustments/:id/post", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), adjustment, ctrl.postAdjustment);
router.get("/sessions/:id/summary", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getSessionSummary);
router.post("/sessions/:id/finalize", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), session, ctrl.finalizeSession);
router.post("/sessions/:id/reopen", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "APPROVE"), session, ctrl.reopenSession);
router.get("/sessions/:id/audit-log", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getSessionAuditLog);
router.get("/sessions/:id/report", authenticateToken, authorizePermission("REPORTS.BANK_RECONCILIATION", "VIEW"), session, ctrl.getSessionReport);

module.exports = router;
