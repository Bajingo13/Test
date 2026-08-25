const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/printTemplate.controller");

const MODULE_KEY = "PRINT.DOCUMENT_TEMPLATES";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.post("/", authenticateToken, requirePerm("CREATE"), ctrl.create);
router.put("/:id", authenticateToken, requirePerm("EDIT"), ctrl.update);
router.post("/:id/set-default", authenticateToken, requirePerm("SET_DEFAULT"), ctrl.setDefault);
router.post("/:id/activate", authenticateToken, requirePerm("ACTIVATE"), ctrl.activate);
router.post("/:id/deactivate", authenticateToken, requirePerm("DEACTIVATE"), ctrl.deactivate);

module.exports = router;
