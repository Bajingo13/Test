-- Invoice Terms.
--
-- invoice_headers has never had a payment-terms column; the print
-- pipeline (invoicePrintDataService.js) has always hardcoded
-- document.terms to null with a comment noting the column doesn't exist.
-- This adds it so the Invoice transaction form can capture free-text
-- terms (e.g. "Net 30", "Due on Receipt") and the printable can show them.
--
-- Additive and idempotent, same guard pattern as
-- phase7j_vat_entry_mode_migration.sql: added only if information_schema
-- shows it missing, NULLABLE with no backfill - every historical invoice
-- keeps terms = NULL, which the print pipeline already renders as "hidden"
-- (no behavior change for existing rows).

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoice_headers'
    AND COLUMN_NAME = 'terms'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE invoice_headers ADD COLUMN terms VARCHAR(255) NULL AFTER due_date",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
