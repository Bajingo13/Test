// Failed-login monitoring (security mitigation B).
//
// On EXACTLY the 3rd consecutive failed password for an existing account, one
// security email goes to the account's registered email address. The counter is
// the existing users.failed_login_count (reset to 0 by a successful login), so a
// failure streak can trigger at most ONE email - the 4th, 5th, ... failures (and
// the existing 5-attempt temporary lockout + per-IP login rate limit) never send
// more. Unknown usernames never reach this code, and the login response is the
// same generic 401 either way, so nothing here reveals whether an account exists.
//
// The email is sent in the background: the login response does not wait for SMTP,
// so neither its content nor its timing differs between accounts. Every outcome
// is audited (no password, hash or token is ever written).
const pool = require("../db");
const audit = require("../lib/audit");
const EmailService = require("./emailService");

const FAILED_LOGIN_ALERT_THRESHOLD = 3;
const pending = new Set();

async function notify(user, attempts, meta) {
  const [[row]] = await pool.execute("SELECT email, full_name FROM users WHERE id = ?", [user.id]);
  const email = row?.email || null;
  let result;
  if (!email) {
    result = { delivered: false, reason: "NO_EMAIL_ON_FILE" };
  } else {
    try {
      result = await EmailService.sendSecurityAlertEmail({ to: email, fullName: row.full_name || user.username, attempts, occurredAt: new Date() });
    } catch (err) {
      // the email service never throws by contract; a defect here must not break login security
      result = { delivered: false, reason: "SEND_FAILED" };
    }
  }
  if (!result.delivered) console.error(`[securityAlert] security email for user ${user.id} not delivered: ${result.reason}`);
  await audit.logAudit(pool, {
    module: "AUTH",
    entityType: "SECURITY_ALERT",
    entityId: user.id,
    action: result.delivered ? "SECURITY_ALERT_EMAIL_SENT" : "SECURITY_ALERT_EMAIL_FAILED",
    description: result.delivered
      ? `Security alert email sent to ${user.username} after ${attempts} failed login attempts`
      : `Security alert email for ${user.username} not delivered (${result.reason})`,
    afterData: { attempts, delivered: Boolean(result.delivered), reason: result.reason || null },
    user, ...meta,
  });
  return result;
}

// Called by POST /api/login after a wrong password has been counted. Deliberately
// NOT async and not awaited by the caller: the login response never waits for the
// audit write or SMTP, so it is identical (content and timing) for every account.
function handleFailedLogin(user, failedCount, meta = {}) {
  if (failedCount !== FAILED_LOGIN_ALERT_THRESHOLD) return null;
  const job = (async () => {
    await audit.logAudit(pool, {
      module: "AUTH",
      entityType: "SECURITY_ALERT",
      entityId: user.id,
      action: "FAILED_LOGIN_THRESHOLD",
      description: `${failedCount} consecutive failed login attempts for ${user.username}`,
      afterData: { attempts: failedCount, threshold: FAILED_LOGIN_ALERT_THRESHOLD },
      user, ...meta,
    });
    return notify(user, failedCount, meta);
  })()
    .catch((err) => console.error("[securityAlert] notification error:", err.message))
    .finally(() => pending.delete(job));
  pending.add(job);
  return job;
}

// Tests (and graceful shutdown) can wait for in-flight notifications.
async function flush() {
  await Promise.all([...pending]);
}

module.exports = { FAILED_LOGIN_ALERT_THRESHOLD, handleFailedLogin, flush };
