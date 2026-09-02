-- Phase 7K: permission catalog rows for the explicit APV/CV Cancel and Void
-- accounting actions. DATA/CONFIG ONLY - no DDL, no schema change. Same
-- INSERT IGNORE pattern and role-grant approach as
-- beginning_balance_delete_permission_migration.sql.
--
-- Cancel (Draft -> Cancelled) reuses each module's existing DELETE
-- permission. TRANSACTIONS.CV never had a DELETE row (no physical delete is
-- exposed for CV) - it is added here so DELETE can authorize CV Cancel,
-- exactly as the approved policy states. Void (Posted -> Void) is a new
-- VOID action per module.
--
-- Must run AFTER user_access_control_migration.sql (creates permissions /
-- role_permissions / roles and does its own one-time ADMIN/ACCOUNTANT
-- blanket grants, which cannot retroactively pick up a permission added
-- later). Idempotent: INSERT IGNORE throughout.

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('TRANSACTIONS.CV',  'DELETE', 'Cancel draft Check Vouchers', NULL),
  ('TRANSACTIONS.APV', 'VOID',   'Void posted AP Vouchers',     NULL),
  ('TRANSACTIONS.CV',  'VOID',   'Void posted Check Vouchers',  NULL);

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON (
     (p.module_key = 'TRANSACTIONS.CV'  AND p.action = 'DELETE')
  OR (p.module_key = 'TRANSACTIONS.APV' AND p.action = 'VOID')
  OR (p.module_key = 'TRANSACTIONS.CV'  AND p.action = 'VOID')
)
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');
