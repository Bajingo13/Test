CREATE TABLE IF NOT EXISTS jv_headers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_no VARCHAR(100) NOT NULL UNIQUE,
  transaction_date DATE NOT NULL,
  reference_no VARCHAR(100),
  prepared_for VARCHAR(255) NULL,
  description TEXT,
  remarks TEXT,
  total_debit DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_credit DECIMAL(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  source_module VARCHAR(30) NULL,
  source_reference_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  posted_by INT NULL,
  posted_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS jv_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jv_id INT NOT NULL,
  account_id INT NULL,
  account_code VARCHAR(50),
  account_title VARCHAR(255),
  particulars TEXT,
  debit DECIMAL(15,2) NOT NULL DEFAULT 0,
  credit DECIMAL(15,2) NOT NULL DEFAULT 0,
  gen_ref VARCHAR(100),
  gen_name VARCHAR(255),
  FOREIGN KEY (jv_id) REFERENCES jv_headers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(30) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id INT NULL,
  action VARCHAR(40) NOT NULL,
  description VARCHAR(500) NOT NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  user_id INT NULL,
  username VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (module, entity_type, entity_id),
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_user (user_id)
);

CREATE TABLE IF NOT EXISTS bank_recon_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bank_account_id INT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  statement_beginning_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  statement_ending_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  date_tolerance_days INT NOT NULL DEFAULT 3,
  amount_variance_type VARCHAR(10) NOT NULL DEFAULT 'FIXED',
  amount_variance_value DECIMAL(15,2) NOT NULL DEFAULT 1.00,
  status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
  notes TEXT,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finalized_by INT NULL,
  finalized_at TIMESTAMP NULL,
  FOREIGN KEY (bank_account_id) REFERENCES bank_codes(id),
  INDEX idx_recon_bank_status (bank_account_id, status),
  INDEX idx_recon_period (period_start, period_end)
);

CREATE TABLE IF NOT EXISTS bank_recon_import_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  file_name VARCHAR(255),
  file_type VARCHAR(10),
  row_count INT DEFAULT 0,
  column_mapping JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'IMPORTED',
  imported_by INT NULL,
  imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES bank_recon_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_recon_statement_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  session_id INT NOT NULL,
  txn_date DATE NOT NULL,
  description VARCHAR(500),
  reference_no VARCHAR(100),
  check_no VARCHAR(100),
  debit DECIMAL(15,2) NOT NULL DEFAULT 0,
  credit DECIMAL(15,2) NOT NULL DEFAULT 0,
  running_balance DECIMAL(15,2) NULL,
  match_status VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES bank_recon_import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES bank_recon_sessions(id) ON DELETE CASCADE,
  INDEX idx_stmt_session_status (session_id, match_status),
  INDEX idx_stmt_date (txn_date),
  INDEX idx_stmt_ref (reference_no),
  INDEX idx_stmt_check (check_no)
);

CREATE TABLE IF NOT EXISTS bank_recon_matches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  statement_line_id INT NOT NULL,
  book_source_type VARCHAR(20) NOT NULL,
  book_source_id INT NOT NULL,
  book_line_id INT NULL,
  match_type VARCHAR(20) NOT NULL,
  confidence_score DECIMAL(5,2) NULL,
  score_breakdown JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  amount DECIMAL(15,2) NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  matched_by INT NULL,
  matched_at TIMESTAMP NULL,
  unmatched_by INT NULL,
  unmatched_at TIMESTAMP NULL,
  FOREIGN KEY (session_id) REFERENCES bank_recon_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_line_id) REFERENCES bank_recon_statement_lines(id) ON DELETE CASCADE,
  INDEX idx_match_stmt_line (statement_line_id),
  INDEX idx_match_book_source (book_source_type, book_source_id),
  INDEX idx_match_session_status (session_id, status)
);

CREATE TABLE IF NOT EXISTS bank_recon_adjustments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  statement_line_id INT NOT NULL,
  adjustment_type VARCHAR(30) NOT NULL,
  suggested_account_id INT NULL,
  amount DECIMAL(15,2) NOT NULL,
  description VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  jv_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  decided_by INT NULL,
  decided_at TIMESTAMP NULL,
  FOREIGN KEY (session_id) REFERENCES bank_recon_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_line_id) REFERENCES bank_recon_statement_lines(id) ON DELETE CASCADE,
  FOREIGN KEY (suggested_account_id) REFERENCES chart_of_accounts(id),
  FOREIGN KEY (jv_id) REFERENCES jv_headers(id)
);
