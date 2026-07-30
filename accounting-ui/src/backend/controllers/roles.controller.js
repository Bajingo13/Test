const RoleService = require("../services/roleService");
const PermissionService = require("../services/permissionService");
const UserAccessService = require("../services/userAccessService");
const pool = require("../db");

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

// SUPER_ADMIN sees every company/branch; everyone else sees only what
// they're assigned to - used to populate the invite/assignment pickers.
exports.listCompanies = async (req, res) => {
  try {
    if (req.user.roleCode === "SUPER_ADMIN") {
      const [rows] = await pool.execute("SELECT id, name, status FROM companies ORDER BY name");
      return res.json(rows);
    }
    const { companies } = await UserAccessService.getUserAccessSummary(req.user.id);
    res.json(companies);
  } catch (err) {
    console.error("LIST COMPANIES ERROR:", err.message);
    res.status(500).json({ message: "Failed to load companies" });
  }
};

exports.listBranches = async (req, res) => {
  try {
    if (req.user.roleCode === "SUPER_ADMIN") {
      const [rows] = await pool.execute("SELECT id, name, company_id, status FROM branches ORDER BY name");
      return res.json(rows);
    }
    const { branches } = await UserAccessService.getUserAccessSummary(req.user.id);
    res.json(branches);
  } catch (err) {
    console.error("LIST BRANCHES ERROR:", err.message);
    res.status(500).json({ message: "Failed to load branches" });
  }
};
