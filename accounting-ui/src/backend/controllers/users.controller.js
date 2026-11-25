const UserService = require("../services/userService");
const RestrictionService = require("../services/restrictionService");
const AccountCredentialService = require("../services/accountCredentialService");
const { requestMeta } = require("../lib/audit");

exports.listUsers = async (req, res) => {
  try {
    res.json(await UserService.listUsers(req.user));
  } catch (err) {
    console.error("LIST USERS ERROR:", err.message);
    res.status(500).json({ message: "Failed to load users" });
  }
};

exports.getUser = async (req, res) => {
  try {
    res.json(await UserService.getUser(req.params.id, req.user));
  } catch (err) {
    console.error("GET USER ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load user" });
  }
};

exports.updateUserAccess = async (req, res) => {
  try {
    const { fullName, roleId, companyIds, branchIds } = req.body;
    res.json(await UserService.updateUserAccess(req.params.id, { fullName, roleId, companyIds, branchIds }, req.user));
  } catch (err) {
    console.error("UPDATE USER ACCESS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update user access" });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    res.json(await UserService.updateUserStatus(req.params.id, req.body.status, req.user));
  } catch (err) {
    console.error("UPDATE USER STATUS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update user status" });
  }
};

exports.unlockUser = async (req, res) => {
  try {
    res.json(await UserService.unlockUser(req.params.id, req.user));
  } catch (err) {
    console.error("UNLOCK USER ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to unlock user" });
  }
};

exports.revokeSessions = async (req, res) => {
  try {
    res.json(await UserService.revokeSessions(req.params.id, req.user));
  } catch (err) {
    console.error("REVOKE SESSIONS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to revoke sessions" });
  }
};

// Administrative credential changes. Responses carry only a fixed message +
// code - never the submitted password, a hash or a token.
function sendCredentialError(res, err, label) {
  if (err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ message: err.message, code: err.code });
  console.error(`${label} ERROR:`, err.code || err.message);
  return res.status(500).json({ message: "The change could not be completed.", code: "SERVER_ERROR" });
}

exports.resetPassword = async (req, res) => {
  try {
    const r = await AccountCredentialService.adminResetPassword({ actingUser: req.user, targetId: req.params.id, body: req.body, meta: requestMeta(req) });
    res.json({ success: true, ...r, message: `Password reset for ${r.username}. They have been signed out and must use the new password.` });
  } catch (err) {
    sendCredentialError(res, err, "RESET USER PASSWORD");
  }
};

exports.changeUsername = async (req, res) => {
  try {
    const r = await AccountCredentialService.adminChangeUsername({ actingUser: req.user, targetId: req.params.id, body: req.body, meta: requestMeta(req) });
    res.json({ success: true, ...r, message: `Username changed to ${r.username}.` });
  } catch (err) {
    sendCredentialError(res, err, "CHANGE USER USERNAME");
  }
};

// Super-Admin-only - the Access Restrictions module.
exports.getUserAccess = async (req, res) => {
  try {
    res.json(await RestrictionService.getUserAccess(req.params.id));
  } catch (err) {
    console.error("GET USER ACCESS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load user access" });
  }
};

exports.setUserAccess = async (req, res) => {
  try {
    res.json(await RestrictionService.setUserAccess(req.params.id, req.body.grants, req.user));
  } catch (err) {
    console.error("SET USER ACCESS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update user access" });
  }
};
