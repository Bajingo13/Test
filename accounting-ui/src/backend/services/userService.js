const pool = require("../db");
const { logAudit } = require("../lib/audit");
const UserAccessService = require("./userAccessService");

const VALID_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];

async function isSuperAdmin(roleCode) {
  return roleCode === "SUPER_ADMIN";
}

// Non-Super-Admin actors only see users who share at least one company
// with them - Admin's "manage users within assigned scope."
async function listUsers(actingUser) {
  if (actingUser.roleCode === "SUPER_ADMIN") {
    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.email, u.full_name, u.status, u.last_login_at, u.locked_until, u.created_at, u.created_by,
         r.id AS role_id, r.code AS role_code, r.name AS role_name,
         creator.username AS created_by_username
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN users creator ON creator.id = u.created_by
       ORDER BY u.created_at DESC`
    );
    return attachAccessSummaries(rows);
  }

  const [rows] = await pool.execute(
    `SELECT DISTINCT u.id, u.username, u.email, u.full_name, u.status, u.last_login_at, u.locked_until, u.created_at, u.created_by,
       r.id AS role_id, r.code AS role_code, r.name AS role_name,
       creator.username AS created_by_username
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN users creator ON creator.id = u.created_by
     JOIN user_companies uc ON uc.user_id = u.id
     WHERE uc.company_id IN (SELECT company_id FROM user_companies WHERE user_id = ?)
       AND (r.code IS NULL OR r.code != 'SUPER_ADMIN')
     ORDER BY u.created_at DESC`,
    [actingUser.id]
  );
  return attachAccessSummaries(rows);
}

async function attachAccessSummaries(rows) {
  const result = [];
  for (const row of rows) {
    const { companies, branches } = await UserAccessService.getUserAccessSummary(row.id);
    result.push({ ...row, companies, branches });
  }
  return result;
}

async function getUserOr404(id) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.email, u.full_name, u.status, u.last_login_at, u.locked_until, u.created_at, u.created_by,
       r.id AS role_id, r.code AS role_code, r.name AS role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [id]
  );
  const user = rows[0];
  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }
  return user;
}

async function getUser(id, actingUser) {
  const user = await getUserOr404(id);
  await assertInScope(user, actingUser);
  const { companies, branches } = await UserAccessService.getUserAccessSummary(id);
  return { ...user, companies, branches };
}

// Shared scope guard: non-Super-Admins can only touch users who share at
// least one company with them, and can never touch a Super Admin.
async function assertInScope(targetUser, actingUser) {
  if (actingUser.roleCode === "SUPER_ADMIN") return;

  if (targetUser.role_code === "SUPER_ADMIN") {
    throw Object.assign(new Error("You cannot view or manage Super Admin users."), { statusCode: 403 });
  }

  const actingCompanyIds = new Set(await UserAccessService.getAccessibleCompanyIds(actingUser.id));
  const targetCompanyIds = await UserAccessService.getAccessibleCompanyIds(targetUser.id);
  const sharesCompany = targetCompanyIds.some((id) => actingCompanyIds.has(id));
  if (!sharesCompany) {
    throw Object.assign(new Error("You do not have access to this user."), { statusCode: 403 });
  }
}

async function countActiveSuperAdmins(excludeUserId = null) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' ${excludeUserId ? "AND u.id != ?" : ""}`,
    excludeUserId ? [excludeUserId] : []
  );
  return rows[0].c;
}

