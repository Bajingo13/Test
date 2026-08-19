-- Baseline schema snapshot - generated 2026-08-18, revised 2026-08-19
-- after execution-testing against a real empty local database
-- (astrea_accounting_dev) surfaced two classes of problem with the
-- first version of this file:
--
--   1. audit_logs was missing entirely (permission_templates_migration.sql
--      needs it, but its own CREATE TABLE IF NOT EXISTS audit_logs lives
--      inside bank_reconciliation_migration.sql, much later in the
--      documented order) - fixed by adding it here as a 30th baseline
--      table.
--   2. The first version captured these 30 tables' CURRENT, fully-
--      evolved production structure - which already includes every
--      column any LATER migration in migrationOrder.js also adds via a
--      plain (non-idempotent) `ALTER TABLE ... ADD COLUMN`. Replaying
--      those later migrations against a database seeded from that
--      snapshot fails with "Duplicate column name", because the column
--      is already there. This version fixes that by generating from
--      current production structure but PROGRAMMATICALLY EXCLUDING
--      every (table, column) pair that some later *_migration.sql file
--      is responsible for adding (cross-referenced automatically from
--      every ALTER TABLE ... ADD COLUMN statement in every OTHER
--      migration file, not hand-picked) - so this baseline represents
--      each table's structure immediately BEFORE this repo's
--      migration-file history begins, and every later migration's own
--      ADD COLUMN runs exactly as originally written, unmodified.
--
-- These 30 tables predate this repo's *_migration.sql convention - no
-- CREATE TABLE for them (in ANY form, evolved or otherwise) exists
-- anywhere in version control. This file exists solely so a fresh
-- dev/test database can be bootstrapped to the same structure
-- production already has, by running this file FIRST and then every
-- other migration in migrationOrder.js afterward, unmodified.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS per table. foreign_key_checks
-- is disabled for the duration of this file only, since these 30
-- tables reference each other and companies/currencies in a shape that
-- was never designed to be created in a single topologically-sorted
-- pass - re-enabled at the end.

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- users
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL,
  `password` varchar(255) NOT NULL,
  `full_name` varchar(150) DEFAULT NULL,
  `role` varchar(50) DEFAULT 'user',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `module` varchar(30) NOT NULL,
  `entity_type` varchar(40) NOT NULL,
  `entity_id` int DEFAULT NULL,
  `action` varchar(40) NOT NULL,
  `description` varchar(500) NOT NULL,
  `before_data` json DEFAULT NULL,
  `after_data` json DEFAULT NULL,
  `user_id` int DEFAULT NULL,
  `username` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_entity` (`module`,`entity_type`,`entity_id`),
  KEY `idx_audit_created` (`created_at`),
  KEY `idx_audit_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- jv_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `jv_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `company_id` int NOT NULL,
  `voucher_no` varchar(100) NOT NULL,
  `transaction_date` date NOT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(15,2) NOT NULL DEFAULT '0.00',
  `total_credit` decimal(15,2) NOT NULL DEFAULT '0.00',
  `status` varchar(20) NOT NULL DEFAULT 'Draft',
  `source_module` varchar(30) DEFAULT NULL,
  `source_reference_id` int DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `posted_by` int DEFAULT NULL,
  `posted_at` timestamp NULL DEFAULT NULL,
  `prepared_for` varchar(255) DEFAULT NULL,
  `currency_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `voucher_no` (`voucher_no`),
  KEY `fk_jv_currency` (`currency_id`),
  KEY `idx_jv_company_date` (`company_id`,`transaction_date`),
  CONSTRAINT `fk_jv_company` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_jv_currency` FOREIGN KEY (`currency_id`) REFERENCES `currencies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- jv_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `jv_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `jv_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` text,
  `debit` decimal(15,2) NOT NULL DEFAULT '0.00',
  `credit` decimal(15,2) NOT NULL DEFAULT '0.00',
  `gen_ref` varchar(100) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  `foreign_debit` decimal(18,2) DEFAULT NULL,
  `foreign_credit` decimal(18,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `jv_id` (`jv_id`),
  CONSTRAINT `jv_lines_ibfk_1` FOREIGN KEY (`jv_id`) REFERENCES `jv_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- chart_of_accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS `chart_of_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(50) NOT NULL,
  `account_date` date NOT NULL,
  `title` varchar(255) NOT NULL,
  `account_class` enum('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE') NOT NULL,
  `description` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- coa
-- ============================================================
CREATE TABLE IF NOT EXISTS `coa` (
  `idCOA` int NOT NULL,
  PRIMARY KEY (`idCOA`),
  UNIQUE KEY `idCOA_UNIQUE` (`idCOA`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- coa_groups
-- ============================================================
CREATE TABLE IF NOT EXISTS `coa_groups` (
  `id` int NOT NULL AUTO_INCREMENT,
  `coa_id` int NOT NULL,
  `group_code` varchar(50) NOT NULL,
  `group_description` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `coa_id` (`coa_id`),
  CONSTRAINT `coa_groups_ibfk_1` FOREIGN KEY (`coa_id`) REFERENCES `chart_of_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- coa_validations
