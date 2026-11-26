-- General Libraries - branch-aware party code uniqueness.
--
-- Before: UNIQUE (company_id, code)  (multi_branch_phase_b_migration.sql) -
--   a code could exist ONCE per company, so a branch could not own a party
--   code already owned by another branch (imports skipped it as "already
--   exists").
-- After:  UNIQUE (company_id, code, branch_scope), branch_scope =
--   IFNULL(branch_id, 0) (stored generated column) - a code is unique per
--   company AND owner (shared, or one branch). Same pattern as
--   chart_of_accounts (uq_coa_code_branch).
--   The API (services/genlibCodePolicy.js) additionally refuses a shared code
--   reused by a branch record (and vice versa) and branch records of the same
--   code with different party types.
--
-- No row is inserted, updated or deleted - one generated column and indexes
-- only. Every existing row already satisfies the new (looser) key because it
-- satisfied the old one. The new key is added BEFORE the old one is dropped,
-- so uniqueness is never absent. fk_genlib_company keeps an index whose first
-- column is company_id (idx_genlib_company_type and the new unique key).
--
-- Idempotent (information_schema guards). Safe to run twice.
-- Must run AFTER multi_branch_phase_b_migration.sql.
--
-- Rollback (only while NO code exists twice in one company - check first):
--   SELECT company_id, code, COUNT(*) FROM general_libraries
--    GROUP BY company_id, code HAVING COUNT(*) > 1;      -- must return 0 rows
--   ALTER TABLE general_libraries ADD UNIQUE KEY uq_genlib_company_code (company_id, code);
--   ALTER TABLE general_libraries DROP INDEX uq_genlib_company_code_branch;
--   ALTER TABLE general_libraries DROP COLUMN branch_scope;

-- Fail fast instead of waiting (default lock_wait_timeout = 1 year) when a
-- long transaction holds general_libraries: the startup migration then stops
-- with an error (the server refuses to boot) rather than hanging the deploy.
-- Session-level only (this migration connection).
SET SESSION lock_wait_timeout = 60;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'branch_scope');
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD COLUMN branch_scope INT GENERATED ALWAYS AS (IFNULL(branch_id, 0)) STORED', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'uq_genlib_company_code_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD UNIQUE KEY uq_genlib_company_code_branch (company_id, code, branch_scope)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'uq_genlib_company_code');
SET @sql = IF(@c > 0, 'ALTER TABLE general_libraries DROP INDEX uq_genlib_company_code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
