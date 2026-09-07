-- Company Profile Contact/BIR Fields.
--
-- The Standard Letter Invoice print pipeline (invoicePrintDataService.js)
-- has always had a `seller` object with phone, email, vatRegistration,
-- branchCode, logoUrl, atpNumber, atpDate, birPermitNumber, and
-- serialNumbers fields - every one of them hardcoded to null because
-- company_profile (the single global letterhead row read by
-- transactionPrintDataService.getCompanyProfile(), WHERE id = 1) never had
-- backing columns for any of it. This migration adds those columns so the
-- print pipeline can start wiring them through instead of nulling them.
--
-- NOTE (flagged, not fixed here): company_profile is a single row
-- (id = 1) with no company_id, read unconditionally regardless of which
-- tenant's document is being printed. The real multi-tenant `companies`
-- table (user_access_control_migration.sql) already carries
-- name/tin/address/zip per company and is what companyScope.js/
-- authorizePermission actually scope against - company_profile appears to
-- predate that table and was never migrated onto it. Every company
-- printed today shares one letterhead. Out of scope for this migration;
-- worth a dedicated follow-up.
--
-- Additive and idempotent, same guard pattern as
-- phase7e_vat_treatment_migration.sql / phase7j_vat_entry_mode_migration.sql:
--   - each column is added only if information_schema shows it missing
--   - all columns are NULLABLE with no backfill, except vat_registered
--     which defaults to 1 (TRUE) so every existing row is treated as
--     VAT-registered, the only status that existed before this column -
--     no historical row's printed output changes as a result.
--   - no existing row is rewritten, no index added or changed.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'telephone'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN telephone VARCHAR(50) NULL AFTER payor_zip",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'email'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN email VARCHAR(255) NULL AFTER telephone",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'vat_registered'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN vat_registered TINYINT(1) NOT NULL DEFAULT 1 AFTER email",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'branch_code'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN branch_code VARCHAR(20) NULL AFTER vat_registered",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'logo_url'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN logo_url VARCHAR(500) NULL AFTER branch_code",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'bir_permit_no'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN bir_permit_no VARCHAR(100) NULL AFTER logo_url",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'atp_date'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN atp_date DATE NULL AFTER bir_permit_no",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'approved_serial_from'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN approved_serial_from VARCHAR(50) NULL AFTER atp_date",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_profile'
    AND COLUMN_NAME = 'approved_serial_to'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE company_profile ADD COLUMN approved_serial_to VARCHAR(50) NULL AFTER approved_serial_from",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
