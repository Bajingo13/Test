-- R10: deposit slips - the bridge between posted OR / CV bank items and the
-- bank statement deposit that carries them.
-- Idempotent (CREATE TABLE IF NOT EXISTS). Safe to re-run. Creates two new
-- tables only - no existing table or row is touched, nothing is backfilled.
--
-- deposit_slips       one physical deposit: one company, one bank account,
--                     one deposit date, a company-unique number (DS-00001),
--                     status DRAFT -> DEPOSITED -> RECONCILED, or CANCELLED.
--                     total_amount is always the sum of its active lines
--                     (computed by the server, never typed).
-- deposit_slip_lines  the OR / CV documents in a slip. Two typed, nullable
--                     foreign keys (or_id / cv_id, exactly one set) instead
--                     of a polymorphic id, so the database enforces that the
--                     document exists and cannot be deleted while listed.
--                     A cancelled slip keeps its lines with released_at set
--                     (history), and the generated active_or_id /
--                     active_cv_id columns are NULL for released lines -
--                     their UNIQUE indexes allow each OR / CV in at most ONE
--                     active (not released) line across all slips.
--
-- Reverse (only while unused): DROP TABLE deposit_slip_lines; DROP TABLE deposit_slips;
--
-- Must run AFTER r9_payment_details_migration.sql (and the baseline
-- companies / bank_codes / or_headers / cv_headers tables).

CREATE TABLE IF NOT EXISTS deposit_slips (
  id INT NOT NULL AUTO_INCREMENT,
  company_id INT NOT NULL,
  bank_account_id INT NOT NULL,
  deposit_no VARCHAR(30) NOT NULL,
  deposit_date DATE NOT NULL,
  currency_id INT NULL,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  remarks VARCHAR(500) NULL,
  reconciled_match_group VARCHAR(40) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deposited_by INT NULL,
  deposited_at DATETIME NULL,
  cancelled_by INT NULL,
  cancelled_at DATETIME NULL,
  cancel_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deposit_slip_company_no (company_id, deposit_no),
  KEY idx_deposit_slip_scope (company_id, bank_account_id, status, deposit_date),
  KEY idx_deposit_slip_match_group (reconciled_match_group),
  CONSTRAINT fk_deposit_slip_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_slip_bank FOREIGN KEY (bank_account_id) REFERENCES bank_codes (id) ON DELETE RESTRICT,
  CONSTRAINT chk_deposit_slip_status CHECK (status IN ('DRAFT', 'DEPOSITED', 'RECONCILED', 'CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS deposit_slip_lines (
  id INT NOT NULL AUTO_INCREMENT,
  deposit_slip_id INT NOT NULL,
  source_type VARCHAR(2) NOT NULL,
  or_id INT NULL,
  cv_id INT NULL,
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL,
  released_at DATETIME NULL,
  active_or_id INT GENERATED ALWAYS AS (IF(released_at IS NULL, or_id, NULL)) STORED,
  active_cv_id INT GENERATED ALWAYS AS (IF(released_at IS NULL, cv_id, NULL)) STORED,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deposit_line_active_or (active_or_id),
  UNIQUE KEY uq_deposit_line_active_cv (active_cv_id),
  KEY idx_deposit_line_slip (deposit_slip_id),
  KEY idx_deposit_line_or (or_id),
  KEY idx_deposit_line_cv (cv_id),
  CONSTRAINT fk_deposit_line_slip FOREIGN KEY (deposit_slip_id) REFERENCES deposit_slips (id) ON DELETE CASCADE,
  CONSTRAINT fk_deposit_line_or FOREIGN KEY (or_id) REFERENCES or_headers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_line_cv FOREIGN KEY (cv_id) REFERENCES cv_headers (id) ON DELETE RESTRICT,
  CONSTRAINT chk_deposit_line_source CHECK (
    (source_type = 'OR' AND or_id IS NOT NULL AND cv_id IS NULL)
    OR (source_type = 'CV' AND cv_id IS NOT NULL AND or_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
