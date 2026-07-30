const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/accessRestrictions.controller");

// Available only to the Super Admin, per spec - requireSuperAdmin on every
// route here, not just permission-gated (Admin has no ADMIN.ACCESS_
// RESTRICTIONS grant by default either, but this makes the "Super Admin
// only" requirement explicit and independent of role_permissions seed data).
router.get("/", authenticateToken, requireSuperAdmin, ctrl.listRestrictions);
router.post("/", authenticateToken, requireSuperAdmin, ctrl.createRestriction);
router.delete("/:id", authenticateToken, requireSuperAdmin, ctrl.deleteRestriction);

module.exports = router;
