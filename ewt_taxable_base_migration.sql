-- Idempotent - safe to run any number of times against any environment.
-- Adds apv_headers.taxable_base: the VAT-exclusive amount EWT was actually
-- computed on, stored for audit purposes (previously only the final
-- tax_withheld_amount was persisted, with no record of what base produced
-- it). Confirmed via live schema inspection that no such column, and no
-- vat_amount/gross_amount/net_amount column, exists anywhere today - gross
-- is already apv_headers.total_credit and net payable is already derivable
-- as total_credit - tax_withheld_amount, so no other columns are added.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'apv_headers'
    AND COLUMN_NAME = 'taxable_base'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE apv_headers ADD COLUMN taxable_base DECIMAL(15,2) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
