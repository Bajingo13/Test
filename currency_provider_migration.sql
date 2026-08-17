-- Currency Setup - Phase 2 (BAP/BSP exchange-rate provider architecture).
-- Idempotent: information_schema + PREPARE/EXECUTE guards for every ALTER
-- TABLE ADD COLUMN, CREATE TABLE IF NOT EXISTS for new tables - same
-- pattern as currencies_migration.sql and beginning_balance_import_migration.sql.
--
-- Extends currency_rates (Phase 1) rather than replacing it - Phase 1's
-- rate_mode/old_rate/new_rate/effective_date/reason columns and the 21
-- existing Phase 1 tests are untouched. New columns are additive and
-- nullable/defaulted so every existing row and every existing INSERT
-- (currencyService.recordRate's original 5-argument call shape) keeps
-- working unchanged.

-- currency_rates: provider/basis/ingestion/status metadata
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'provider');
SET @sql = IF(@col_exists = 0, "ALTER TABLE currency_rates ADD COLUMN provider VARCHAR(20) NOT NULL DEFAULT 'MANUAL'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'rate_basis');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN rate_basis VARCHAR(100) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'provider_rate_description');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN provider_rate_description VARCHAR(150) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'ingestion_method');
SET @sql = IF(@col_exists = 0, "ALTER TABLE currency_rates ADD COLUMN ingestion_method VARCHAR(20) NOT NULL DEFAULT 'MANUAL_ENTRY'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'status');
SET @sql = IF(@col_exists = 0, "ALTER TABLE currency_rates ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'FINAL'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'publication_timestamp');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN publication_timestamp DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'retrieval_timestamp');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN retrieval_timestamp DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'source_reference');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN source_reference VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'derivation_method');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN derivation_method VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'provider_original_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN provider_original_rate DECIMAL(20,10) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'currency_rates' AND COLUMN_NAME = 'provider_original_direction');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE currency_rates ADD COLUMN provider_original_direction VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: every Phase 1 row was a real manual/fixed entry - provider
-- should mirror rate_mode rather than sit at the generic 'MANUAL' default,
-- and ingestion_method is genuinely MANUAL_ENTRY for all of them.
UPDATE currency_rates SET provider = rate_mode WHERE provider = 'MANUAL' AND rate_mode = 'FIXED';

-- Derivation components for CROSS_VIA_USD rates (see currencyRateResolverService.js).
-- One row per leg of the derivation (e.g. EUR/USD then USD/PHP), so the
-- full "why" behind a derived rate is reconstructable, not just the
-- final number.
CREATE TABLE IF NOT EXISTS currency_rate_derivations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  currency_rate_id INT NOT NULL,
  sequence_order INT NOT NULL,
  component_currency_pair VARCHAR(10) NOT NULL,
  component_rate DECIMAL(20, 10) NOT NULL,
  component_provider VARCHAR(20) NOT NULL,
  component_rate_basis VARCHAR(100) NULL,
  component_effective_date DATE NOT NULL,
  component_publication_timestamp DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_derivations_rate (currency_rate_id),
  CONSTRAINT fk_derivations_rate FOREIGN KEY (currency_rate_id) REFERENCES currency_rates(id)
);

-- Per-company exchange-rate policy - what Phase 3's transaction posting
-- will consult (not used by any transaction workflow yet, per Phase 2
-- scope: infrastructure only).
CREATE TABLE IF NOT EXISTS company_rate_policies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  preferred_usd_php_provider VARCHAR(20) NOT NULL DEFAULT 'BAP',
  preferred_cross_rate_provider VARCHAR(20) NOT NULL DEFAULT 'BSP',
  draft_rate_type VARCHAR(20) NOT NULL DEFAULT 'INDICATIVE',
  posting_rate_type VARCHAR(20) NOT NULL DEFAULT 'FINAL',
  allow_previous_business_day TINYINT(1) NOT NULL DEFAULT 1,
  max_rate_age_days INT NOT NULL DEFAULT 3,
  allow_manual_override TINYINT(1) NOT NULL DEFAULT 1,
  require_rate_approval TINYINT(1) NOT NULL DEFAULT 0,
  fallback_mode VARCHAR(30) NOT NULL DEFAULT 'LAST_APPROVED_RATE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_policy_per_company (company_id),
  CONSTRAINT fk_rate_policy_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- Permission catalog additions for Phase 2 actions.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.CURRENCY_SETUP', 'REFRESH_RATE', 'Refresh Exchange Rate', 'Trigger a rate refresh/resolution for a currency.'),
  ('FILESETUP.CURRENCY_SETUP', 'IMPORT_RATES', 'Import Official Rates', 'Import BAP/BSP official rates from a CSV/Excel file.'),
  ('FILESETUP.CURRENCY_SETUP', 'ENTER_OFFICIAL_RATE', 'Enter Official Rate', 'Manually record an official BAP/BSP rate.'),
  ('FILESETUP.CURRENCY_SETUP', 'APPROVE_RATE', 'Approve Exchange Rate', 'Approve a rate for posting use.'),
  ('FILESETUP.CURRENCY_SETUP', 'CONFIGURE_PROVIDER', 'Configure Rate Provider Policy', 'Configure the company''s exchange-rate provider/fallback policy.'),
  ('FILESETUP.CURRENCY_SETUP', 'VIEW_PROVIDER_STATUS', 'View Provider Status', 'View BAP/BSP/external provider health status.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP'
  AND p.action IN ('REFRESH_RATE', 'IMPORT_RATES', 'ENTER_OFFICIAL_RATE', 'APPROVE_RATE', 'CONFIGURE_PROVIDER', 'VIEW_PROVIDER_STATUS')
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP' AND p.action = 'VIEW_PROVIDER_STATUS'
WHERE r.code = 'ACCOUNTANT';
