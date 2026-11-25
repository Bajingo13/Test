const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const { requireSelfServiceRole } = require("../lib/credentialPolicy");
const ctrl = require("../controllers/account.controller");

// PUBLIC: confirm a notification e-mail with the one-time token from the
// verification link (the link may be opened in another browser, so no session
// is required - the 256-bit single-use token is the proof). Per-IP limited.
const emailVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later.", code: "RATE_LIMITED" },
});
router.post("/email/verify", emailVerifyLimiter, ctrl.confirmEmail);

// Everything else is mounted at /api/account, for the authenticated account itself
// (the service never accepts a target user id). Unauthenticated -> 401 and a role
// that may not change credentials -> 403, before any credential is read:
//   change-password / change-username: lib/credentialPolicy (SUPER_ADMIN; also ADMIN
//     where ADMIN_CREDENTIAL_MANAGEMENT=enabled; ACCOUNTANT never)
//   notification e-mail: SUPER_ADMIN only.
router.use(authenticateToken);

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

router.post("/change-password", requireSelfServiceRole, credentialChangeLimiter, ctrl.changePassword);
router.post("/change-username", requireSelfServiceRole, credentialChangeLimiter, ctrl.changeUsername);

// Notification e-mail. Every request (successful or not) counts here, because a
// successful one sends an e-mail: at most 5 verification e-mails per 15 minutes.
const emailRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => `account-email:${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many email change requests. Please try again later.", code: "RATE_LIMITED" },
});
router.get("/email", requireSuperAdmin, ctrl.getEmail);
router.post("/email/request", requireSuperAdmin, credentialChangeLimiter, emailRequestLimiter, ctrl.requestEmail);

module.exports = router;
