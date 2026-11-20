-- Multi-Branch Foundation, Phase B - code uniqueness for branch-owned setup data.
--
-- Read-only audit run first (local test + UAT databases): no duplicate COA or
-- General Library codes - not even after TRIM/case normalization - and no
-- branch-only rows yet, so every existing row satisfies the new rules.
--
-- 1. chart_of_accounts: code was unique system-wide. Now:
--      shared accounts (branch_id NULL)  - code unique among shared accounts
--      branch-only accounts              - code unique within the branch, and
--                                          MAY be reused by another branch
--    via a stored generated column branch_scope = IFNULL(branch_id, 0) and
--    UNIQUE (code, branch_scope). Two more rules are enforced by the API
--    (services/coaLookupService.assertCoaCodeAllowed), not by the schema:
--      - a branch account may not reuse a SHARED code (and vice versa), so a
--        shared code always means exactly one account;
--      - branch accounts that share a code must have the same account class,
--        so consolidation by code keeps its accounting meaning.
--    Code-keyed report joins go through coaByCodeSql() (one row per code), so
--    a reused code can never double an amount.
-- 2. general_libraries: code was unique system-wide (across companies). Now
--    UNIQUE (company_id, code): unique within a company - shared and
--    branch-only parties alike - because transaction lines reference parties
--    by code (gen_ref) with no branch, and every code lookup is already
--    company-filtered. Two companies may now use the same party code.
-- No row is changed: only indexes and one generated column.
--
-- Idempotent (information_schema guards). Safe to run twice. The new unique
-- key is added BEFORE the old one is dropped, so uniqueness is never absent.
-- Must run AFTER multi_branch_foundation_migration.sql.

-- 1. chart_of_accounts
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND COLUMN_NAME = 'branch_scope');
SET @sql = IF(@c = 0, 'ALTER TABLE chart_of_accounts ADD COLUMN branch_scope INT GENERATED ALWAYS AS (IFNULL(branch_id, 0)) STORED', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND INDEX_NAME = 'uq_coa_code_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE chart_of_accounts ADD UNIQUE KEY uq_coa_code_branch (code, branch_scope)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND INDEX_NAME = 'code' AND NON_UNIQUE = 0);
SET @sql = IF(@c > 0, 'ALTER TABLE chart_of_accounts DROP INDEX `code`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. general_libraries
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'uq_genlib_company_code');
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD UNIQUE KEY uq_genlib_company_code (company_id, code)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'code' AND NON_UNIQUE = 0);
SET @sql = IF(@c > 0, 'ALTER TABLE general_libraries DROP INDEX `code`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
