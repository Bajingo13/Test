-- Company Management: the controlled way to create a NEW company (the seed in
-- user_access_control_migration.sql only ever creates the first one).
-- DATA ONLY - no DDL, no schema change. Idempotent (INSERT IGNORE).
--
-- One catalog permission, FILESETUP.COMPANIES / CREATE, granted to NO role:
-- SUPER_ADMIN passes every permission check (authorizePermission bypass), so
-- company creation is Super-Admin-only by default. It is a real catalog row so
-- the route can use authorizePermission (ACCESS_DENIED audit on refusal) and the
-- sidebar can hide the page - and so a Super Admin could later delegate it
-- through the role matrix (itself Super-Admin-only) if that is ever decided.
--
-- ADMIN and ACCOUNTANT get an explicit granted = 0 row. Same reason as
-- rfp_schema_permissions_migration.sql: user_access_control_migration.sql grants
-- ADMIN every permission outside four ADMIN.* modules with INSERT IGNORE, and the
-- local migrate.js runner re-runs the chain - without this row that catch-all
-- would hand ADMIN company creation. With it, the catch-all is a no-op. An
-- administrator's later decision through the role matrix is never overridden.
--
-- Must run AFTER user_access_control_migration.sql (owns permissions /
-- role_permissions / roles).

INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('FILESETUP.COMPANIES', 'CREATE', 'Create Company', 'Create a new company (Super Admin only unless explicitly delegated).');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 0
FROM roles r
JOIN permissions p ON p.module_key = 'FILESETUP.COMPANIES' AND p.action = 'CREATE'
WHERE r.code IN ('ADMIN', 'ACCOUNTANT');
