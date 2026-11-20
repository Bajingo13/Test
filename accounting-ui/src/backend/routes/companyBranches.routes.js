// /api/company-branches - Company Branch Management (master data).
// Separate from GET /api/branches (roles.routes.js), which lists the branches a
// user is ASSIGNED to for the invite / user-access pickers and is unchanged.
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/branches.controller");

const requirePerm = (action) => authorizePermission("FILESETUP.BRANCHES", action);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.get);
router.post("/", authenticateToken, requirePerm("CREATE"), ctrl.create);
router.put("/:id", authenticateToken, requirePerm("EDIT"), ctrl.update);
// ACTIVATE or DEACTIVATE is checked in the controller (depends on the body).
router.patch("/:id/status", authenticateToken, requirePerm("VIEW"), ctrl.setStatus);

module.exports = router;
