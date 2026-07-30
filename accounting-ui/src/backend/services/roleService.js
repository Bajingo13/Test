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

const { logAudit } = require("../lib/audit");

// Bulk-replace a role's grants. SUPER_ADMIN's permissions are a hardcoded
// always-allow bypass (see permissionService.can), not seeded rows - editing
// them here would be a no-op at best and confusing at worst, so it's
// explicitly rejected rather than silently accepted.
async function setRolePermissions(roleId, grants, actingUser) {
  const [roleRows] = await pool.execute("SELECT id, code, name FROM roles WHERE id = ?", [roleId]);
  const role = roleRows[0];
  if (!role) {
    throw Object.assign(new Error("Role not found"), { statusCode: 404 });
  }
  if (role.code === "SUPER_ADMIN") {
    throw Object.assign(new Error("Super Admin always has full access and cannot be restricted."), { statusCode: 400 });
  }
  if (!Array.isArray(grants)) {
    throw Object.assign(new Error("grants must be an array of { permissionId, granted }."), { statusCode: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const g of grants) {
      await conn.execute(
        `INSERT INTO role_permissions (role_id, permission_id, granted)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE granted = VALUES(granted)`,
        [roleId, g.permissionId, g.granted ? 1 : 0]
      );
    }

    await logAudit(conn, {
      module: "ROLES",
      entityType: "ROLE",
      entityId: roleId,
      action: "PERMISSION_CHANGED",
      description: `${actingUser.username} updated permissions for role ${role.name}`,
      afterData: { grantCount: grants.length },
      user: actingUser,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getRolePermissions(roleId);
}

module.exports = { listRoles, listPermissions, getRolePermissions, setRolePermissions };
