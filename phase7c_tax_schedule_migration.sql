-- Phase 7C: Unified Journal Entry Tax Workflow - tax schedule metadata.
-- Idempotent - safe to run any number of times against any environment.
--
-- Architecture audit finding (see the Phase 7C completion report): no
-- table anywhere in this schema stores structured VAT schedule
-- information (supplier/customer identity, gross/net/VAT breakdown,
-- purchase classification). EWT already has HEADER-level columns
-- (atc_code/tax_type/tax_rate/tax_withheld_amount/taxable_base/payee_tin
-- on invoice_headers/or_headers/cv_headers/apv_headers/
-- purchase_order_headers, from ewt_taxable_base_migration.sql and
-- ewt_phase2_migration.sql) but those are NOT touched or duplicated here -
-- this migration is purely additive, for the NEW per-line schedule
-- metadata Phase 7C introduces (supplier/customer name+TIN+address
-- snapshots, gross/net/VAT breakdown, classification) that neither the
-- header columns nor any existing table capture.
--
-- transaction_type/transaction_id is the same polymorphic-reference
-- pattern the existing transaction_applications table already uses
-- (source_type/source_id) - no single FK is possible since the same
-- transaction_id value means a different physical table (invoice_headers
-- vs apv_headers) depending on transaction_type, so this table has no FK
-- to a header table, matching that established precedent.
--
-- line_id references the real, persisted invoice_lines.id/apv_lines.id
-- (not a client-side UUID, which is regenerated fresh on every page load
-- and is therefore NOT a stable identity across save/reload cycles) - see
-- the Phase 7C report's "Tax-line identification method" item.
CREATE TABLE IF NOT EXISTS transaction_tax_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  transaction_type VARCHAR(10) NOT NULL,
  transaction_id INT NOT NULL,
  line_id INT NOT NULL,
  entry_type VARCHAR(20) NOT NULL,

  party_id INT NULL,
  party_name_snapshot VARCHAR(255) NULL,
  party_tin_snapshot VARCHAR(20) NULL,
  party_address_snapshot VARCHAR(500) NULL,

  transaction_date DATE NULL,
  gross_amount DECIMAL(15,2) NULL,
  net_amount DECIMAL(15,2) NULL,
  vat_rate DECIMAL(6,3) NULL,
  vat_amount DECIMAL(15,2) NULL,
  purchase_classification VARCHAR(30) NULL,

  atc_code VARCHAR(20) NULL,
  tax_type VARCHAR(20) NULL,
  taxable_base DECIMAL(15,2) NULL,
  withheld_amount DECIMAL(15,2) NULL,

  account_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_tax_entries' AND INDEX_NAME = 'idx_tax_entry_txn');
SET @sql = IF(@idx_exists = 0, 'CREATE INDEX idx_tax_entry_txn ON transaction_tax_entries (transaction_type, transaction_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_tax_entries' AND INDEX_NAME = 'idx_tax_entry_line');
SET @sql = IF(@idx_exists = 0, 'CREATE INDEX idx_tax_entry_line ON transaction_tax_entries (line_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_tax_entries' AND INDEX_NAME = 'idx_tax_entry_party');
SET @sql = IF(@idx_exists = 0, 'CREATE INDEX idx_tax_entry_party ON transaction_tax_entries (party_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_tax_entries' AND INDEX_NAME = 'idx_tax_entry_company');
SET @sql = IF(@idx_exists = 0, 'CREATE INDEX idx_tax_entry_company ON transaction_tax_entries (company_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
