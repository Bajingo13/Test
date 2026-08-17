-- Checkpoint 4I: Company Isolation Phase E - database-level enforcement.
-- Idempotent (information_schema guards, same pattern as every prior
-- migration). Safe to re-run: already-NOT-NULL columns and already-
-- existing FKs are detected and skipped, never re-applied or duplicated.
--
-- Prerequisite: checkpoint4h_company_isolation_migration.sql must already
-- be applied and its backfill complete (verified separately via
-- verify_company_isolation.js - zero NULL, zero invalid company_id on
-- every table below, confirmed live before this file was written).
--
-- audit_logs is DELIBERATELY EXCLUDED from this migration. Its 1,137
-- existing rows have no deterministic company signal to backfill from
-- (many predate any company concept in this schema entirely) - converting
-- it to NOT NULL now would mean guessing ownership, which section 3 of
-- the Checkpoint 4I spec explicitly forbids. It stays nullable, forward-
-- populated only, with no FK. This is a reported decision, not an
-- oversight - see the Checkpoint 4I completion report.
--
-- ON DELETE RESTRICT (never CASCADE) on every FK below: a company must
-- never be deletable while it still owns accounting history. Deleting a
-- company that owns even one invoice/APV/OR/CV/JV/PO/beginning-balance/
-- party row will fail loudly at the database level, not silently cascade
-- and erase financial history.

-- ============================================================
-- PHASE E-1: NOT NULL enforcement
-- ============================================================

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE invoice_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE apv_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE or_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE cv_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE jv_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE purchase_order_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE arap_beginning_balance_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE gl_beginning_balance_headers MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @is_nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@is_nullable = 'YES', 'ALTER TABLE general_libraries MODIFY COLUMN company_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE E-2: foreign keys, ON DELETE RESTRICT
-- ============================================================

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND CONSTRAINT_NAME = 'fk_invoice_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE invoice_headers ADD CONSTRAINT fk_invoice_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND CONSTRAINT_NAME = 'fk_apv_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE apv_headers ADD CONSTRAINT fk_apv_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND CONSTRAINT_NAME = 'fk_or_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE or_headers ADD CONSTRAINT fk_or_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND CONSTRAINT_NAME = 'fk_cv_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE cv_headers ADD CONSTRAINT fk_cv_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND CONSTRAINT_NAME = 'fk_jv_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE jv_headers ADD CONSTRAINT fk_jv_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND CONSTRAINT_NAME = 'fk_po_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE purchase_order_headers ADD CONSTRAINT fk_po_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND CONSTRAINT_NAME = 'fk_arapbb_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE arap_beginning_balance_headers ADD CONSTRAINT fk_arapbb_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND CONSTRAINT_NAME = 'fk_glbb_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE gl_beginning_balance_headers ADD CONSTRAINT fk_glbb_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND CONSTRAINT_NAME = 'fk_genlib_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE general_libraries ADD CONSTRAINT fk_genlib_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE E-3: verification (informational only, safe to run standalone)
-- ============================================================
-- SELECT TABLE_NAME, IS_NULLABLE FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'company_id'
--   AND TABLE_NAME IN ('invoice_headers','apv_headers','or_headers','cv_headers',
--     'jv_headers','purchase_order_headers','arap_beginning_balance_headers',
--     'gl_beginning_balance_headers','general_libraries');
-- -- expect IS_NULLABLE = 'NO' on every row above.
--
-- SELECT CONSTRAINT_NAME, TABLE_NAME FROM information_schema.TABLE_CONSTRAINTS
--   WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'
--   AND CONSTRAINT_NAME LIKE 'fk_%_company';
-- -- expect 9 rows.