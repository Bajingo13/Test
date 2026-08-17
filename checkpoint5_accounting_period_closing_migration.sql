-- Checkpoint 5: Accounting Period Closing & Transaction Locking.
-- Idempotent (information_schema / CREATE TABLE IF NOT EXISTS guards, same
-- pattern as every prior migration in this project). Additive only - does
-- not touch any table created by 4H/4I migrations.
--
-- No prior Transaction Locking tables exist to migrate/preserve (verified
-- live via SHOW TABLES before writing this file - see the Checkpoint 5
-- completion report, section "Existing lock data preservation").

-- ============================================================
-- accounting_periods
-- ============================================================
CREATE TABLE IF NOT EXISTS accounting_periods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  year INT NOT NULL,
  period_month TINYINT NOT NULL,           -- 1-12
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('OPEN','SOFT_CLOSED','CLOSED') NOT NULL DEFAULT 'OPEN',
  soft_closed_by INT NULL,
  soft_closed_at TIMESTAMP NULL,
  soft_close_notes VARCHAR(500) NULL,
  closed_by INT NULL,
  closed_at TIMESTAMP NULL,
  close_notes VARCHAR(500) NULL,
  reopened_by INT NULL,
  reopened_at TIMESTAMP NULL,
  reopen_reason VARCHAR(500) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_period_company_year_month (company_id, year, period_month),
  CONSTRAINT fk_period_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  INDEX idx_period_company_dates (company_id, start_date, end_date),
  INDEX idx_period_company_status (company_id, status)
);

-- ============================================================
-- accounting_period_history - append-only, never updated/deleted
-- ============================================================
CREATE TABLE IF NOT EXISTS accounting_period_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_id INT NOT NULL,
  company_id INT NOT NULL,
  action ENUM('GENERATED','SOFT_CLOSED','CLOSED','REOPENED') NOT NULL,
  previous_status VARCHAR(20) NULL,
  new_status VARCHAR(20) NOT NULL,
  user_id INT NULL,
  username VARCHAR(100) NULL,
  reason VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_period_history_period FOREIGN KEY (period_id) REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  CONSTRAINT fk_period_history_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  INDEX idx_period_history_period (period_id),
  INDEX idx_period_history_company (company_id)
);

-- ============================================================
-- Permission catalog: same (module_key, action) convention as every
-- existing migration (see recurring_transactions_migration.sql).
-- ============================================================
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('ACCOUNTING_PERIODS', 'VIEW', 'View Accounting Periods', 'View the accounting period list and lock history.'),
  ('ACCOUNTING_PERIODS', 'GENERATE', 'Generate Accounting Periods', 'Generate a full year of monthly accounting periods for a company.'),
  ('ACCOUNTING_PERIODS', 'SOFT_CLOSE', 'Soft Close Period', 'Soft-close an accounting period. Blocks normal users, authorized users may still post approved adjustments.'),
  ('ACCOUNTING_PERIODS', 'CLOSE', 'Close Period', 'Hard-close an accounting period. No mutation is possible until explicitly reopened.'),
  ('ACCOUNTING_PERIODS', 'REOPEN', 'Reopen Period', 'Reopen a soft-closed or closed accounting period. Requires a reason.'),
  ('ACCOUNTING_PERIODS', 'POST_SOFT_CLOSED', 'Post Into Soft-Closed Period', 'Create/edit/post accounting transactions dated into a SOFT_CLOSED period (approved month-end adjustments).');

-- ADMIN gets full period management by default (same pattern used for
-- every other module in this project - see recurring_transactions_migration.sql).
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'ACCOUNTING_PERIODS'
WHERE r.code = 'ADMIN';

-- ACCOUNTANT can view periods and post approved soft-close adjustments,
-- but cannot close/reopen/generate - that stays an Admin/Super Admin
-- decision, consistent with section 29's "only authorized accounting/
-- admin roles" and the spec's explicit Accountant/Admin soft-close split.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'ACCOUNTING_PERIODS'
  AND p.action IN ('VIEW', 'POST_SOFT_CLOSED')
WHERE r.code = 'ACCOUNTANT';

-- ============================================================
-- Verification (informational only, safe to run standalone)
-- ============================================================
-- SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
--   AND TABLE_NAME IN ('accounting_periods','accounting_period_history');
-- -- expect 2
--
-- SELECT COUNT(*) FROM permissions WHERE module_key = 'ACCOUNTING_PERIODS';
-- -- expect 6