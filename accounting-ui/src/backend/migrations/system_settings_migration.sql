-- System Settings + audit log.
--
-- Purely additive: two new standalone tables, no ALTERs to anything else.
-- First (and currently only) consumer is the superadmin-only global 2FA
-- toggle (require_2fa_globally) - see systemSettingsService.js. The table
-- is generic key/value on purpose so a future setting doesn't need its own
-- migration.
--
-- system_settings has no seeded default row for require_2fa_globally by
-- design: systemSettingsService.js treats a missing/unreadable row as
-- "enabled" (the safe default per spec) entirely in application code, so a
-- row only appears here once a superadmin actually changes the setting for
-- the first time. This avoids a false "someone configured this" audit
-- trail implication for a value nobody ever touched.
--
-- CREATE TABLE IF NOT EXISTS is already idempotent; re-run is a no-op.

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value TEXT         NULL,
  updated_by    INT          NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_settings_audit_log (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  setting_key      VARCHAR(100) NOT NULL,
  previous_value   TEXT         NULL,
  new_value        TEXT         NULL,
  actor_user_id    INT          NULL,
  actor_username   VARCHAR(191) NULL,
  ip_address       VARCHAR(64)  NULL,
  user_agent       VARCHAR(255) NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_system_settings_audit_log_key (setting_key)
) ENGINE=InnoDB;
