const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const DashboardService = require("../services/dashboardService");

// Mounted at /api/dashboard. DASHBOARD/VIEW opens the endpoint; every
// section inside is gated again on the permission of the report it mirrors
// (see dashboardService.js), so the dashboard never shows more than the
// user's reports would.
router.get("/summary", authenticateToken, authorizePermission("DASHBOARD", "VIEW"), async (req, res) => {
  try {
    res.set("Cache-Control", "private, no-store");
    res.json(await DashboardService.getDashboardSummary(req.user, req.query));
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ message: err.message });
    console.error("DASHBOARD SUMMARY ERROR:", err.message);
    res.status(500).json({ message: "Unable to load the dashboard." });
  }
});

module.exports = router;
