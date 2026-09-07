-- Phase 2 (Document Print Template Infrastructure) - Invoice/OR print
-- architecture roadmap. Additive only: one brand-new table + new
-- permission catalog rows. No existing table is touched, no transaction
-- table is altered, no accounting value is affected. CREATE TABLE IF NOT
-- EXISTS / INSERT IGNORE make this safe to run any number of times,
-- including directly against an existing production database with live
-- data - no backfill, no required row for any company/module to keep
-- working (see printTemplateService.js's resolveEffectiveConfig: no DB
-- row at all is a fully supported state, not an error).
--
-- Company-scoped from day one (company_id NOT NULL, unlike
-- recurring_transaction_templates' historical nullable column - see that
-- table's own migration header for why it started nullable; this feature
-- has no such legacy baggage since every row is created after
-- resolveCompanyIdForWrite already exists everywhere else in this repo).

CREATE TABLE IF NOT EXISTS document_print_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  module_type VARCHAR(20) NOT NULL,          -- 'invoice' | 'or' (Phase 2 scope only)
  template_code VARCHAR(60) NOT NULL,        -- machine-safe identifier, unique within (company, module)
  template_name VARCHAR(150) NOT NULL,
  document_variant VARCHAR(40) NOT NULL,     -- sales_invoice|service_invoice|commercial_invoice|cash_invoice
                                              -- or official_receipt|collection_receipt|acknowledgement_receipt
  config_json JSON NOT NULL,                 -- presentation-only config - see printTemplateService.js's
                                              -- CONFIG_SCHEMA for the full whitelist. Never contains
                                              -- executable code, never touches accounting values.
  is_default TINYINT(1) NOT NULL DEFAULT 0,  -- at most one TRUE per (company_id, module_type) - enforced
                                              -- in printTemplateService.js (an UPDATE unsets the prior
                                              -- default inside the same transaction), not a DB constraint,
                                              -- matching this repo's existing currencies.is_base_currency
                                              -- precedent (currencyService.js's own createCurrency/
                                              -- setBaseCurrency handle that the same way).
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  updated_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_dpt_company_module_code (company_id, module_type, template_code),
  INDEX idx_dpt_company_module_active (company_id, module_type, is_active),
  INDEX idx_dpt_company_module_default (company_id, module_type, is_default)
);

-- Permission catalog: same (module_key, action) convention as every
-- existing migration (see recurring_transactions_migration.sql,
-- currencies_migration.sql). ACTIVATE/DEACTIVATE kept as separate actions
-- to match currencies_migration.sql's precedent for the same shape of
-- toggle. No MANAGE_ALL/ownership concept - unlike recurring transactions,
-- there is no per-user-created-by restriction anywhere in this feature to
-- begin with, so nothing needs a broader override permission.
INSERT IGNORE INTO permissions (module_key, action, label, description) VALUES
  ('PRINT.DOCUMENT_TEMPLATES', 'VIEW', 'View Print Templates', 'View document print templates for Invoice/OR.'),
  ('PRINT.DOCUMENT_TEMPLATES', 'CREATE', 'Create Print Templates', 'Create a new document print template.'),
  ('PRINT.DOCUMENT_TEMPLATES', 'EDIT', 'Edit Print Templates', 'Edit an existing document print template.'),
  ('PRINT.DOCUMENT_TEMPLATES', 'ACTIVATE', 'Activate Print Templates', 'Reactivate a deactivated print template.'),
  ('PRINT.DOCUMENT_TEMPLATES', 'DEACTIVATE', 'Deactivate Print Templates', 'Deactivate a print template so it can no longer be selected or resolved as default.'),
  ('PRINT.DOCUMENT_TEMPLATES', 'SET_DEFAULT', 'Set Default Print Template', 'Mark a template as the default for its module within the company.');

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'PRINT.DOCUMENT_TEMPLATES'
WHERE r.code = 'ADMIN';

INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
SELECT r.id, p.id, 1
FROM roles r
JOIN permissions p ON p.module_key = 'PRINT.DOCUMENT_TEMPLATES'
WHERE r.code = 'ACCOUNTANT';
