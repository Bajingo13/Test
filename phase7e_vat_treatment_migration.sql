-- Phase 7E: VAT Treatment Classification (STANDARD / ZERO_RATED / EXEMPT).
--
-- The system previously could not tell a zero-rated sale, a VAT-exempt
-- sale, and a genuine 0% VATable line apart - all three were just
-- "rate = 0". Zero-rated and exempt are legally distinct treatments with
-- different reporting meaning even when computed VAT is zero, so the
-- treatment is now stored EXPLICITLY: on each VAT Rate Library code, and
-- as a transaction-time SNAPSHOT on every modern VAT tax entry (so a later
-- edit to the library never reclassifies a posted transaction).
--
-- Additive and idempotent. Safe to run any number of times, including
-- directly against an existing database with live data:
--   - every column is added only if information_schema shows it missing
--     (the same guard pattern phase7c_tax_schedule_migration.sql uses for
--     its indexes)
--   - existing vat_rate_codes rows take the column DEFAULT 'STANDARD'
--   - existing transaction_tax_entries VAT rows (entry_type INPUT_VAT /
--     OUTPUT_VAT) are backfilled to 'STANDARD' - NOT because rate = 0 is
--     inferred as anything, but because no non-standard treatment existed
--     before this migration, so every historical VAT entry IS standard by
--     definition. EWT rows are left NULL (they carry no VAT treatment).
--   - no historical rate/amount is rewritten.

-- ---------------------------------------------------------------------------
-- 1. vat_rate_codes.treatment
-- ---------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'vat_rate_codes'
    AND COLUMN_NAME = 'treatment'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE vat_rate_codes ADD COLUMN treatment VARCHAR(20) NOT NULL DEFAULT 'STANDARD' AFTER rate",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Any row that somehow has a NULL/blank treatment (e.g. added by an older
-- partial run) is normalized to STANDARD. Never touches a row that already
-- carries ZERO_RATED / EXEMPT.
UPDATE vat_rate_codes
SET treatment = 'STANDARD'
WHERE treatment IS NULL OR treatment = '';

-- Reference rows for the two non-standard treatments so the VAT entry
-- modal has something to pick out of the box. INSERT IGNORE against the
-- real UNIQUE key on `code` - never recreates or overwrites an
-- administrator-edited row.
INSERT IGNORE INTO vat_rate_codes (code, description, applies_to, rate, treatment, status)
VALUES
  ('VAT_ZERO_RATED', 'Zero-Rated Sale/Purchase', 'BOTH', 0.000, 'ZERO_RATED', 'ACTIVE'),
  ('VAT_EXEMPT',     'VAT-Exempt Sale/Purchase', 'BOTH', 0.000, 'EXEMPT',     'ACTIVE');

-- ---------------------------------------------------------------------------
-- 2. transaction_tax_entries.vat_code + vat_treatment (transaction-time snapshot)
-- ---------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'transaction_tax_entries'
    AND COLUMN_NAME = 'vat_code'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE transaction_tax_entries ADD COLUMN vat_code VARCHAR(20) NULL AFTER purchase_classification",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'transaction_tax_entries'
    AND COLUMN_NAME = 'vat_treatment'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE transaction_tax_entries ADD COLUMN vat_treatment VARCHAR(20) NULL AFTER vat_code",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill: every pre-existing VAT entry is STANDARD by definition (no
-- other treatment existed). EWT rows keep vat_treatment NULL.
UPDATE transaction_tax_entries
SET vat_treatment = 'STANDARD'
WHERE entry_type IN ('INPUT_VAT', 'OUTPUT_VAT')
  AND (vat_treatment IS NULL OR vat_treatment = '');
