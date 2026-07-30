const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/invitations.controller");

// Public - the invited user has no session yet.
router.get("/validate/:token", ctrl.validateToken);
router.post("/accept", ctrl.acceptInvitation);

router.get("/", authenticateToken, authorizePermission("ADMIN.INVITATIONS", "VIEW"), ctrl.listInvitations);
router.post("/", authenticateToken, authorizePermission("ADMIN.INVITATIONS", "CREATE"), ctrl.createInvitation);
router.post("/:id/resend", authenticateToken, authorizePermission("ADMIN.INVITATIONS", "CREATE"), ctrl.resendInvitation);
router.post("/:id/revoke", authenticateToken, authorizePermission("ADMIN.INVITATIONS", "CREATE"), ctrl.revokeInvitation);

module.exports = router;
