-- Dashboard Activity Timeline permission. DATA/CONFIG ONLY - no DDL, no
-- schema change. Same INSERT IGNORE pattern as
-- r7_accountant_bank_codes_view_migration.sql.
--
-- The dashboard's Activity Timeline used to require ADMIN.AUDIT_LOGS / VIEW,
-- which only the Super Admin holds by default, so Admin and Accountant always
-- saw "no permission". ADMIN.AUDIT_LOGS is NOT changed or widened by this
-- file. Instead a separate, narrower permission is added:
--
--   DASHBOARD.ACTIVITY / VIEW - see the selected company's recent audit
--   events about records the user can already open (each event is shown
--   only when the user holds VIEW on that event's transaction module or on
--   Bank Reconciliation). Sign-in, user, role, permission, invitation and
--   settings events are never shown, and before/after data is never sent
--   (see services/dashboardService.js activitySection).
--
-- Default grants: ADMIN and ACCOUNTANT. SUPER_ADMIN bypasses permission
-- checks. INSERT IGNORE: a role row an administrator has already set
-- (granted = 0 or 1) through the role matrix is left exactly as it is.
-- Re-running is a no-op.
--
-- Must run AFTER user_access_control_migration.sql (owns permissions /
-- role_permissions / roles).

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('DASHBOARD.ACTIVITY', 'VIEW', 'View dashboard activity', 'See recent company activity on records the user can already open, on the Dashboard.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'DASHBOARD.ACTIVITY' AND p.action = 'VIEW'
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');
