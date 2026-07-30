const RoleService = require("../services/roleService");
const PermissionService = require("../services/permissionService");

exports.listRoles = async (req, res) => {
  try {
    res.json(await RoleService.listRoles());
  } catch (err) {
    console.error("LIST ROLES ERROR:", err.message);
    res.status(500).json({ message: "Failed to load roles" });
  }
};

exports.listPermissions = async (req, res) => {
  try {
    res.json(await RoleService.listPermissions());
  } catch (err) {
    console.error("LIST PERMISSIONS ERROR:", err.message);
    res.status(500).json({ message: "Failed to load permissions" });
  }
};

exports.getRolePermissions = async (req, res) => {
  try {
    res.json(await RoleService.getRolePermissions(req.params.id));
  } catch (err) {
    console.error("GET ROLE PERMISSIONS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load role permissions" });
  }
};

exports.getMyPermissions = async (req, res) => {
  try {
    res.json(await PermissionService.getEffectivePermissions(req.user.id));
  } catch (err) {
    console.error("GET MY PERMISSIONS ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load effective permissions" });
  }
};
