-- Idempotent version - safe to run any number of times against any
-- environment, regardless of which columns/tables already exist there.
-- Uses information_schema + PREPARE/EXECUTE for the ALTER TABLE ADD COLUMN
-- statements (MySQL has no portable ADD COLUMN IF NOT EXISTS across all
-- versions/providers), and keeps CREATE TABLE IF NOT EXISTS for the two
-- new tables, which MySQL already supports natively. Never drops or
-- recreates anything, never touches existing data/rows.

-- gl_beginning_balance_lines.reference_no
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'gl_beginning_balance_lines'
    AND COLUMN_NAME = 'reference_no'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE gl_beginning_balance_lines ADD COLUMN reference_no VARCHAR(100) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- gl_beginning_balance_lines.remarks
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'gl_beginning_balance_lines'
    AND COLUMN_NAME = 'remarks'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE gl_beginning_balance_lines ADD COLUMN remarks VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- arap_beginning_balance_lines.document_date
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'arap_beginning_balance_lines'
    AND COLUMN_NAME = 'document_date'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE arap_beginning_balance_lines ADD COLUMN document_date DATE NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Shared preview/commit staging + import history, used by GL, AR, and AP
-- beginning-balance imports alike (parameterized by `module`). Preview
-- parses+validates a file and stores rows here without touching the real
-- GL/AR/AP tables; commit re-validates the stored rows against live data
-- and inserts them in one transaction, referencing only the batch id (not
-- client-supplied row data). CREATE TABLE IF NOT EXISTS is already
-- natively safe to re-run - no information_schema check needed here.
CREATE TABLE IF NOT EXISTS import_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(30) NOT NULL,
  template_version VARCHAR(10) NOT NULL,
  file_name VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PREVIEWED',
  total_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  invalid_rows INT NOT NULL DEFAULT 0,
  warning_rows INT NOT NULL DEFAULT 0,
  total_debit DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_credit DECIMAL(18,4) NOT NULL DEFAULT 0,
  duplicate_mode VARCHAR(20) NOT NULL DEFAULT 'REJECT',
  created_by INT NULL,
  created_by_username VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  committed_at TIMESTAMP NULL,
  INDEX idx_import_batches_module (module, status)
);

CREATE TABLE IF NOT EXISTS import_batch_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  row_num INT NOT NULL,
  raw_data JSON NOT NULL,
  resolved_data JSON NULL,
  status VARCHAR(20) NOT NULL,
  errors JSON NULL,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  INDEX idx_import_batch_rows_batch (batch_id, status)
);
