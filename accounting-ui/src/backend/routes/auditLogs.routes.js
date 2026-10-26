const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { logAudit } = require("../lib/audit");
const AuditLogService = require("../services/auditLogService");

// Mounted at /api/audit-logs. Every route needs ADMIN.AUDIT_LOGS/VIEW (Super
// Admin bypasses permission checks as everywhere else); company scope is
// enforced inside AuditLogService for list, detail and export alike.
const canView = authorizePermission("ADMIN.AUDIT_LOGS", "VIEW");

function sendError(res, err, fallback) {
  if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ message: err.message });
  console.error(`${fallback.toUpperCase()} ERROR:`, err);
  return res.status(500).json({ message: fallback });
}

// List. The body stays a plain array (existing contract); paging metadata
// travels in headers: X-Next-Cursor (pass back as ?cursor=), X-Has-More,
// X-Page-Limit (the limit actually applied, max 200).
router.get("/", authenticateToken, canView, async (req, res) => {
  try {
    const page = await AuditLogService.listAuditLogs(req.user, req.query);
    res.set({
      "X-Has-More": String(page.hasMore),
      "X-Page-Limit": String(page.limit),
      "Access-Control-Expose-Headers": "X-Next-Cursor, X-Has-More, X-Page-Limit",
    });
    if (page.nextCursor) res.set("X-Next-Cursor", page.nextCursor);
    res.json(page.items);
  } catch (err) {
    sendError(res, err, "Failed to load audit logs");
  }
});

// CSV export: same scope and filters as the list, capped at
// MAX_EXPORT_ROWS (X-Export-Truncated: true when the cap was hit). The
// export itself is audited.
router.get("/export", authenticateToken, canView, async (req, res) => {
  try {
    const result = await AuditLogService.exportAuditLogs(req.user, req.query);
    const singleCompany = result.scope.companyIds && result.scope.companyIds.length === 1 ? result.scope.companyIds[0] : null;
    await logAudit(pool, {
      module: "AUDIT_LOGS",
      entityType: "AUDIT_LOG",
      entityId: null,
      action: "EXPORT",
      description: `${req.user.username} exported ${result.items.length} audit log row(s)${result.truncated ? " (truncated)" : ""}`,
      afterData: {
        rowCount: result.items.length,
        truncated: result.truncated,
        scope: result.scope.systemOnly ? "system" : result.scope.companyIds === null ? "all" : "company",
        companyIds: result.scope.companyIds,
        filters: { ...result.filters, from: result.filters.from?.value, to: result.filters.to?.value },
      },
      user: req.user,
      companyId: singleCompany,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-logs-${stamp}.csv"`,
      "X-Export-Truncated": String(result.truncated),
      "X-Export-Max-Rows": String(AuditLogService.MAX_EXPORT_ROWS),
      "Access-Control-Expose-Headers": "X-Export-Truncated, X-Export-Max-Rows, Content-Disposition",
    });
    res.send(AuditLogService.toCsv(result.items));
  } catch (err) {
    sendError(res, err, "Failed to export audit logs");
  }
});

// Detail. Unknown and out-of-scope ids return the same 404.
router.get("/:id", authenticateToken, canView, async (req, res) => {
  try {
    res.json(await AuditLogService.getAuditLog(req.user, req.params.id));
  } catch (err) {
    sendError(res, err, "Failed to load audit log");
  }
});

module.exports = router;
