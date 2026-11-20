-- Multi-Branch Foundation, Phase A (data model only - no UI, no transaction-entry change).
--
-- 1. Transaction headers + beginning-balance headers get a nullable branch_id
--    (BRANCH-SPECIFIC): APV, Invoice, CV, OR, JV, Debit/Credit Memo, Petty Cash,
--    PO, Quotation, AR/AP beginning balances, GL beginning balances. (rfp_headers
--    and recurring_transaction_templates already carry branch_id.) Lines, tax
--    entries, currency snapshots and transaction_applications inherit the branch
--    of their header - no column of their own.
-- 2. chart_of_accounts / general_libraries get a nullable branch_id meaning
--    "branch-only record"; NULL = shared (COA: system-wide as today; General
--    Libraries: company-wide as today). No existing setup row is changed.
-- 3. Historical backfill - ONLY for a company that has exactly one branch: its
--    rows get that branch. A company with two or more branches is NOT guessed:
--    its rows stay NULL (see scripts/multiBranchUnresolvedAudit.sql). Only
--    branch_id is written; amounts, status, dates, lines and journals are not
--    touched, and updated_at is preserved (SET updated_at = updated_at).
-- 4. FK branch_id -> branches(id) ON DELETE RESTRICT, added only when every
--    existing value is valid. A branch that owns accounting data cannot be
--    deleted (branches are retired by deactivation).
-- 5. REPORTS.ALL_BRANCHES / VIEW - consolidated ("All Branches") reporting.
--    ADMIN granted; ACCOUNTANT explicitly 0. SUPER_ADMIN bypasses.
--
-- Idempotent (information_schema guards, WHERE branch_id IS NULL, INSERT IGNORE).
-- Safe to run twice. Must run AFTER branch_management_migration.sql.

-- apv_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND INDEX_NAME = 'idx_apv_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD INDEX idx_apv_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- invoice_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND INDEX_NAME = 'idx_inv_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD INDEX idx_inv_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- cv_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND INDEX_NAME = 'idx_cv_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD INDEX idx_cv_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- or_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND INDEX_NAME = 'idx_or_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD INDEX idx_or_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- jv_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE jv_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND INDEX_NAME = 'idx_jv_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE jv_headers ADD INDEX idx_jv_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- memo_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE memo_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND INDEX_NAME = 'idx_memo_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE memo_headers ADD INDEX idx_memo_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- petty_cash_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE petty_cash_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND INDEX_NAME = 'idx_pcv_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE petty_cash_headers ADD INDEX idx_pcv_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- purchase_order_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND INDEX_NAME = 'idx_po_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD INDEX idx_po_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- quotation_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE quotation_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND INDEX_NAME = 'idx_quo_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE quotation_headers ADD INDEX idx_quo_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- arap_beginning_balance_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE arap_beginning_balance_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND INDEX_NAME = 'idx_arapbb_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE arap_beginning_balance_headers ADD INDEX idx_arapbb_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- gl_beginning_balance_headers
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE gl_beginning_balance_headers ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND INDEX_NAME = 'idx_glbb_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE gl_beginning_balance_headers ADD INDEX idx_glbb_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- chart_of_accounts
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE chart_of_accounts ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND INDEX_NAME = 'idx_coa_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE chart_of_accounts ADD INDEX idx_coa_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- general_libraries
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'branch_id');
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD COLUMN branch_id INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND INDEX_NAME = 'idx_genlib_branch');
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD INDEX idx_genlib_branch (branch_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Historical backfill: single-branch companies only (multi-branch stays NULL).
UPDATE apv_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE invoice_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE cv_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE or_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE jv_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id
 WHERE x.branch_id IS NULL;
UPDATE memo_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE petty_cash_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE purchase_order_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE quotation_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE arap_beginning_balance_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;
UPDATE gl_beginning_balance_headers x
  JOIN (SELECT company_id, MIN(id) AS branch_id FROM branches GROUP BY company_id HAVING COUNT(*) = 1) one
    ON one.company_id = x.company_id
   SET x.branch_id = one.branch_id, x.updated_at = x.updated_at
 WHERE x.branch_id IS NULL;

SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND CONSTRAINT_NAME = 'fk_apv_branch')
       + (SELECT COUNT(*) FROM apv_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD CONSTRAINT fk_apv_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND CONSTRAINT_NAME = 'fk_inv_branch')
       + (SELECT COUNT(*) FROM invoice_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD CONSTRAINT fk_inv_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND CONSTRAINT_NAME = 'fk_cv_branch')
       + (SELECT COUNT(*) FROM cv_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD CONSTRAINT fk_cv_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND CONSTRAINT_NAME = 'fk_or_branch')
       + (SELECT COUNT(*) FROM or_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD CONSTRAINT fk_or_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND CONSTRAINT_NAME = 'fk_jv_branch')
       + (SELECT COUNT(*) FROM jv_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE jv_headers ADD CONSTRAINT fk_jv_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND CONSTRAINT_NAME = 'fk_memo_branch')
       + (SELECT COUNT(*) FROM memo_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE memo_headers ADD CONSTRAINT fk_memo_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND CONSTRAINT_NAME = 'fk_pcv_branch')
       + (SELECT COUNT(*) FROM petty_cash_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE petty_cash_headers ADD CONSTRAINT fk_pcv_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND CONSTRAINT_NAME = 'fk_po_branch')
       + (SELECT COUNT(*) FROM purchase_order_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD CONSTRAINT fk_po_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quotation_headers' AND CONSTRAINT_NAME = 'fk_quo_branch')
       + (SELECT COUNT(*) FROM quotation_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE quotation_headers ADD CONSTRAINT fk_quo_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'arap_beginning_balance_headers' AND CONSTRAINT_NAME = 'fk_arapbb_branch')
       + (SELECT COUNT(*) FROM arap_beginning_balance_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE arap_beginning_balance_headers ADD CONSTRAINT fk_arapbb_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gl_beginning_balance_headers' AND CONSTRAINT_NAME = 'fk_glbb_branch')
       + (SELECT COUNT(*) FROM gl_beginning_balance_headers x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE gl_beginning_balance_headers ADD CONSTRAINT fk_glbb_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND CONSTRAINT_NAME = 'fk_coa_branch')
       + (SELECT COUNT(*) FROM chart_of_accounts x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE chart_of_accounts ADD CONSTRAINT fk_coa_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND CONSTRAINT_NAME = 'fk_genlib_branch')
       + (SELECT COUNT(*) FROM general_libraries x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.branch_id IS NOT NULL AND b.id IS NULL);
SET @sql = IF(@c = 0, 'ALTER TABLE general_libraries ADD CONSTRAINT fk_genlib_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Consolidated reporting permission.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('REPORTS.ALL_BRANCHES', 'VIEW', 'Consolidated (All Branches) Reports', 'Request one combined report over every branch the user is authorized for.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1 FROM roles r JOIN permissions p ON p.module_key = 'REPORTS.ALL_BRANCHES' AND p.action = 'VIEW'
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 0 FROM roles r JOIN permissions p ON p.module_key = 'REPORTS.ALL_BRANCHES' AND p.action = 'VIEW'
WHERE r.code = 'ACCOUNTANT';
