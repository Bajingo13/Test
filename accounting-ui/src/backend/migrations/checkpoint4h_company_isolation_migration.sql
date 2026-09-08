-- Checkpoint 4H: Company Isolation & Accounting Report Integrity Hardening.
-- Idempotent (information_schema guards, same pattern as every prior
-- migration): ADD COLUMN only runs if the column doesn't already exist.
-- Safe to re-run.
--
-- PHASE A (this file, part 1): add company_id INT NULL to every header
-- table that currently has none, plus indexes. Nullable deliberately -
-- see checkpoint4h_company_isolation_notnull_migration.sql for Phase E
-- (NOT NULL), which must only run AFTER every write path in the codebase
-- has been updated to always stamp company_id (verified by the Checkpoint
-- 4H completion report's regression + live verification), never before.
--
-- PHASE B (this file, part 2): deterministic backfill. At the time this
-- migration was written, the `companies` table contains EXACTLY ONE row
-- (id=1, "AstreaBlue Accounting System") and `user_companies` contains
-- EXACTLY ONE row (the sole user, mapped to that sole company) - confirmed
-- live against the database, not assumed. Every existing transaction row
-- in this system was therefore created under company 1; there is no
-- ambiguity to resolve (see Checkpoint 4H audit report, "Historical rows
-- requiring backfill"). If this migration is ever run against a database
-- that already has more than one company by the time it executes, Phase B
-- deliberately does NOT run its blanket UPDATE (guarded below) - it backs
-- off and leaves company_id NULL rather than guessing, matching the
-- "do not guess ambiguous historical ownership" mandate. Phase C then
-- reports how many rows (if any) are still NULL so they can be resolved
-- administratively before Phase E can safely run.
--
-- chart_of_accounts is intentionally EXCLUDED from this migration - per
-- explicit product decision (Checkpoint 4H), the Chart of Accounts remains
-- a single shared/global chart across all companies, not company-scoped.
-- Line tables (invoice_lines, apv_lines, or_lines, cv_lines, jv_lines,
-- purchase_order_lines, *_beginning_balance_lines) are also NOT given
-- their own company_id - ownership is derived via header -> company_id,
-- per the "don't duplicate onto every line table" guidance. Likewise
-- transaction_applications, fx_revaluation_items, and
-- recurring_transaction_schedules/occurrences derive company ownership
-- via their existing header/session/template FK rather than a duplicated
-- column.

-- ============================================================
-- PHASE A: additive nullable columns + indexes
-- ============================================================

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND INDEX_NAME = 'idx_invoice_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE invoice_headers ADD INDEX idx_invoice_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE apv_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND INDEX_NAME = 'idx_apv_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE apv_headers ADD INDEX idx_apv_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND INDEX_NAME = 'idx_or_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE or_headers ADD INDEX idx_or_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND INDEX_NAME = 'idx_cv_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE cv_headers ADD INDEX idx_cv_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE jv_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND INDEX_NAME = 'idx_jv_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE jv_headers ADD INDEX idx_jv_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND INDEX_NAME = 'idx_po_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE purchase_order_headers ADD INDEX idx_po_company_date (company_id, transaction_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE arap_beginning_balance_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND INDEX_NAME = 'idx_arapbb_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE arap_beginning_balance_headers ADD INDEX idx_arapbb_company_date (company_id, balance_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE gl_beginning_balance_headers ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND INDEX_NAME = 'idx_glbb_company_date');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE gl_beginning_balance_headers ADD INDEX idx_glbb_company_date (company_id, balance_date)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE general_libraries ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'idx_genlib_company_type');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE general_libraries ADD INDEX idx_genlib_company_type (company_id, party_type)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- audit_logs: nullable, forward-populated only (no backfill - see header
-- note; audit rows are a historical action log, not accounting balances,
-- and leaving old entries' company_id NULL does not affect correctness of
-- any financial figure).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE audit_logs ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_company');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE audit_logs ADD INDEX idx_audit_company (company_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE B: deterministic backfill (single-company-only guard)
-- ============================================================
-- Only runs the blanket UPDATE when EXACTLY one company row exists at
-- migration time. If a second company has since been created, this backs
-- off entirely and leaves company_id NULL for Phase C to report.

SET @company_count = (SELECT COUNT(*) FROM companies);
SET @only_company_id = (SELECT id FROM companies ORDER BY id LIMIT 1);

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE invoice_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE apv_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE or_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE cv_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE jv_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE purchase_order_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE arap_beginning_balance_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE gl_beginning_balance_headers SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE general_libraries SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Also backfill the two existing FX tables that were left nullable in
-- earlier checkpoints (fx_revaluation_sessions.company_id,
-- recurring_transaction_templates.company_id) for the same deterministic
-- single-company reason - closes the loop so 4H's own audit finding
-- ("nullable, not enforced") is fully resolved, not just documented.
SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE fx_revaluation_sessions SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE recurring_transaction_templates SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE C: verification (run this SELECT manually after applying; not
-- itself part of the idempotent migration body, included here for
-- convenience when auditing a fresh environment)
-- ============================================================
-- SELECT 'invoice_headers' t, COUNT(*) null_rows FROM invoice_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'apv_headers', COUNT(*) FROM apv_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'or_headers', COUNT(*) FROM or_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'cv_headers', COUNT(*) FROM cv_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'jv_headers', COUNT(*) FROM jv_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'purchase_order_headers', COUNT(*) FROM purchase_order_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'arap_beginning_balance_headers', COUNT(*) FROM arap_beginning_balance_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'gl_beginning_balance_headers', COUNT(*) FROM gl_beginning_balance_headers WHERE company_id IS NULL
-- UNION ALL SELECT 'general_libraries', COUNT(*) FROM general_libraries WHERE company_id IS NULL;