-- R9: OR / CV payment details for Bank Reconciliation.
-- Idempotent (information_schema guards). Safe to re-run. Schema only -
-- no existing row is changed, nothing is backfilled or guessed.
--
-- 1. payment_method VARCHAR(10) -> VARCHAR(20) on or_headers / cv_headers so
--    the new "Bank Transfer" method fits. Existing values ("Cash", "Check")
--    and each table's NOT NULL + default are kept exactly as they are.
-- 2. payment_reference VARCHAR(100) NULL + payment_date DATE NULL on both
--    tables: the bank's transfer / reference number and the transfer date of
--    a Bank Transfer payment. reference_no is NOT reused - it already holds
--    the document's own number - and check_no / check_date stay check-only.
--
-- Reverse (only while no row uses the new method / columns):
--   ALTER TABLE or_headers DROP COLUMN payment_date, DROP COLUMN payment_reference,
--     MODIFY payment_method VARCHAR(10) NOT NULL DEFAULT 'Cash';
--   ALTER TABLE cv_headers DROP COLUMN payment_date, DROP COLUMN payment_reference,
--     MODIFY payment_method VARCHAR(10) NOT NULL DEFAULT 'Check';
--
-- Must run AFTER cashcheck_migration.sql (which adds payment_method,
-- bank_account_id, check_no and check_date to or_headers / cv_headers).

SET @len = (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'payment_method');
SET @sql = IF(@len IS NOT NULL AND @len < 20, 'ALTER TABLE or_headers MODIFY payment_method VARCHAR(20) NOT NULL DEFAULT ''Cash''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @len = (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'payment_method');
SET @sql = IF(@len IS NOT NULL AND @len < 20, 'ALTER TABLE cv_headers MODIFY payment_method VARCHAR(20) NOT NULL DEFAULT ''Check''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'payment_reference');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN payment_reference VARCHAR(100) NULL AFTER check_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'payment_date');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN payment_date DATE NULL AFTER payment_reference', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'payment_reference');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN payment_reference VARCHAR(100) NULL AFTER check_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'payment_date');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN payment_date DATE NULL AFTER payment_reference', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
