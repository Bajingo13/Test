-- R8.4-B: one-to-many deposit matching - link the match rows of one proposal.
-- Idempotent (information_schema guards). Safe to re-run. Schema only.
--
-- bank_recon_matches holds one row per (statement line, book document).
-- A deposit matched to several ORs is several rows that must be proposed,
-- confirmed and unmatched TOGETHER (never partially). match_group is the
-- shared key of those rows; it is NULL for every one-to-one match - which is
-- every row that exists before R8.4-B, so there is nothing to backfill.
--
-- Must run AFTER bank_reconciliation_migration.sql.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_matches' AND COLUMN_NAME = 'match_group');
SET @sql = IF(@c = 0, 'ALTER TABLE bank_recon_matches ADD COLUMN match_group VARCHAR(40) NULL AFTER book_line_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_matches' AND INDEX_NAME = 'idx_match_group');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_matches ADD INDEX idx_match_group (match_group, status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
