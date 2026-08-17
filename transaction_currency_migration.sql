-- Multi-Currency Transaction Integration - Checkpoint 3A (Invoice + APV
-- only). Idempotent: information_schema guards for ALTER TABLE ADD
-- COLUMN, CREATE TABLE IF NOT EXISTS for the new table, INSERT IGNORE for
-- the permission catalog row - same pattern as every prior migration in
-- this project.
--
-- currency_id is nullable and existing rows are left NULL on purpose -
-- NULL means "predates multi-currency, implicitly the company's base
-- currency", read that way everywhere (frontend, print, reports) rather
-- than guessed or backfilled. debit/credit/total_debit/total_credit are
-- NOT touched - they remain the base-currency values every existing
-- report (LedgerReportService, Trial Balance, Income Statement) already
-- reads directly off these tables.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN currency_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_headers ADD COLUMN currency_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Line-level foreign amounts, alongside the existing (unchanged) base
-- debit/credit - section 13: "Do not replace the foreign amount with the
-- converted amount. Both values are important."
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_lines' AND COLUMN_NAME = 'foreign_credit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_lines ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_lines' AND COLUMN_NAME = 'foreign_credit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_lines ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Shared header-level currency snapshot - one row per transaction,
-- generalizes to every future module (OR/CV/JV/PO/...) without repeating
-- ~15 columns per header table each time. See section 42 of the Phase 3
-- spec - this is the "shared snapshot table" option, chosen because the
-- snapshot shape is identical across every module and duplicating it 8x
-- across header tables is a bigger, riskier migration surface than one
-- well-normalized table.
CREATE TABLE IF NOT EXISTS transaction_currency_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NULL,
  transaction_type VARCHAR(10) NOT NULL,
  transaction_id INT NOT NULL,
  currency_id INT NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  base_currency_id INT NOT NULL,
  base_currency_code VARCHAR(3) NOT NULL,
  exchange_rate DECIMAL(20, 10) NOT NULL,
  rate_date DATE NOT NULL,
  rate_source VARCHAR(20) NOT NULL,
  rate_basis VARCHAR(100) NULL,
  rate_status VARCHAR(20) NULL,
  rate_retrieved_at DATETIME NULL,
  rate_ingestion_method VARCHAR(20) NULL,
  rate_locked TINYINT(1) NOT NULL DEFAULT 0,
  -- Override never destroys the original resolved rate (section 11) -
  -- system_rate is what the resolver actually returned; override_rate is
  -- what an authorized user chose to use instead. exchange_rate (above)
  -- is whichever one is actually in effect for GL conversion.
  system_rate DECIMAL(20, 10) NULL,
  override_rate DECIMAL(20, 10) NULL,
  override_reason VARCHAR(255) NULL,
  override_by INT NULL,
  override_at DATETIME NULL,
  foreign_subtotal DECIMAL(18, 2) NOT NULL DEFAULT 0,
  foreign_tax DECIMAL(18, 2) NOT NULL DEFAULT 0,
  foreign_ewt DECIMAL(18, 2) NOT NULL DEFAULT 0,
  foreign_total DECIMAL(18, 2) NOT NULL DEFAULT 0,
  base_subtotal DECIMAL(18, 2) NOT NULL DEFAULT 0,
  base_tax DECIMAL(18, 2) NOT NULL DEFAULT 0,
  base_ewt DECIMAL(18, 2) NOT NULL DEFAULT 0,
  base_total DECIMAL(18, 2) NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_snapshot_per_transaction (transaction_type, transaction_id),
  KEY idx_snapshot_currency (currency_id),
  CONSTRAINT fk_snapshot_currency FOREIGN KEY (currency_id) REFERENCES currencies(id),
  CONSTRAINT fk_snapshot_base_currency FOREIGN KEY (base_currency_id) REFERENCES currencies(id)
);

-- Permission: reuses the existing FILESETUP.CURRENCY_SETUP module (no new
-- RBAC architecture) - one new action for the transaction-level manual
-- rate override.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.CURRENCY_SETUP', 'OVERRIDE_RATE', 'Override Transaction Exchange Rate', 'Manually override the resolved exchange rate on a specific transaction, with a required reason.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP' AND p.action = 'OVERRIDE_RATE'
WHERE r.code = 'ADMIN';
