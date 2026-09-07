-- Recurring Transactions - Phase 1 (Invoice)
-- Additive only: brand-new tables + new permission catalog rows. No
-- existing table is touched. CREATE TABLE IF NOT EXISTS is natively
-- idempotent; INSERT IGNORE against UNIQUE keys makes the seed rows safe
-- to re-run. Safe to run any number of times.

CREATE TABLE IF NOT EXISTS recurring_transaction_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_type VARCHAR(20) NOT NULL,           -- 'invoice' | 'apv' | 'jv' | 'po' | 'or' | 'cv'
  template_name VARCHAR(150) NOT NULL,
  party_id INT NULL,
  party_name VARCHAR(255) NULL,
  description_template VARCHAR(500) NULL,     -- supports {{variables}}
  currency VARCHAR(10) NOT NULL DEFAULT 'PHP',
  amount_mode VARCHAR(30) NOT NULL DEFAULT 'FIXED',  -- FIXED | COPY_LAST | MANUAL_REVIEW | PERCENTAGE_ADJUSTMENT | ESCALATION
  amount_config JSON NULL,                    -- mode-specific params (percent, effective dates, etc.)
  due_date_rule JSON NULL,                    -- { mode, days/weeks/months }
  company_id INT NULL,                        -- nullable, NOT enforced yet - see migration header note
  branch_id INT NULL,                         -- nullable, NOT enforced yet - see migration header note
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PAUSED | COMPLETED | STOPPED
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rtt_module_type (module_type),
  INDEX idx_rtt_status (status)
);

CREATE TABLE IF NOT EXISTS recurring_transaction_template_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  account_id INT NULL,
  account_code VARCHAR(30) NULL,
  account_title VARCHAR(255) NULL,
  particulars_template VARCHAR(500) NULL,     -- supports {{variables}}
  debit DECIMAL(18,2) NOT NULL DEFAULT 0,
  credit DECIMAL(18,2) NOT NULL DEFAULT 0,
  gen_ref VARCHAR(100) NULL,
  gen_name VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  FOREIGN KEY (template_id) REFERENCES recurring_transaction_templates(id) ON DELETE CASCADE,
  INDEX idx_rttl_template (template_id)
);

CREATE TABLE IF NOT EXISTS recurring_transaction_schedules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  frequency VARCHAR(30) NOT NULL,             -- DAILY | WEEKLY | BIWEEKLY | MONTHLY | BIMONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL | CUSTOM
  interval_value INT NOT NULL DEFAULT 1,      -- used by CUSTOM (every N days/weeks/months/years) and biweekly/bimonthly
  custom_unit VARCHAR(10) NULL,               -- DAYS | WEEKS | MONTHS | YEARS - only for CUSTOM
  weekday TINYINT NULL,                       -- 0=Sunday..6=Saturday, for WEEKLY
  month_day TINYINT NULL,                     -- 1-31, for MONTHLY "same calendar day"
  month_rule JSON NULL,                       -- { type: 'SAME_DAY'|'LAST_DAY'|'FIRST_BUSINESS_DAY'|'LAST_BUSINESS_DAY'|'SPECIFIC_WEEKDAY', ... }
  start_date DATE NOT NULL,
  end_date DATE NULL,
  max_occurrences INT NULL,
  generated_count INT NOT NULL DEFAULT 0,
  last_run_date DATE NULL,
  next_run_date DATE NOT NULL,
  timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Manila',
  date_adjustment_rule VARCHAR(30) NOT NULL DEFAULT 'KEEP_ORIGINAL', -- KEEP_ORIGINAL | NEXT_BUSINESS_DAY | PREVIOUS_BUSINESS_DAY | LAST_VALID_DAY | SKIP
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_paused TINYINT(1) NOT NULL DEFAULT 0,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES recurring_transaction_templates(id) ON DELETE CASCADE,
  INDEX idx_rts_next_run_date (next_run_date),
  INDEX idx_rts_active_paused (is_active, is_paused)
);

CREATE TABLE IF NOT EXISTS recurring_transaction_occurrences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  schedule_id INT NOT NULL,
  occurrence_date DATE NOT NULL,
  generated_module_type VARCHAR(20) NOT NULL,
  generated_transaction_id INT NULL,
  trigger_type VARCHAR(10) NOT NULL,          -- SCHEDULED | MANUAL
  status VARCHAR(10) NOT NULL,                -- SUCCESS | FAILED | SKIPPED
  error_message VARCHAR(500) NULL,
  reason VARCHAR(500) NULL,                   -- used for SKIPPED
  generated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (schedule_id) REFERENCES recurring_transaction_schedules(id) ON DELETE CASCADE,
  UNIQUE KEY uq_rto_schedule_date (schedule_id, occurrence_date),
  INDEX idx_rto_status (status)
);

-- Created now with the right shape; populated starting Phase 2 when
-- template editing ships (nothing writes to this yet in Phase 1).
CREATE TABLE IF NOT EXISTS recurring_transaction_template_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  version_snapshot JSON NOT NULL,
  changed_by INT NULL,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES recurring_transaction_templates(id) ON DELETE CASCADE,
  INDEX idx_rtv_template (template_id)
);

-- Atomic per-(module_type, period) voucher-number counter, scoped only to
-- recurring-generated transactions - manual entry's free-text voucher_no
-- is completely untouched by this table.
CREATE TABLE IF NOT EXISTS recurring_number_counters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_type VARCHAR(20) NOT NULL,
  period_key VARCHAR(20) NOT NULL,            -- e.g. '202608'
  last_number INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rnc_module_period (module_type, period_key)
);

-- Permission catalog: same (module_key, action) convention as every
-- existing migration.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('RECURRING.TRANSACTIONS', 'VIEW', 'View Recurring Transactions', 'View recurring transaction templates and schedules.'),
  ('RECURRING.TRANSACTIONS', 'CREATE', 'Create Recurring Templates', 'Create new recurring transaction templates and schedules.'),
  ('RECURRING.TRANSACTIONS', 'EDIT', 'Edit Recurring Templates', 'Edit recurring transaction templates and schedules.'),
  ('RECURRING.TRANSACTIONS', 'PAUSE', 'Pause Recurring Schedules', 'Pause an active recurring schedule.'),
  ('RECURRING.TRANSACTIONS', 'RESUME', 'Resume Recurring Schedules', 'Resume a paused recurring schedule.'),
  ('RECURRING.TRANSACTIONS', 'GENERATE', 'Generate Recurring Transactions', 'Manually trigger generation of the next occurrence (Generate Now).'),
  ('RECURRING.TRANSACTIONS', 'SKIP', 'Skip Recurring Occurrences', 'Skip a single scheduled occurrence.'),
  ('RECURRING.TRANSACTIONS', 'STOP', 'Stop Recurring Schedules', 'Permanently stop a recurring schedule.'),
  ('RECURRING.TRANSACTIONS', 'VIEW_HISTORY', 'View Recurring History', 'View the generation/occurrence history of a recurring schedule.'),
  ('RECURRING.TRANSACTIONS', 'MANAGE_ALL', 'Manage All Recurring Schedules', 'Act on recurring schedules created by other users (company/branch-scoped restriction is not enforceable yet - see plan).');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'RECURRING.TRANSACTIONS'
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'RECURRING.TRANSACTIONS'
  AND p.action IN ('VIEW', 'CREATE', 'EDIT', 'PAUSE', 'RESUME', 'GENERATE', 'SKIP', 'STOP', 'VIEW_HISTORY')
WHERE r.code = 'ACCOUNTANT';
