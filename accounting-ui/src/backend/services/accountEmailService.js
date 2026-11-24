const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const EmailService = require("./emailService");

// SUPER_ADMIN notification e-mail (Account Security), verified before use.
//
//   1. requestEmailChange (authenticated SUPER_ADMIN, current password required):
//      validates the address against the SAME identifier rules as the rest of the
//      system (unused as any account's username or e-mail and by any pending
//      invitation), supersedes this account's earlier pending requests, stores
//      only the SHA-256 of a fresh 256-bit token with a short expiry, and e-mails
//      the one-time link to the NEW address. users.email is not touched.
//   2. confirmEmailChange (public - the link may be opened in another browser;
//      the token is the proof): accepts a PENDING, unexpired token exactly once,
//      re-checks the account (still an ACTIVE SUPER_ADMIN) and the address
//      (still unused), then writes users.email and marks the token USED in one
//      transaction. The previous address (if any) gets a courtesy notice.
//
// Only users.email changes: username, role, status, permissions and company /
// branch assignments are never written. Accounts without an e-mail keep working
// exactly as before. Audit rows carry the addresses but never a token, hash or
// password. Responses never contain the token.

const TOKEN_TTL_MINUTES = 30;
const EMAIL_MAX_LENGTH = 255; // users.email VARCHAR(255)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same rule as invitations
const TOKEN_RE = /^[0-9a-f]{64}$/;
const TARGET_FIELDS = ["id", "userId", "user_id", "targetUserId", "target_user_id"];

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
}

// "j***@example.com" - for UI display of a pending address.
function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function normalizeEmail(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) throw fail(400, "EMAIL_REQUIRED", "Enter an email address.");
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) throw fail(400, "EMAIL_INVALID", "Enter a valid email address.");
  return email;
}

function assertNoTargetUser(body) {
  if (body && TARGET_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f))) {
    throw fail(400, "TARGET_USER_NOT_ALLOWED", "The email can only be changed for your own account.");
  }
}

async function lockSelf(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.username, u.full_name, u.email, u.password, u.status, u.role_id, r.code AS role_code
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? FOR UPDATE`,
    [userId]
  );
  const user = rows[0];
  if (!user || user.status !== "ACTIVE") throw fail(401, "SESSION_INVALID", "Your session is no longer valid. Please log in again.");
  if (user.role_code !== "SUPER_ADMIN") throw fail(403, "SUPER_ADMIN_REQUIRED", "Super Admin access required");
  return user;
}

// Is `email` free for account `userId`? Compared with the columns' own
// collation (case-insensitive) - the same comparison as login and the UNIQUE keys.
async function emailAvailable(conn, email, userId) {
  const [[r]] = await conn.execute(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE (email = ? OR username = ?) AND id <> ?) AS users_n,
       (SELECT COUNT(*) FROM invitations WHERE status = 'PENDING' AND (email = ? OR username = ?)) AS invitations_n`,
    [email, email, userId, email, email]
  );
  return Number(r.users_n) === 0 && Number(r.invitations_n) === 0;
}

async function auditSafe(entry) {
  try {
    await logAudit(pool, entry);
  } catch (err) {
    console.error("ACCOUNT EMAIL AUDIT ERROR:", err.message);
  }
}

// GET /api/account/email
async function getEmailStatus({ actingUser }) {
  const [[row]] = await pool.execute("SELECT email FROM users WHERE id = ?", [actingUser.id]);
  const [pending] = await pool.execute(
    `SELECT new_email, expires_at FROM account_email_verifications
      WHERE user_id = ? AND status = 'PENDING' AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`,
    [actingUser.id]
  );
  return {
    email: row?.email || null,
    pending: pending[0] ? { email: maskEmail(pending[0].new_email), expiresAt: pending[0].expires_at } : null,
  };
}

