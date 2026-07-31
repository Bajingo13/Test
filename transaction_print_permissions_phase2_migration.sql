-- Transaction Printing Options - Phase 2 (OR, APV, CV)
-- Additive only: new permission catalog rows + role defaults, same pattern
-- as transaction_print_permissions_migration.sql (Phase 1). Safe to re-run.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.OR', 'PRINT', 'Print Official Receipt (customer-facing)', 'Print/preview/export the customer-facing OR document and summary lists - no accounting entries.'),
  ('TRANSACTIONS.OR', 'PRINT_WITH_ENTRIES', 'Print Official Receipt with Accounting Entries', 'Print/preview/export the internal OR copy including the accounting entries (account code, debit, credit).'),
  ('TRANSACTIONS.APV', 'PRINT', 'Print AP Voucher (supplier-facing)', 'Print/preview/export the supplier-facing APV document and summary lists - no accounting entries.'),
  ('TRANSACTIONS.APV', 'PRINT_WITH_ENTRIES', 'Print AP Voucher with Accounting Entries', 'Print/preview/export the internal APV copy including the accounting entries (account code, debit, credit).'),
  ('TRANSACTIONS.CV', 'PRINT', 'Print Check Voucher (payee-facing)', 'Print/preview/export the payee-facing CV document and summary lists - no accounting entries.'),
  ('TRANSACTIONS.CV', 'PRINT_WITH_ENTRIES', 'Print Check Voucher with Accounting Entries', 'Print/preview/export the internal CV copy including the accounting entries (account code, debit, credit).');

-- ADMIN/ACCOUNTANT already got these module_keys' other actions via the
-- catch-all seeds in earlier migrations, but those don't retroactively
-- cover rows inserted by this later migration, so grant explicitly here.
INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.OR', 'TRANSACTIONS.APV', 'TRANSACTIONS.CV')
  AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.OR', 'TRANSACTIONS.APV', 'TRANSACTIONS.CV')
  AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ACCOUNTANT';
