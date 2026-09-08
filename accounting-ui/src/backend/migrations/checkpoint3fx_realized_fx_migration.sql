-- Checkpoint 3FX: Realized Foreign Exchange Gain/Loss. Idempotent -
-- information_schema guards for ALTER TABLE ADD COLUMN, CREATE TABLE IF
-- NOT EXISTS - same pattern as every prior migration in this project.
--
-- company_fx_accounts mirrors company_rate_policies (Phase 2): one row per
-- company_id, holding the two configured Chart of Accounts references.
-- chart_of_accounts has no company_id column of its own (confirmed single
-- global COA, per Checkpoint 3FX investigation) - the FK just guarantees
-- the configured account genuinely exists.

CREATE TABLE IF NOT EXISTS company_fx_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  realized_fx_gain_account_id INT NULL,
  realized_fx_loss_account_id INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fx_accounts_per_company (company_id),
  CONSTRAINT fk_fx_gain_account FOREIGN KEY (realized_fx_gain_account_id) REFERENCES chart_of_accounts(id),
  CONSTRAINT fk_fx_loss_account FOREIGN KEY (realized_fx_loss_account_id) REFERENCES chart_of_accounts(id)
);

-- transaction_applications already has fx_difference/fx_direction
-- (Checkpoint 3B) - this adds where the realized amount was actually
-- posted, so "which OR/CV line represents this application's FX effect"
-- is reconstructable per section 26/28. Nullable: same-rate applications
-- (fx_difference = 0) never populate this.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'fx_account_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN fx_account_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Permission: reuses the existing FILESETUP.CURRENCY_SETUP module (no new
-- RBAC architecture, per section 25) - one new action for the FX account
-- configuration screen. Posting itself continues to use each module's own
-- existing CREATE/EDIT permission (TRANSACTIONS.OR / TRANSACTIONS.CV) -
-- users are never asked to pick an FX account per-transaction.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.CURRENCY_SETUP', 'CONFIGURE_FX_ACCOUNTS', 'Configure Realized FX Gain/Loss Accounts', 'Set which Chart of Accounts entries realized foreign exchange gains and losses post to.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP' AND p.action = 'CONFIGURE_FX_ACCOUNTS'
WHERE r.code = 'ADMIN';
