-- Transaction Printing Options - Phase 1 (Invoice)
-- Additive only: new permission catalog rows + role defaults. No existing
-- table's columns are removed or renamed. INSERT IGNORE against the
-- existing UNIQUE keys makes this safe to re-run any number of times.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.INVOICE', 'PRINT', 'Print Invoice (customer-facing)', 'Print/preview/export the customer-facing Invoice document and summary lists - no accounting entries.'),
  ('TRANSACTIONS.INVOICE', 'PRINT_WITH_ENTRIES', 'Print Invoice with Accounting Entries', 'Print/preview/export the internal Invoice copy including the accounting entries (account code, debit, credit).');

-- ADMIN already gets nearly every module via the catch-all seeded in
-- user_access_control_migration.sql, but that seed only ran against the
-- permission rows that existed at the time - it does not retroactively
-- cover rows inserted by this later migration, so grant explicitly here.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.INVOICE' AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ADMIN';

-- ACCOUNTANT: same reasoning - the TRANSACTIONS.% catch-all in the prior
-- migration doesn't retroactively cover these new rows.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.INVOICE' AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ACCOUNTANT';
