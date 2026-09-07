-- Checkpoint 3C: JV + Purchase Order multi-currency. Idempotent -
-- information_schema guards for ALTER TABLE ADD COLUMN, same pattern as
-- every prior migration in this project.
--
-- Scope note: Checkpoint 3C's spec also named Journal Entry, Debit Memo,
-- Credit Memo, and Petty Cash. Investigation confirmed none of those have
-- any backend table or route today (JournalEntry.jsx is unreachable
-- hardcoded demo code; DebitCreditMemo.jsx/PettyCashVoucher.jsx are
-- frontend-only stubs with no server wiring at all) - there is nothing to
-- extend for them, so this migration only touches JV and Purchase Order,
-- the two modules that actually have real tables.

-- JV: posts to GL (see LedgerReportService.js/trialBalanceCheckerService.js
-- unions), so it gets the exact same currency_id + foreign_debit/foreign_credit
-- shape as Invoice/APV/OR/CV (Checkpoints 3A/3B).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE jv_headers ADD COLUMN currency_id INT NULL, ADD CONSTRAINT fk_jv_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE jv_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL, ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Purchase Order: confirmed NON-GL-posting (absent from every ledger/trial
-- balance union). currency_id + per-line foreign_debit/foreign_credit are
-- added for accurate reference-only storage and printing (section 13/15 of
-- the spec) - never read by any GL/ledger/trial-balance query.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN currency_id INT NULL, ADD CONSTRAINT fk_po_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_lines' AND COLUMN_NAME = 'foreign_debit');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_lines ADD COLUMN foreign_debit DECIMAL(18,2) NULL, ADD COLUMN foreign_credit DECIMAL(18,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
