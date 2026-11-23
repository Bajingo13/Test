const AccountCredentialService = require("../services/accountCredentialService");
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
