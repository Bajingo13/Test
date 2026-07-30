const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/roles.controller");

// Mounted at /api - full paths below match the endpoints named in the plan.
// Read-only in Phase 1; write endpoints (PUT /api/roles/:id/permissions
// etc.) arrive in Phase 4 with the matrix UI they're actually for.
router.get("/roles", authenticateToken, ctrl.listRoles);
router.get("/roles/:id/permissions", authenticateToken, ctrl.getRolePermissions);
router.put("/roles/:id/permissions", authenticateToken, requireSuperAdmin, ctrl.updateRolePermissions);
router.get("/permissions", authenticateToken, ctrl.listPermissions);
router.get("/me/permissions", authenticateToken, ctrl.getMyPermissions);
router.get("/companies", authenticateToken, ctrl.listCompanies);
router.get("/branches", authenticateToken, ctrl.listBranches);

module.exports = router;
