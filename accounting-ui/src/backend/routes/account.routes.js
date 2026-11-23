const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const ctrl = require("../controllers/account.controller");

// Mounted at /api/account. SUPER_ADMIN only, for the authenticated account
// itself (the service never accepts a target user id). Unauthenticated -> 401,
// ADMIN / ACCOUNTANT -> 403, before any credential is read.
router.use(authenticateToken, requireSuperAdmin);

// Defence in depth against guessing the current password through a stolen
// session: only FAILED attempts count, per account, after authorization.
const credentialChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `account-credentials:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
});

router.post("/change-password", credentialChangeLimiter, ctrl.changePassword);
router.post("/change-username", credentialChangeLimiter, ctrl.changeUsername);

module.exports = router;
