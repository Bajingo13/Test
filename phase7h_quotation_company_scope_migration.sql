-- Phase 7H: make the Quotation module company-scoped.
--
-- quotation_headers predates the checkpoint4h company-isolation retrofit and
-- was the one company-scoped-transaction table still missing company_id.
-- This adds it, backfills safely, and replaces the global
-- UNIQUE(quotation_no) with a composite UNIQUE(company_id, quotation_no) so
-- Company A and Company B may each have SQ26-00001.
--
-- Additive/index-only + idempotent (information_schema guards, same pattern
-- as phase7c/7e/7g). NO table recreation. NO amount/date/customer/status/
-- line/number modification. Existing quotation numbers are preserved
-- verbatim - historical rows are NEVER renumbered.
--
-- BACKFILL STRATEGY (spec section 5): company_id is added NULL, then
-- backfilled to the single company ONLY WHEN EXACTLY ONE company exists in
-- the target database (the same "one accessible company" rule
-- resolveCompanyIdForWrite already applies). If 0 or >1 companies exist,
-- legacy rows keep company_id = NULL: the composite unique index tolerates
-- multiple NULLs, and ownership must then be assigned by an explicit
-- remediation step before those rows are usable (do NOT guess ownership).
-- checkpoint4h's own company_id retrofit chose the same nullable + index +
-- no-FK shape for the same backfill-tolerance reason; Phase 7H follows it.
--
-- PRE-PRODUCTION AUDIT (run read-only BEFORE applying this against
-- production; do NOT apply if any check fails without an approved
-- remediation):
--   1. SELECT COUNT(*) FROM companies;                       -- backfill only auto-runs when = 1
--   2. SELECT COUNT(*) FROM quotation_headers;               -- table size / lock-risk estimate
--   3. SELECT COUNT(*) FROM quotation_headers WHERE company_id IS NULL;  -- (pre-migration: all rows)
--   4. After the intended ownership assignment, verify NO same-company
--      dup: SELECT company_id, quotation_no, COUNT(*) FROM quotation_headers
--      GROUP BY company_id, quotation_no HAVING COUNT(*) > 1;
--   5. SHOW INDEX FROM quotation_headers;                    -- confirm the old global `quotation_no` unique still exists
--   6. Data/index size from information_schema.TABLES for quotation_headers.
-- If > 1 company holds legacy quotations, ownership is AMBIGUOUS: this
-- migration leaves those rows company_id = NULL (inaccessible to every
-- company route) until an explicit remediation assigns ownership.

-- ---------------------------------------------------------------------------
-- 1. quotation_headers.company_id
-- ---------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND COLUMN_NAME = 'company_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE quotation_headers ADD COLUMN company_id INT NULL AFTER id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Safe backfill: only when exactly one company exists.
UPDATE quotation_headers
SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1)
WHERE company_id IS NULL
  AND (SELECT COUNT(*) FROM companies) = 1;

-- ---------------------------------------------------------------------------
-- 2. company/date index
-- ---------------------------------------------------------------------------
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND INDEX_NAME = 'idx_quotation_company_date'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE quotation_headers ADD INDEX idx_quotation_company_date (company_id, quotation_date)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------------------
-- 3. global UNIQUE(quotation_no) -> composite UNIQUE(company_id, quotation_no)
-- The inline `quotation_no VARCHAR(50) NOT NULL UNIQUE` in
-- quotation_migration.sql produced an index named `quotation_no`.
-- ---------------------------------------------------------------------------
SET @has_old = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND INDEX_NAME = 'quotation_no'
);
SET @sql = IF(@has_old > 0, 'ALTER TABLE quotation_headers DROP INDEX quotation_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_new = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND INDEX_NAME = 'uq_quotation_company_no'
);
SET @sql = IF(@has_new = 0,
  'ALTER TABLE quotation_headers ADD UNIQUE INDEX uq_quotation_company_no (company_id, quotation_no)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
