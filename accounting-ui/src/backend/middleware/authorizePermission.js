const pool = require("../db");
const { logAudit } = require("../lib/audit");
const PermissionService = require("../services/permissionService");

// Express middleware factory - use after authenticateToken. Denies with a
// clear 403 and audit-logs an ACCESS_DENIED entry (backend enforcement,
// not just hiding a frontend button, per the spec's explicit requirement).
function authorizePermission(moduleKey, action) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Access token required" });
    }

    try {
      const allowed = await PermissionService.can(req.user.id, moduleKey, action);
      if (!allowed) {
        await logAudit(pool, {
          module: "ACCESS_CONTROL",
          entityType: "PERMISSION",
          entityId: null,
          action: "ACCESS_DENIED",
          description: `User ${req.user.username} was denied ${action} on ${moduleKey}`,
          afterData: { moduleKey, action, path: req.originalUrl, method: req.method },
          user: req.user,
        });
        return res.status(403).json({ message: "You do not have permission to perform this action" });
      }
      next();
    } catch (err) {
      console.error("AUTHORIZE PERMISSION ERROR:", err);
      res.status(500).json({ message: "Failed to verify permissions" });
    }
  };
}

module.exports = authorizePermission;
