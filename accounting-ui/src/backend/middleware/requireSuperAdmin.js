// Use after authenticateToken. Only the Super Admin may configure role
// restrictions, per spec.
function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Access token required" });
  }
  if (req.user.roleCode !== "SUPER_ADMIN") {
    return res.status(403).json({ message: "Super Admin access required" });
  }
  next();
}

module.exports = requireSuperAdmin;
