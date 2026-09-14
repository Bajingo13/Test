const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/systemSettings.controller");

// Superadmin-only, per spec - GET is also superadmin-only (not just PUT)
// since even reading whether 2FA is globally required is itself sensitive
// configuration, same posture as users.routes.js's :id/access endpoints.
router.get("/require-2fa-globally", authenticateToken, requireSuperAdmin, ctrl.getRequire2faGlobally);
router.put("/require-2fa-globally", authenticateToken, requireSuperAdmin, ctrl.setRequire2faGlobally);

module.exports = router;
