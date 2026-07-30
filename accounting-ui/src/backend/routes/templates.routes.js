const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/templates.controller");

// Read is available to anyone authenticated (needed to populate the
// template picker in InviteUserModal) - write/apply is Super-Admin-only,
// same rationale as Access Restrictions.
router.get("/", authenticateToken, ctrl.listTemplates);
router.get("/:id", authenticateToken, ctrl.getTemplate);
router.post("/", authenticateToken, requireSuperAdmin, ctrl.createTemplate);
router.put("/:id", authenticateToken, requireSuperAdmin, ctrl.updateTemplate);
router.delete("/:id", authenticateToken, requireSuperAdmin, ctrl.deleteTemplate);
router.post("/:id/apply", authenticateToken, requireSuperAdmin, ctrl.applyTemplate);

module.exports = router;
