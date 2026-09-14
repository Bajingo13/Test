-- Phase M.1: Report Section master data.
--
-- Converts the previously hard-coded Report Section catalog (duplicated in
-- src/backend/services/groupCodeClassification.js's REPORT_SECTIONS array
-- and src/pages/FILESETUP/groupCodeSections.mjs's SECTION_LABELS object)
-- into a real, user-maintainable master table. account_group_codes.
-- report_section (added by accounting_group_code_report_section_migration.sql)
-- is completely unchanged by this migration - it still stores the same
-- VARCHAR(32) code, just validated against this table going forward instead
-- of an in-code array. New table only; no existing column is touched.
--
-- Seeded with the EXACT 11 sections already live in
-- groupCodeClassification.js today (same code/name/account_class) so every
-- existing account_group_codes.report_section value - and the already-
-- shipped structured Income Statement / Balance Sheet skeleton
-- (financialStatementStructureService.js), which still keys off these same
-- 11 codes and is NOT touched by this phase - keeps working unchanged.
-- Anything a user adds beyond these 11 is new, additional master data; it
-- validates fine on Group Code but has no bespoke placement in the
-- structured statement skeleton yet (shows under Unclassified there until a
-- later phase teaches the skeleton about custom sections - documented
-- limitation, not a defect).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT IGNORE (unique on code).
-- Safe to re-run any number of times. Local/demo use only per Phase M.1
-- instructions - not applied to any production database in this phase.

CREATE TABLE IF NOT EXISTS report_sections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  account_class VARCHAR(20) NOT NULL,
  display_order INT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_report_sections_code (code),
  UNIQUE KEY uq_report_sections_class_name (account_class, name),
  KEY idx_report_sections_class (account_class)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO report_sections (code, name, account_class, display_order, status) VALUES
  ('CURRENT_ASSET', 'Current Assets', 'ASSET', 10, 'ACTIVE'),
  ('NON_CURRENT_ASSET', 'Non-Current Assets', 'ASSET', 20, 'ACTIVE'),
  ('CURRENT_LIABILITY', 'Current Liabilities', 'LIABILITY', 10, 'ACTIVE'),
  ('NON_CURRENT_LIABILITY', 'Non-Current Liabilities', 'LIABILITY', 20, 'ACTIVE'),
  ('EQUITY', 'Equity', 'EQUITY', 10, 'ACTIVE'),
  ('REVENUE', 'Revenue', 'INCOME', 10, 'ACTIVE'),
  ('OTHER_INCOME', 'Other Income', 'INCOME', 20, 'ACTIVE'),
  ('DIRECT_COST', 'Direct Costs', 'EXPENSE', 10, 'ACTIVE'),
  ('OPERATING_EXPENSE', 'Operating Expenses', 'EXPENSE', 20, 'ACTIVE'),
  ('OTHER_EXPENSE', 'Other Expenses', 'EXPENSE', 30, 'ACTIVE'),
  ('TAX_EXPENSE', 'Tax Expense', 'EXPENSE', 40, 'ACTIVE');
