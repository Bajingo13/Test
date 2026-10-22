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

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Validates a request's [{ permissionId, granted, reason? }] list before
// anything is written: every id must be a positive integer that exists in
// the catalog. Exact duplicates collapse to one entry; the same id listed
// with different granted values is rejected (there's no safe "winner").
async function normalizeGrants(grants) {
  if (!Array.isArray(grants)) {
    throw badRequest("grants must be an array of { permissionId, granted }.");
  }
  const byId = new Map();
  for (const g of grants) {
    const permissionId = Number(g?.permissionId);
    if (!Number.isInteger(permissionId) || permissionId <= 0) {
      throw badRequest("Every grant needs a valid permissionId.");
    }
    const granted = !!g.granted;
    const existing = byId.get(permissionId);
    if (existing && existing.granted !== granted) {
      throw badRequest(`Permission ${permissionId} is listed more than once with different values.`);
    }
    if (!existing) byId.set(permissionId, { permissionId, granted, reason: g.reason || null });
  }
  const ids = [...byId.keys()];
  if (ids.length) {
    const [rows] = await pool.query("SELECT id FROM permissions WHERE id IN (?)", [ids]);
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((r) => r.id));
      const unknown = ids.filter((id) => !known.has(id));
      throw badRequest(`Unknown permission id(s): ${unknown.join(", ")}.`);
    }
  }
  return [...byId.values()];
}

// Catalog metadata for audit records: id -> { permissionId, permission,
// moduleKey, action, label }.
async function describePermissions(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const [rows] = await pool.query("SELECT id, module_key, action, label FROM permissions WHERE id IN (?)", [ids]);
  for (const r of rows) {
    map.set(r.id, { permissionId: r.id, permission: `${r.module_key}.${r.action}`, moduleKey: r.module_key, action: r.action, label: r.label });
  }
  return map;
}

// "MODULE.ACTION" keys the user is currently granted (role + overrides,
// Super Admin = everything) - the ceiling for what they may hand out.
async function getGrantedPermissionKeys(userId) {
  const { permissions } = await getEffectivePermissions(userId);
  return new Set(permissions.filter((p) => p.granted).map((p) => `${p.moduleKey}.${p.action}`));
}

module.exports = { can, getEffectivePermissions, normalizeGrants, describePermissions, getGrantedPermissionKeys };
