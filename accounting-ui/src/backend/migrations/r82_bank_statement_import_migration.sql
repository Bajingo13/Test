-- R8.2: bank statement import foundation - ownership, provenance and
-- database-level duplicate protection for imported statement rows.
-- Idempotent (information_schema guards, same pattern as
-- bank_recon_company_scope_migration.sql): every ALTER runs only when its
-- column / index / constraint is missing; the backfill only touches rows it
-- has not filled yet. Safe to re-run. Uses only MySQL features older
-- migrations already rely on (no window functions, no REGEXP_REPLACE).
--
-- OWNERSHIP - never guessed. Every import batch and statement line hangs
-- off a reconciliation session through its own NOT NULL session_id FK, and
-- the session holds the authoritative company_id (NULL only for legacy
-- sessions a Super Admin has not assigned yet) and bank_account_id (NOT
-- NULL, never edited). The backfill copies exactly those two values from
-- the row's OWN session_id:
--   * bank_account_id - always resolvable (NOT NULL afterwards);
--   * company_id      - copied as-is; a legacy NULL-company session keeps
--                       NULL on its rows (imports into such sessions are
--                       refused by the application; assigning the session a
--                       company later also assigns its rows).
-- A composite FK (session_id, company_id, bank_account_id) ->
-- bank_recon_sessions(id, company_id, bank_account_id) then makes it
-- impossible to store a row whose company / bank account differs from its
-- session's.
--
-- FINGERPRINT (version 2) - computed from the row's stored values exactly
-- as bankStatementParser.rowFingerprint() does:
--   SHA2( "v2" US txn_date(YYYY-MM-DD) US direction(IN|OUT) US
--         amount in centavos US check_no US reference_no US description
--         "#" n , 256)
-- (US = CHAR(31)). direction/amount: debit > 0 -> OUT/debit, else IN/credit.
-- n is the row's occurrence of that exact tuple within its own import batch
-- (by id), so genuinely identical bank lines in one statement stay distinct.
-- Company and bank account are not hashed - the unique key scopes them.
--
-- HISTORICAL DUPLICATES - before R8.2 the same statement could be imported
-- into two sessions of one bank account. Those rows are kept untouched;
-- only the EARLIEST (lowest id) gets the fingerprint, later copies keep a
-- NULL row_fingerprint (outside the unique key) so the unique index can be
-- created. PHASE D lists them for review.
--
-- Must run AFTER bank_reconciliation_migration.sql and
-- bank_recon_company_scope_migration.sql.

-- ============================================================
-- PHASE A: columns
-- ============================================================

