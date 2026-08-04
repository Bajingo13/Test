const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/recurringTransactions.controller");

const MODULE_KEY = "RECURRING.TRANSACTIONS";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

router.post("/from-transaction/:moduleType/:id", authenticateToken, requirePerm("CREATE"), ctrl.createFromTransaction);
router.post("/preview-schedule", authenticateToken, requirePerm("CREATE"), ctrl.previewSchedule);
router.post("/", authenticateToken, requirePerm("CREATE"), ctrl.create);
router.get("/", authenticateToken, requirePerm("VIEW"), ctrl.list);
router.get("/:id", authenticateToken, requirePerm("VIEW"), ctrl.getOne);
router.put("/:id", authenticateToken, requirePerm("EDIT"), ctrl.update);
router.post("/:id/pause", authenticateToken, requirePerm("PAUSE"), ctrl.pause);
router.post("/:id/resume", authenticateToken, requirePerm("RESUME"), ctrl.resume);
router.post("/:id/stop", authenticateToken, requirePerm("STOP"), ctrl.stop);
router.post("/:id/generate", authenticateToken, requirePerm("GENERATE"), ctrl.generate);
router.post("/:id/skip", authenticateToken, requirePerm("SKIP"), ctrl.skip);
router.get("/:id/history", authenticateToken, requirePerm("VIEW_HISTORY"), ctrl.history);
router.get("/:id/preview", authenticateToken, requirePerm("VIEW"), ctrl.preview);

module.exports = router;
