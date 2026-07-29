-- Small additive columns needed by the Beginning Balance import templates
-- (no existing column covers these) - nullable, non-breaking.
ALTER TABLE gl_beginning_balance_lines ADD COLUMN reference_no VARCHAR(100) NULL;
ALTER TABLE gl_beginning_balance_lines ADD COLUMN remarks VARCHAR(255) NULL;

ALTER TABLE arap_beginning_balance_lines ADD COLUMN document_date DATE NULL;

-- Shared preview/commit staging + import history, used by GL, AR, and AP
-- beginning-balance imports alike (parameterized by `module`). Preview
-- parses+validates a file and stores rows here without touching the real
-- GL/AR/AP tables; commit re-validates the stored rows against live data
-- and inserts them in one transaction, referencing only the batch id (not
-- client-supplied row data).
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
