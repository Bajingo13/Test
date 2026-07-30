const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const ctrl = require("../controllers/AIReconController");

router.get("/status", authenticateToken, authorizePermission("REPORTS.AI_RECONCILIATION", "VIEW"), ctrl.getStatus);
router.post("/conversations", authenticateToken, authorizePermission("REPORTS.AI_RECONCILIATION", "VIEW"), ctrl.createConversation);
router.get("/conversations/:id", authenticateToken, authorizePermission("REPORTS.AI_RECONCILIATION", "VIEW"), ctrl.getConversation);
router.post("/conversations/:id/messages", authenticateToken, authorizePermission("REPORTS.AI_RECONCILIATION", "VIEW"), ctrl.sendMessage);

module.exports = router;
