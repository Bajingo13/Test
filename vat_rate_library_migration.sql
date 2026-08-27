-- Phase 6D: VAT Rate Library - reference-only VAT catalog (Code,
-- Description, Applies To, Rate, Status). Idempotent - safe to run any
-- number of times against any environment.
--
-- Architecture decisions (see the Phase 6B/6C audit reports):
--   - No effective dating, no version table (Model A) - historical
--     correctness for posted transactions is already handled by
--     transaction-time snapshotting (transaction_tax_entries.vat_rate /
--     vat_amount), not by anything this catalog does. A rate edited here
--     later never affects an already-posted transaction.
--   - No FK from any transaction table to this table, and no company_id -
--     this is a GLOBAL reference table, matching the existing
--     ewt_library/chart_of_accounts precedent (neither is company-scoped
--     either).
--   - Real DB-level UNIQUE key on `code` (unlike ewt_library's atc_code,
--     which has only an app-level duplicate check today - see Phase 6C
--     section 3). This is a brand-new table with no legacy data to
--     retrofit around, so there is no reason to repeat that gap here.
--   - `applies_to` is picker-filtering metadata only (which module's VAT
--     entry picker should offer this code) - it never overrides the
--     accounting direction, which remains determined by the module
--     (Invoice=OUTPUT, APV=INPUT), exactly as before this migration.
--   - No Delete action is exposed anywhere in the API/UI on top of this
--     table (Active/Inactive only) - a deliberate improvement over
--     ewt_library's current unconditional hard-delete (DELETE
--     /api/ewt-library/:id has no in-use check at all), not a copy of it.
CREATE TABLE IF NOT EXISTS `vat_rate_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(20) NOT NULL,
  `description` varchar(255) DEFAULT NULL,
  `applies_to` varchar(10) NOT NULL DEFAULT 'BOTH',
  `rate` decimal(6,3) NOT NULL DEFAULT '12.000',
  `status` varchar(20) NOT NULL DEFAULT 'ACTIVE',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vat_rate_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Seed the default reference row (Phase 6C section 9 - deployment safety:
-- entry must never become unusable because no VAT row exists). INSERT
-- IGNORE against the real UNIQUE key on `code` is idempotent and never
-- overwrites an administrator-edited row - re-running this migration after
-- an admin has renamed/edited STANDARD_VAT will not recreate or touch it
-- unless the code "STANDARD_VAT" itself is free again.
INSERT IGNORE INTO `vat_rate_codes` (`code`, `description`, `applies_to`, `rate`, `status`)
VALUES ('STANDARD_VAT', 'Standard VAT', 'BOTH', 12.000, 'ACTIVE');
