-- Permission templates + audit trail completeness + account lockout
-- (Phase 5). Additive only, idempotent, safe to re-run.

CREATE TABLE IF NOT EXISTS permission_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY uq_permission_templates_name (name)
);

CREATE TABLE IF NOT EXISTS permission_template_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  permission_id INT NOT NULL,
  granted TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (template_id) REFERENCES permission_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
  UNIQUE KEY uq_template_permission (template_id, permission_id)
);

-- audit_logs.ip_address / user_agent (spec requires these on every record;
-- the table Phase 1-4 already used didn't have them)
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'ip_address'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE audit_logs ADD COLUMN ip_address VARCHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'user_agent'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE audit_logs ADD COLUMN user_agent VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.failed_login_count / locked_until (account lockout)
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'failed_login_count'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'locked_until'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN locked_until TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Starter templates from the spec's suggested list. Items are populated by
-- a follow-up Node script (needs live permission IDs, not portable to
-- hardcode here) - see backend/scripts/seedPermissionTemplates.js.
INSERT IGNORE INTO permission_templates (name, description, is_system) VALUES
  ('Full Admin', 'Everything an Admin role can do.', 1),
  ('Limited Admin', 'Admin scope minus user/company management.', 1),
  ('Senior Accountant', 'Full transaction lifecycle including approve and post.', 1),
  ('Accounts Receivable Accountant', 'Invoice and Official Receipt focused.', 1),
  ('Accounts Payable Accountant', 'AP Voucher and Check Voucher focused.', 1),
  ('Reporting Only', 'View and export reports, no transaction access.', 1),
  ('Bank Reconciliation User', 'Bank Reconciliation and AI Reconciliation only.', 1),
  ('Read-Only Auditor', 'View-only access across transactions, ledger, and reports.', 1);
