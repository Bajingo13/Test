-- Account Group Code report classification.
--
-- Adds two purely-additive, nullable columns to account_group_codes so the
-- Balance Sheet and Income Statement can later drive Condensed / Detailed
-- output with correct Current / Non-Current sections, Direct Cost vs
-- Operating Expense, Other Income, Tax Expense, and a controlled report
-- ordering that is independent of account code:
--
--   report_section  VARCHAR(32) NULL  - application-level values:
--       Balance Sheet:  CURRENT_ASSET, NON_CURRENT_ASSET,
--                       CURRENT_LIABILITY, NON_CURRENT_LIABILITY, EQUITY
--       Income Statement: REVENUE, DIRECT_COST, OPERATING_EXPENSE,
--                         OTHER_INCOME, OTHER_EXPENSE, TAX_EXPENSE
--       NULL = unclassified (allowed; only future BS/IS template
--       generation that needs these will validate them)
--
--   display_order   INT NULL  - report ordering within a section
--       (10, 20, 30, ...). NULL falls back to: section, group code,
--       account code.
--
-- Additive and idempotent - same guard pattern as
-- invoice_terms_migration.sql / phase7j_vat_entry_mode_migration.sql: each
-- column is added only if information_schema shows it missing, NULLABLE
-- with NO backfill. Every existing account_group_codes row keeps
-- report_section = NULL and display_order = NULL. There is deliberately NO
-- name-based / keyword / prefix auto-classification - existing groups stay
-- unclassified until a human classifies them in File Setup. Re-run is a
-- no-op. No column is dropped, renamed, or retyped.

SET @report_section_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'account_group_codes'
    AND COLUMN_NAME = 'report_section'
);
SET @sql = IF(
  @report_section_exists = 0,
  "ALTER TABLE account_group_codes ADD COLUMN report_section VARCHAR(32) NULL AFTER account_class",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @display_order_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'account_group_codes'
    AND COLUMN_NAME = 'display_order'
);
SET @sql = IF(
  @display_order_exists = 0,
  "ALTER TABLE account_group_codes ADD COLUMN display_order INT NULL AFTER report_section",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
