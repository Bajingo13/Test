-- Accountant RBAC corrections from the File Setup audit (R1-R4). DATA ONLY -
-- no DDL, no schema change, no permission-catalog change. Touches the
-- ACCOUNTANT role only; ADMIN and SUPER_ADMIN are unchanged.
--
-- R1-R3: read-only File Setup lookups. Every transaction form loads its
-- account, customer/supplier and tax-code pickers from GET /api/coa,
-- GET /api/genlib, GET /api/ewt-library and GET /api/vat-rate-codes, which
-- require FILESETUP.COA / FILESETUP.GENLIB / FILESETUP.TAX_SETUP VIEW.
-- user_access_control_migration.sql's ACCOUNTANT catch-all excludes
-- FILESETUP.% (apart from BEGINNING_BALANCES), so those pickers returned 403
-- and an Accountant could not complete a transaction form. Same gap and same
-- fix as r7_accountant_bank_codes_view_migration.sql (Bank Codes VIEW).
-- VIEW only: CREATE / EDIT / DELETE (COA, General Libraries) and CONFIGURE
-- (Tax Setup) stay ADMIN-only. General Libraries CREATE / EDIT (party
-- quick-add from a transaction form) is a separate, undecided business
-- decision and is NOT granted here.
--
-- INSERT IGNORE: an ACCOUNTANT row that an administrator has already set
-- (granted 0 or 1) through the role matrix is left exactly as it is.
-- Re-running is a no-op.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p
  ON (p.module_key = 'FILESETUP.COA' AND p.action = 'VIEW')
  OR (p.module_key = 'FILESETUP.GENLIB' AND p.action = 'VIEW')
  OR (p.module_key = 'FILESETUP.TAX_SETUP' AND p.action = 'VIEW')
WHERE r.code = 'ACCOUNTANT';

-- R4: maker-checker for bank reconciliation adjustments. ACCOUNTANT received
-- REPORTS.BANK_RECONCILIATION / APPROVE through the REPORTS.% catch-all, so an
-- Accountant could approve and post their own adjustments. Approval is a
-- reviewer (ADMIN) step, like TRANSACTIONS.RFP / APPROVE
-- (rfp_schema_permissions_migration.sql stores ACCOUNTANT's row as granted = 0).
-- Every other bank-reconciliation action (VIEW / CREATE / EDIT / ...) is
-- unchanged.
--
-- The row already exists (granted = 1) wherever the catch-all ran, so this
-- is an UPDATE of exactly that one ACCOUNTANT row; the INSERT IGNORE covers a
-- database where no row exists yet, so a later re-run of the catch-all's
-- INSERT IGNORE cannot hand the permission back. On the deploy runner
-- (schema_migrations ledger) this file runs once, so an administrator's later
-- decision through the role matrix is not overridden.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 0
FROM roles r
JOIN permissions p ON p.module_key = 'REPORTS.BANK_RECONCILIATION' AND p.action = 'APPROVE'
WHERE r.code = 'ACCOUNTANT';

UPDATE role_permissions rp
JOIN roles r ON r.id = rp.role_id
JOIN permissions p ON p.id = rp.permission_id
SET rp.granted = 0
WHERE r.code = 'ACCOUNTANT'
  AND p.module_key = 'REPORTS.BANK_RECONCILIATION'
  AND p.action = 'APPROVE';
