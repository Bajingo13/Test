-- Checkpoint 3D Part A: Beginning Balance multi-currency. Idempotent -
-- information_schema guards for ALTER TABLE ADD COLUMN, same pattern as
-- every prior migration in this project.
--
-- Design: currency lives at the LINE level (not the header), because one
-- GL/AR/AP beginning balance header groups multiple lines by balance_date
-- and those lines can legitimately be in different currencies (USD lines,
-- EUR lines, PHP lines under the same opening batch - see Checkpoint 3D
-- spec section 4). Opening-rate metadata is NOT duplicated into new rate
-- columns here - each line reuses the existing generic
-- transaction_currency_snapshots table, keyed by
-- (transaction_type = 'GL_BEGINNING'|'AR_BEGINNING'|'AP_BEGINNING',
-- transaction_id = line.id). This is a natural fit: each line already IS
-- its own document/currency, and it reuses getSnapshot/saveSnapshot/
-- lockSnapshot/override-permission logic unchanged instead of inventing a
-- second rate-tracking mechanism.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_lines' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE gl_beginning_balance_lines ADD COLUMN currency_id INT NULL, ADD CONSTRAINT fk_glbb_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE gl_beginning_balance_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL, ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- arap_beginning_balance_lines: each row is one outstanding document (like
-- a mini Invoice/APV). foreign_original/paid/balance mirror the pattern
-- invoice_headers/apv_headers already use (foreign_paid_amount,
-- foreign_balance_amount) - "original" is the extra piece since AR/AP
-- beginning balance has no separate total_debit/total_credit column to
-- borrow that meaning from the way Invoice/APV do.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_lines' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE arap_beginning_balance_lines ADD COLUMN currency_id INT NULL, ADD CONSTRAINT fk_arapbb_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_lines' AND COLUMN_NAME = 'foreign_original_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE arap_beginning_balance_lines ADD COLUMN foreign_original_amount DECIMAL(18,2) NULL, ADD COLUMN foreign_paid_amount DECIMAL(18,2) NULL, ADD COLUMN foreign_balance_amount DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- import_batch_rows stores raw_data/resolved_data as JSON already - the new
-- currency/rate fields are staged inside that JSON, no schema change needed.

-- transaction_currency_snapshots.transaction_type was varchar(10) - enough
-- for every existing value (INV/APV/OR/CV/JV/PO) but too narrow for
-- 'GL_BEGINNING'/'AR_BEGINNING'/'AP_BEGINNING' (12 chars). Widening is
-- backward compatible (existing short values are unaffected).
ALTER TABLE transaction_currency_snapshots MODIFY COLUMN transaction_type VARCHAR(20) NOT NULL;