// POST /api/account/email/request { currentPassword, newEmail }
async function requestEmailChange({ actingUser, body = {}, meta = {} }) {
  assertNoTargetUser(body);
  const { currentPassword, newEmail } = body;
  const conn = await pool.getConnection();
  let user;
  let email;
  let raw;
  let expiresAt;
  try {
    await conn.beginTransaction();
    user = await lockSelf(conn, actingUser.id);
    if (typeof currentPassword !== "string" || currentPassword.length === 0) {
      throw fail(400, "CURRENT_PASSWORD_REQUIRED", "Enter your current password.");
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw fail(400, "CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.");
    }
    email = normalizeEmail(newEmail);
    if (user.email && user.email.toLowerCase() === email) throw fail(400, "EMAIL_UNCHANGED", "That is already your notification email.");
    if (!(await emailAvailable(conn, email, user.id))) throw fail(409, "EMAIL_TAKEN", "That email address is already in use.");

    // One live request per account: earlier pending links stop working.
    await conn.execute("UPDATE account_email_verifications SET status = 'SUPERSEDED' WHERE user_id = ? AND status = 'PENDING'", [user.id]);
    raw = crypto.randomBytes(32).toString("hex");
    await conn.execute(
      `INSERT INTO account_email_verifications (user_id, new_email, token_hash, status, expires_at)
       VALUES (?, ?, ?, 'PENDING', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [user.id, email, sha256(raw), TOKEN_TTL_MINUTES]
    );
    const [[exp]] = await conn.execute("SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS t", [TOKEN_TTL_MINUTES]);
    expiresAt = exp.t;
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === "CURRENT_PASSWORD_INCORRECT") {
      await auditSafe({
        module: "USERS", entityType: "USER", entityId: actingUser.id, action: "EMAIL_CHANGE_REJECTED",
        description: `${actingUser.username} - notification email change rejected (incorrect current password)`,
        user: actingUser, ...meta,
      });
    }
    throw err;
  } finally {
    conn.release();
  }

  // Sent after the commit (the row lock is not held while talking to SMTP).
  const verifyUrl = `${frontendBaseUrl()}/verify-email?token=${raw}`;
  const sent = await EmailService.sendEmailVerificationEmail({ to: email, fullName: user.full_name || user.username, verifyUrl, expiresAt });
  if (!sent.delivered) {
    // Nobody received the link: the request is void (never left "pending").
    await pool.execute("UPDATE account_email_verifications SET status = 'CANCELLED', used_at = NOW() WHERE token_hash = ? AND status = 'PENDING'", [sha256(raw)]);
  }
  await auditSafe({
    module: "USERS", entityType: "USER", entityId: user.id, action: "EMAIL_CHANGE_REQUESTED",
    description: `${user.username} requested notification email ${email}; verification email ${sent.delivered ? "sent" : `not sent (${sent.reason})`}`,
    beforeData: { email: user.email || null },
    afterData: { pendingEmail: email, verificationEmailDelivered: Boolean(sent.delivered), reason: sent.reason || null },
    user: actingUser, ...meta,
  });
  return { pendingEmail: maskEmail(email), expiresAt, emailDelivered: Boolean(sent.delivered), reason: sent.reason || null };
}

// POST /api/account/email/verify { token } - public.
async function confirmEmailChange({ body = {}, meta = {} }) {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const invalid = () => fail(400, "VERIFICATION_INVALID", "This verification link is invalid or has already been used.");
  if (!TOKEN_RE.test(token)) throw invalid();

  const conn = await pool.getConnection();
  let outcome;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id, user_id, new_email, status, (expires_at <= NOW()) AS expired
         FROM account_email_verifications WHERE token_hash = ? FOR UPDATE`,
      [sha256(token)]
    );
    const v = rows[0];
    if (!v || v.status !== "PENDING") throw invalid();
    if (Number(v.expired)) throw fail(410, "VERIFICATION_EXPIRED", "This verification link has expired. Request a new one from Account Security.");

    const [urows] = await conn.execute(
      `SELECT u.id, u.username, u.full_name, u.email, u.status, u.role_id, r.code AS role_code
         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE`,
      [v.user_id]
    );
    const user = urows[0];
    if (!user || user.status !== "ACTIVE" || user.role_code !== "SUPER_ADMIN") {
      await conn.execute("UPDATE account_email_verifications SET status = 'CANCELLED', used_at = NOW() WHERE id = ?", [v.id]);
      await conn.commit();
      throw invalid();
    }
    if (!(await emailAvailable(conn, v.new_email, user.id))) {
      await conn.execute("UPDATE account_email_verifications SET status = 'CANCELLED', used_at = NOW() WHERE id = ?", [v.id]);
      await conn.commit();
      throw fail(409, "EMAIL_TAKEN", "That email address is no longer available. Request a change with a different address.");
    }
    try {
      await conn.execute("UPDATE users SET email = ? WHERE id = ? AND role_id = ? AND status = 'ACTIVE'", [v.new_email, user.id, user.role_id]);
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") throw fail(409, "EMAIL_TAKEN", "That email address is no longer available. Request a change with a different address.");
      throw err;
    }
    const [used] = await conn.execute(
      "UPDATE account_email_verifications SET status = 'USED', used_at = NOW() WHERE id = ? AND status = 'PENDING'",
      [v.id]
    );
    if (used.affectedRows !== 1) throw invalid();
    await logAudit(conn, {
      module: "USERS", entityType: "USER", entityId: user.id, action: "EMAIL_CHANGED",
      description: `${user.username} verified notification email ${v.new_email}`,
      beforeData: { email: user.email || null },
      afterData: { email: v.new_email },
      user: { id: user.id, username: user.username }, ...meta,
    });
    await conn.commit();
    outcome = { user, previous: user.email || null, email: v.new_email };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  if (outcome.previous && outcome.previous.toLowerCase() !== outcome.email) {
    const notice = await EmailService.sendEmailChangedNotice({ to: outcome.previous, fullName: outcome.user.full_name || outcome.user.username, occurredAt: new Date() });
    if (!notice.delivered) console.error(`[accountEmail] email-changed notice for user ${outcome.user.id} not delivered: ${notice.reason}`);
  }
  return { email: outcome.email };
}

module.exports = {
  TOKEN_TTL_MINUTES,
  getEmailStatus,
  requestEmailChange,
  confirmEmailChange,
  // exported for tests
  maskEmail,
  normalizeEmail,
};
