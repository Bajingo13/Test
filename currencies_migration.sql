-- Currency Setup - Phase 1 (foundation only, no BAP/BSP, no transaction
-- integration). Idempotent: CREATE TABLE IF NOT EXISTS for the two new
-- tables (MySQL supports this natively), INSERT IGNORE for permission
-- catalog rows against their existing UNIQUE keys - safe to run any
-- number of times, matches the pattern already used by
-- transaction_print_permissions_migration.sql and
-- beginning_balance_import_migration.sql.
--
-- No existing table is altered. currency_code/currency_name/currency
-- columns already present on arap_beginning_balance_headers,
-- gl_beginning_balance_headers, and recurring_transaction_templates are
-- left untouched - those are free-text, unused for any real conversion
-- today, and wiring them to this table is transaction-integration work
-- for a later phase, not Phase 1.
--
-- FK'd to `companies` (the real multi-company RBAC scaffold from the User
-- Access Control phase), not `company_profile` (a print-letterhead
-- singleton with no multi-tenancy intent) - see the Phase 1 report for
-- why.

CREATE TABLE IF NOT EXISTS currencies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  currency_name VARCHAR(100) NOT NULL,
  currency_symbol VARCHAR(10) NOT NULL,
  iso_numeric_code VARCHAR(3) NULL,
  symbol_position ENUM('BEFORE', 'AFTER') NOT NULL DEFAULT 'BEFORE',
  space_after_symbol TINYINT(1) NOT NULL DEFAULT 0,
  decimal_places TINYINT NOT NULL DEFAULT 2,
  decimal_separator VARCHAR(1) NOT NULL DEFAULT '.',
  thousand_separator VARCHAR(1) NOT NULL DEFAULT ',',
  default_rate_mode ENUM('BASE', 'MANUAL', 'FIXED', 'AUTOMATIC', 'DAILY', 'TRANSACTION_SPECIFIC') NOT NULL DEFAULT 'MANUAL',
  is_base_currency TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  -- Denormalized cache of the latest currency_rates.new_rate, kept in sync
  -- by currencyService whenever a rate is recorded - lets Phase 3 load
  -- "current approved rate" for a transaction with a single row read
  -- instead of a history-table lookup on every keystroke. currency_rates
  -- remains the source of truth; this is a read-optimization only.
  current_rate DECIMAL(20, 10) NULL,
  notes VARCHAR(255) NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- MySQL has no native "partial unique index" - this generated-column
  -- trick enforces "at most one base currency per company" at the DB
  -- layer: the column is NULL for every non-base row (NULLs never
  -- collide in a UNIQUE index), and equals company_id for base rows, so a
  -- second base-currency row for the same company hits the unique key.
  base_currency_flag INT GENERATED ALWAYS AS (IF(is_base_currency = 1, company_id, NULL)) STORED,
  UNIQUE KEY uniq_currency_per_company (company_id, currency_code),
  UNIQUE KEY uniq_base_currency_per_company (base_currency_flag),
  KEY idx_currencies_company (company_id),
  CONSTRAINT fk_currencies_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- Append-only rate history. A "current rate" is never overwritten in
-- place - every manual/fixed rate change inserts a new row here (old_rate
-- + new_rate both captured) and currencies.current_rate is updated to
-- match in the same DB transaction.
CREATE TABLE IF NOT EXISTS currency_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  currency_id INT NOT NULL,
  base_currency_id INT NOT NULL,
  rate_mode ENUM('MANUAL', 'FIXED') NOT NULL,
  old_rate DECIMAL(20, 10) NULL,
  new_rate DECIMAL(20, 10) NOT NULL,
  effective_date DATE NOT NULL,
  reason VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_currency_rates_currency (currency_id, effective_date),
  KEY idx_currency_rates_company (company_id),
  CONSTRAINT fk_currency_rates_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_currency_rates_currency FOREIGN KEY (currency_id) REFERENCES currencies(id),
  CONSTRAINT fk_currency_rates_base_currency FOREIGN KEY (base_currency_id) REFERENCES currencies(id)
);

-- Permission catalog: FILESETUP.CURRENCY_SETUP, mirroring the granularity
-- requested (view/create/edit/activate/deactivate/set_base/manual_rate/
-- fixed_rate/rate_history) using this project's existing (module_key,
-- action) convention.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.CURRENCY_SETUP', 'VIEW', 'View Currency Setup', 'View configured currencies and their rates.'),
  ('FILESETUP.CURRENCY_SETUP', 'CREATE', 'Create Currency', 'Add a new currency to the company.'),
  ('FILESETUP.CURRENCY_SETUP', 'EDIT', 'Edit Currency', 'Edit an existing currency''s configuration.'),
  ('FILESETUP.CURRENCY_SETUP', 'ACTIVATE', 'Activate Currency', 'Reactivate a deactivated currency.'),
  ('FILESETUP.CURRENCY_SETUP', 'DEACTIVATE', 'Deactivate Currency', 'Deactivate a currency (base currency cannot be deactivated).'),
  ('FILESETUP.CURRENCY_SETUP', 'SET_BASE', 'Set Base Currency', 'Change which currency is the company''s base currency.'),
  ('FILESETUP.CURRENCY_SETUP', 'MANUAL_RATE', 'Set Manual Exchange Rate', 'Record a manual exchange rate for a currency.'),
  ('FILESETUP.CURRENCY_SETUP', 'FIXED_RATE', 'Set Fixed Exchange Rate', 'Record a fixed exchange rate for a currency.'),
  ('FILESETUP.CURRENCY_SETUP', 'RATE_HISTORY', 'View Rate History', 'View the exchange rate change history for a currency.');

-- ADMIN: full currency configuration access (company-scoped by the
-- existing user_companies assignment, enforced in currencyService, not by
-- this permission grant).
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP'
WHERE r.code = 'ADMIN';

-- ACCOUNTANT: view + rate history by default only, per spec ("can edit
-- rates only if explicitly permitted") - MANUAL_RATE/FIXED_RATE/etc. are
-- withheld here and can be granted per-user via user_permissions.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.CURRENCY_SETUP' AND p.action IN ('VIEW', 'RATE_HISTORY')
WHERE r.code = 'ACCOUNTANT';

-- Backward-compatibility seed: this app has assumed PHP everywhere (every
-- formatMoney is en-PH, every hardcoded currency default is 'PHP') with
-- no configurable currency at all until this migration. Non-destructive
-- and additive only - for every company that does not yet have a base
-- currency, seed PHP as active + base so the app keeps working exactly
-- as it always has instead of landing on an empty, unusable Currency
-- Setup page. Safe to re-run: a company that already has a base
-- currency (from this seed or a real admin action) is skipped.
INSERT IGNORE INTO currencies (
  company_id, currency_code, currency_name, currency_symbol, iso_numeric_code,
  symbol_position, space_after_symbol, decimal_places, decimal_separator, thousand_separator,
  default_rate_mode, is_base_currency, is_active, current_rate, notes
)
SELECT
  companies.id, 'PHP', 'Philippine Peso', '₱', '608',
  'BEFORE', 0, 2, '.', ',',
  'BASE', 1, 1, 1.0000000000, 'Seeded during Currency Setup Phase 1 migration - this app previously assumed PHP everywhere with no configurable currency.'
FROM companies
WHERE NOT EXISTS (SELECT 1 FROM currencies c WHERE c.company_id = companies.id AND c.is_base_currency = 1);
