-- Trial Balance Checker company isolation.
-- Idempotent (information_schema guards, same pattern as every prior
-- migration): each ALTER only runs if the column / index / constraint
-- doesn't already exist. Safe to re-run.
--
-- A checker run is computed for exactly one company (every detector query
-- is filtered by company_id), but that company was never stored - so its
-- findings, mark-investigated, export, recheck and adjustment drafts had
-- no authoritative company once the run finished. Ownership lives on the
-- run only; trial_balance_checker_findings keeps deriving it through
-- run_id (same "don't duplicate onto child rows" rule as
-- bank_recon_company_scope_migration.sql).
--
-- company_id INT NULL + FK + index. NO backfill: an existing run's company
-- cannot be reconstructed safely, so legacy runs stay NULL. They are
-- reachable only by a Super Admin and can never create an adjustment
-- draft (the API refuses with 409).
--
-- Rollback (if ever needed): drop fk_tb_checker_run_company, then
-- idx_tb_checker_run_company, then the column. Only the new column's data
-- is lost.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trial_balance_checker_runs' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE trial_balance_checker_runs ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trial_balance_checker_runs' AND INDEX_NAME = 'idx_tb_checker_run_company');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE trial_balance_checker_runs ADD INDEX idx_tb_checker_run_company (company_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trial_balance_checker_runs' AND CONSTRAINT_NAME = 'fk_tb_checker_run_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE trial_balance_checker_runs ADD CONSTRAINT fk_tb_checker_run_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Verification (run manually after applying; not part of the idempotent
-- body). Every pre-existing run is expected to be unassigned.
-- SELECT COUNT(*) AS runs, SUM(company_id IS NULL) AS unassigned FROM trial_balance_checker_runs;
