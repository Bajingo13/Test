-- Checkpoint 3D Part B: Recurring Transactions multi-currency. Idempotent -
-- information_schema guards for ALTER TABLE ADD/MODIFY COLUMN.
--
-- recurring_transaction_templates.currency (varchar(10), default 'PHP')
-- already exists from Phase 1 but is dead (captured, never read by
-- generation - confirmed by investigation). currency_id is the real FK the
-- generation service will actually use; the old varchar column is left in
-- place (still populated for display/back-compat) rather than dropped.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recurring_transaction_templates' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE recurring_transaction_templates ADD COLUMN currency_id INT NULL, ADD CONSTRAINT fk_rtt_currency FOREIGN KEY (currency_id) REFERENCES currencies(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- rate_policy: RESOLVE_ON_GENERATION (default - each occurrence resolves
-- its own rate at generation time, never locked into the template),
-- FIXED_RATE (every occurrence uses fixed_rate until the template is
-- edited), MANUAL_REVIEW (occurrence is held for human rate approval
-- instead of auto-generating - see recurring_transaction_occurrences.status
-- below).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recurring_transaction_templates' AND COLUMN_NAME = 'rate_policy');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE recurring_transaction_templates ADD COLUMN rate_policy VARCHAR(30) NOT NULL DEFAULT ''RESOLVE_ON_GENERATION'', ADD COLUMN fixed_rate DECIMAL(18,6) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- status was varchar(10) - too short for 'RATE_REVIEW_REQUIRED' (21 chars,
-- section 25/43 of the spec). Widening a varchar is safe/backward
-- compatible; existing short values (SUCCESS/FAILED/SKIPPED) are unaffected.
ALTER TABLE recurring_transaction_occurrences MODIFY COLUMN status VARCHAR(30) NOT NULL;
