-- User Settings / Roles / Permissions / Access Restrictions - Phase 1
-- Additive only: no existing table's columns are removed or renamed.
-- CREATE TABLE IF NOT EXISTS is natively idempotent. The `users` ALTERs use
-- the information_schema + PREPARE/EXECUTE pattern established in
-- beginning_balance_import_migration.sql, since ADD COLUMN IF NOT EXISTS
-- isn't portable across MySQL versions/providers. Safe to re-run any number
-- of times.

CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  tin VARCHAR(20) NULL,
  address VARCHAR(255) NULL,
  zip VARCHAR(20) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  INDEX idx_branches_company (company_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_key VARCHAR(60) NOT NULL,
  action VARCHAR(30) NOT NULL,
  label VARCHAR(150) NOT NULL,
  description VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_permissions_module_action (module_key, action)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT NOT NULL,
  permission_id INT NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_role_permission (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  permission_id INT NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_permission (user_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  company_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_company (user_id, company_id)
);

CREATE TABLE IF NOT EXISTS user_branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  branch_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_branch (user_id, branch_id)
);

-- users.email
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.status
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'status'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.role_id
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role_id'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN role_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.token_version
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.updated_at
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'updated_at'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.created_by
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'created_by'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Seed roles (idempotent via INSERT IGNORE against the UNIQUE code column)
INSERT IGNORE INTO roles (code, name, description, is_system) VALUES
  ('SUPER_ADMIN', 'Super Admin', 'System owner - full access to all companies, branches, and modules - only role that can configure restrictions for other roles.', 1),
  ('ADMIN', 'Admin', 'Client administrator - scoped to assigned companies/branches - access to modules is configurable by Super Admin.', 1),
  ('ACCOUNTANT', 'Accountant', 'Handles accounting transactions, review, approval, reconciliation, and reporting within granted modules.', 1);

-- Seed permission catalog: (module_key, action, label) - real module/route
-- inventory from this repo, not a guessed list. Not every module gets every
-- action. Extending this catalog later is an INSERT, not a migration.
INSERT IGNORE INTO permissions (module_key, action, label) VALUES
  ('DASHBOARD', 'VIEW', 'View Dashboard'),

  ('FILESETUP.COA', 'VIEW', 'View Chart of Accounts'),
  ('FILESETUP.COA', 'CREATE', 'Create Chart of Accounts entries'),
  ('FILESETUP.COA', 'EDIT', 'Edit Chart of Accounts entries'),
  ('FILESETUP.COA', 'DELETE', 'Delete Chart of Accounts entries'),
  ('FILESETUP.GENLIB', 'VIEW', 'View General Libraries'),
  ('FILESETUP.GENLIB', 'CREATE', 'Create General Libraries entries'),
  ('FILESETUP.GENLIB', 'EDIT', 'Edit General Libraries entries'),
  ('FILESETUP.GENLIB', 'DELETE', 'Delete General Libraries entries'),
  ('FILESETUP.GROUP_CODES', 'VIEW', 'View Group Codes'),
  ('FILESETUP.GROUP_CODES', 'CONFIGURE', 'Configure Group Codes'),
  ('FILESETUP.TAX_SETUP', 'VIEW', 'View Tax Setup / EWT Library'),
  ('FILESETUP.TAX_SETUP', 'CONFIGURE', 'Configure Tax Setup / EWT Library'),
  ('FILESETUP.BEGINNING_BALANCES', 'VIEW', 'View Beginning Balances'),
  ('FILESETUP.BEGINNING_BALANCES', 'CREATE', 'Create Beginning Balances'),
  ('FILESETUP.BEGINNING_BALANCES', 'EDIT', 'Edit Beginning Balances'),
  ('FILESETUP.COMPANY_SETUP', 'VIEW', 'View Company Profile'),
  ('FILESETUP.COMPANY_SETUP', 'CONFIGURE', 'Configure Company Profile'),
  ('FILESETUP.BANK_CODES', 'VIEW', 'View Bank Codes'),
  ('FILESETUP.BANK_CODES', 'CONFIGURE', 'Configure Bank Codes'),
  ('FILESETUP.FIXED_ASSETS', 'VIEW', 'View Fixed Asset Setup'),
  ('FILESETUP.FIXED_ASSETS', 'CREATE', 'Create Fixed Asset Setup entries'),
  ('FILESETUP.FIXED_ASSETS', 'EDIT', 'Edit Fixed Asset Setup entries'),
  ('FILESETUP.PREPAID_ACCOUNTS', 'VIEW', 'View Prepaid Account Setup'),
  ('FILESETUP.PREPAID_ACCOUNTS', 'CREATE', 'Create Prepaid Account Setup entries'),
  ('FILESETUP.PREPAID_ACCOUNTS', 'EDIT', 'Edit Prepaid Account Setup entries'),

  ('TRANSACTIONS.INVOICE', 'VIEW', 'View Invoices'),
  ('TRANSACTIONS.INVOICE', 'CREATE', 'Create Invoices'),
  ('TRANSACTIONS.INVOICE', 'EDIT', 'Edit draft Invoices'),
  ('TRANSACTIONS.INVOICE', 'DELETE', 'Delete Invoices'),
  ('TRANSACTIONS.INVOICE', 'SUBMIT', 'Submit Invoices'),
  ('TRANSACTIONS.CV', 'VIEW', 'View Check Vouchers'),
  ('TRANSACTIONS.CV', 'CREATE', 'Create Check Vouchers'),
  ('TRANSACTIONS.CV', 'EDIT', 'Edit draft Check Vouchers'),
  ('TRANSACTIONS.CV', 'SUBMIT', 'Submit Check Vouchers'),
  ('TRANSACTIONS.JV', 'VIEW', 'View Journal Vouchers'),
  ('TRANSACTIONS.JV', 'CREATE', 'Create Journal Vouchers'),
  ('TRANSACTIONS.JV', 'EDIT', 'Edit draft Journal Vouchers'),
  ('TRANSACTIONS.JV', 'DELETE', 'Delete Journal Vouchers'),
  ('TRANSACTIONS.JV', 'SUBMIT', 'Submit Journal Vouchers'),
  ('TRANSACTIONS.OR', 'VIEW', 'View Official Receipts'),
  ('TRANSACTIONS.OR', 'CREATE', 'Create Official Receipts'),
  ('TRANSACTIONS.OR', 'EDIT', 'Edit draft Official Receipts'),
  ('TRANSACTIONS.APV', 'VIEW', 'View AP Vouchers'),
  ('TRANSACTIONS.APV', 'CREATE', 'Create AP Vouchers'),
  ('TRANSACTIONS.APV', 'EDIT', 'Edit draft AP Vouchers'),
  ('TRANSACTIONS.APV', 'DELETE', 'Delete AP Vouchers'),
  ('TRANSACTIONS.APV', 'SUBMIT', 'Submit AP Vouchers'),
  ('TRANSACTIONS.PETTY_CASH', 'VIEW', 'View Petty Cash Vouchers'),
  ('TRANSACTIONS.PETTY_CASH', 'CREATE', 'Create Petty Cash Vouchers'),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'VIEW', 'View Debit/Credit Memos'),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'CREATE', 'Create Debit/Credit Memos'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'VIEW', 'View Purchase Orders'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'CREATE', 'Create Purchase Orders'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'EDIT', 'Edit draft Purchase Orders'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'DELETE', 'Delete Purchase Orders'),
  ('TRANSACTIONS.QUOTATION', 'VIEW', 'View Quotations'),
  ('TRANSACTIONS.QUOTATION', 'CREATE', 'Create Quotations'),
  ('TRANSACTIONS.QUOTATION', 'EDIT', 'Edit draft Quotations'),
  ('TRANSACTIONS.QUOTATION', 'DELETE', 'Delete Quotations'),

  ('POSTING', 'VIEW', 'View Pending Postings'),
  ('POSTING', 'APPROVE', 'Approve transactions for posting'),
  ('POSTING', 'POST', 'Post transactions'),

  ('LEDGER.GENERAL_LEDGER', 'VIEW', 'View General Ledger'),
  ('LEDGER.SUBSIDIARY_LEDGER', 'VIEW', 'View Subsidiary Ledger'),
  ('LEDGER.ACCOUNT_ANALYSIS', 'VIEW', 'View Account Analysis'),

  ('REPORTS.FINANCIAL', 'VIEW', 'View Financial Reports (Trial Balance, Balance Sheet, Income Statement, Cash Flow)'),
  ('REPORTS.FINANCIAL', 'EXPORT', 'Export Financial Reports'),
  ('REPORTS.AR', 'VIEW', 'View AR Reports (AR Aging)'),
  ('REPORTS.AR', 'EXPORT', 'Export AR Reports'),
  ('REPORTS.AP', 'VIEW', 'View AP Reports (AP Aging)'),
  ('REPORTS.AP', 'EXPORT', 'Export AP Reports'),
  ('REPORTS.FIXED_ASSETS', 'VIEW', 'View Fixed Asset Reports'),
  ('REPORTS.FIXED_ASSETS', 'EXPORT', 'Export Fixed Asset Reports'),
  ('REPORTS.BIR_COMPLIANCE', 'VIEW', 'View BIR Compliance Reports (VAT, Alphalist, 2307)'),
  ('REPORTS.BIR_COMPLIANCE', 'EXPORT', 'Export BIR Compliance Reports'),
  ('REPORTS.BANK_RECONCILIATION', 'VIEW', 'View Bank Reconciliation'),
  ('REPORTS.BANK_RECONCILIATION', 'CREATE', 'Perform Bank Reconciliation'),
  ('REPORTS.BANK_RECONCILIATION', 'APPROVE', 'Approve Bank Reconciliation adjustments'),
  ('REPORTS.AI_RECONCILIATION', 'VIEW', 'Use AI Reconciliation Assistant'),
  ('REPORTS.TRIAL_BALANCE_CHECKER', 'VIEW', 'Use Unbalanced Trial Balance Checker'),
  ('REPORTS.TRIAL_BALANCE_CHECKER', 'CONFIGURE', 'Create adjustment drafts from Trial Balance Checker findings'),

  ('ADMIN.USER_SETTINGS', 'VIEW', 'View User Settings'),
  ('ADMIN.USER_SETTINGS', 'EDIT', 'Edit users (status, company/branch assignment)'),
  ('ADMIN.INVITATIONS', 'VIEW', 'View Invitations'),
  ('ADMIN.INVITATIONS', 'CREATE', 'Send Invitations'),
  ('ADMIN.ROLES_PERMISSIONS', 'VIEW', 'View Roles and Permissions'),
  ('ADMIN.ROLES_PERMISSIONS', 'CONFIGURE', 'Configure Role Permissions'),
  ('ADMIN.ACCESS_RESTRICTIONS', 'VIEW', 'View Access Restrictions'),
  ('ADMIN.ACCESS_RESTRICTIONS', 'CONFIGURE', 'Configure Access Restrictions'),
  ('ADMIN.AUDIT_LOGS', 'VIEW', 'View Audit Logs'),
  ('ADMIN.SYSTEM_CONFIGURATION', 'VIEW', 'View System Configuration'),
  ('ADMIN.SYSTEM_CONFIGURATION', 'CONFIGURE', 'Configure System settings');