-- ============================================================
CREATE TABLE IF NOT EXISTS `coa_validations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `coa_id` int NOT NULL,
  `validation_name` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `coa_id` (`coa_id`),
  CONSTRAINT `coa_validations_ibfk_1` FOREIGN KEY (`coa_id`) REFERENCES `chart_of_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- account_group_codes
-- ============================================================
CREATE TABLE IF NOT EXISTS `account_group_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `group_code` varchar(50) NOT NULL,
  `group_description` varchar(255) NOT NULL,
  `account_class` varchar(100) DEFAULT '',
  `status` varchar(20) DEFAULT 'ACTIVE',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `group_code` (`group_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- company_profile
-- ============================================================
CREATE TABLE IF NOT EXISTS `company_profile` (
  `id` int NOT NULL DEFAULT '1',
  `payor_name` varchar(255) DEFAULT NULL,
  `payor_tin` varchar(20) DEFAULT NULL,
  `payor_address` varchar(255) DEFAULT NULL,
  `payor_zip` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- general_libraries
-- ============================================================
CREATE TABLE IF NOT EXISTS `general_libraries` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(50) NOT NULL,
  `party_type` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `status` varchar(50) DEFAULT 'ACTIVE',
  `start_date` date DEFAULT NULL,
  `address1` varchar(255) DEFAULT NULL,
  `address2` varchar(255) DEFAULT NULL,
  `address3` varchar(255) DEFAULT NULL,
  `attention` varchar(150) DEFAULT NULL,
  `position` varchar(150) DEFAULT NULL,
  `telephone` varchar(50) DEFAULT NULL,
  `fax` varchar(50) DEFAULT NULL,
  `mobile` varchar(50) DEFAULT NULL,
  `tin` varchar(50) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `atc_code` varchar(50) DEFAULT NULL,
  `ewt_code` varchar(50) DEFAULT NULL,
  `category` varchar(50) DEFAULT NULL,
  `branch_code` varchar(50) DEFAULT NULL,
  `rdo_code` varchar(50) DEFAULT NULL,
  `notes` text,
  `is_prospective` tinyint(1) DEFAULT '0',
  `is_client` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`),
  KEY `idx_genlib_company_type` (`party_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- bank_codes
-- ============================================================
CREATE TABLE IF NOT EXISTS `bank_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bank_code` varchar(50) DEFAULT NULL,
  `bank_name` varchar(255) DEFAULT NULL,
  `account_no` varchar(100) DEFAULT NULL,
  `account_name` varchar(255) DEFAULT NULL,
  `coa_account_id` int DEFAULT NULL,
  `coa_code` varchar(50) DEFAULT NULL,
  `status` varchar(20) DEFAULT 'ACTIVE',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_coa_account` (`coa_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- ewt_library
-- ============================================================
CREATE TABLE IF NOT EXISTS `ewt_library` (
  `id` int NOT NULL AUTO_INCREMENT,
  `atc_code` varchar(20) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `tax_type` varchar(20) DEFAULT 'EWT',
  `rate` decimal(6,3) DEFAULT '0.000',
  `bir_form` varchar(20) DEFAULT NULL,
  `status` varchar(20) DEFAULT 'ACTIVE',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- fixed_assets
-- ============================================================
CREATE TABLE IF NOT EXISTS `fixed_assets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `asset_code` varchar(50) DEFAULT NULL,
  `asset_name` varchar(255) DEFAULT NULL,
  `category` varchar(100) DEFAULT NULL,
  `acquisition_date` date DEFAULT NULL,
  `acquisition_cost` decimal(15,2) DEFAULT '0.00',
  `salvage_value` decimal(15,2) DEFAULT '0.00',
  `useful_life_years` int DEFAULT '5',
  `depreciation_method` varchar(30) DEFAULT 'STRAIGHT_LINE',
  `asset_account_code` varchar(50) DEFAULT NULL,
  `status` varchar(20) DEFAULT 'Active',
  `disposal_date` date DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- prepaid_accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS `prepaid_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `prepaid_code` varchar(50) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `party_name` varchar(255) DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `expense_account_code` varchar(50) DEFAULT NULL,
  `start_date` date DEFAULT NULL,
  `amount` decimal(15,2) DEFAULT '0.00',
  `term_months` int DEFAULT '1',
  `status` varchar(20) DEFAULT 'Active',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- invoice_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `invoice_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `voucher_no` varchar(100) NOT NULL,
  `customer_id` int DEFAULT NULL,
  `customer_name` varchar(255) NOT NULL,
  `transaction_date` date DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(15,2) DEFAULT '0.00',
  `total_credit` decimal(15,2) DEFAULT '0.00',
  `paid_amount` decimal(15,2) DEFAULT '0.00',
  `balance_amount` decimal(15,2) DEFAULT '0.00',
  `payment_status` varchar(50) DEFAULT 'Unpaid',
  `status` varchar(50) DEFAULT 'Draft',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_voucher_no` (`voucher_no`),
  KEY `idx_invoice_company_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- invoice_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `invoice_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invoice_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(100) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` text,
  `debit` decimal(15,2) DEFAULT '0.00',
  `credit` decimal(15,2) DEFAULT '0.00',
  `gen_ref` varchar(100) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_invoice_lines_header` (`invoice_id`),
  CONSTRAINT `fk_invoice_lines_header` FOREIGN KEY (`invoice_id`) REFERENCES `invoice_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- apv_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `apv_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `voucher_no` varchar(50) NOT NULL,
  `supplier_id` int DEFAULT NULL,
  `supplier_name` varchar(255) DEFAULT NULL,
  `transaction_date` date DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(18,2) DEFAULT '0.00',
  `total_credit` decimal(18,2) DEFAULT '0.00',
  `status` varchar(30) DEFAULT 'DRAFT',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `paid_amount` decimal(12,2) DEFAULT '0.00',
  `balance_amount` decimal(12,2) DEFAULT '0.00',
  `payment_status` varchar(30) DEFAULT 'Unpaid',
  `source_po_id` int DEFAULT NULL,
  `atc_code` varchar(20) DEFAULT NULL,
  `tax_type` varchar(20) DEFAULT NULL,
  `tax_rate` decimal(6,3) DEFAULT NULL,
  `tax_withheld_amount` decimal(15,2) DEFAULT NULL,
  `payee_tin` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `voucher_no` (`voucher_no`),
  KEY `idx_apv_company_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- apv_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `apv_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `apv_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` varchar(255) DEFAULT NULL,
  `debit` decimal(18,2) DEFAULT '0.00',
  `credit` decimal(18,2) DEFAULT '0.00',
  `gen_ref` varchar(50) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `apv_id` (`apv_id`),
  CONSTRAINT `apv_lines_ibfk_1` FOREIGN KEY (`apv_id`) REFERENCES `apv_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- cv_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `cv_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `voucher_no` varchar(50) DEFAULT NULL,
  `payee_id` int DEFAULT NULL,
  `payee_name` varchar(255) DEFAULT NULL,
  `transaction_date` date DEFAULT NULL,
  `reference_no` varchar(50) DEFAULT NULL,
  `check_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(12,2) DEFAULT '0.00',
  `total_credit` decimal(12,2) DEFAULT '0.00',
  `status` varchar(30) DEFAULT 'Draft',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `voucher_no` (`voucher_no`),
  KEY `idx_cv_company_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- cv_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `cv_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `cv_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` text,
  `debit` decimal(12,2) DEFAULT '0.00',
  `credit` decimal(12,2) DEFAULT '0.00',
  `gen_ref` varchar(50) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `cv_id` (`cv_id`),
  CONSTRAINT `cv_lines_ibfk_1` FOREIGN KEY (`cv_id`) REFERENCES `cv_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- or_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `or_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `voucher_no` varchar(100) NOT NULL,
  `customer_id` int DEFAULT NULL,
  `customer_name` varchar(255) NOT NULL,
  `transaction_date` date DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `receipt_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(15,2) DEFAULT '0.00',
  `total_credit` decimal(15,2) DEFAULT '0.00',
  `status` varchar(50) DEFAULT 'Draft',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_or_voucher_no` (`voucher_no`),
  KEY `idx_or_company_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- or_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `or_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `or_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(100) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` text,
  `gen_ref` varchar(100) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  `debit` decimal(15,2) DEFAULT '0.00',
  `credit` decimal(15,2) DEFAULT '0.00',
  PRIMARY KEY (`id`),
  KEY `fk_or_lines_header` (`or_id`),
  CONSTRAINT `fk_or_lines_header` FOREIGN KEY (`or_id`) REFERENCES `or_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- purchase_order_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `purchase_order_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `voucher_no` varchar(50) DEFAULT NULL,
  `supplier_id` int DEFAULT NULL,
  `supplier_name` varchar(255) DEFAULT NULL,
  `transaction_date` date DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `description` text,
  `remarks` text,
  `total_debit` decimal(15,2) DEFAULT '0.00',
  `total_credit` decimal(15,2) DEFAULT '0.00',
  `status` varchar(20) DEFAULT 'Open',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_po_company_date` (`transaction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- purchase_order_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `purchase_order_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `po_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `particulars` varchar(255) DEFAULT NULL,
  `debit` decimal(15,2) DEFAULT '0.00',
  `credit` decimal(15,2) DEFAULT '0.00',
  `gen_ref` varchar(100) DEFAULT NULL,
  `gen_name` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `po_id` (`po_id`),
  CONSTRAINT `purchase_order_lines_ibfk_1` FOREIGN KEY (`po_id`) REFERENCES `purchase_order_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- arap_beginning_balance_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `arap_beginning_balance_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `balance_type` enum('AR','AP') NOT NULL,
  `balance_date` date NOT NULL,
  `currency_code` varchar(10) DEFAULT 'PHP',
  `currency_name` varchar(100) DEFAULT 'PHILIPPINE PESO',
  `status` varchar(20) DEFAULT 'Draft',
  `remarks` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_arapbb_company_date` (`balance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- arap_beginning_balance_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `arap_beginning_balance_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `header_id` int NOT NULL,
  `party_id` int DEFAULT NULL,
  `party_code` varchar(50) DEFAULT NULL,
  `party_name` varchar(255) NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) DEFAULT NULL,
  `account_title` varchar(255) DEFAULT NULL,
  `reference_no` varchar(100) DEFAULT NULL,
  `invoice_no` varchar(100) DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `debit` decimal(18,4) DEFAULT '0.0000',
  `credit` decimal(18,4) DEFAULT '0.0000',
  `balance_amount` decimal(18,4) DEFAULT '0.0000',
  `paid_amount` decimal(18,4) DEFAULT '0.0000',
  `status` varchar(30) DEFAULT 'Unpaid',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_arap_bb_header` (`header_id`),
  CONSTRAINT `fk_arap_bb_header` FOREIGN KEY (`header_id`) REFERENCES `arap_beginning_balance_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- arap_beginning_balance_applications
-- ============================================================
CREATE TABLE IF NOT EXISTS `arap_beginning_balance_applications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `balance_type` enum('AR','AP') NOT NULL,
  `beginning_balance_line_id` int NOT NULL,
  `schedule_id` int DEFAULT NULL,
  `applied_type` varchar(20) NOT NULL,
  `applied_id` int NOT NULL,
  `amount` decimal(18,4) NOT NULL,
  `application_date` date NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_arap_application_line` (`beginning_balance_line_id`),
  KEY `fk_arap_application_schedule` (`schedule_id`),
  CONSTRAINT `fk_arap_application_line` FOREIGN KEY (`beginning_balance_line_id`) REFERENCES `arap_beginning_balance_lines` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_arap_application_schedule` FOREIGN KEY (`schedule_id`) REFERENCES `arap_payment_schedules` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- arap_payment_schedules
-- ============================================================
CREATE TABLE IF NOT EXISTS `arap_payment_schedules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `beginning_balance_line_id` int NOT NULL,
  `schedule_date` date NOT NULL,
  `amount` decimal(18,4) NOT NULL DEFAULT '0.0000',
  `paid_amount` decimal(18,4) DEFAULT '0.0000',
  `balance_amount` decimal(18,4) DEFAULT '0.0000',
  `status` varchar(30) DEFAULT 'Unpaid',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_arap_schedule_line` (`beginning_balance_line_id`),
  CONSTRAINT `fk_arap_schedule_line` FOREIGN KEY (`beginning_balance_line_id`) REFERENCES `arap_beginning_balance_lines` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- gl_beginning_balance_headers
-- ============================================================
CREATE TABLE IF NOT EXISTS `gl_beginning_balance_headers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `filter_code` varchar(50) DEFAULT 'NON',
  `balance_date` date NOT NULL,
  `currency_code` varchar(10) DEFAULT 'PHP',
  `currency_name` varchar(100) DEFAULT 'PHILIPPINE PESO',
  `title` varchar(255) DEFAULT NULL,
  `status` varchar(20) DEFAULT 'Draft',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_glbb_company_date` (`balance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- gl_beginning_balance_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS `gl_beginning_balance_lines` (
  `id` int NOT NULL AUTO_INCREMENT,
  `header_id` int NOT NULL,
  `account_id` int DEFAULT NULL,
  `account_code` varchar(50) NOT NULL,
  `account_title` varchar(255) NOT NULL,
  `project_code` varchar(50) DEFAULT NULL,
  `dept_code` varchar(50) DEFAULT NULL,
  `othrdebit` decimal(18,4) DEFAULT '0.0000',
  `othrcredit` decimal(18,4) DEFAULT '0.0000',
  `debit_based` decimal(18,4) DEFAULT '0.0000',
  `credit_based` decimal(18,4) DEFAULT '0.0000',
  `debit_orig_curr` decimal(18,4) DEFAULT '0.0000',
  `credit_orig_curr` decimal(18,4) DEFAULT '0.0000',
  `debit_functional` decimal(18,4) DEFAULT '0.0000',
  `credit_functional` decimal(18,4) DEFAULT '0.0000',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_gl_beginning_account` (`header_id`,`account_code`),
  CONSTRAINT `fk_gl_beginning_balance_header` FOREIGN KEY (`header_id`) REFERENCES `gl_beginning_balance_headers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- transaction_applications
-- ============================================================
CREATE TABLE IF NOT EXISTS `transaction_applications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `source_type` varchar(30) NOT NULL,
  `source_id` int NOT NULL,
  `applied_type` varchar(30) NOT NULL,
  `applied_id` int NOT NULL,
  `amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `application_date` date NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ta_source` (`source_type`,`source_id`),
  KEY `idx_ta_applied` (`applied_type`,`applied_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


SET FOREIGN_KEY_CHECKS = 1;
