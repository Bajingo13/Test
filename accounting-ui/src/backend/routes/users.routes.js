const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/users.controller");
const rateLimit = require("express-rate-limit");
const { requireCredentialAdminEnabled, requireCredentialAdmin } = require("../lib/credentialPolicy");

const credentialAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => `user-credentials-admin:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
});

router.get("/", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "VIEW"), ctrl.listUsers);
router.get("/:id", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "VIEW"), ctrl.getUser);
router.patch("/:id", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.updateUserAccess);
router.patch("/:id/status", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.updateUserStatus);
router.post("/:id/unlock", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.unlockUser);
router.post("/:id/revoke-sessions", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.revokeSessions);
// Administrative credential changes (lib/credentialPolicy): 404 unless the
// deployment enables them; then SUPER_ADMIN / ADMIN within their manage scope.
const credentialAdmin = [requireCredentialAdminEnabled, authenticateToken, requireCredentialAdmin, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), credentialAdminLimiter];
router.post("/:id/reset-password", ...credentialAdmin, ctrl.resetPassword);
router.post("/:id/change-username", ...credentialAdmin, ctrl.changeUsername);
router.get("/:id/access", authenticateToken, requireSuperAdmin, ctrl.getUserAccess);
router.put("/:id/access", authenticateToken, requireSuperAdmin, ctrl.setUserAccess);

module.exports = router;
