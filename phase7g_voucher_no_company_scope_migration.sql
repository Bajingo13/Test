-- Phase 7G: voucher/reference numbers unique PER COMPANY, not globally.
--
-- Every company-scoped transaction header table currently carries a GLOBAL
-- UNIQUE(voucher_no). In a multi-company system that is wrong: Company A
-- and Company B may each legitimately have INV-0001. This migration
-- replaces the global unique index with a composite UNIQUE(company_id,
-- voucher_no) on each of the eight tables (memo_headers also keys on
-- memo_type, since Debit Memo and Credit Memo share that table and should
-- each keep their own number series within a company).
--
-- Index-only. Additive/safe and idempotent:
--   - each old global index is dropped ONLY if information_schema still
--     shows it (a re-run is a no-op)
--   - each new composite index is added ONLY if not already present
--   - explicit index names throughout; no unrelated index is touched
--   - NO table recreation, NO column drop, NO data modification
--
-- PRE-MIGRATION DATA REQUIREMENT: run
--   SELECT company_id, voucher_no, COUNT(*) FROM <table>
--   GROUP BY company_id, voucher_no HAVING COUNT(*) > 1;
-- on each table first. Cross-company duplicates are fine (that is the
-- point). Same-company duplicates would make the ADD UNIQUE fail - they
-- must be remediated as data before this runs. purchase_order_headers had
-- NO global unique index, so it only gets the ADD.

-- ---------------------------------------------------------------------------
-- helper pattern (repeated per table): drop old global unique, add composite
-- ---------------------------------------------------------------------------

-- invoice_headers : uq_invoice_voucher_no -> uq_invoice_company_voucher_no
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND INDEX_NAME = 'uq_invoice_voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE invoice_headers DROP INDEX uq_invoice_voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND INDEX_NAME = 'uq_invoice_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE invoice_headers ADD UNIQUE INDEX uq_invoice_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- apv_headers : voucher_no -> uq_apv_company_voucher_no
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND INDEX_NAME = 'voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE apv_headers DROP INDEX voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND INDEX_NAME = 'uq_apv_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE apv_headers ADD UNIQUE INDEX uq_apv_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- or_headers : uq_or_voucher_no -> uq_or_company_voucher_no
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND INDEX_NAME = 'uq_or_voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE or_headers DROP INDEX uq_or_voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND INDEX_NAME = 'uq_or_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE or_headers ADD UNIQUE INDEX uq_or_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- cv_headers : voucher_no -> uq_cv_company_voucher_no (voucher_no is nullable;
-- multiple NULLs stay allowed by SQL unique-index semantics)
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND INDEX_NAME = 'voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE cv_headers DROP INDEX voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND INDEX_NAME = 'uq_cv_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE cv_headers ADD UNIQUE INDEX uq_cv_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- jv_headers : voucher_no -> uq_jv_company_voucher_no
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND INDEX_NAME = 'voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE jv_headers DROP INDEX voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND INDEX_NAME = 'uq_jv_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE jv_headers ADD UNIQUE INDEX uq_jv_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- purchase_order_headers : (no old global index) -> uq_po_company_voucher_no
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND INDEX_NAME = 'uq_po_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE purchase_order_headers ADD UNIQUE INDEX uq_po_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- petty_cash_headers : uq_petty_cash_voucher_no -> uq_petty_cash_company_voucher_no
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND INDEX_NAME = 'uq_petty_cash_voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE petty_cash_headers DROP INDEX uq_petty_cash_voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND INDEX_NAME = 'uq_petty_cash_company_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE petty_cash_headers ADD UNIQUE INDEX uq_petty_cash_company_voucher_no (company_id, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- memo_headers : uq_memo_voucher_no -> uq_memo_company_type_voucher_no
-- (company_id, memo_type, voucher_no) - Debit Memo and Credit Memo share
-- this table and keep independent number series within a company.
SET @has_old = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND INDEX_NAME = 'uq_memo_voucher_no');
SET @sql = IF(@has_old > 0, 'ALTER TABLE memo_headers DROP INDEX uq_memo_voucher_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @has_new = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND INDEX_NAME = 'uq_memo_company_type_voucher_no');
SET @sql = IF(@has_new = 0, 'ALTER TABLE memo_headers ADD UNIQUE INDEX uq_memo_company_type_voucher_no (company_id, memo_type, voucher_no)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
