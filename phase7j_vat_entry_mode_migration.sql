-- Phase 7J: VAT Entry Mode snapshot (INCLUSIVE / EXCLUSIVE).
--
-- The modern VAT modal (VatEntryModal.jsx -> line.taxEntry ->
-- taxEntryService.saveTaxEntries) previously assumed one input mode only:
-- the user always typed a VAT-INCLUSIVE gross amount, which was split
-- net = gross / (1 + rate), vat = gross - net. Phase 7J adds an explicit
-- VAT-EXCLUSIVE input mode where the user types the pre-VAT base and the
-- modal derives gross = base + round(base * rate) before handing the SAME
-- {grossAmount, netAmount, vatAmount, vatRate, vatCode, vatTreatment}
-- payload to the unchanged backend path.
--
-- The two modes produce identical stored gross/net/vat for an equivalent
-- sale, so this column is a REMEMBERED-INPUT snapshot only (so the edit
-- modal re-opens in the mode the user actually used, and so the mode is
-- auditable) - it never changes any calculation, report, or print value.
--
-- Additive and idempotent, same guard pattern as
-- phase7c_tax_schedule_migration.sql / phase7e_vat_treatment_migration.sql:
--   - the column is added only if information_schema shows it missing
--     (safe to re-run; safe if it already exists)
--   - it is NULLABLE with no DEFAULT and NO backfill - every historical
--     row keeps vat_entry_mode = NULL, which the application reads as
--     INCLUSIVE (the only mode that existed before this migration)
--   - no existing row is rewritten, no index is added or changed, no
--     table is rebuilt beyond the in-place ADD COLUMN MySQL performs for a
--     trailing nullable column
--
-- EWT rows (entry_type = 'EWT') carry no VAT entry mode and are left NULL,
-- exactly like vat_code / vat_treatment from Phase 7E.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'transaction_tax_entries'
    AND COLUMN_NAME = 'vat_entry_mode'
);
SET @sql = IF(
  @col_exists = 0,
  "ALTER TABLE transaction_tax_entries ADD COLUMN vat_entry_mode VARCHAR(10) NULL AFTER vat_treatment",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
