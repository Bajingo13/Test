const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/fxRevaluation.controller");

const MODULE_KEY = "FX_REVALUATION";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.post("/calculate", authenticateToken, requirePerm("CALCULATE"), ctrl.calculate);
router.post("/:id/post", authenticateToken, requirePerm("POST"), ctrl.post);
router.post("/:id/reverse", authenticateToken, requirePerm("REVERSE"), ctrl.reverse);

module.exports = router;