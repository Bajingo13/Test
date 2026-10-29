-- R8.4-A: opening-balance provenance for reconciliation sessions.
-- Idempotent (information_schema guards). Safe to re-run.
--
-- bank_recon_sessions.statement_beginning_balance has never recorded where
-- the figure came from. From R8.4-A a new session's opening balance is
-- either CARRIED (the statement_ending_balance of the previous FINALIZED
-- session of the same company + bank account) or MANUAL (typed by the
-- accountant when there is no such session):
--   opening_balance_source            'MANUAL' | 'CARRIED'
--   opening_balance_source_session_id the session it was carried from
--                                     (RESTRICT: provenance cannot vanish)
--
-- Backfill - a fact, not a guess: before R8.4-A the system had no way to
-- carry a balance, so every existing beginning balance was entered (or left
-- at its default) by hand. Existing sessions become MANUAL with no source
-- session.
--
-- Session overlap (same company + bank account, overlapping period) is not
-- expressible as a MySQL constraint; it is enforced by the application under
-- a bank-account row lock (bankReconSessionService.js). PHASE C lists any
-- overlaps that already existed before R8.4-A, for review.
--
-- Must run AFTER bank_reconciliation_migration.sql and
-- bank_recon_company_scope_migration.sql.

-- ============================================================
-- PHASE A: columns, foreign key
-- ============================================================

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND COLUMN_NAME = 'opening_balance_source');
SET @sql = IF(@c = 0, 'ALTER TABLE bank_recon_sessions ADD COLUMN opening_balance_source VARCHAR(20) NULL AFTER statement_beginning_balance, ADD COLUMN opening_balance_source_session_id INT NULL AFTER opening_balance_source', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND CONSTRAINT_NAME = 'fk_recon_opening_source');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_sessions ADD CONSTRAINT fk_recon_opening_source FOREIGN KEY (opening_balance_source_session_id) REFERENCES bank_recon_sessions (id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE B: backfill (sessions created before R8.4-A)
-- ============================================================

UPDATE bank_recon_sessions SET opening_balance_source = 'MANUAL' WHERE opening_balance_source IS NULL;

-- ============================================================
-- PHASE C: verification (run manually; not part of the idempotent body)
-- ============================================================
-- Overlapping sessions that existed before R8.4-A (same company + bank
-- account, overlapping period) - review and finalize / clean up by hand:
-- SELECT a.id, b.id AS overlaps_with, a.company_id, a.bank_account_id, a.period_start, a.period_end, b.period_start, b.period_end
-- FROM bank_recon_sessions a JOIN bank_recon_sessions b
--   ON b.id > a.id AND b.bank_account_id = a.bank_account_id AND b.company_id <=> a.company_id
--  AND b.period_start <= a.period_end AND b.period_end >= a.period_start
-- ORDER BY a.bank_account_id, a.period_start;
