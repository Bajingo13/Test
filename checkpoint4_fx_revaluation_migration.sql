-- Checkpoint 4: Unrealized FX Gain/Loss / Month-End Revaluation.
-- Idempotent: information_schema guards for ALTER TABLE ADD COLUMN,
-- CREATE TABLE IF NOT EXISTS for new tables, INSERT IGNORE for the
-- permission catalog - same pattern as every prior migration.
--
-- Two new tables mirror the session/item pattern already proven by the
-- recurring-transactions framework (schedule+occurrences):
--   fx_revaluation_sessions - one row per (company, revaluation_date) run.
--   fx_revaluation_items    - one row per open foreign document included
--                             in that run, preserved forever once POSTED
--                             (never recomputed when viewing history - the
--                             stored row IS the historical record).
--
-- Does NOT touch transaction_currency_snapshots, invoice_headers,
-- apv_headers, or arap_beginning_balance_lines - the original documents'
-- historical rate/foreign balance are never modified by revaluation
-- (section 5/31/32 of the spec). The GL impact is entirely a JV posted
-- through the existing jv_headers/jv_lines tables (source_module =
-- 'FX_REVALUATION', already-existing discriminator columns).

CREATE TABLE IF NOT EXISTS fx_revaluation_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NULL,
  revaluation_date DATE NOT NULL,
  base_currency_id INT NOT NULL,
  base_currency_code VARCHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  -- CARRY_FORWARD_REVALUATION (default, implemented): each new revaluation
  -- posts only the INCREMENTAL movement since the last POSTED, unreversed
  -- revaluation for each item (or since the original historical rate, if
  -- none) - see fxRevaluationService.js's getCarryingBasis(). This is the
  -- standard treatment (PFRS/IFRS retranslation model): the revalued
  -- amount becomes the new carrying basis for the next period.
  -- AUTO_REVERSE_NEXT_PERIOD (documented, not auto-triggered): the manual
  -- "Reverse Session" action can implement this model per company choice,
  -- but nothing in this checkpoint auto-fires a reversal on period
  -- rollover - the reasoning is documented in the completion report.
  reversal_policy VARCHAR(30) NOT NULL DEFAULT 'CARRY_FORWARD_REVALUATION',
  item_count INT NOT NULL DEFAULT 0,
  items_requiring_rate INT NOT NULL DEFAULT 0,
  total_gain DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_loss DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_effect DECIMAL(18,2) NOT NULL DEFAULT 0,
  jv_id INT NULL,
  reversal_jv_id INT NULL,
  reversed_date DATE NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  posted_by INT NULL,
  posted_at DATETIME NULL,
  reversed_by INT NULL,
  reversed_at DATETIME NULL,
  -- The core duplicate-prevention guarantee (section 26): one company can
  -- never have two sessions for the same revaluation_date. A CANCELLED
  -- session still occupies this slot on purpose - retrying after
  -- cancellation reuses/updates the same row rather than inserting a
  -- second one for that date (see fxRevaluationService.calculate()).
  UNIQUE KEY uniq_fxreval_company_date (company_id, revaluation_date),
  CONSTRAINT fk_fxreval_base_currency FOREIGN KEY (base_currency_id) REFERENCES currencies(id),
  CONSTRAINT fk_fxreval_jv FOREIGN KEY (jv_id) REFERENCES jv_headers(id),
  CONSTRAINT fk_fxreval_reversal_jv FOREIGN KEY (reversal_jv_id) REFERENCES jv_headers(id)
);

CREATE TABLE IF NOT EXISTS fx_revaluation_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  source_type VARCHAR(20) NOT NULL,
  source_id INT NOT NULL,
  ar_ap_type VARCHAR(2) NOT NULL,
  document_number VARCHAR(100) NULL,
  party_name VARCHAR(255) NULL,
  currency_id INT NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  foreign_balance DECIMAL(18,2) NOT NULL,
  historical_rate DECIMAL(20,10) NOT NULL,
  carrying_rate DECIMAL(20,10) NOT NULL,
  carrying_base_amount DECIMAL(18,2) NOT NULL,
  closing_rate DECIMAL(20,10) NULL,
  rate_effective_date DATE NULL,
  rate_source VARCHAR(20) NULL,
  closing_base_amount DECIMAL(18,2) NULL,
  unrealized_difference DECIMAL(18,2) NULL,
  direction VARCHAR(20) NULL,
  ar_ap_account_id INT NULL,
  fx_account_id INT NULL,
  -- CALCULATED (has a closing rate, ready to post) | RATE_REQUIRED (no
  -- approved closing rate found for this currency/date) | POSTED.
  status VARCHAR(20) NOT NULL DEFAULT 'CALCULATED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- One item per source document per session - recalculating a DRAFT
  -- session replaces (not duplicates) each item's row.
  UNIQUE KEY uniq_fxreval_item_session_source (session_id, source_type, source_id),
  -- The lookup index getCarryingBasis()/settlement-time realized-FX both
  -- depend on: "find the most recent POSTED revaluation for THIS source
  -- document" (see paymentApplicationService.js's carrying-basis check).
  KEY idx_fxreval_item_source (source_type, source_id),
  CONSTRAINT fk_fxreval_item_session FOREIGN KEY (session_id) REFERENCES fx_revaluation_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_fxreval_item_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)
);

-- Separate, explicitly-configurable Unrealized FX accounts - never
-- silently reuses the Realized FX Gain/Loss accounts already configured
-- in company_fx_accounts (section 14).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_fx_accounts' AND COLUMN_NAME = 'unrealized_fx_gain_account_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE company_fx_accounts ADD COLUMN unrealized_fx_gain_account_id INT NULL, ADD CONSTRAINT fk_unrealized_fx_gain_account FOREIGN KEY (unrealized_fx_gain_account_id) REFERENCES chart_of_accounts(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company_fx_accounts' AND COLUMN_NAME = 'unrealized_fx_loss_account_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE company_fx_accounts ADD COLUMN unrealized_fx_loss_account_id INT NULL, ADD CONSTRAINT fk_unrealized_fx_loss_account FOREIGN KEY (unrealized_fx_loss_account_id) REFERENCES chart_of_accounts(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Permission catalog: RECURRING.TRANSACTIONS-style 4-action set, granted
-- to ADMIN and ACCOUNTANT (same roles Realized FX / Recurring already grant to).
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FX_REVALUATION', 'VIEW', 'View FX Revaluation', 'View month-end unrealized FX revaluation sessions and history.'),
  ('FX_REVALUATION', 'CALCULATE', 'Calculate FX Revaluation', 'Run a month-end unrealized FX revaluation preview without posting.'),
  ('FX_REVALUATION', 'POST', 'Post FX Revaluation', 'Post a calculated month-end unrealized FX revaluation to the General Ledger.'),
  ('FX_REVALUATION', 'REVERSE', 'Reverse FX Revaluation', 'Reverse a posted month-end unrealized FX revaluation.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FX_REVALUATION'
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');