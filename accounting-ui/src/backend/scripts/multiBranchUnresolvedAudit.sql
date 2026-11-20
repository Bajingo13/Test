-- Multi-Branch Foundation - READ-ONLY audit of historical rows left without a
-- branch (branch_id NULL) by multi_branch_foundation_migration.sql. Those rows
-- belong to companies that have two or more branches, so their branch could not
-- be determined and was deliberately NOT guessed.
--
-- SELECT-only. Not a migration (not listed in migrationOrder.js). Safe to run
-- against any environment; it changes nothing.

SELECT 'apv_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM apv_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'invoice_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM invoice_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'cv_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM cv_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'or_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM or_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'jv_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM jv_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'memo_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM memo_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'petty_cash_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM petty_cash_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'purchase_order_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM purchase_order_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'quotation_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM quotation_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'arap_beginning_balance_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM arap_beginning_balance_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
SELECT 'gl_beginning_balance_headers' AS table_name, x.company_id, COUNT(*) AS unresolved FROM gl_beginning_balance_headers x WHERE x.branch_id IS NULL AND (SELECT COUNT(*) FROM branches b WHERE b.company_id = x.company_id) > 1 GROUP BY x.company_id;
