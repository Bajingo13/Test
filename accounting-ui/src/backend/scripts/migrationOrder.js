// Single source of truth for migration execution order (Infrastructure
// Checkpoint, section 17). Derived from reading every *_migration.sql
// file's CREATE/ALTER TABLE targets and cross-referencing them against
// each other's dependencies - NOT filename alphabetical order (that
// would run checkpoint3b before checkpoint4h, ai_recon before
// bank_reconciliation, etc. in an order that has never actually been
// exercised).
//
// 000_baseline_schema_migration.sql is new, generated this checkpoint: 32
// core tables (users, audit_logs, jv_headers, jv_lines, chart_of_accounts,
// invoice_headers, apv_headers, cv_headers, or_headers,
// purchase_order_headers, general_libraries, the AR/AP/GL beginning
// balance tables, transaction_applications, etc.) have no CREATE TABLE
// anywhere in this repo's version history - they predate the
// *_migration.sql convention entirely. It is a read-only `SHOW CREATE
// TABLE` snapshot of production's structure, generated to represent each
// table's shape immediately BEFORE this repo's migration-file history
// begins (every column any later migration file itself adds via ALTER is
// programmatically excluded - see that file's header for why). It must
// run first, since almost every migration below ALTERs one of those 32
// tables.
//
// This order was execution-tested end-to-end against freshly-created,
// empty local databases (astrea_accounting_dev and astrea_accounting_test,
// including a full db:test:reset drop-and-rebuild cycle). Three real gaps
// were found and fixed in the process, none by rewriting an existing
// migration file:
//   1. audit_logs was missing from the baseline entirely.
//   2. jv_headers/jv_lines were also missing - both created defensively
//      (CREATE TABLE IF NOT EXISTS) inside bank_reconciliation_migration.sql,
//      but needed much earlier by checkpoint3c.
//   3. FILESETUP.BEGINNING_BALANCES.DELETE has never been seeded by any
//      migration (production has it only via an undocumented manual
//      insert) - fixed by the new beginning_balance_delete_permission_migration.sql
//      below, which must run after user_access_control_migration.sql
//      (which creates the permissions table and does its own one-time
//      ADMIN/ACCOUNTANT blanket grants that can't retroactively pick up
//      a permission added later).
const MIGRATION_ORDER = [
  "000_baseline_schema_migration.sql",
  "user_access_control_migration.sql",
  "beginning_balance_delete_permission_migration.sql",
  "permission_templates_migration.sql",
  "invitations_migration.sql",
  "quotation_migration.sql",
  "quotation_account_migration.sql",
  "cashcheck_migration.sql",
  "ewt_phase2_migration.sql",
  "ewt_taxable_base_migration.sql",
  "transaction_print_permissions_migration.sql",
  "transaction_print_permissions_phase2_migration.sql",
  "transaction_print_permissions_phase3_migration.sql",
  "currencies_migration.sql",
  "currency_provider_migration.sql",
  "transaction_currency_migration.sql",
  "checkpoint3b_payment_currency_migration.sql",
  "checkpoint3c_transaction_currency_migration.sql",
  "beginning_balance_import_migration.sql",
  "checkpoint3d_beginning_balance_currency_migration.sql",
  "recurring_transactions_migration.sql",
  "checkpoint3d_recurring_currency_migration.sql",
  "checkpoint3fx_realized_fx_migration.sql",
  "checkpoint4_fx_revaluation_migration.sql",
  "bank_reconciliation_migration.sql",
  "ai_recon_migration.sql",
  "trial_balance_checker_migration.sql",
  "checkpoint4h_company_isolation_migration.sql",
  "checkpoint4i_company_phase_e_migration.sql",
  "checkpoint5_accounting_period_closing_migration.sql",
  "petty_cash_and_memo_migration.sql",
  // Phase 7C - purely additive (one new standalone table, no ALTERs to
  // anything else), depends only on companies/chart_of_accounts/
  // general_libraries already existing in the baseline.
  "phase7c_tax_schedule_migration.sql",
];

module.exports = { MIGRATION_ORDER };