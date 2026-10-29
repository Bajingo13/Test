-- R7-1: read-only Bank Codes access for the ACCOUNTANT role. DATA/CONFIG
-- ONLY - no DDL, no schema change. Same INSERT IGNORE role-grant pattern as
-- phase8_or_email_permissions_migration.sql.
--
-- The Official Receipt / Check Voucher forms and the Bank Reconciliation
-- session form load their bank-account selector from GET /api/bank-codes,
-- which requires FILESETUP.BANK_CODES / VIEW. ACCOUNTANT holds TRANSACTIONS.OR,
-- TRANSACTIONS.CV and REPORTS.BANK_RECONCILIATION but was never granted that
-- VIEW (user_access_control_migration.sql's ACCOUNTANT catch-all excludes
-- FILESETUP.% apart from BEGINNING_BALANCES), so the selector came back
-- empty and an Accountant's OR/CV was saved without a bank account - which
-- keeps it out of Bank Reconciliation entirely.
--
-- Grants VIEW only. FILESETUP.BANK_CODES / CONFIGURE (add, edit, delete,
-- sync from the Chart of Accounts) stays ADMIN-only. ADMIN already holds
-- both actions; SUPER_ADMIN bypasses permission checks.
--
-- INSERT IGNORE: an ACCOUNTANT row for this permission that an administrator
-- has already set (granted = 0 or 1) through the role matrix is left exactly
-- as it is. Re-running is a no-op.
--
-- Must run AFTER user_access_control_migration.sql (owns permissions /
-- role_permissions / roles and the FILESETUP.BANK_CODES / VIEW row).

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.BANK_CODES' AND p.action = 'VIEW'
WHERE r.code = 'ACCOUNTANT';
