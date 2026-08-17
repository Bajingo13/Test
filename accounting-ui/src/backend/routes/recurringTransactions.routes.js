const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/recurringTransactions.controller");

const MODULE_KEY = "RECURRING.TRANSACTIONS";
const requirePerm = (action) => authorizePermission(MODULE_KEY, action);

// Checkpoint 3F: stateless external-trigger alternative to the in-process
// node-cron (jobs/recurringSchedulerJob.js) - a Railway Cron Job can POST
// here on a schedule instead, once RECURRING_INPROCESS_CRON_ENABLED=false
// disables the in-process timer. Gated by a shared secret header, not
// user JWT, since a cron job has no interactive user; disabled entirely
// (404) unless RECURRING_CRON_SECRET is actually configured, so it never
// exists as an unauthenticated surface by accident.
router.post("/run-due", ctrl.runDue);

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
