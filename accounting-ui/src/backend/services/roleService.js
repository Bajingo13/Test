const pool = require("../db");

async function listRoles() {
  const [rows] = await pool.execute("SELECT id, code, name, description, is_system, created_at FROM roles ORDER BY id ASC");
  return rows;
}

async function listPermissions() {
  const [rows] = await pool.execute("SELECT id, module_key, action, label, description FROM permissions ORDER BY module_key, action");
  return rows;
}

// Read-only in Phase 1 - the PUT write endpoint arrives in Phase 4 with the
// matrix UI it's actually for.
async function getRolePermissions(roleId) {
  const [roleRows] = await pool.execute("SELECT id, code, name FROM roles WHERE id = ?", [roleId]);
  const role = roleRows[0];
  if (!role) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }

  const [rows] = await pool.execute(
    `SELECT p.id AS permission_id, p.module_key, p.action, p.label, COALESCE(rp.granted, 0) AS granted
     FROM permissions p
     LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = ?
     ORDER BY p.module_key, p.action`,
    [roleId]
  );

  return { role, permissions: rows };
}

module.exports = { listRoles, listPermissions, getRolePermissions };
