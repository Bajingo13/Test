-- Bank Reconciliation company isolation (Option B).
-- Idempotent (information_schema guards, same pattern as every prior
-- migration): each ALTER only runs if the column / index / constraint
-- doesn't already exist. Safe to re-run.
--
-- bank_recon_sessions had no company ownership at all, so every session -
-- and every child row hanging off it (import batches, statement lines,
-- matches, adjustments, AI conversations, all FK'd by session_id) - was
-- visible to every company. Ownership lives on the session only; child
-- tables keep deriving it through session_id (same "don't duplicate onto
-- line tables" rule as checkpoint4h_company_isolation_migration.sql).
-- bank_codes deliberately stays global, like chart_of_accounts.
--
-- PHASE A: company_id INT NULL + FK + index. Nullable on purpose: rows the
-- backfill can't attribute stay NULL and are reachable only by a Super
-- Admin until assigned.
--
-- PHASE B: backfill, never a guess:
--   1. exactly one company exists        -> every session gets it;
--   2. more than one company exists      -> a session gets a company only
--      when ALL of its book-side evidence (matched CV / OR / JV documents
--      and JVs posted from its adjustments) points at one single company;
--   3. anything else (no evidence, or evidence from several companies)
--      stays NULL - see PHASE C.
--
-- Rollback (if ever needed): drop fk_bank_recon_session_company, then
-- idx_recon_company, then the column. Only the new column's data is lost.

-- ============================================================
-- PHASE A: column, foreign key, index
-- ============================================================

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND COLUMN_NAME = 'company_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE bank_recon_sessions ADD COLUMN company_id INT NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND INDEX_NAME = 'idx_recon_company');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE bank_recon_sessions ADD INDEX idx_recon_company (company_id, status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND CONSTRAINT_NAME = 'fk_bank_recon_session_company');
SET @sql = IF(@fk_exists = 0, 'ALTER TABLE bank_recon_sessions ADD CONSTRAINT fk_bank_recon_session_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE B: backfill
-- ============================================================

SET @company_count = (SELECT COUNT(*) FROM companies);
SET @only_company_id = (SELECT id FROM companies ORDER BY id LIMIT 1);

-- B.1 single company: deterministic.
SET @sql = IF(@company_count = 1,
  CONCAT('UPDATE bank_recon_sessions SET company_id = ', @only_company_id, ' WHERE company_id IS NULL'),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- B.2 several companies: only where the session's own book evidence names
-- exactly one company. (A no-op when B.1 already filled everything.)
UPDATE bank_recon_sessions s
JOIN (
  SELECT evidence.session_id, MIN(evidence.company_id) AS company_id
  FROM (
    SELECT m.session_id, cv.company_id
    FROM bank_recon_matches m JOIN cv_headers cv ON cv.id = m.book_source_id
    WHERE m.book_source_type = 'CV'
    UNION ALL
    SELECT m.session_id, o.company_id
    FROM bank_recon_matches m JOIN or_headers o ON o.id = m.book_source_id
    WHERE m.book_source_type = 'OR'
    UNION ALL
    SELECT m.session_id, j.company_id
    FROM bank_recon_matches m JOIN jv_headers j ON j.id = m.book_source_id
    WHERE m.book_source_type = 'JV'
    UNION ALL
    SELECT a.session_id, j.company_id
    FROM bank_recon_adjustments a JOIN jv_headers j ON j.id = a.jv_id
  ) evidence
  WHERE evidence.company_id IS NOT NULL
  GROUP BY evidence.session_id
  HAVING COUNT(DISTINCT evidence.company_id) = 1
) resolved ON resolved.session_id = s.id
SET s.company_id = resolved.company_id
WHERE s.company_id IS NULL;

-- ============================================================
-- PHASE C: verification (run manually after applying; not part of the
-- idempotent body). Sessions listed here are Super-Admin-only until a
-- company is assigned by hand.
-- ============================================================
-- SELECT COUNT(*) AS sessions, SUM(company_id IS NULL) AS unassigned FROM bank_recon_sessions;
-- SELECT s.id, s.bank_account_id, s.period_start, s.period_end, s.status, s.created_by
-- FROM bank_recon_sessions s WHERE s.company_id IS NULL ORDER BY s.id;
