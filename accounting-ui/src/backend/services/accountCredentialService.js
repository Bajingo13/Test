const bcrypt = require("bcryptjs");
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { soleCompanyOfUser } = require("../lib/auditCompany");
const CredentialPolicy = require("../lib/credentialPolicy");

// Credential management. Who may do what is lib/credentialPolicy: by default
// only SUPER_ADMIN self-service; where ADMIN_CREDENTIAL_MANAGEMENT=enabled also
// ADMIN self-service plus administrative changes to managed users (bottom of
// this file). ACCOUNTANT never.
//
// Self-service (POST /api/account/*): the account being changed is ALWAYS the authenticated user (req.user.id from
// middleware/authenticate.js) - no target user id is ever accepted from the
// browser. Only the credential columns are written; id, role, role_id, status,
// permissions and company/branch assignments are never touched, so this can
// never downgrade, deactivate or remove the (last) SUPER_ADMIN.
//
// Passwords: same bcrypt implementation and cost as every other password in the
// system (invitationService.acceptInvitation: bcryptjs, cost 10) and the same
// existing minimum length (8). bcrypt only uses the first 72 bytes of its input,
// so a longer password is rejected rather than silently truncated.
//
// Sessions: a password change increments users.token_version - the existing
// revocation mechanism checked on every request by middleware/authenticate.js -
// so every previously issued token (including the current one) stops working
// and the user must log in again. A username change keeps the session: the
// middleware re-reads the username from the database on every request, and the
// login lookup uses the stored username.

const BCRYPT_COST = 10;
const PASSWORD_MIN_LENGTH = 8; // the existing rule (invitation acceptance)
const PASSWORD_MAX_BYTES = 72; // bcrypt input limit
const USERNAME_MAX_LENGTH = 100; // users.username VARCHAR(100)
// Letters/digits plus . _ @ + - (covers the existing styles: e-mail usernames
// from invitations and bootstrap names such as "alas.superadmin"); starts with a
// letter or digit; no whitespace or control characters.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,99}$/;
const TARGET_FIELDS = ["id", "userId", "user_id", "targetUserId", "target_user_id", "username_id"];

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

// Requests may never name an account: the authenticated user is the account.
function assertNoTargetUser(body) {
  if (body && TARGET_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f))) {
    throw fail(400, "TARGET_USER_NOT_ALLOWED", "Credentials can only be changed for your own account.");
  }
}

function validateNewPassword(newPassword, confirmPassword) {
  if (typeof newPassword !== "string" || newPassword.length === 0) {
    throw fail(400, "PASSWORD_REQUIRED", "Enter a new password.");
  }
  if (newPassword.trim().length === 0) {
    throw fail(400, "PASSWORD_INVALID", "The new password cannot be blank.");
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw fail(400, "PASSWORD_TOO_SHORT", `The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (Buffer.byteLength(newPassword, "utf8") > PASSWORD_MAX_BYTES) {
    throw fail(400, "PASSWORD_TOO_LONG", `The new password must be at most ${PASSWORD_MAX_BYTES} bytes.`);
  }
  if (newPassword !== confirmPassword) {
    throw fail(400, "PASSWORD_MISMATCH", "The new password and its confirmation do not match.");
  }
}

function normalizeUsername(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw fail(400, "USERNAME_REQUIRED", "Enter a new username.");
  }
  const username = raw.trim();
  if (username.length > USERNAME_MAX_LENGTH || !USERNAME_RE.test(username)) {
    throw fail(
      400,
      "USERNAME_INVALID",
      `Usernames are 3-${USERNAME_MAX_LENGTH} characters: letters, digits and . _ @ + - only, starting with a letter or digit, no spaces.`
    );
  }
  return username;
}

// Locks and returns the authenticated user's row, and confirms it is ACTIVE and
// that its STORED role may change its own credentials (lib/credentialPolicy:
// SUPER_ADMIN, plus ADMIN where enabled) - re-checked here, not only in the route.
async function lockSelf(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.username, u.password, u.status, u.role_id, r.code AS role_code
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? FOR UPDATE`,
    [userId]
  );
  const user = rows[0];
  if (!user || user.status !== "ACTIVE") throw fail(401, "SESSION_INVALID", "Your session is no longer valid. Please log in again.");
  if (!CredentialPolicy.canChangeOwnCredentials(user.role_code)) {
    throw fail(403, "CREDENTIAL_CHANGE_NOT_ALLOWED", "You are not allowed to change account credentials.");
  }
  return user;
}

// Uniqueness follows the column's own collation (the same comparison the UNIQUE
// key and the login lookup use). Also reserved: another account's e-mail and a
// pending invitation's e-mail/username, because login accepts username OR e-mail
// and an accepted invitation becomes a user with that username.
async function assertUsernameAvailable(conn, username, userId) {
  const [[taken]] = await conn.execute(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE username = ? AND id <> ?) AS by_username,
       (SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?) AS by_email,
       (SELECT COUNT(*) FROM invitations WHERE (email = ? OR username = ?) AND status = 'PENDING') AS by_invitation`,
    [username, userId, username, userId, username, username]
  );
  if (Number(taken.by_username) || Number(taken.by_email) || Number(taken.by_invitation)) {
    throw fail(409, "USERNAME_TAKEN", "That username is already in use.");
  }
}

async function assertCurrentPassword(user, currentPassword) {
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    throw fail(400, "CURRENT_PASSWORD_REQUIRED", "Enter your current password.");
  }
  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) throw fail(400, "CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.");
}

// Proves the update touched credentials only: role, role_id and status are the
// same as before and the system still has an active SUPER_ADMIN.
async function assertIdentityPreserved(conn, before) {
  const [[after]] = await conn.execute(
    `SELECT u.role_id, u.status, r.code AS role_code,
            (SELECT COUNT(*) FROM users su JOIN roles sr ON sr.id = su.role_id
              WHERE sr.code = 'SUPER_ADMIN' AND su.status = 'ACTIVE') AS active_super_admins
       FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [before.id]
  );
  if (!after || after.role_id !== before.role_id || after.status !== before.status || after.role_code !== before.role_code || Number(after.active_super_admins) < 1) {
    throw fail(500, "IDENTITY_CHANGED", "The change could not be completed.");
  }
}

