-- Multi-Currency Transaction Integration - Checkpoint 3B (Official
-- Receipt + Check Voucher + payment applications). Idempotent:
-- information_schema guards for ALTER TABLE ADD COLUMN - same pattern as
-- transaction_currency_migration.sql (Checkpoint 3A).
--
-- OR/CV get the exact same currency_id/foreign_debit/foreign_credit shape
-- Invoice/APV already have, and reuse the SAME transaction_currency_snapshots
-- table (transaction_type = 'OR'/'CV') - no new snapshot table needed.
--
-- All new columns are nullable and existing rows are left NULL on purpose,
-- same historical-compatibility rule as 3A: NULL means "predates this
-- checkpoint / base-currency", never guessed or backfilled.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN currency_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN currency_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_lines' AND COLUMN_NAME = 'foreign_credit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_lines ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_lines' AND COLUMN_NAME = 'foreign_credit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_lines ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Foreign-currency payment tracking on the SOURCE documents (Invoice/APV),
-- additive alongside the existing base paid_amount/balance_amount (section
-- 7 - "do not replace existing base fields"). foreign_original_amount is
-- intentionally NOT stored here - it's already available, unchanged, as
-- transaction_currency_snapshots.foreign_total for that transaction, and
-- duplicating it risks drift. Precision matches each table's existing
-- paid_amount/balance_amount columns (invoice_headers is (15,2), apv_headers
-- is (12,2) - pre-existing inconsistency, not something this migration
-- should silently "fix" and risk truncating existing data).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'foreign_paid_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN foreign_paid_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'foreign_balance_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN foreign_balance_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'foreign_paid_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_headers ADD COLUMN foreign_paid_amount DECIMAL(12,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'foreign_balance_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_headers ADD COLUMN foreign_balance_amount DECIMAL(12,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- transaction_applications: currency/rate/FX metadata, additive alongside
-- the existing `amount` column (kept exactly as-is - it remains the
-- base-currency value updateInvoicePaymentStatus/updateApvPaymentStatus
-- already SUM() - zero behavior change for existing rows or PHP-only
-- transactions). See section 8/10/11 of the Checkpoint 3B spec for field
-- naming. fx_difference/fx_direction are calculated and stored but NEVER
-- posted as a journal entry in this checkpoint (section 41).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'source_currency_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN source_currency_code VARCHAR(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'payment_currency_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN payment_currency_code VARCHAR(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'foreign_amount_applied');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN foreign_amount_applied DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'source_exchange_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN source_exchange_rate DECIMAL(20,10) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'payment_exchange_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN payment_exchange_rate DECIMAL(20,10) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'source_base_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN source_base_amount DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'payment_base_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN payment_base_amount DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'fx_difference');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN fx_difference DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND COLUMN_NAME = 'fx_direction');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE transaction_applications ADD COLUMN fx_direction VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- transaction_applications only had a PRIMARY KEY(id) before this
-- checkpoint - every lookup (updateInvoicePaymentStatus, the OR/CV
-- edit-reversal flow, application history) filters by these pairs, so
-- this is a pure performance addition, safe to add even on a populated
-- table (index creation on a small/medium table, non-blocking metadata
-- change on modern MySQL with ALGORITHM=INPLACE which is the default).
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND INDEX_NAME = 'idx_ta_source');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE transaction_applications ADD INDEX idx_ta_source (source_type, source_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_applications' AND INDEX_NAME = 'idx_ta_applied');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE transaction_applications ADD INDEX idx_ta_applied (applied_type, applied_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
