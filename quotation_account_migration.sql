-- Batch 8: these three quotation_lines columns were previously bare
-- `ALTER TABLE ... ADD COLUMN`, which throws ER_DUP_FIELDNAME on any rerun
-- against a DB that already has them. Now guarded with the repo's standard
-- information_schema prepared-statement idiom - identical schema on first
-- run, no-op on rerun. No column dropped, no type change, no data.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_lines' AND COLUMN_NAME = 'account_id');
SET @sql = IF(@x = 0, 'ALTER TABLE quotation_lines ADD COLUMN account_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_lines' AND COLUMN_NAME = 'account_code');
SET @sql = IF(@x = 0, 'ALTER TABLE quotation_lines ADD COLUMN account_code VARCHAR(50) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_lines' AND COLUMN_NAME = 'account_title');
SET @sql = IF(@x = 0, 'ALTER TABLE quotation_lines ADD COLUMN account_title VARCHAR(255) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
