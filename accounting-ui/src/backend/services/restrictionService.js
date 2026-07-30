const pool = require("../db");
const { logAudit } = require("../lib/audit");
const PermissionService = require("./permissionService");

// The Access Restrictions module (Super-Admin-only per spec) is a
// management surface over the same user_permissions table Phase 1 built -
// "Super Admin restrictions" and "user-specific restrictions" collapse
// into one mechanism, per the precedence design from Phase 1's plan.
async function listRestrictions() {
  const [rows] = await pool.execute(
    `SELECT up.id, up.user_id, u.username, u.full_name, up.permission_id,
       p.module_key, p.action, p.label, up.granted, up.reason,
       up.created_by, creator.username AS created_by_username, up.created_at
     FROM user_permissions up
     JOIN users u ON u.id = up.user_id
     JOIN permissions p ON p.id = up.permission_id
     LEFT JOIN users creator ON creator.id = up.created_by
     ORDER BY up.created_at DESC`
  );
  return rows;
}

async function createRestriction({ userId, permissionId, granted, reason, actingUser }) {
  const [userRows] = await pool.execute(
    `SELECT u.id, u.username, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  const targetUser = userRows[0];
  if (!targetUser) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }
  if (targetUser.role_code === "SUPER_ADMIN") {
    throw Object.assign(new Error("Super Admin always has full access and cannot be restricted."), { statusCode: 400 });
  }

  const [permRows] = await pool.execute("SELECT id, module_key, action FROM permissions WHERE id = ?", [permissionId]);
  const permission = permRows[0];
  if (!permission) {
    throw Object.assign(new Error("Permission not found"), { statusCode: 404 });
  }

  await pool.execute(
    `INSERT INTO user_permissions (user_id, permission_id, granted, created_by, reason)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE granted = VALUES(granted), reason = VALUES(reason), created_by = VALUES(created_by)`,
    [userId, permissionId, granted ? 1 : 0, actingUser.id, reason || null]
  );

  await logAudit(pool, {
    module: "ACCESS_RESTRICTIONS",
    entityType: "USER_PERMISSION",
    entityId: userId,
    action: "RESTRICTION_ADDED",
    description: `${actingUser.username} set ${targetUser.username}'s ${permission.module_key}.${permission.action} to ${granted ? "allowed" : "denied"}${reason ? ` (${reason})` : ""}`,
    afterData: { userId, permissionId, granted, reason },
    user: actingUser,
  });

  const [rows] = await pool.execute("SELECT id FROM user_permissions WHERE user_id = ? AND permission_id = ?", [userId, permissionId]);
  return { id: rows[0].id, userId, permissionId, granted: !!granted };
}

async function deleteRestriction(id, actingUser) {
  const [rows] = await pool.execute(
    `SELECT up.id, up.user_id, u.username, p.module_key, p.action
     FROM user_permissions up JOIN users u ON u.id = up.user_id JOIN permissions p ON p.id = up.permission_id
     WHERE up.id = ?`,
    [id]
  );
  const restriction = rows[0];
  if (!restriction) {
    throw Object.assign(new Error("Restriction not found"), { statusCode: 404 });
  }

  await pool.execute("DELETE FROM user_permissions WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "ACCESS_RESTRICTIONS",
    entityType: "USER_PERMISSION",
    entityId: restriction.user_id,
    action: "RESTRICTION_REMOVED",
    description: `${actingUser.username} removed the ${restriction.module_key}.${restriction.action} override for ${restriction.username} (reverts to role default)`,
    user: actingUser,
  });

  return { id, removed: true };
}

// A user's full resolved access - permissions with source tags plus their
// company/branch assignment - distinct from GET /api/me/permissions in
// that it targets an arbitrary user (Super-Admin-only route) rather than
// "myself."
async function getUserAccess(userId) {
  const UserAccessService = require("./userAccessService");
  const effective = await PermissionService.getEffectivePermissions(userId);
  const { companies, branches } = await UserAccessService.getUserAccessSummary(userId);
  return { ...effective, companies, branches };
}

// Bulk-replace ALL of a user's overrides in one call (used by "Reset to
// role defaults" [empty array], "Copy permissions from another user", and
// manual per-permission edits in the matrix UI).
async function setUserAccess(userId, grants, actingUser) {
  const [userRows] = await pool.execute(
    `SELECT u.id, u.username, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );
  const targetUser = userRows[0];
  if (!targetUser) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }
  if (targetUser.role_code === "SUPER_ADMIN") {
    throw Object.assign(new Error("Super Admin always has full access and cannot be restricted."), { statusCode: 400 });
  }
  if (!Array.isArray(grants)) {
    throw Object.assign(new Error("grants must be an array of { permissionId, granted, reason }."), { statusCode: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute("DELETE FROM user_permissions WHERE user_id = ?", [userId]);
    for (const g of grants) {
      await conn.execute(
        `INSERT INTO user_permissions (user_id, permission_id, granted, created_by, reason) VALUES (?, ?, ?, ?, ?)`,
        [userId, g.permissionId, g.granted ? 1 : 0, actingUser.id, g.reason || null]
      );
    }

    // Overrides changed - force re-auth so it takes effect immediately.
    await conn.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [userId]);

    await logAudit(conn, {
      module: "ACCESS_RESTRICTIONS",
      entityType: "USER_PERMISSION",
      entityId: userId,
      action: "RESTRICTION_ADDED",
      description: `${actingUser.username} replaced all overrides for ${targetUser.username} (${grants.length} override(s))`,
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

  return getUserAccess(userId);
}

module.exports = { listRestrictions, createRestriction, deleteRestriction, getUserAccess, setUserAccess };