async function auditRejected(actingUser, action, reason, meta) {
  try {
    await logAudit(pool, {
      module: "USERS",
      entityType: "USER",
      entityId: actingUser.id,
      action,
      description: `${actingUser.username} - credential change rejected (${reason})`,
      user: actingUser,
      ...meta,
    });
  } catch (err) {
    console.error("CREDENTIAL AUDIT ERROR:", err.message);
  }
}

async function changePassword({ actingUser, body = {}, meta = {} }) {
  assertNoTargetUser(body);
  const { currentPassword, newPassword, confirmPassword } = body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const user = await lockSelf(conn, actingUser.id);
    await assertCurrentPassword(user, currentPassword);
    validateNewPassword(newPassword, confirmPassword);
    if (await bcrypt.compare(newPassword, user.password)) {
      throw fail(400, "PASSWORD_UNCHANGED", "The new password must be different from the current password.");
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const [result] = await conn.execute(
      `UPDATE users
          SET password = ?, token_version = token_version + 1, failed_login_count = 0, locked_until = NULL
        WHERE id = ? AND role_id = ? AND status = 'ACTIVE'`,
      [hash, user.id, user.role_id]
    );
    if (result.affectedRows !== 1) throw fail(409, "CREDENTIAL_CONFLICT", "The change could not be completed. Please try again.");
    await assertIdentityPreserved(conn, user);
    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: user.id,
      action: "PASSWORD_CHANGED",
      description: `${user.username} changed their password; all existing sessions were signed out`,
      user: actingUser,
      ...meta,
    });
    await conn.commit();
    return { reauthRequired: true };
  } catch (err) {
    await conn.rollback().catch(() => {});
    // audited only after the row lock is released (audit_logs may reference users)
    if (err.code === "CURRENT_PASSWORD_INCORRECT") await auditRejected(actingUser, "PASSWORD_CHANGE_REJECTED", "incorrect current password", meta);
    throw err;
  } finally {
    conn.release();
  }
}