async function updateUserAccess(id, { fullName, roleId, companyIds, branchIds }, actingUser) {
  const target = await getUserOr404(id);
  await assertInScope(target, actingUser);

  let newRole = null;
  if (roleId && Number(roleId) !== target.role_id) {
    const [roleRows] = await pool.execute("SELECT id, code, name FROM roles WHERE id = ?", [roleId]);
    newRole = roleRows[0];
    if (!newRole) {
      throw Object.assign(new Error("Selected role does not exist."), { statusCode: 400 });
    }
    if (newRole.code === "SUPER_ADMIN" && actingUser.roleCode !== "SUPER_ADMIN") {
      throw Object.assign(new Error("Only a Super Admin can grant Super Admin access."), { statusCode: 403 });
    }
    if (target.role_code === "SUPER_ADMIN" && newRole.code !== "SUPER_ADMIN") {
      const activeCount = await countActiveSuperAdmins(target.id);
      if (activeCount === 0) {
        throw Object.assign(new Error("Cannot change this user's role - they are the last active Super Admin."), { statusCode: 409 });
      }
    }
  }

  const companyIdList = Array.isArray(companyIds) ? companyIds.map(Number).filter(Boolean) : null;
  const branchIdList = Array.isArray(branchIds) ? branchIds.map(Number).filter(Boolean) : null;

  if (actingUser.roleCode !== "SUPER_ADMIN" && (companyIdList || branchIdList)) {
    const accessibleCompanyIds = new Set(await UserAccessService.getAccessibleCompanyIds(actingUser.id));
    const accessibleBranchIds = new Set(await UserAccessService.getAccessibleBranchIds(actingUser.id));
    const outOfScopeCompany = (companyIdList || []).find((cid) => !accessibleCompanyIds.has(cid));
    const outOfScopeBranch = (branchIdList || []).find((bid) => !accessibleBranchIds.has(bid));
    if (outOfScopeCompany || outOfScopeBranch) {
      throw Object.assign(new Error("You can only assign companies/branches you yourself have access to."), { statusCode: 403 });
    }
  }

  const before = { fullName: target.full_name, roleCode: target.role_code };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (fullName) {
      await conn.execute("UPDATE users SET full_name = ? WHERE id = ?", [fullName, id]);
    }
    if (newRole) {
      await conn.execute("UPDATE users SET role_id = ? WHERE id = ?", [newRole.id, id]);
    }
    if (companyIdList) {
      await conn.execute("DELETE FROM user_companies WHERE user_id = ?", [id]);
      for (const cid of companyIdList) {
        await conn.execute("INSERT IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)", [id, cid]);
      }
    }
    if (branchIdList) {
      await conn.execute("DELETE FROM user_branches WHERE user_id = ?", [id]);
      for (const bid of branchIdList) {
        await conn.execute("INSERT IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)", [id, bid]);
      }
    }

    // Role/scope changes should take effect immediately - bump
    // token_version so any already-issued token is forced to re-auth and
    // pick up the new permission set on their very next request.
    await conn.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [id]);

    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: id,
      action: "ACCESS_UPDATED",
      description: `${actingUser.username} updated access for ${target.username}`,
      beforeData: before,
      afterData: { fullName, roleCode: newRole?.code, companyIdList, branchIdList },
      user: actingUser,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getUser(id, actingUser);
}

async function updateUserStatus(id, status, actingUser) {
  if (!VALID_STATUSES.includes(status)) {
    throw Object.assign(new Error(`Status must be one of ${VALID_STATUSES.join(", ")}.`), { statusCode: 400 });
  }

  const target = await getUserOr404(id);
  await assertInScope(target, actingUser);

  if (target.id === actingUser.id && status !== "ACTIVE") {
    throw Object.assign(new Error("You cannot deactivate or suspend your own account."), { statusCode: 400 });
  }

  if (target.role_code === "SUPER_ADMIN" && status !== "ACTIVE") {
    const activeCount = await countActiveSuperAdmins(target.id);
    if (activeCount === 0) {
      throw Object.assign(new Error("Cannot deactivate the last active Super Admin."), { statusCode: 409 });
    }
  }

  const actionName = status === "ACTIVE" ? "USER_ACTIVATED" : status === "SUSPENDED" ? "USER_SUSPENDED" : "USER_DEACTIVATED";

  // Deactivating/suspending must revoke active sessions immediately -
  // bump token_version (checked on every request by middleware/authenticate.js).
  await pool.execute(
    `UPDATE users SET status = ?, token_version = token_version + 1 WHERE id = ?`,
    [status, id]
  );

  await logAudit(pool, {
    module: "USERS",
    entityType: "USER",
    entityId: id,
    action: actionName,
    description: `${actingUser.username} set ${target.username}'s status to ${status}`,
    beforeData: { status: target.status },
    afterData: { status },
    user: actingUser,
  });

  return getUser(id, actingUser);
}

async function unlockUser(id, actingUser) {
  const target = await getUserOr404(id);
  await assertInScope(target, actingUser);

  await pool.execute("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "USERS",
    entityType: "USER",
    entityId: id,
    action: "USER_UNLOCKED",
    description: `${actingUser.username} unlocked ${target.username}'s account`,
    user: actingUser,
  });

  return getUser(id, actingUser);
}

async function revokeSessions(id, actingUser) {
  const target = await getUserOr404(id);
  await assertInScope(target, actingUser);

  await pool.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "USERS",
    entityType: "USER",
    entityId: id,
    action: "SESSION_REVOKED",
    description: `${actingUser.username} revoked all active sessions for ${target.username}`,
    user: actingUser,
  });

  return { id, revoked: true };
}

module.exports = { listUsers, getUser, updateUserAccess, updateUserStatus, unlockUser, revokeSessions };
