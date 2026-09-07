-- Infrastructure Checkpoint gap fix: FILESETUP.BEGINNING_BALANCES.DELETE
-- has never existed in any migration file - user_access_control_migration.sql
-- seeds VIEW/CREATE/EDIT for this module but not DELETE, yet production
-- has had a DELETE permission row (id 373, granted to ADMIN and
-- ACCOUNTANT) since some point in its history, added directly rather
-- than through a migration. Confirmed via periodLocking.http.test.js's
-- Beginning Balance closed-period test failing with 403 (not the
-- expected 409 from the period-lock check) the first time it ran
-- against a freshly-migrated database - the permission check runs
-- before the period check, so the missing grant masked the thing that
-- test actually verifies.
--
-- Must run AFTER user_access_control_migration.sql (creates permissions/
-- role_permissions and does its own one-time ADMIN/ACCOUNTANT blanket
-- grants, which can't retroactively pick up a permission added later) -
-- see migrationOrder.js. Idempotent: INSERT IGNORE throughout.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.BEGINNING_BALANCES', 'DELETE', 'Delete Beginning Balances', NULL);

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.BEGINNING_BALANCES' AND p.action = 'DELETE'
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');