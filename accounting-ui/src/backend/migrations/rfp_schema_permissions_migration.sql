-- RFP (Request for Payment) R1: schema + permission foundation only.
-- Idempotent: CREATE TABLE IF NOT EXISTS for the new tables, INSERT IGNORE
-- for the permission catalog / grants - same pattern as every prior
-- migration. Safe to re-run.
--
-- An RFP is a pre-accounting request to pay a supplier. It never posts to
-- the ledger: no AP balance, aging or cash movement comes from it. An
-- APPROVED RFP will later be converted into a NEW Draft APV (R5); until
-- then converted_apv_id stays NULL. Payment status is never stored here -
-- it is read from the linked APV - so there is no PAID / CLOSED status.
--
-- Status values (VARCHAR, validated by the service layer - same as every
-- other status column in this schema, which uses no CHECK constraints):
--   DRAFT, SUBMITTED, APPROVED, CONVERTED, RETURNED, REJECTED, CANCELLED
--
-- Company ownership is explicit: company_id NOT NULL, FK RESTRICT. Which
-- company a new RFP belongs to is decided by the future service layer
-- (strict selection, never a fallback company) - not by this migration.
--
-- Supplier / account / user columns follow the apv_headers / apv_lines /
-- accounting_period_history conventions: supplier_id is a
-- general_libraries.id (the value /api/genlib returns and apv_headers.
-- supplier_id stores), account_id a chart_of_accounts.id, both plain
-- indexed INTs with no FK, exactly like the APV tables the RFP converts
-- into. Name/TIN are snapshotted on the header.
--
-- Rollback (if ever needed): DROP TABLE rfp_status_history, rfp_lines,
-- rfp_headers (in that order), then DELETE the TRANSACTIONS.RFP rows from
-- permissions (role_permissions / user_permissions cascade).

CREATE TABLE IF NOT EXISTS rfp_headers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  branch_id INT NULL,
  rfp_no VARCHAR(50) NOT NULL,
  rfp_date DATE NOT NULL,
  requester_user_id INT NOT NULL,
  supplier_id INT NULL,
  supplier_name VARCHAR(255) NULL,
  supplier_tin VARCHAR(50) NULL,
  purpose TEXT NULL,
  requested_payment_date DATE NULL,
  currency_id INT NULL,
  total_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  remarks TEXT NULL,
  supporting_reference VARCHAR(100) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  submitted_by INT NULL,
  submitted_at DATETIME NULL,
  decided_by INT NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(500) NULL,
  -- One APV per RFP, and one RFP per APV: UNIQUE allows any number of
  -- NULLs (unconverted RFPs) but never two RFPs pointing at the same APV.
  -- No FK yet - what happens to the link when a Draft APV is deleted is
  -- decided with the conversion phase (R5).
  converted_apv_id INT NULL,
  converted_by INT NULL,
  converted_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rfp_company_no (company_id, rfp_no),
  UNIQUE KEY uq_rfp_converted_apv (converted_apv_id),
  INDEX idx_rfp_company_date (company_id, rfp_date),
  INDEX idx_rfp_company_status (company_id, status),
  INDEX idx_rfp_supplier (supplier_id),
  INDEX idx_rfp_requester (requester_user_id),
  CONSTRAINT fk_rfp_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfp_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfp_requester FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfp_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Request lines. Company is derived through rfp_id (not duplicated onto
-- child rows). vat_treatment uses the existing STANDARD / ZERO_RATED /
-- EXEMPT values (vatCalculationService.VAT_TREATMENTS); it is a hint for
-- the APV - authoritative VAT/EWT is computed on the APV, never here.
CREATE TABLE IF NOT EXISTS rfp_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfp_id INT NOT NULL,
  description VARCHAR(255) NULL,
  account_id INT NULL,
  gross_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  vat_treatment VARCHAR(20) NULL,
  reference VARCHAR(100) NULL,
  INDEX idx_rfp_lines_rfp (rfp_id),
  CONSTRAINT fk_rfp_lines_rfp FOREIGN KEY (rfp_id) REFERENCES rfp_headers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only workflow trail (same shape as accounting_period_history).
-- RESTRICT: an RFP with workflow history can never be hard-deleted - it
-- can only be cancelled.
CREATE TABLE IF NOT EXISTS rfp_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfp_id INT NOT NULL,
  previous_status VARCHAR(20) NULL,
  new_status VARCHAR(20) NOT NULL,
  action VARCHAR(30) NOT NULL,
  user_id INT NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rfp_history_rfp (rfp_id, created_at),
  CONSTRAINT fk_rfp_history_rfp FOREIGN KEY (rfp_id) REFERENCES rfp_headers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Permission catalog: same (module_key, action) convention as every
-- existing migration. Super Admin is not granted anything - PermissionService
-- bypasses the catalog for SUPER_ADMIN.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.RFP', 'VIEW', 'View Requests for Payment', 'View Request for Payment (RFP) records.'),
  ('TRANSACTIONS.RFP', 'CREATE', 'Create Requests for Payment', 'Create draft Requests for Payment.'),
  ('TRANSACTIONS.RFP', 'EDIT', 'Edit draft Requests for Payment', 'Edit Requests for Payment while Draft or Returned.'),
  ('TRANSACTIONS.RFP', 'DELETE', 'Delete Requests for Payment', 'Delete draft Requests for Payment that were never submitted.'),
  ('TRANSACTIONS.RFP', 'SUBMIT', 'Submit Requests for Payment', 'Submit Requests for Payment for approval.'),
  ('TRANSACTIONS.RFP', 'APPROVE', 'Approve Requests for Payment', 'Approve, return or reject submitted Requests for Payment.'),
  ('TRANSACTIONS.RFP', 'CONVERT', 'Convert Requests for Payment to APV', 'Create a Draft AP Voucher from an approved Request for Payment.'),
  ('TRANSACTIONS.RFP', 'PRINT', 'Print Requests for Payment', 'Print Request for Payment forms.');

-- Default grants. A later-added module_key needs its own explicit grant
-- (the catch-alls in user_access_control_migration.sql only covered rows
-- that existed when it first ran). ADMIN gets all eight.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.RFP'
  AND p.action IN ('VIEW', 'CREATE', 'EDIT', 'DELETE', 'SUBMIT', 'APPROVE', 'CONVERT', 'PRINT')
WHERE r.code = 'ADMIN';

-- ACCOUNTANT: everything except APPROVE.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.RFP'
  AND p.action IN ('VIEW', 'CREATE', 'EDIT', 'DELETE', 'SUBMIT', 'CONVERT', 'PRINT')
WHERE r.code = 'ACCOUNTANT';

-- ACCOUNTANT APPROVE is stored as an explicit granted = 0 row rather than
-- left absent. user_access_control_migration.sql grants ACCOUNTANT every
-- `TRANSACTIONS.%` permission with INSERT IGNORE; the local migrate.js
-- runner re-runs the whole chain, and with no row here that catch-all
-- would hand ACCOUNTANT TRANSACTIONS.RFP.APPROVE. With the row present its
-- INSERT IGNORE is a no-op. INSERT IGNORE here likewise only establishes
-- the default when no row exists: an administrator's later decision
-- (granted 0 or 1, set through the role matrix) is never changed by a
-- re-run.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 0
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.RFP' AND p.action = 'APPROVE'
WHERE r.code = 'ACCOUNTANT';
