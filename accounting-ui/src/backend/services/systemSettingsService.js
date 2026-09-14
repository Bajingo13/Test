const pool = require("../db");

// Generic key/value system settings + an append-only audit log
// (system_settings_migration.sql). First (currently only) consumer is the
// superadmin-only global 2FA toggle - REQUIRE_2FA_GLOBALLY_KEY.
//
// This is infrastructure only: it stores and audits the setting's value.
// It does not itself send OTP/2FA emails or enforce 2FA at login - no
// per-user 2FA/OTP flow exists yet anywhere in this codebase (see the
// discovery report). Once one is built, its login path should read
// isRequire2faGloballyEnabled() before deciding whether to require a
// second factor.
const REQUIRE_2FA_GLOBALLY_KEY = "require_2fa_globally";

// "Default safely to enabled if the setting is missing or unreadable" -
// per spec. A missing row (nobody has ever changed this) and a DB error
// both fail toward requiring 2FA, never toward silently disabling it.
async function isRequire2faGloballyEnabled() {
  try {
    const [rows] = await pool.execute(
      `SELECT setting_value FROM system_settings WHERE setting_key = ?`,
      [REQUIRE_2FA_GLOBALLY_KEY]
    );
    if (!rows.length) return true;
    return rows[0].setting_value === "true";
  } catch (err) {
    console.error("SYSTEM SETTINGS READ ERROR (require_2fa_globally, defaulting to enabled):", err);
    return true;
  }
}

// Superadmin-only write path (enforced by requireSuperAdmin on the route,
// not just the UI - see systemSettings.routes.js). Every change is
// audited with actor, timestamp, previous value, and new value, per spec.
async function setRequire2faGlobally(enabled, { user, ipAddress, userAgent } = {}) {
  const newValue = enabled ? "true" : "false";

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.execute(
      `SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE`,
      [REQUIRE_2FA_GLOBALLY_KEY]
    );
    // Unset previously means the code-level default (enabled) was in
    // effect - recorded as "true" in the audit trail so the log reads as
    // an accurate before/after of the EFFECTIVE value, not just of
    // whether a row happened to exist yet.
    const previousValue = existingRows.length ? existingRows[0].setting_value : "true";

    await conn.execute(
      `INSERT INTO system_settings (setting_key, setting_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [REQUIRE_2FA_GLOBALLY_KEY, newValue, user?.id || null]
    );

    await conn.execute(
      `INSERT INTO system_settings_audit_log
         (setting_key, previous_value, new_value, actor_user_id, actor_username, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [REQUIRE_2FA_GLOBALLY_KEY, previousValue, newValue, user?.id || null, user?.username || null, ipAddress || null, userAgent || null]
    );

    await conn.commit();
    return { key: REQUIRE_2FA_GLOBALLY_KEY, value: enabled };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  REQUIRE_2FA_GLOBALLY_KEY,
  isRequire2faGloballyEnabled,
  setRequire2faGlobally,
};
