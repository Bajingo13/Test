const AccountCredentialService = require("../services/accountCredentialService");
const AccountEmailService = require("../services/accountEmailService");
const { requestMeta } = require("../lib/audit");

// SUPER_ADMIN-only self-service credentials. Error responses carry only a fixed
// message + code - never any submitted value, hash or token.
function sendError(res, err, label) {
  if (err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({ message: err.message, code: err.code });
  }
  console.error(`${label} ERROR:`, err.code || err.message);
  return res.status(500).json({ message: "The change could not be completed.", code: "SERVER_ERROR" });
}

exports.changePassword = async (req, res) => {
  try {
    await AccountCredentialService.changePassword({ actingUser: req.user, body: req.body, meta: requestMeta(req) });
    res.json({ success: true, reauthRequired: true, message: "Password changed successfully. Please log in again." });
  } catch (err) {
    sendError(res, err, "CHANGE PASSWORD");
  }
};

exports.changeUsername = async (req, res) => {
  try {
    const { username } = await AccountCredentialService.changeUsername({ actingUser: req.user, body: req.body, meta: requestMeta(req) });
    res.json({ success: true, username, message: "Username changed successfully." });
  } catch (err) {
    sendError(res, err, "CHANGE USERNAME");
  }
};

// Notification e-mail (services/accountEmailService.js).
exports.getEmail = async (req, res) => {
  try {
    res.json({ success: true, ...(await AccountEmailService.getEmailStatus({ actingUser: req.user })) });
  } catch (err) {
    sendError(res, err, "GET ACCOUNT EMAIL");
  }
};

exports.requestEmail = async (req, res) => {
  try {
    const r = await AccountEmailService.requestEmailChange({ actingUser: req.user, body: req.body, meta: requestMeta(req) });
    // The verification token is never in the response; delivery problems are
    // reported in plain language only.
    const message = r.emailDelivered
      ? `A confirmation link was sent to ${r.pendingEmail}. Your notification email changes after you open it.`
      : r.reason === "SMTP_NOT_CONFIGURED"
        ? "Email delivery is not set up on this system yet, so the confirmation link could not be sent. Your notification email was not changed."
        : "The confirmation email could not be delivered. Your notification email was not changed. Please try again later.";
    res.status(r.emailDelivered ? 200 : 202).json({ success: r.emailDelivered, emailDelivered: r.emailDelivered, pendingEmail: r.pendingEmail, expiresAt: r.expiresAt, message });
  } catch (err) {
    sendError(res, err, "REQUEST ACCOUNT EMAIL");
  }
};

exports.confirmEmail = async (req, res) => {
  try {
    const { email } = await AccountEmailService.confirmEmailChange({ body: req.body, meta: requestMeta(req) });
    res.json({ success: true, email, message: "Your notification email has been confirmed." });
  } catch (err) {
    sendError(res, err, "CONFIRM ACCOUNT EMAIL");
  }
};
