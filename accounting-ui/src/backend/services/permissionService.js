const pool = require("../db");

// Precedence (collapses the 5-tier spec into 3 real tiers - "Super Admin
// restrictions" and "user-specific restrictions" are the same mechanism,
// since both are Super-Admin-authored rows in user_permissions):
//   1. SUPER_ADMIN role -> always allowed (hardcoded bypass, not seeded
//      rows, so it can never be under-provisioned by bad seed data).
//   2. user_permissions row for (user, permission) -> use its `granted`.
//   3. role_permissions row for the user's role -> use its `granted`.
//   4. Otherwise -> deny (default-deny).
async function can(userId, moduleKey, action) {
  const [userRows] = await pool.execute(
    `SELECT u.id, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  const user = userRows[0];
  if (!user) return false;
  if (user.role_code === "SUPER_ADMIN") return true;

  const [permRows] = await pool.execute(
    `SELECT id FROM permissions WHERE module_key = ? AND action = ?`,
    [moduleKey, action]
  );
  const permission = permRows[0];
  if (!permission) return false;

  const [overrideRows] = await pool.execute(
    `SELECT granted FROM user_permissions WHERE user_id = ? AND permission_id = ?`,
    [userId, permission.id]
  );
  if (overrideRows.length > 0) return !!overrideRows[0].granted;

  if (!user.role_code) return false;

  const [roleRows] = await pool.execute(
    `SELECT rp.granted FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     WHERE r.code = ? AND rp.permission_id = ?`,
    [user.role_code, permission.id]
  );
  if (roleRows.length > 0) return !!roleRows[0].granted;

  return false;
}

// Full resolved permission map for a user, tagged with where each grant
// came from - used by GET /api/me/permissions and, later, the frontend
// permission context (Phase 3+).
async function getEffectivePermissions(userId) {
  const [userRows] = await pool.execute(
    `SELECT u.id, u.username, u.email, u.status, r.id AS role_id, r.code AS role_code, r.name AS role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  const user = userRows[0];
  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }

  const [allPermissions] = await pool.execute(
    `SELECT id, module_key, action, label FROM permissions ORDER BY module_key, action`
  );

  if (user.role_code === "SUPER_ADMIN") {
    return {
      user: { id: user.id, username: user.username, email: user.email, status: user.status, roleId: user.role_id, roleCode: user.role_code, roleName: user.role_name },
      permissions: allPermissions.map((p) => ({ moduleKey: p.module_key, action: p.action, label: p.label, granted: true, source: "super_admin" })),
    };
  }

  const [roleGrants] = await pool.execute(
    `SELECT rp.permission_id, rp.granted FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id WHERE r.code = ?`,
    [user.role_code || "__none__"]
  );
  const roleGrantMap = new Map(roleGrants.map((r) => [r.permission_id, !!r.granted]));

  const [overrides] = await pool.execute(
    `SELECT permission_id, granted FROM user_permissions WHERE user_id = ?`,
    [userId]
  );
  const overrideMap = new Map(overrides.map((o) => [o.permission_id, !!o.granted]));

  const permissions = allPermissions.map((p) => {
    if (overrideMap.has(p.id)) {
      return { moduleKey: p.module_key, action: p.action, label: p.label, granted: overrideMap.get(p.id), source: "override" };
    }
    if (roleGrantMap.has(p.id)) {
      return { moduleKey: p.module_key, action: p.action, label: p.label, granted: roleGrantMap.get(p.id), source: "role" };
    }
    return { moduleKey: p.module_key, action: p.action, label: p.label, granted: false, source: "default_deny" };
  });

  return {
    user: { id: user.id, username: user.username, email: user.email, status: user.status, roleId: user.role_id, roleCode: user.role_code, roleName: user.role_name },
    permissions,
  };
}

module.exports = { can, getEffectivePermissions };
