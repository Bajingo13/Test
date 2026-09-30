-- Phase M.1: permission catalog rows for the new Report Sections master-
-- data page. Additive only, same pattern as
-- transaction_print_permissions_migration.sql - INSERT IGNORE against the
-- existing UNIQUE keys makes this safe to re-run.
--
-- Mirrors FILESETUP.GROUP_CODES exactly (VIEW / CONFIGURE, ADMIN-only by
-- default): the ADMIN catch-all grant in user_access_control_migration.sql
-- only covers permission rows that existed when IT ran, so a later-added
-- module_key (this one) needs its own explicit grant, same as
-- TRANSACTIONS.INVOICE's PRINT permissions did. ACCOUNTANT's catch-all does
-- not include FILESETUP.GROUP_CODES either, so ACCOUNTANT is intentionally
-- not granted this new module by default, for consistency.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.REPORT_SECTIONS', 'VIEW', 'View Report Sections', 'View the Report Section master-data list used to classify Group Codes for the Balance Sheet / Income Statement.'),
  ('FILESETUP.REPORT_SECTIONS', 'CONFIGURE', 'Configure Report Sections', 'Add, edit, and delete Report Section master-data records.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.REPORT_SECTIONS' AND p.action IN ('VIEW', 'CONFIGURE')
WHERE r.code = 'ADMIN';
