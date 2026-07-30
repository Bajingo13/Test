const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/users.controller");

router.get("/", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "VIEW"), ctrl.listUsers);
router.get("/:id", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "VIEW"), ctrl.getUser);
router.patch("/:id", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.updateUserAccess);
router.patch("/:id/status", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.updateUserStatus);
router.post("/:id/unlock", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.unlockUser);
router.post("/:id/revoke-sessions", authenticateToken, authorizePermission("ADMIN.USER_SETTINGS", "EDIT"), ctrl.revokeSessions);
router.get("/:id/access", authenticateToken, requireSuperAdmin, ctrl.getUserAccess);
router.put("/:id/access", authenticateToken, requireSuperAdmin, ctrl.setUserAccess);

module.exports = router;
