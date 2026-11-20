-- Company Branch Management (ONE company -> MANY branches). Master data only:
-- no transaction table, transaction API or report changes.
--
-- Reuses the EXISTING `branches` table (user_access_control_migration.sql:
-- id, company_id -> companies.id ON DELETE CASCADE, name, code, status
-- ACTIVE/INACTIVE, created_at, updated_at) - it is already referenced by
-- user_branches, invitations.branch_ids, rfp_headers.branch_id and
-- recurring_transaction_templates.branch_id, so no second branch concept is
-- introduced. companies.branch_code / general_libraries.branch_code are the BIR
-- TIN branch suffix (e.g. 000), a different thing, and are not touched.
--
-- Idempotent (information_schema guards + INSERT IGNORE). Safe to re-run.
-- Must run AFTER user_access_control_migration.sql (owns branches, permissions,
-- role_permissions, roles).

-- 1. Contact columns, named like the companies table (address / telephone / email).
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'address');
SET @sql = IF(@c = 0, 'ALTER TABLE branches ADD COLUMN address VARCHAR(255) NULL AFTER code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'telephone');
SET @sql = IF(@c = 0, 'ALTER TABLE branches ADD COLUMN telephone VARCHAR(50) NULL AFTER address', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'email');
SET @sql = IF(@c = 0, 'ALTER TABLE branches ADD COLUMN email VARCHAR(255) NULL AFTER telephone', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. A branch code is unique WITHIN a company (two companies may both have MAIN).
-- The API requires a code for every branch it creates or edits; the column stays
-- nullable so no existing row has to be rewritten. If an existing database holds
-- duplicate (company_id, code) pairs this statement FAILS on purpose rather than
-- silently skipping the rule - run the read-only duplicate check before deploying.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND INDEX_NAME = 'uq_branches_company_code');
SET @sql = IF(@c = 0, 'ALTER TABLE branches ADD UNIQUE KEY uq_branches_company_code (company_id, code)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Permission catalog: FILESETUP.BRANCHES, same action vocabulary as
-- FILESETUP.CURRENCY_SETUP (separate ACTIVATE / DEACTIVATE). No DELETE action:
-- branches are retired by deactivation, never deleted.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.BRANCHES', 'VIEW', 'View Branches', 'View the branches of the companies the user belongs to.'),
  ('FILESETUP.BRANCHES', 'CREATE', 'Create Branch', 'Add a branch to a company the user belongs to.'),
  ('FILESETUP.BRANCHES', 'EDIT', 'Edit Branch', 'Edit a branch''s code, name and contact details (its company cannot be changed).'),
  ('FILESETUP.BRANCHES', 'ACTIVATE', 'Activate Branch', 'Reactivate an inactive branch.'),
  ('FILESETUP.BRANCHES', 'DEACTIVATE', 'Deactivate Branch', 'Deactivate a branch; it stays in the list and history but is no longer an active branch.');

-- 4. Default grants. ADMIN manages branches; ACCOUNTANT may view them.
-- INSERT IGNORE: a row an administrator has already set through the role
-- matrix (granted 0 or 1) is left exactly as it is. SUPER_ADMIN bypasses.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.BRANCHES'
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.BRANCHES' AND p.action = 'VIEW'
WHERE r.code = 'ACCOUNTANT';
