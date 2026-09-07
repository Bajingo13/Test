-- Companies Contact/BIR Fields + company_profile Retirement (Option B).
--
-- Follow-up to company_profile_contact_fields_migration.sql. That
-- migration's own header flagged, without fixing, that company_profile
-- is a single global row (id always = 1, no company_id) read
-- unconditionally by transactionPrintDataService.getCompanyProfile() and
-- by GET/PUT /api/company-profile - every company in this multi-tenant
-- system was printing every document (invoices, ORs, APV/CV/PO/JV, the 3
-- "Print List by..." summaries, and the BIR Form 2307 Certificate of
-- Creditable Tax Withheld) with the SAME letterhead/TIN/address/BIR data,
-- regardless of which company actually issued the document.
--
-- Verified before writing this migration (not assumed): companies.id = 1
-- and company_profile.id = 1 are the SAME real-world tenant.
-- user_access_control_migration.sql creates the `companies` table fresh
-- in that same file (CREATE TABLE IF NOT EXISTS, AUTO_INCREMENT PRIMARY
-- KEY) and, guarded by `WHERE NOT EXISTS (SELECT 1 FROM companies)`,
-- seeds its very first row by copying DIRECTLY from company_profile
-- ("Seed the default company/branch from the existing company_profile
-- singleton" - SELECT ... FROM company_profile cp ... LIMIT 1). Since
-- companies was empty at that point, AUTO_INCREMENT assigned that seeded
-- row id = 1. Corroborated by checkpoint4h_company_isolation_migration.sql's
-- own verified-live comment naming companies.id = 1 as "AstreaBlue
-- Accounting System" - the exact fallback name that same seed INSERT
-- uses when company_profile.payor_name is blank.
--
-- This migration:
--   1. Adds the same 9 columns company_profile_contact_fields_migration.sql
--      added to company_profile, now onto `companies` instead - same
--      types, additive, idempotent (information_schema guard).
--   2. Backfills companies.id = 1's new columns from company_profile's
--      row - the ONE company_id this migration has verified evidence
--      for, never a blanket UPDATE across every company row. Guarded so
--      a re-run (or a run after an admin has already edited companies.id
--      = 1 through a newer, company-scoped settings page) is a no-op -
--      only fires while every one of the 9 new columns on companies.id=1
--      is still untouched (NULL, or vat_registered still at its column
--      DEFAULT of 1).
--   3. Defensively retires company_profile by RENAME (not DROP) to
--      company_profile_deprecated, so it still exists - unread by any
--      application code after this migration, but recoverable - for one
--      release cycle before an eventual follow-up migration drops it for
--      real. Every reader of company_profile (transactionPrintDataService.js,
--      server.js's /api/company-profile and BIR 2307 report,
--      beginningBalanceTemplateService.js, test fixtures) is repointed to
--      `companies` in this same checkpoint's code changes.
--
-- No other company's data is touched. No existing companies row's
-- identity columns (name/tin/address/zip) are modified - only the 9 new
-- columns are added and backfilled, and only for company_id = 1.

-- ---------------------------------------------------------------------------
-- 1. Add the 9 columns to `companies` (idempotent).
-- ---------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'telephone'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN telephone VARCHAR(50) NULL AFTER zip", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'email'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN email VARCHAR(255) NULL AFTER telephone", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'vat_registered'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN vat_registered TINYINT(1) NOT NULL DEFAULT 1 AFTER email", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'branch_code'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN branch_code VARCHAR(20) NULL AFTER vat_registered", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'logo_url'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN logo_url VARCHAR(500) NULL AFTER branch_code", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'bir_permit_no'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN bir_permit_no VARCHAR(100) NULL AFTER logo_url", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'atp_date'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN atp_date DATE NULL AFTER bir_permit_no", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'approved_serial_from'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN approved_serial_from VARCHAR(50) NULL AFTER atp_date", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'approved_serial_to'
);
SET @sql = IF(@col_exists = 0, "ALTER TABLE companies ADD COLUMN approved_serial_to VARCHAR(50) NULL AFTER approved_serial_from", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. Backfill companies.id = 1 ONLY, from company_profile's row, and only
--    while untouched since column creation (idempotent, non-clobbering).
-- ---------------------------------------------------------------------------
SET @profile_table_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_profile'
);
SET @sql = IF(
  @profile_table_exists > 0,
  "UPDATE companies c
     JOIN company_profile cp ON cp.id = 1
      SET c.telephone = cp.telephone,
          c.email = cp.email,
          c.vat_registered = cp.vat_registered,
          c.branch_code = cp.branch_code,
          c.logo_url = cp.logo_url,
          c.bir_permit_no = cp.bir_permit_no,
          c.atp_date = cp.atp_date,
          c.approved_serial_from = cp.approved_serial_from,
          c.approved_serial_to = cp.approved_serial_to
    WHERE c.id = 1
      AND c.telephone IS NULL AND c.email IS NULL AND c.branch_code IS NULL
      AND c.logo_url IS NULL AND c.bir_permit_no IS NULL AND c.atp_date IS NULL
      AND c.approved_serial_from IS NULL AND c.approved_serial_to IS NULL",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. Defensively retire company_profile (rename, do not drop).
-- ---------------------------------------------------------------------------
SET @profile_table_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_profile'
);
SET @deprecated_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_profile_deprecated'
);
SET @sql = IF(
  @profile_table_exists > 0 AND @deprecated_exists = 0,
  'RENAME TABLE company_profile TO company_profile_deprecated',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
