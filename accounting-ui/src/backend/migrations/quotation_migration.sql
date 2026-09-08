CREATE TABLE IF NOT EXISTS quotation_headers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quotation_no VARCHAR(50) NOT NULL UNIQUE,
  customer_id INT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_address TEXT,
  contact_name VARCHAR(255),
  quotation_date DATE NOT NULL,
  expiration_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  notes TEXT,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  converted_invoice_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quotation_id INT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  line_type VARCHAR(10) NOT NULL DEFAULT 'item',
  description TEXT,
  notes TEXT,
  quantity DECIMAL(15,2) NOT NULL DEFAULT 0,
  unit_label VARCHAR(20) NOT NULL DEFAULT 'Units',
  unit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (quotation_id) REFERENCES quotation_headers(id) ON DELETE CASCADE
);

-- Batch 8: the three invoice_headers columns below were previously bare
-- `ALTER TABLE ... ADD COLUMN`, which throws ER_DUP_FIELDNAME on any rerun
-- against a DB that already has them (migrate.js has no applied-migrations
-- ledger and re-runs the whole chain). Now guarded with the same
-- information_schema prepared-statement idiom used by
-- ewt_taxable_base_migration.sql / phase7j / phase7h - identical schema on
-- first run, no-op on rerun. No column dropped, no type change, no data.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'source_quotation_id');
SET @sql = IF(@x = 0, 'ALTER TABLE invoice_headers ADD COLUMN source_quotation_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'invoice_type');
SET @sql = IF(@x = 0, "ALTER TABLE invoice_headers ADD COLUMN invoice_type VARCHAR(20) NOT NULL DEFAULT 'Standard'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'recurrence_frequency');
SET @sql = IF(@x = 0, 'ALTER TABLE invoice_headers ADD COLUMN recurrence_frequency VARCHAR(20) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
