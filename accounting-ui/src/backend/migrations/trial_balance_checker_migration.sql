-- Unbalanced Trial Balance Checker - new tables only, additive, idempotent
-- (CREATE TABLE IF NOT EXISTS is natively safe to re-run). No existing
-- table is altered - the only link back to jv_headers is
-- trial_balance_checker_findings.adjustment_jv_id, a nullable column on
-- this new table, not a column added to jv_headers.

CREATE TABLE IF NOT EXISTS trial_balance_checker_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_by INT NULL,
  run_by_username VARCHAR(100) NULL,
  from_date DATE NULL,
  to_date DATE NULL,
  tolerance DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_debit DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_credit DECIMAL(18,4) NOT NULL DEFAULT 0,
  difference DECIMAL(18,4) NOT NULL DEFAULT 0,
  balance_status VARCHAR(20) NOT NULL DEFAULT 'UNBALANCED',
  finding_count INT NOT NULL DEFAULT 0,
  run_state VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_tbcr_run_by (run_by, run_state, created_at)
);

CREATE TABLE IF NOT EXISTS trial_balance_checker_findings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_id INT NOT NULL,
  category VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  source_module VARCHAR(20) NULL,
  source_table VARCHAR(60) NULL,
  transaction_id INT NULL,
  transaction_number VARCHAR(100) NULL,
  transaction_date DATE NULL,
  reference_no VARCHAR(100) NULL,
  account_code VARCHAR(50) NULL,
  account_title VARCHAR(255) NULL,
  debit DECIMAL(18,4) NULL,
  credit DECIMAL(18,4) NULL,
  line_difference DECIMAL(18,4) NULL,
  status VARCHAR(30) NULL,
  reason TEXT NULL,
  recommended_action VARCHAR(255) NULL,
  investigated TINYINT(1) NOT NULL DEFAULT 0,
  investigated_by INT NULL,
  investigated_note VARCHAR(500) NULL,
  investigated_at TIMESTAMP NULL,
  adjustment_jv_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES trial_balance_checker_runs(id) ON DELETE CASCADE,
  INDEX idx_tbcf_run (run_id, category, severity)
);
