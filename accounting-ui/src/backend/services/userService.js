const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { soleCompanyForAccess, soleCompanyOfUser } = require("../lib/auditCompany");
const UserAccessService = require("./userAccessService");

const VALID_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];

// Non-Super-Admin actors only see users who share at least one company
// with them - Admin's "manage users within assigned scope."
async function listUsers(actingUser) {
  if (actingUser.roleCode === "SUPER_ADMIN") {
    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.email, u.full_name, u.status, u.last_login_at, u.locked_until, u.created_at, u.created_by,
       (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
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
       (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
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
       (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS is_locked,
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
  return withAccessSummary(user);
}

async function withAccessSummary(user) {
  const { companies, branches } = await UserAccessService.getUserAccessSummary(user.id);
  return { ...user, companies, branches };
}

// Who may manage whom. Super Admin manages everyone (but never another
// Super Admin's role - see updateUserAccess); Admin manages Accountants
// only. Anyone not listed (Accountant) manages no one.
const MANAGEABLE_ROLES_BY_ACTOR = {
  SUPER_ADMIN: ["SUPER_ADMIN", "ADMIN", "ACCOUNTANT"],
  ADMIN: ["ACCOUNTANT"],
};

// Roles an actor may assign through Edit Access. Super Admin is never
// assignable here (mirrors invitationService's INVITABLE_ROLES_BY_INVITER).
const ASSIGNABLE_ROLES_BY_ACTOR = {
  SUPER_ADMIN: ["ADMIN", "ACCOUNTANT"],
  ADMIN: ["ACCOUNTANT"],
};

function notFound() {
  return Object.assign(new Error("User not found"), { statusCode: 404 });
}

function forbidden(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function isSelf(target, actingUser) {
  return Number(target.id) === Number(actingUser.id);
}

// Shared scope guard: non-Super-Admins can only see users who share at
// least one company with them, and never a Super Admin. Anything outside
// that scope gets exactly the same 404 as a user id that doesn't exist, so
// the response reveals nothing about who exists elsewhere.
async function assertInScope(targetUser, actingUser) {
  if (actingUser.roleCode === "SUPER_ADMIN") return;
  if (isSelf(targetUser, actingUser)) return;

  if (targetUser.role_code === "SUPER_ADMIN") throw notFound();

  const actingCompanyIds = new Set(await UserAccessService.getAccessibleCompanyIds(actingUser.id));
  const targetCompanyIds = await UserAccessService.getAccessibleCompanyIds(targetUser.id);
  const sharesCompany = targetCompanyIds.some((id) => actingCompanyIds.has(id));
  if (!sharesCompany) throw notFound();
}

// Visible is not the same as manageable: an Admin can see a fellow Admin
// in a shared company but may not change them. Acting on your own account
// is decided by each operation (own role/status changes are refused there).
async function assertCanManage(targetUser, actingUser) {
  await assertInScope(targetUser, actingUser);
  if (isSelf(targetUser, actingUser)) return;
  const manageable = MANAGEABLE_ROLES_BY_ACTOR[actingUser.roleCode] || [];
  if (!manageable.includes(targetUser.role_code)) {
    throw forbidden(
      actingUser.roleCode === "ADMIN"
        ? "Admins can only manage Accountant users."
        : "You do not have permission to manage this user."
    );
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

function parseIdList(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw badRequest(`${label} must be a list.`);
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw badRequest(`Selected ${label.toLowerCase()} are not valid.`);
  }
  return [...new Set(ids)];
}

async function assertAllExist(table, ids, message) {
  if (!ids.length) return;
  const [rows] = await pool.query(`SELECT id FROM ${table} WHERE id IN (?)`, [ids]);
  if (rows.length !== ids.length) throw badRequest(message);
}

// The actor edits only the memberships inside their own scope; anything
// outside it is carried over untouched. Super Admin's scope is everything,
// so their submission is the full list.
function mergeMemberships(existingIds, submittedIds, actorScope) {
  if (actorScope === null) return submittedIds;
  const preserved = existingIds.filter((id) => !actorScope.has(id));
  return [...new Set([...preserved, ...submittedIds])];
}

const sortIds = (ids) => [...ids].sort((a, b) => a - b);

async function updateUserAccess(id, { fullName, roleId, companyIds, branchIds }, actingUser) {
  const target = await getUserOr404(id);
  await assertCanManage(target, actingUser);

  // Validate everything before writing anything, so a rejected request
  // leaves the user exactly as it was.
  let newRole = null;
  if (roleId && Number(roleId) !== target.role_id) {
    if (isSelf(target, actingUser)) {
      throw forbidden("You cannot change your own role.");
    }
    if (target.role_code === "SUPER_ADMIN") {
      throw forbidden("A Super Admin's role cannot be changed.");
    }
    const [roleRows] = await pool.execute("SELECT id, code, name FROM roles WHERE id = ?", [roleId]);
    newRole = roleRows[0];
    if (!newRole) {
      throw badRequest("Selected role does not exist.");
    }
    const assignable = ASSIGNABLE_ROLES_BY_ACTOR[actingUser.roleCode] || [];
    if (!assignable.includes(newRole.code)) {
      throw forbidden(`You cannot assign the ${newRole.name} role.`);
    }
  }

  const submittedCompanyIds = parseIdList(companyIds, "Companies");
  const submittedBranchIds = parseIdList(branchIds, "Branches");

  const isSuper = actingUser.roleCode === "SUPER_ADMIN";
  const actorCompanyScope = isSuper ? null : new Set(await UserAccessService.getAccessibleCompanyIds(actingUser.id));
  const actorBranchScope = isSuper ? null : new Set(await UserAccessService.getAccessibleBranchIds(actingUser.id));

  if (submittedCompanyIds) {
    await assertAllExist("companies", submittedCompanyIds, "Selected company does not exist.");
    if (actorCompanyScope && submittedCompanyIds.some((cid) => !actorCompanyScope.has(cid))) {
      throw forbidden("You can only assign companies/branches you yourself have access to.");
    }
  }
  if (submittedBranchIds) {
    await assertAllExist("branches", submittedBranchIds, "Selected branch does not exist.");
    if (actorBranchScope && submittedBranchIds.some((bid) => !actorBranchScope.has(bid))) {
      throw forbidden("You can only assign companies/branches you yourself have access to.");
    }
  }

  const existingCompanyIds = await UserAccessService.getAccessibleCompanyIds(target.id);
  const existingBranchIds = await UserAccessService.getAccessibleBranchIds(target.id);
  const finalCompanyIds = submittedCompanyIds
    ? mergeMemberships(existingCompanyIds, submittedCompanyIds, actorCompanyScope)
    : existingCompanyIds;
  const finalBranchIds = submittedBranchIds
    ? mergeMemberships(existingBranchIds, submittedBranchIds, actorBranchScope)
    : existingBranchIds;

  // Super Admins bypass company scoping, so only other roles need a company.
  const finalRoleCode = newRole ? newRole.code : target.role_code;
  if (submittedCompanyIds && finalRoleCode !== "SUPER_ADMIN" && finalCompanyIds.length === 0) {
    throw badRequest("Select at least one company for this user.");
  }

  const before = {
    fullName: target.full_name,
    roleCode: target.role_code,
    companyIds: sortIds(existingCompanyIds),
    branchIds: sortIds(existingBranchIds),
  };
  const after = {
    fullName: fullName || target.full_name,
    roleCode: finalRoleCode,
    companyIds: sortIds(finalCompanyIds),
    branchIds: sortIds(finalBranchIds),
  };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (fullName) {
      await conn.execute("UPDATE users SET full_name = ? WHERE id = ?", [fullName, id]);
    }
    if (newRole) {
      await conn.execute("UPDATE users SET role_id = ? WHERE id = ?", [newRole.id, id]);
    }
    if (submittedCompanyIds) {
      await conn.execute("DELETE FROM user_companies WHERE user_id = ?", [id]);
      for (const cid of finalCompanyIds) {
        await conn.execute("INSERT IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)", [id, cid]);
      }
    }
    if (submittedBranchIds) {
      await conn.execute("DELETE FROM user_branches WHERE user_id = ?", [id]);
      for (const bid of finalBranchIds) {
        await conn.execute("INSERT IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)", [id, bid]);
      }
    }

    // Role/scope changes should take effect immediately - bump
    // token_version so any already-issued token is forced to re-auth and
    // pick up the new permission set on their very next request.
    await conn.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [id]);

    // Company of the event: the one company spanned by the before AND
    // after access sets (a move from A to B touches two - stays NULL).
    const auditCompanyId = await soleCompanyForAccess(conn, {
      companyIds: [...before.companyIds, ...after.companyIds],
      branchIds: [...before.branchIds, ...after.branchIds],
    });

    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: id,
      action: "ACCESS_UPDATED",
      description: `${actingUser.username} updated access for ${target.username}`,
      beforeData: before,
      afterData: after,
      user: actingUser,
      companyId: auditCompanyId,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // No second scope check: the change is committed, and an Admin who just
  // moved the user out of their shared companies must get a success
  // response, not a misleading error for a change that did happen.
  return withAccessSummary(await getUserOr404(id));
}

async function updateUserStatus(id, status, actingUser) {
  if (!VALID_STATUSES.includes(status)) {
    throw Object.assign(new Error(`Status must be one of ${VALID_STATUSES.join(", ")}.`), { statusCode: 400 });
  }

  const target = await getUserOr404(id);
  await assertCanManage(target, actingUser);

  if (isSelf(target, actingUser) && status !== "ACTIVE") {
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
    companyId: await soleCompanyOfUser(pool, id),
  });

  return withAccessSummary(await getUserOr404(id));
}

async function unlockUser(id, actingUser) {
  const target = await getUserOr404(id);
  await assertCanManage(target, actingUser);

  await pool.execute("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "USERS",
    entityType: "USER",
    entityId: id,
    action: "USER_UNLOCKED",
    description: `${actingUser.username} unlocked ${target.username}'s account`,
    user: actingUser,
    companyId: await soleCompanyOfUser(pool, id),
  });

  return withAccessSummary(await getUserOr404(id));
}

async function revokeSessions(id, actingUser) {
  const target = await getUserOr404(id);
  await assertCanManage(target, actingUser);

  await pool.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "USERS",
    entityType: "USER",
    entityId: id,
    action: "SESSION_REVOKED",
    description: `${actingUser.username} revoked all active sessions for ${target.username}`,
    user: actingUser,
    companyId: await soleCompanyOfUser(pool, id),
  });

  return { id, revoked: true };
}

module.exports = {
  listUsers,
  getUser,
  updateUserAccess,
  updateUserStatus,
  unlockUser,
  revokeSessions,
  MANAGEABLE_ROLES_BY_ACTOR,
  ASSIGNABLE_ROLES_BY_ACTOR,
};
