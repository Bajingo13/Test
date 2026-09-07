-- Transaction Printing Options - Phase 3 (JV, PO)
-- Additive only: new permission catalog rows + role defaults, same pattern
-- as Phase 1/2. Safe to re-run.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.JV', 'PRINT', 'Print Journal Voucher summary lists', 'Print/preview/export Journal Voucher summary lists (a JV has no customer-facing form - this gates List printing only).'),
  ('TRANSACTIONS.JV', 'PRINT_WITH_ENTRIES', 'Print Journal Voucher with Accounting Entries', 'Print/preview/export the Journal Voucher including its accounting entries (account code, debit, credit) - a JV always shows entries.'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'PRINT', 'Print Purchase Order (supplier-facing)', 'Print/preview/export the supplier-facing PO document and summary lists - no accounting entries.'),
  ('TRANSACTIONS.PURCHASE_ORDER', 'PRINT_WITH_ENTRIES', 'Print Purchase Order with Accounting Entries', 'Print/preview/export the internal PO copy including the accounting entries (account code, debit, credit).');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.JV', 'TRANSACTIONS.PURCHASE_ORDER')
  AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key IN ('TRANSACTIONS.JV', 'TRANSACTIONS.PURCHASE_ORDER')
  AND p.action IN ('PRINT', 'PRINT_WITH_ENTRIES')
WHERE r.code = 'ACCOUNTANT';
