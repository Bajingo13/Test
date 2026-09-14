const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const ctrl = require("../controllers/invoiceVerification.controller");

// Public, unauthenticated invoice-verification routes (QR scan target).
// Deliberately isolated in their own router so helmet + rate limiting -
// neither of which server.js applies globally today - can be scoped to
// exactly this public surface without touching any other route.
router.use(helmet());

// 60 requests / 15 min / IP: generous enough for a person scanning a QR
// code and retrying a flaky connection a few times, tight enough to make
// bulk token-guessing impractical (a 32-hex-char token is 128 bits of
// randomness - rate limiting here is defense in depth, not the primary
// control). Mirrors the shape of server.js's own loginRateLimiter.
const verifyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "invalid" },
});
router.use(verifyRateLimiter);

router.get("/:token", ctrl.verifyInvoice);
router.get("/:token/pdf", ctrl.downloadVerifiedInvoicePdf);

module.exports = router;
