-- Checkpoint 6: Petty Cash Voucher + Debit/Credit Memo proper module
-- identity. Fixes the architectural defect where these two transaction
-- types fell through TransactionFormLayout's default API path and were
-- silently persisted as apv_headers/apv_lines rows (see Checkpoint 6
-- investigation report - the fallback lived in the frontend, not here;
-- this migration only adds the tables/permissions that let the backend
-- give them a real, separate identity).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, INSERT IGNORE throughout.
-- Additive only - does not touch apv_headers/apv_lines or any existing
-- table. Historical Petty Cash/Memo rows that were previously saved into
-- apv_headers under the old fallback are NOT migrated here - there is no
-- reliable marker distinguishing them from genuine APVs (see the
-- Checkpoint 6 completion report, "Historical fallback-record handling").

-- ============================================================
-- petty_cash_headers / petty_cash_lines
-- ============================================================
-- Shaped like jv_headers (immediate GL entry, no AP-aging concept - a
-- petty cash voucher is a cash disbursement settled at the moment it's
-- recorded, never "unpaid") plus a payee_id/payee_name pair matching the
-- supplier_id/supplier_name convention used by every other party-bearing
-- module (apv_headers, cv_headers).
CREATE TABLE IF NOT EXISTS petty_cash_headers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  voucher_no VARCHAR(100) NOT NULL,
  payee_id INT NULL,
  payee_name VARCHAR(255) NULL,
  transaction_date DATE NOT NULL,
  reference_no VARCHAR(100) NULL,
  description TEXT NULL,
  remarks TEXT NULL,
  total_debit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  total_credit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  currency_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  posted_by INT NULL,
  posted_at TIMESTAMP NULL,
  UNIQUE KEY uq_petty_cash_voucher_no (voucher_no),
  KEY idx_petty_cash_company_date (company_id, transaction_date),
  CONSTRAINT fk_petty_cash_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_petty_cash_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS petty_cash_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  petty_cash_id INT NOT NULL,
  account_id INT NULL,
  account_code VARCHAR(50) NULL,
  account_title VARCHAR(255) NULL,
  particulars TEXT NULL,
  debit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  credit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  foreign_debit DECIMAL(18,2) NULL,
  foreign_credit DECIMAL(18,2) NULL,
  gen_ref VARCHAR(100) NULL,
  gen_name VARCHAR(255) NULL,
  KEY petty_cash_id (petty_cash_id),
  CONSTRAINT fk_petty_cash_lines_header FOREIGN KEY (petty_cash_id) REFERENCES petty_cash_headers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- memo_headers / memo_lines
-- ============================================================
-- One shared table pair for Debit Memo and Credit Memo (structurally
-- identical, only accounting direction differs) per the approved
-- Checkpoint 6 design decision: memo_type drives document identity,
-- print title, and default line-label suggestions; the actual GL
-- entries stay fully user-driven (debit/credit lines entered directly),
-- consistent with every other module here (JV/APV/CV never auto-post -
-- only OR/CV's settlement wizard does, and that's out of scope for
-- Memo). source_type/source_id is an optional, non-mutating reference
-- to the Invoice/APV a memo relates to - the source document's own
-- balance/rate is never touched.
CREATE TABLE IF NOT EXISTS memo_headers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  voucher_no VARCHAR(100) NOT NULL,
  memo_type ENUM('DEBIT','CREDIT') NOT NULL,
  party_id INT NULL,
  party_name VARCHAR(255) NULL,
  party_type ENUM('CUSTOMER','SUPPLIER') NULL,
  transaction_date DATE NOT NULL,
  reference_no VARCHAR(100) NULL,
  description TEXT NULL,
  remarks TEXT NULL,
  total_debit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  total_credit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(20) NOT NULL DEFAULT 'Draft',
  source_type ENUM('INVOICE','APV') NULL,
  source_id INT NULL,
  currency_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  posted_by INT NULL,
  posted_at TIMESTAMP NULL,
  UNIQUE KEY uq_memo_voucher_no (voucher_no),
  KEY idx_memo_company_date (company_id, transaction_date),
  KEY idx_memo_source (source_type, source_id),
  CONSTRAINT fk_memo_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_memo_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS memo_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  memo_id INT NOT NULL,
  account_id INT NULL,
  account_code VARCHAR(50) NULL,
  account_title VARCHAR(255) NULL,
  particulars TEXT NULL,
  debit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  credit DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  foreign_debit DECIMAL(18,2) NULL,
  foreign_credit DECIMAL(18,2) NULL,
  gen_ref VARCHAR(100) NULL,
  gen_name VARCHAR(255) NULL,
  KEY memo_id (memo_id),
  CONSTRAINT fk_memo_lines_header FOREIGN KEY (memo_id) REFERENCES memo_headers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- Permission catalog completion
-- ============================================================
-- TRANSACTIONS.PETTY_CASH and TRANSACTIONS.DEBIT_CREDIT_MEMO already
-- exist in user_access_control_migration.sql with VIEW/CREATE only
-- (never referenced by any code until this checkpoint). Adding the
-- remaining actions to match APV's action set (VIEW/CREATE/EDIT/DELETE/
-- SUBMIT) plus PRINT (the transaction-printing framework's convention -
-- see transaction_print_permissions_migration.sql).
-- PRINT_WITH_ENTRIES is a separate action from PRINT (matches
-- transaction_print_permissions_migration.sql's convention for every
-- other module: PRINT gates the customer/supplier-facing copy,
-- PRINT_WITH_ENTRIES additionally gates the internal accounting copy
-- that shows account codes/debit/credit). Missing here in the first
-- version of this file, caught by pettyCashAndMemo.http.test.js's print
-- test returning 403 instead of 200.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.PETTY_CASH', 'EDIT', 'Edit Petty Cash Vouchers', NULL),
  ('TRANSACTIONS.PETTY_CASH', 'DELETE', 'Delete Petty Cash Vouchers', NULL),
  ('TRANSACTIONS.PETTY_CASH', 'SUBMIT', 'Post Petty Cash Vouchers', NULL),
  ('TRANSACTIONS.PETTY_CASH', 'PRINT', 'Print Petty Cash Vouchers', NULL),
  ('TRANSACTIONS.PETTY_CASH', 'PRINT_WITH_ENTRIES', 'Print Petty Cash Vouchers with Accounting Entries', NULL),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'EDIT', 'Edit Debit/Credit Memos', NULL),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'DELETE', 'Delete Debit/Credit Memos', NULL),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'SUBMIT', 'Post Debit/Credit Memos', NULL),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'PRINT', 'Print Debit/Credit Memos', NULL),
  ('TRANSACTIONS.DEBIT_CREDIT_MEMO', 'PRINT_WITH_ENTRIES', 'Print Debit/Credit Memos with Accounting Entries', NULL);

-- user_access_control_migration.sql's ADMIN blanket grant (module_key
-- NOT IN a fixed admin-only denylist) and ACCOUNTANT grant already ran
-- once against whatever permissions existed at that time - a permission
-- row added later by this file is never retroactively picked up by
-- those old INSERT..SELECT statements, so the grants are made explicit
-- here instead (same pattern as beginning_balance_delete_permission_migration.sql).
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.PETTY_CASH', 'TRANSACTIONS.DEBIT_CREDIT_MEMO')
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.PETTY_CASH', 'TRANSACTIONS.DEBIT_CREDIT_MEMO')
WHERE r.code = 'ACCOUNTANT';