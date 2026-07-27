const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const ctrl = require("../controllers/AIReconController");

router.get("/status", authenticateToken, ctrl.getStatus);
router.post("/conversations", authenticateToken, ctrl.createConversation);
router.get("/conversations/:id", authenticateToken, ctrl.getConversation);
router.post("/conversations/:id/messages", authenticateToken, ctrl.sendMessage);

module.exports = router;
