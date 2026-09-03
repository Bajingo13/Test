-- Release Batch 8, Commit 1: permission catalog row for the Official
-- Receipt email action (POST /api/or/:id/email). DATA/CONFIG ONLY - no
-- DDL, no schema change. Same INSERT IGNORE pattern and role-grant
-- approach as phase7k_void_cancel_permissions_migration.sql and
-- transaction_print_permissions_phase2_migration.sql.
--
-- TRANSACTIONS.OR / EMAIL is granted to exactly the role set that already
-- holds TRANSACTIONS.OR / PRINT (ADMIN + ACCOUNTANT - see
-- transaction_print_permissions_phase2_migration.sql). Emailing an OR is a
-- read-only distribution action over the same customer-facing document the
-- PRINT action already exposes.
--
-- Must run AFTER user_access_control_migration.sql (creates permissions /
-- role_permissions / roles and its own one-time ADMIN/ACCOUNTANT blanket
-- grants, which cannot retroactively pick up a permission added later) and
-- AFTER transaction_print_permissions_phase2_migration.sql (owns the
-- TRANSACTIONS.OR / PRINT rows this one mirrors). Idempotent: INSERT
-- IGNORE throughout - re-run is a no-op.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.OR', 'EMAIL', 'Email Official Receipt to customer', 'Email the customer-facing Official Receipt PDF (without accounting entries). Read-only - never changes the OR.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'TRANSACTIONS.OR' AND p.action = 'EMAIL'
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');