-- Seed a starter ADMIN/ACCOUNTANT default grant set (editable later via the
-- Phase 4 matrix UI - this is a reasonable starting point, not final policy).
-- ADMIN: everything except the genuinely Super-Admin-only Administration
-- surfaces (role/permission configuration, access restrictions, audit
-- logs, system configuration). Admin DOES get User Settings and
-- Invitations per spec ("view and manage users within assigned scope",
-- "invite Accountants") - the earlier version of this migration excluded
-- ALL of ADMIN.%, which was wrong; fixed here.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key NOT IN (
  'ADMIN.ROLES_PERMISSIONS', 'ADMIN.ACCESS_RESTRICTIONS', 'ADMIN.AUDIT_LOGS', 'ADMIN.SYSTEM_CONFIGURATION'
)
WHERE r.code = 'ADMIN';

-- ACCOUNTANT: transaction/ledger/report modules, view-and-do actions, no
-- Administration.*, no File Setup configuration actions (COA/GenLib edit
-- rights are commonly delegated per your spec's examples, so those stay).
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON (
  p.module_key LIKE 'TRANSACTIONS.%'
  OR p.module_key LIKE 'LEDGER.%'
  OR p.module_key LIKE 'REPORTS.%'
  OR p.module_key = 'POSTING'
  OR p.module_key = 'DASHBOARD'
  OR p.module_key = 'FILESETUP.BEGINNING_BALANCES'
)
WHERE r.code = 'ACCOUNTANT';

-- Seed the default company/branch from the existing company_profile
-- singleton (falls back to a generic name if it's blank, matching the
-- fallback pattern already used in beginningBalanceTemplateService.js).
INSERT INTO companies (name, tin, address, zip)
SELECT
  IF(TRIM(COALESCE(cp.payor_name, '')) = '', 'AstreaBlue Accounting System', cp.payor_name),
  NULLIF(cp.payor_tin, ''), NULLIF(cp.payor_address, ''), NULLIF(cp.payor_zip, '')
FROM company_profile cp
WHERE NOT EXISTS (SELECT 1 FROM companies)
LIMIT 1;

INSERT INTO branches (company_id, name, code)
SELECT c.id, 'Main Branch', 'MAIN'
FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM branches)
LIMIT 1;

-- Migrate the existing user(s) to SUPER_ADMIN with full company/branch
-- assignment, so nobody loses access. Only touches rows that don't yet
-- have a role_id (safe to re-run).
UPDATE users
SET role_id = (SELECT id FROM roles WHERE code = 'SUPER_ADMIN'), status = 'ACTIVE'
WHERE role_id IS NULL;

INSERT IGNORE INTO user_companies (user_id, company_id)
SELECT u.id, c.id FROM users u JOIN companies c ON 1=1
WHERE u.role_id = (SELECT id FROM roles WHERE code = 'SUPER_ADMIN');

INSERT IGNORE INTO user_branches (user_id, branch_id)
SELECT u.id, b.id FROM users u JOIN branches b ON 1=1
WHERE u.role_id = (SELECT id FROM roles WHERE code = 'SUPER_ADMIN');
