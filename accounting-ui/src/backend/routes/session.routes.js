// /api/auth - session keepalive for the 15-minute inactivity timeout
// (lib/sessionPolicy.js). The browser calls it only after real user activity.
// It needs a valid, NOT yet expired token (authenticateToken also re-checks the
// user's status and token_version), so it can only extend a live session -
// never revive an expired or revoked one.
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const pool = require("../db");
const { signSessionToken, SESSION_IDLE_SECONDS } = require("../lib/sessionPolicy");

router.post("/keepalive", authenticateToken, async (req, res) => {
  try {
    const [[row]] = await pool.execute("SELECT id, username, role, token_version FROM users WHERE id = ?", [req.user.id]);
    res.json({ token: signSessionToken(row), expiresInSeconds: SESSION_IDLE_SECONDS });
  } catch (err) {
    console.error("SESSION KEEPALIVE ERROR:", err.message);
    res.status(500).json({ message: "Failed to refresh session" });
  }
});

module.exports = router;
