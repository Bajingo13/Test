-- Batch 9: the seven bare `ALTER TABLE ... ADD COLUMN` below (payment
-- method / bank account / check number+date on or_headers and cv_headers)
-- threw ER_DUP_FIELDNAME "Duplicate column name 'payment_method'" on any
-- no-reset rerun of the ledger-less migrate.js. Now wrapped in the repo's
-- standard information_schema guarded prepared-statement idiom (same as
-- ewt_taxable_base_migration.sql / phase7j / phase7h / the Batch 8
-- quotation migrations). Identical schema on first run, no-op on rerun.
-- No column dropped, no type/default change, no data touched.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'payment_method');
SET @sql = IF(@x = 0, "ALTER TABLE or_headers ADD COLUMN payment_method VARCHAR(10) NOT NULL DEFAULT 'Cash'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'bank_account_id');
SET @sql = IF(@x = 0, 'ALTER TABLE or_headers ADD COLUMN bank_account_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'check_no');
SET @sql = IF(@x = 0, 'ALTER TABLE or_headers ADD COLUMN check_no VARCHAR(100) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'check_date');
SET @sql = IF(@x = 0, 'ALTER TABLE or_headers ADD COLUMN check_date DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'payment_method');
SET @sql = IF(@x = 0, "ALTER TABLE cv_headers ADD COLUMN payment_method VARCHAR(10) NOT NULL DEFAULT 'Check'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'bank_account_id');
SET @sql = IF(@x = 0, 'ALTER TABLE cv_headers ADD COLUMN bank_account_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'check_date');
SET @sql = IF(@x = 0, 'ALTER TABLE cv_headers ADD COLUMN check_date DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
