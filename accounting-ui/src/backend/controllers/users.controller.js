const UserService = require("../services/userService");
const RestrictionService = require("../services/restrictionService");

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

exports.revokeSessions = async (req, res) => {
  try {
    res.json(await UserService.revokeSessions(req.params.id, req.user));
  } catch (err) {
    console.error("REVOKE SESSIONS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to revoke sessions" });
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
