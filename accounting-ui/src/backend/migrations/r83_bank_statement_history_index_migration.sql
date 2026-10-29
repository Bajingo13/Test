-- R8.3: index for bank statement history. Schema-only (one index), no data
-- change. Idempotent (information_schema guard). Safe to re-run.
--
-- A reconciliation session now reads the bank account's statement history
-- instead of rows imported through it: company_id + bank_account_id +
-- txn_date range (plus match_status for the carried-forward, still-unresolved
-- rows) - BankMatchingService.statementSetWhere(). The only existing key on
-- those columns, uq_stmt_fingerprint (company_id, bank_account_id,
-- row_fingerprint), serves the company + bank prefix but not the date range.
--
-- Must run AFTER r82_bank_statement_import_migration.sql (adds company_id /
-- bank_account_id to bank_recon_statement_lines).

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND INDEX_NAME = 'idx_stmt_owner_date');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_statement_lines ADD INDEX idx_stmt_owner_date (company_id, bank_account_id, txn_date, match_status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