SET @t = 'bank_recon_import_batches';
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = @t AND COLUMN_NAME = 'company_id');
SET @sql = IF(@c = 0, 'ALTER TABLE bank_recon_import_batches ADD COLUMN company_id INT NULL AFTER session_id, ADD COLUMN bank_account_id INT NULL AFTER company_id, ADD COLUMN file_sha256 CHAR(64) NULL AFTER file_type, ADD COLUMN duplicate_count INT NOT NULL DEFAULT 0 AFTER row_count, ADD COLUMN ignored_count INT NOT NULL DEFAULT 0 AFTER duplicate_count, ADD COLUMN parser_version INT NULL AFTER ignored_count', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @t = 'bank_recon_statement_lines';
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = @t AND COLUMN_NAME = 'row_fingerprint');
SET @sql = IF(@c = 0, 'ALTER TABLE bank_recon_statement_lines ADD COLUMN company_id INT NULL AFTER session_id, ADD COLUMN bank_account_id INT NULL AFTER company_id, ADD COLUMN source_row INT NULL AFTER bank_account_id, ADD COLUMN value_date DATE NULL AFTER txn_date, ADD COLUMN check_no_normalized VARCHAR(100) NULL AFTER check_no, ADD COLUMN reference_no_normalized VARCHAR(100) NULL AFTER reference_no, ADD COLUMN bank_reference VARCHAR(100) NULL AFTER reference_no_normalized, ADD COLUMN row_fingerprint CHAR(64) NULL AFTER running_balance', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE B: backfill (rows not filled yet only)
-- ============================================================

-- B.1 ownership from each row's own session: rows not filled yet, and rows
-- of a legacy session that has since been given a company (e.g. by a later
-- run of bank_recon_company_scope_migration.sql). Such rows release their
-- fingerprint first; B.3 recomputes it under the earliest-copy rule, so a
-- re-run can never trip the unique key.
UPDATE bank_recon_import_batches b
JOIN bank_recon_sessions s ON s.id = b.session_id
SET b.company_id = s.company_id, b.bank_account_id = s.bank_account_id
WHERE b.bank_account_id IS NULL OR (b.company_id IS NULL AND s.company_id IS NOT NULL);

UPDATE bank_recon_statement_lines l
JOIN bank_recon_sessions s ON s.id = l.session_id
SET l.row_fingerprint = NULL
WHERE l.company_id IS NULL AND s.company_id IS NOT NULL;

UPDATE bank_recon_statement_lines l
JOIN bank_recon_sessions s ON s.id = l.session_id
SET l.company_id = s.company_id, l.bank_account_id = s.bank_account_id
WHERE l.bank_account_id IS NULL OR (l.company_id IS NULL AND s.company_id IS NOT NULL);

-- B.2 normalized identifiers, same rule as normalizeIdentifier(): trim,
-- lower-case, drop leading zeros that are followed by a digit ("000" -> "0",
-- "007" -> "7", "00a" -> "0a").
UPDATE bank_recon_statement_lines l
JOIN (
  SELECT id,
         LOWER(TRIM(COALESCE(check_no, ''))) AS ck,
         TRIM(LEADING '0' FROM LOWER(TRIM(COALESCE(check_no, '')))) AS ckz,
         LOWER(TRIM(COALESCE(reference_no, ''))) AS rf,
         TRIM(LEADING '0' FROM LOWER(TRIM(COALESCE(reference_no, '')))) AS rfz
  FROM bank_recon_statement_lines
  WHERE check_no_normalized IS NULL
) n ON n.id = l.id
SET l.check_no_normalized = CASE
      WHEN n.ck = '' THEN ''
      WHEN n.ckz = '' THEN '0'
      WHEN n.ckz REGEXP '^[0-9]' OR LEFT(n.ck, 1) <> '0' THEN n.ckz
      ELSE CONCAT('0', n.ckz) END,
    l.reference_no_normalized = CASE
      WHEN n.rf = '' THEN ''
      WHEN n.rfz = '' THEN '0'
      WHEN n.rfz REGEXP '^[0-9]' OR LEFT(n.rf, 1) <> '0' THEN n.rfz
      ELSE CONCAT('0', n.rfz) END;

-- B.3 fingerprints. Base hash of the stored tuple, then the occurrence
-- number of that tuple within the row's batch, then the fingerprint.
DROP TEMPORARY TABLE IF EXISTS r82_fp_base;
CREATE TEMPORARY TABLE r82_fp_base (
  id INT PRIMARY KEY,
  batch_id INT NOT NULL,
  company_id INT NULL,
  bank_account_id INT NOT NULL,
  tuple_text TEXT NOT NULL,
  tuple_hash CHAR(64) NOT NULL,
  n INT NULL,
  fp CHAR(64) NULL,
  KEY k_batch_hash (batch_id, tuple_hash, id)
);
INSERT INTO r82_fp_base (id, batch_id, company_id, bank_account_id, tuple_text, tuple_hash)
SELECT l.id, l.batch_id, l.company_id, l.bank_account_id, x.tuple_text, SHA2(x.tuple_text, 256)
FROM bank_recon_statement_lines l
JOIN (
  SELECT id, CONCAT_WS(CHAR(31 USING utf8mb4),
           'v2',
           DATE_FORMAT(txn_date, '%Y-%m-%d'),
           IF(debit > 0, 'OUT', 'IN'),
           CAST(IF(debit > 0, debit, credit) * 100 AS UNSIGNED),
           COALESCE(check_no, ''),
           COALESCE(reference_no, ''),
           COALESCE(description, '')) AS tuple_text
  FROM bank_recon_statement_lines
  WHERE row_fingerprint IS NULL
) x ON x.id = l.id
WHERE l.row_fingerprint IS NULL AND l.bank_account_id IS NOT NULL;

DROP TEMPORARY TABLE IF EXISTS r82_fp_counts;
CREATE TEMPORARY TABLE r82_fp_counts (id INT PRIMARY KEY, n INT NOT NULL);
INSERT INTO r82_fp_counts (id, n)
SELECT a.id, 1 + (
  SELECT COUNT(*) FROM bank_recon_statement_lines p
  WHERE p.batch_id = a.batch_id AND p.id < a.id
    AND SHA2(CONCAT_WS(CHAR(31 USING utf8mb4), 'v2', DATE_FORMAT(p.txn_date, '%Y-%m-%d'), IF(p.debit > 0, 'OUT', 'IN'),
          CAST(IF(p.debit > 0, p.debit, p.credit) * 100 AS UNSIGNED), COALESCE(p.check_no, ''), COALESCE(p.reference_no, ''),
          COALESCE(p.description, '')), 256) = a.tuple_hash
)
FROM r82_fp_base a;
UPDATE r82_fp_base a JOIN r82_fp_counts c ON c.id = a.id
SET a.n = c.n, a.fp = SHA2(CONCAT(a.tuple_text, '#', c.n), 256);

-- Historical cross-session duplicates: only the earliest copy (per
-- company + bank account) keeps the fingerprint.
DROP TEMPORARY TABLE IF EXISTS r82_fp_first;
CREATE TEMPORARY TABLE r82_fp_first (fp CHAR(64) NOT NULL, company_key BIGINT NOT NULL, bank_account_id INT NOT NULL, first_id INT NOT NULL,
  PRIMARY KEY (fp, company_key, bank_account_id));
INSERT INTO r82_fp_first (fp, company_key, bank_account_id, first_id)
SELECT a.fp, COALESCE(a.company_id, -1), a.bank_account_id, MIN(a.id)
FROM r82_fp_base a
GROUP BY a.fp, COALESCE(a.company_id, -1), a.bank_account_id;

-- ...and never one already stored on an earlier-filled row (re-run safety).
UPDATE bank_recon_statement_lines l
JOIN r82_fp_base a ON a.id = l.id
JOIN r82_fp_first f ON f.fp = a.fp AND f.company_key = COALESCE(a.company_id, -1) AND f.bank_account_id = a.bank_account_id AND f.first_id = a.id
LEFT JOIN bank_recon_statement_lines taken
  ON taken.row_fingerprint = a.fp AND taken.bank_account_id = a.bank_account_id AND taken.company_id <=> a.company_id
SET l.row_fingerprint = a.fp
WHERE l.row_fingerprint IS NULL AND taken.id IS NULL;

DROP TEMPORARY TABLE IF EXISTS r82_fp_first;
DROP TEMPORARY TABLE IF EXISTS r82_fp_counts;
DROP TEMPORARY TABLE IF EXISTS r82_fp_base;

-- B.4 bank_account_id is resolvable for every row (its session's NOT NULL
-- value): make it NOT NULL - only when the backfill left none empty.
SET @empty = (SELECT COUNT(*) FROM bank_recon_import_batches WHERE bank_account_id IS NULL);
SET @nullable = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_import_batches' AND COLUMN_NAME = 'bank_account_id' AND IS_NULLABLE = 'YES');
SET @sql = IF(@empty = 0 AND @nullable = 1, 'ALTER TABLE bank_recon_import_batches MODIFY bank_account_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @empty = (SELECT COUNT(*) FROM bank_recon_statement_lines WHERE bank_account_id IS NULL);
SET @nullable = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND COLUMN_NAME = 'bank_account_id' AND IS_NULLABLE = 'YES');
SET @sql = IF(@empty = 0 AND @nullable = 1, 'ALTER TABLE bank_recon_statement_lines MODIFY bank_account_id INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE C: keys and constraints
-- ============================================================

-- Owner key on sessions, referenced by the children's composite FKs.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_sessions' AND INDEX_NAME = 'uq_recon_session_owner');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_sessions ADD UNIQUE KEY uq_recon_session_owner (id, company_id, bank_account_id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_import_batches' AND CONSTRAINT_NAME = 'fk_recon_batch_owner');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_import_batches ADD CONSTRAINT fk_recon_batch_owner FOREIGN KEY (session_id, company_id, bank_account_id) REFERENCES bank_recon_sessions (id, company_id, bank_account_id) ON DELETE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND CONSTRAINT_NAME = 'fk_recon_stmt_owner');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_statement_lines ADD CONSTRAINT fk_recon_stmt_owner FOREIGN KEY (session_id, company_id, bank_account_id) REFERENCES bank_recon_sessions (id, company_id, bank_account_id) ON DELETE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The database is the final duplicate guard.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND INDEX_NAME = 'uq_stmt_fingerprint');
SET @sql = IF(@x = 0, 'ALTER TABLE bank_recon_statement_lines ADD UNIQUE KEY uq_stmt_fingerprint (company_id, bank_account_id, row_fingerprint)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- PHASE D: verification (run manually after applying; not part of the
-- idempotent body)
-- ============================================================
-- Rows still without a company (legacy sessions awaiting assignment):
-- SELECT session_id, COUNT(*) FROM bank_recon_statement_lines WHERE company_id IS NULL GROUP BY session_id;
-- Historical duplicate copies left without a fingerprint, for review:
-- SELECT l.id, l.session_id, l.batch_id, l.txn_date, l.debit, l.credit, l.check_no, l.description
-- FROM bank_recon_statement_lines l WHERE l.row_fingerprint IS NULL AND l.company_id IS NOT NULL ORDER BY l.bank_account_id, l.txn_date, l.id;
