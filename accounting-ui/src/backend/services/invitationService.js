const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const EmailService = require("./emailService");
const UserAccessService = require("./userAccessService");

const DEFAULT_EXPIRY_DAYS = 7;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 30;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Raw token goes in the emailed link, only its SHA-256 hash is ever stored
// - same principle as a password, so a DB leak alone can't be used to
// accept someone else's invitation.
function generateToken() {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
}

async function createInvitation({ email, fullName, roleId, companyIds, branchIds, expiresInDays, permissionTemplateId, actingUser }) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw Object.assign(new Error("A valid email address is required."), { statusCode: 400 });
  }
  if (!fullName || !String(fullName).trim()) {
    throw Object.assign(new Error("Full name is required."), { statusCode: 400 });
  }

  const [roleRows] = await pool.execute("SELECT id, code, name FROM roles WHERE id = ?", [roleId]);
  const role = roleRows[0];
  if (!role) {
    throw Object.assign(new Error("Selected role does not exist."), { statusCode: 400 });
  }

  // Admins can never create a Super Admin, and can never invite anyone
  // into a role higher than their own effective scope. Only a Super Admin
  // may invite another Super Admin.
  if (role.code === "SUPER_ADMIN" && actingUser.roleCode !== "SUPER_ADMIN") {
    throw Object.assign(new Error("Only a Super Admin can invite another Super Admin."), { statusCode: 403 });
  }

  const companyIdList = Array.isArray(companyIds) ? companyIds.map(Number).filter(Boolean) : [];
  const branchIdList = Array.isArray(branchIds) ? branchIds.map(Number).filter(Boolean) : [];

  if (actingUser.roleCode !== "SUPER_ADMIN") {
    const accessibleCompanyIds = new Set(await UserAccessService.getAccessibleCompanyIds(actingUser.id));
    const accessibleBranchIds = new Set(await UserAccessService.getAccessibleBranchIds(actingUser.id));
    const outOfScopeCompany = companyIdList.find((id) => !accessibleCompanyIds.has(id));
    const outOfScopeBranch = branchIdList.find((id) => !accessibleBranchIds.has(id));
    if (outOfScopeCompany || outOfScopeBranch) {
      throw Object.assign(new Error("You can only assign companies/branches you yourself have access to."), { statusCode: 403 });
    }
  }

  // Duplicate-email prevention: an existing account, or an already-pending
  // invitation for the same address.
  const [existingUser] = await pool.execute("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
  if (existingUser.length > 0) {
    throw Object.assign(new Error("A user with this email already exists."), { statusCode: 409 });
  }
  const [existingInvite] = await pool.execute(
    "SELECT id FROM invitations WHERE email = ? AND status = 'PENDING'",
    [normalizedEmail]
  );
  if (existingInvite.length > 0) {
    throw Object.assign(new Error("An invitation is already pending for this email. Resend or revoke it instead."), { statusCode: 409 });
  }

  const days = Math.min(Math.max(Number(expiresInDays) || DEFAULT_EXPIRY_DAYS, MIN_EXPIRY_DAYS), MAX_EXPIRY_DAYS);
  const { raw, hash } = generateToken();

  const [result] = await pool.execute(
    `INSERT INTO invitations
      (email, full_name, role_id, company_ids, branch_ids, permission_template_id, token_hash, status, expires_at, invited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
    [normalizedEmail, String(fullName).trim(), roleId, JSON.stringify(companyIdList), JSON.stringify(branchIdList), permissionTemplateId || null, hash, days, actingUser.id]
  );
  const invitationId = result.insertId;

  const [companyRows] = companyIdList.length
    ? await pool.execute(`SELECT name FROM companies WHERE id IN (${companyIdList.map(() => "?").join(",")})`, companyIdList)
    : [[]];

  const acceptUrl = `${frontendBaseUrl()}/accept-invite?token=${raw}`;
  const [invRow] = await pool.execute("SELECT expires_at FROM invitations WHERE id = ?", [invitationId]);

  const emailResult = await EmailService.sendInvitationEmail({
    to: normalizedEmail,
    fullName: String(fullName).trim(),
    roleName: role.name,
    companyName: companyRows[0]?.name,
    acceptUrl,
    expiresAt: invRow[0].expires_at,
  });

  await pool.execute(
    "UPDATE invitations SET last_sent_at = NOW(), email_delivery_status = ? WHERE id = ?",
    [emailResult.delivered ? "SENT" : "NOT_SENT", invitationId]
  );

  await logAudit(pool, {
    module: "INVITATIONS",
    entityType: "INVITATION",
    entityId: invitationId,
    action: "USER_INVITED",
    description: `${actingUser.username} invited ${normalizedEmail} as ${role.name}`,
    afterData: { email: normalizedEmail, roleCode: role.code, companyIdList, branchIdList, emailDelivered: emailResult.delivered },
    user: actingUser,
  });

  return {
    id: invitationId,
    email: normalizedEmail,
    emailDelivered: emailResult.delivered,
    // Only ever returned to the ACTING (already-authenticated, permission-
    // checked) admin as a manual-share fallback when SMTP isn't configured
    // or delivery failed - never logged, never emailed in plaintext to
    // anyone else, and the invitation is otherwise indistinguishable from
    // one that was delivered normally.
    acceptUrl: emailResult.delivered ? undefined : acceptUrl,
  };
}

async function listInvitations(actingUser) {
  const params = [];
  let scopeSql = "";
  if (actingUser.roleCode !== "SUPER_ADMIN") {
    scopeSql = "WHERE i.invited_by = ?";
    params.push(actingUser.id);
  }

  const [rows] = await pool.execute(
    `SELECT i.id, i.email, i.full_name, r.name AS role_name, r.code AS role_code, i.status,
       i.expires_at, i.resend_count, i.last_sent_at, i.email_delivery_status,
       i.created_at, i.accepted_at, u.username AS invited_by_username
     FROM invitations i
     JOIN roles r ON r.id = i.role_id
     LEFT JOIN users u ON u.id = i.invited_by
     ${scopeSql}
     ORDER BY i.created_at DESC`,
    params
  );
  return rows;
}

async function getInvitationOr404(id) {
  const [rows] = await pool.execute("SELECT * FROM invitations WHERE id = ?", [id]);
  const invitation = rows[0];
  if (!invitation) {
    throw Object.assign(new Error("Invitation not found"), { statusCode: 404 });
  }
  return invitation;
}

async function resendInvitation(id, actingUser) {
  const invitation = await getInvitationOr404(id);
  if (invitation.status !== "PENDING") {
    throw Object.assign(new Error(`Cannot resend an invitation with status ${invitation.status}.`), { statusCode: 409 });
  }

  const { raw, hash } = generateToken();
  await pool.execute(
    `UPDATE invitations
     SET token_hash = ?, expires_at = DATE_ADD(NOW(), INTERVAL ? DAY), resend_count = resend_count + 1, last_sent_at = NOW()
     WHERE id = ?`,
    [hash, DEFAULT_EXPIRY_DAYS, id]
  );

  const [roleRows] = await pool.execute("SELECT name FROM roles WHERE id = ?", [invitation.role_id]);
  const acceptUrl = `${frontendBaseUrl()}/accept-invite?token=${raw}`;
  const [freshRow] = await pool.execute("SELECT expires_at FROM invitations WHERE id = ?", [id]);

  const emailResult = await EmailService.sendInvitationEmail({
    to: invitation.email,
    fullName: invitation.full_name,
    roleName: roleRows[0]?.name || "User",
    acceptUrl,
    expiresAt: freshRow[0].expires_at,
  });

  await pool.execute("UPDATE invitations SET email_delivery_status = ? WHERE id = ?", [emailResult.delivered ? "SENT" : "NOT_SENT", id]);

  await logAudit(pool, {
    module: "INVITATIONS",
    entityType: "INVITATION",
    entityId: id,
    action: "INVITATION_RESENT",
    description: `${actingUser.username} resent invitation to ${invitation.email}`,
    afterData: { emailDelivered: emailResult.delivered },
    user: actingUser,
  });

  return { id, emailDelivered: emailResult.delivered, acceptUrl: emailResult.delivered ? undefined : acceptUrl };
}

async function revokeInvitation(id, actingUser) {
  const invitation = await getInvitationOr404(id);
  if (invitation.status !== "PENDING") {
    throw Object.assign(new Error(`Cannot revoke an invitation with status ${invitation.status}.`), { statusCode: 409 });
  }

  await pool.execute(
    "UPDATE invitations SET status = 'REVOKED', revoked_at = NOW(), revoked_by = ? WHERE id = ?",
    [actingUser.id, id]
  );

  await logAudit(pool, {
    module: "INVITATIONS",
    entityType: "INVITATION",
    entityId: id,
    action: "INVITATION_REVOKED",
    description: `${actingUser.username} revoked invitation to ${invitation.email}`,
    user: actingUser,
  });

  return { id, status: "REVOKED" };
}

async function validateToken(rawToken) {
  const hash = crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");

  const [rows] = await pool.execute(
    `SELECT i.id, i.email, i.full_name, i.status, i.expires_at, r.name AS role_name, i.company_ids
     FROM invitations i JOIN roles r ON r.id = i.role_id
     WHERE i.token_hash = ?`,
    [hash]
  );
  const invitation = rows[0];

  if (!invitation) {
    throw Object.assign(new Error("This invitation link is invalid."), { statusCode: 404 });
  }
  if (invitation.status !== "PENDING") {
    throw Object.assign(new Error("This invitation has already been used or is no longer valid."), { statusCode: 410 });
  }
  if (new Date(invitation.expires_at) < new Date()) {
    throw Object.assign(new Error("This invitation link has expired."), { statusCode: 410 });
  }

  let companyNames = [];
  const companyIds = invitation.company_ids || [];
  if (companyIds.length) {
    const [companyRows] = await pool.execute(
      `SELECT name FROM companies WHERE id IN (${companyIds.map(() => "?").join(",")})`,
      companyIds
    );
    companyNames = companyRows.map((c) => c.name);
  }

  // Never expose raw database IDs - only display-safe fields.
  return {
    email: invitation.email,
    fullName: invitation.full_name,
    roleName: invitation.role_name,
    companyNames,
    expiresAt: invitation.expires_at,
  };
}

async function acceptInvitation({ token, password, acceptedTerms }) {
  if (!password || password.length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters."), { statusCode: 400 });
  }
  if (!acceptedTerms) {
    throw Object.assign(new Error("You must accept the terms to continue."), { statusCode: 400 });
  }

  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute("SELECT * FROM invitations WHERE token_hash = ? FOR UPDATE", [hash]);
    const invitation = rows[0];

    if (!invitation) {
      throw Object.assign(new Error("This invitation link is invalid."), { statusCode: 404 });
    }
    if (invitation.status !== "PENDING") {
      throw Object.assign(new Error("This invitation has already been used or is no longer valid."), { statusCode: 410 });
    }
    if (new Date(invitation.expires_at) < new Date()) {
      throw Object.assign(new Error("This invitation link has expired."), { statusCode: 410 });
    }

    const [existingUser] = await conn.execute("SELECT id FROM users WHERE email = ?", [invitation.email]);
    if (existingUser.length > 0) {
      throw Object.assign(new Error("An account with this email already exists."), { statusCode: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [userResult] = await conn.execute(
      `INSERT INTO users (username, password, full_name, role, role_id, status, email, created_by)
       VALUES (?, ?, ?, 'user', ?, 'ACTIVE', ?, ?)`,
      [invitation.email, passwordHash, invitation.full_name, invitation.role_id, invitation.email, invitation.invited_by]
    );
    const newUserId = userResult.insertId;

    const companyIds = invitation.company_ids || [];
    const branchIds = invitation.branch_ids || [];
    for (const companyId of companyIds) {
      await conn.execute("INSERT IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)", [newUserId, companyId]);
    }
    for (const branchId of branchIds) {
      await conn.execute("INSERT IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)", [newUserId, branchId]);
    }

    // A permission template, if selected at invite time, is copied into
    // this new user's overrides as a one-time starting point - not a live
    // link, so later template edits never silently change this user. This
    // must write a COMPLETE override set (explicit allow AND explicit deny
    // for every permission in the catalog, via the LEFT JOIN below), not
    // just allow-rows for what the template includes - otherwise a
    // restrictive template applied on top of a broader role wouldn't
    // actually restrict anything, since unmentioned permissions would fall
    // through to the role's own (broader) defaults.
    if (invitation.permission_template_id) {
      const [templateItems] = await conn.execute(
        `SELECT p.id AS permission_id, COALESCE(i.granted, 0) AS granted
         FROM permissions p
         LEFT JOIN permission_template_items i ON i.permission_id = p.id AND i.template_id = ?`,
        [invitation.permission_template_id]
      );
      for (const item of templateItems) {
        await conn.execute(
          "INSERT IGNORE INTO user_permissions (user_id, permission_id, granted, created_by, reason) VALUES (?, ?, ?, ?, ?)",
          [newUserId, item.permission_id, item.granted, invitation.invited_by, "Applied from permission template at invitation acceptance"]
        );
      }
    }

    const [updateResult] = await conn.execute(
      "UPDATE invitations SET status = 'ACCEPTED', accepted_at = NOW(), accepted_user_id = ? WHERE id = ? AND status = 'PENDING'",
      [newUserId, invitation.id]
    );
    if (updateResult.affectedRows === 0) {
      // Someone else accepted this exact invitation in the moment between
      // our SELECT ... FOR UPDATE and here - extremely unlikely given the
      // row lock, but fail safe rather than risk a double-accept.
      throw Object.assign(new Error("This invitation has already been used."), { statusCode: 410 });
    }

    await logAudit(conn, {
      module: "INVITATIONS",
      entityType: "INVITATION",
      entityId: invitation.id,
      action: "INVITATION_ACCEPTED",
      description: `${invitation.email} accepted their invitation and activated their account`,
      afterData: { newUserId },
      user: { id: newUserId, username: invitation.email },
    });
    await logAudit(conn, {
      module: "USERS",
      entityType: "USER",
      entityId: newUserId,
      action: "USER_ACTIVATED",
      description: `Account activated via invitation for ${invitation.email}`,
      user: { id: newUserId, username: invitation.email },
    });

    await conn.commit();
    return { userId: newUserId, username: invitation.email };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  validateToken,
  acceptInvitation,
};
