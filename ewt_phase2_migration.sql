-- Idempotent - safe to run any number of times against any environment.
-- Extends EWT support (built for APV in ewt_taxable_base_migration.sql) to
-- Invoice, Official Receipt, Check Voucher, and Purchase Order.
--
-- invoice_headers/or_headers get no payee_tin: those are the "inbound"
-- direction (the CUSTOMER is the withholding agent, not us - EWT here just
-- records what they already withheld, evidenced by a Form 2307 they issue
-- to us). customer_id/customer_name already identify the party; there's no
-- "payee" to collect a TIN for. cv_headers/purchase_order_headers are the
-- same "outbound" direction as apv_headers (we withhold and remit), so they
-- get payee_tin to match.

-- invoice_headers
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'atc_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN atc_code VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'tax_type');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN tax_type VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'tax_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN tax_rate DECIMAL(6,3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'tax_withheld_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN tax_withheld_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'taxable_base');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE invoice_headers ADD COLUMN taxable_base DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- or_headers
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'atc_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN atc_code VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'tax_type');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN tax_type VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'tax_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN tax_rate DECIMAL(6,3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'tax_withheld_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN tax_withheld_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'taxable_base');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE or_headers ADD COLUMN taxable_base DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- cv_headers
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'atc_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN atc_code VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'tax_type');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN tax_type VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'tax_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN tax_rate DECIMAL(6,3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'tax_withheld_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN tax_withheld_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'taxable_base');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN taxable_base DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'payee_tin');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE cv_headers ADD COLUMN payee_tin VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- purchase_order_headers
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'atc_code');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN atc_code VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'tax_type');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN tax_type VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'tax_rate');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN tax_rate DECIMAL(6,3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'tax_withheld_amount');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN tax_withheld_amount DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'taxable_base');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN taxable_base DECIMAL(15,2) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'payee_tin');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN payee_tin VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