async function changeUsername({ actingUser, body = {}, meta = {} }) {
  assertNoTargetUser(body);
  const { currentPassword, newUsername } = body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const user = await lockSelf(conn, actingUser.id);
    await assertCurrentPassword(user, currentPassword);
    const username = normalizeUsername(newUsername);
    if (username === user.username) throw fail(400, "USERNAME_UNCHANGED", "The new username is the same as the current one.");
    await assertUsernameAvailable(conn, username, user.id);
    let result;
    try {
      [result] = await conn.execute(
        "UPDATE users SET username = ? WHERE id = ? AND role_id = ? AND status = 'ACTIVE'",
        [username, user.id, user.role_id]
      );
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") throw fail(409, "USERNAME_TAKEN", "That username is already in use.");
      throw err;
    }
    if (result.affectedRows !== 1) throw fail(409, "CREDENTIAL_CONFLICT", "The change could not be completed. Please try again.");
    await assertIdentityPreserved(conn, user);
    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: user.id,
      action: "USERNAME_CHANGED",
      description: `Username changed from ${user.username} to ${username}`,
      beforeData: { username: user.username },
      afterData: { username },
      user: { ...actingUser, username },
      ...meta,
    });
    await conn.commit();
    return { username };
  } catch (err) {
    await conn.rollback().catch(() => {});
    // audited only after the row lock is released (audit_logs may reference users)
    if (err.code === "CURRENT_PASSWORD_INCORRECT") await auditRejected(actingUser, "USERNAME_CHANGE_REJECTED", "incorrect current password", meta);
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Administrative changes to ANOTHER user's credentials
// (POST /api/users/:id/reset-password, POST /api/users/:id/change-username).
// Only where lib/credentialPolicy enables them (ALAS). Who may change whom is
// the existing User Settings manage scope (userService.assertCanManage):
// SUPER_ADMIN -> anyone; ADMIN -> Accountants sharing a company (a SUPER_ADMIN
// target is invisible = 404, a fellow ADMIN = 403); ACCOUNTANT -> no one.
// Your own account always goes through Account Security (current password).
// Only the credential column is written: role, status, company/branch
// assignments, permission overrides and the lockout state are never touched.

async function lockManagedTarget(conn, actingUser, targetId) {
  if (!CredentialPolicy.canManageOthersCredentials(actingUser.roleCode)) {
    throw fail(403, "CREDENTIAL_ADMIN_NOT_ALLOWED", "You are not allowed to manage user credentials.");
  }
  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) throw fail(404, "USER_NOT_FOUND", "User not found");
  if (id === Number(actingUser.id)) {
    throw fail(400, "USE_ACCOUNT_SECURITY", "Change your own username or password in Account Security.");
  }
  // Scope first (same 404/403 answers as every other User List action) ...
  const UserService = require("./userService");
  const visible = await UserService.getUserOr404(id).catch((err) => {
    throw err.statusCode === 404 ? fail(404, "USER_NOT_FOUND", "User not found") : err;
  });
  await UserService.assertCanManage(visible, actingUser).catch((err) => {
    throw fail(err.statusCode || 403, err.statusCode === 404 ? "USER_NOT_FOUND" : "USER_NOT_MANAGEABLE", err.message);
  });
  // ... then lock the row and make sure the role did not change in between.
  const [rows] = await conn.execute(
    `SELECT u.id, u.username, u.password, u.status, u.role_id, r.code AS role_code
       FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE`,
    [id]
  );
  const target = rows[0];
  if (!target || target.role_id !== visible.role_id) throw fail(409, "CREDENTIAL_CONFLICT", "The change could not be completed. Please try again.");
  return target;
}

async function adminResetPassword({ actingUser, targetId, body = {}, meta = {} }) {
  const { newPassword, confirmPassword } = body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const target = await lockManagedTarget(conn, actingUser, targetId);
    validateNewPassword(newPassword, confirmPassword);
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // token_version + 1 signs the user out everywhere (authenticate.js checks it
    // on every request). Lockout counters are left alone - Unlock stays separate.
    const [result] = await conn.execute(
      "UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ? AND role_id = ? AND status = ?",
      [hash, target.id, target.role_id, target.status]
    );
    if (result.affectedRows !== 1) throw fail(409, "CREDENTIAL_CONFLICT", "The change could not be completed. Please try again.");
    await assertIdentityPreserved(conn, target);
    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: target.id,
      action: "PASSWORD_RESET",
      description: `${actingUser.username} reset the password for ${target.username}; all of their sessions were signed out`,
      user: actingUser,
      companyId: await soleCompanyOfUser(conn, target.id),
      ...meta,
    });
    await conn.commit();
    return { id: target.id, username: target.username, sessionsRevoked: true };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function adminChangeUsername({ actingUser, targetId, body = {}, meta = {} }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const target = await lockManagedTarget(conn, actingUser, targetId);
    const username = normalizeUsername(body.newUsername);
    if (username === target.username) throw fail(400, "USERNAME_UNCHANGED", "The new username is the same as the current one.");
    await assertUsernameAvailable(conn, username, target.id);
    let result;
    try {
      [result] = await conn.execute(
        "UPDATE users SET username = ? WHERE id = ? AND role_id = ? AND status = ?",
        [username, target.id, target.role_id, target.status]
      );
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") throw fail(409, "USERNAME_TAKEN", "That username is already in use.");
      throw err;
    }
    if (result.affectedRows !== 1) throw fail(409, "CREDENTIAL_CONFLICT", "The change could not be completed. Please try again.");
    await assertIdentityPreserved(conn, target);
    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: target.id,
      action: "USERNAME_CHANGED",
      description: `${actingUser.username} changed the username of ${target.username} to ${username}`,
      beforeData: { username: target.username },
      afterData: { username },
      user: actingUser,
      companyId: await soleCompanyOfUser(conn, target.id),
      ...meta,
    });
    await conn.commit();
    return { id: target.id, username };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
  USERNAME_RE,
  changePassword,
  changeUsername,
  adminResetPassword,
  adminChangeUsername,
  // exported for unit tests
  validateNewPassword,
  normalizeUsername,
};
