-- company_profile rerun guard (Reports compatibility with multi-company PR #8).
--
-- companies_contact_bir_fields_migration.sql retires the legacy single-row
-- `company_profile` letterhead table by RENAME (not DROP) to
-- `company_profile_deprecated`, so the canonical multi-company `companies`
-- table becomes the sole source of truth for print / BIR / contact data.
-- That is the intended final architecture and MUST stay intact.
--
-- The problem this migration fixes is idempotency only: on a second/third
-- run of the whole migration chain, 000_baseline_schema_migration.sql's
--   CREATE TABLE IF NOT EXISTS `company_profile` (...)
-- no longer finds the (renamed) table and resurrects an EMPTY legacy
-- `company_profile`. The chain then ends with BOTH `company_profile` and
-- `company_profile_deprecated`, drifting the schema (79 -> 80 tables) and
-- adding stray columns. Nothing in the application reads `company_profile`
-- after PR #8, so the resurrected copy is pure dead weight.
--
-- This migration removes ONLY that spurious resurrection. It fires solely
-- when ALL of the following hold, so it can never touch a genuinely-old
-- database or a table with real data:
--   * company_profile_deprecated EXISTS  -> retirement already completed,
--     the real legacy data is safely preserved there
--   * a bare `company_profile` table EXISTS  -> it was resurrected by the
--     baseline rerun
--   * that `company_profile` has ZERO rows  -> never drop a table holding
--     data
--
-- `companies` and `company_profile_deprecated` are NEVER referenced for
-- deletion. No DROP TABLE companies, no DELETE FROM companies, no data
-- fabrication. Scenario A (old DB, no _deprecated yet): every guard is
-- false -> no-op, first-run upgrade proceeds normally. Scenario B / C
-- (already upgraded, or a fresh DB on its 2nd+ chain run): the stray
-- `company_profile` is dropped, so run N ends at the same schema as run 1.

SET @retired = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_profile_deprecated'
);
SET @legacy_present = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_profile'
);

-- Row count of `company_profile` - only evaluated (via dynamic SQL) when
-- the table actually exists, so a missing table never errors here.
SET @legacy_rows = 1;
SET @sql = IF(
  @retired > 0 AND @legacy_present > 0,
  'SELECT COUNT(*) INTO @legacy_rows FROM company_profile',
  'SET @legacy_rows = 1'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = IF(
  @retired > 0 AND @legacy_present > 0 AND @legacy_rows = 0,
  'DROP TABLE company_profile',
  'SELECT 1'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
