-- General Libraries - database-enforced branch-aware code identity.
--
-- genlib_branch_code_scope_migration.sql lets one code exist once per OWNER
-- (UNIQUE company_id, code, branch_scope). Two more rules cannot be written as
-- a unique key, so the application checked them (genlibCodePolicy) - and two
-- concurrent writers could both pass that check:
--   1. a code is EITHER one shared record OR branch-only records, never both;
--   2. branch-only records sharing a code have the same party type.
-- This migration makes the database enforce them for every writer (import,
-- manual create / edit, scripts):
--   general_library_code_registry - one row per (company_id, code) with the
--     number of shared and branch-only records and the branch party type;
--   triggers on general_libraries keep it current. Each trigger UPSERTS the
--     registry row first, which takes an exclusive row lock, so concurrent
--     writers of the same company + code are serialized by InnoDB; then it
--     checks the counts and SIGNALs (SQLSTATE 45000, errno 1644) on a
--     conflict, which fails the statement and undoes the trigger's own change.
--   Same-owner duplicates are still refused by uq_genlib_company_code_branch
--   (ER_DUP_ENTRY), exactly as before.
--
-- No general_libraries row is inserted, updated or deleted. Order: table ->
-- triggers -> recompute every registry row from general_libraries (so a write
-- that lands between the steps can never leave a stale count).
-- Idempotent: safe to run again. Must run AFTER
-- genlib_branch_code_scope_migration.sql.
--
-- Rollback (removes the enforcement only; data untouched):
--   DROP TRIGGER IF EXISTS trg_genlib_code_bi;
--   DROP TRIGGER IF EXISTS trg_genlib_code_bu;
--   DROP TRIGGER IF EXISTS trg_genlib_code_ad;
--   DROP TABLE IF EXISTS general_library_code_registry;

-- 1. Registry table; `code` uses general_libraries.code's own character set and
--    collation, so "the same code" means exactly what it means there.
SET @cs = (SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'code');
SET @co = (SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'code');
SET @sql = CONCAT(
  'CREATE TABLE IF NOT EXISTS general_library_code_registry (',
  ' company_id INT NOT NULL,',
  ' code VARCHAR(50) CHARACTER SET ', @cs, ' COLLATE ', @co, ' NOT NULL,',
  ' shared_count INT NOT NULL DEFAULT 0,',
  ' branch_count INT NOT NULL DEFAULT 0,',
  ' branch_party_type VARCHAR(50) NULL,',
  ' PRIMARY KEY (company_id, code)',
  ') ENGINE=InnoDB'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Triggers.
DROP TRIGGER IF EXISTS trg_genlib_code_bi;
CREATE TRIGGER trg_genlib_code_bi BEFORE INSERT ON general_libraries FOR EACH ROW
BEGIN
  DECLARE v_shared INT DEFAULT 0;
  DECLARE v_branch INT DEFAULT 0;
  DECLARE v_type VARCHAR(50) DEFAULT NULL;
  INSERT INTO general_library_code_registry (company_id, code, shared_count, branch_count, branch_party_type)
  VALUES (NEW.company_id, NEW.code, IF(NEW.branch_id IS NULL, 1, 0), IF(NEW.branch_id IS NULL, 0, 1), IF(NEW.branch_id IS NULL, NULL, NEW.party_type))
  ON DUPLICATE KEY UPDATE
    shared_count = shared_count + IF(NEW.branch_id IS NULL, 1, 0),
    branch_count = branch_count + IF(NEW.branch_id IS NULL, 0, 1),
    branch_party_type = IF(branch_party_type IS NULL AND NEW.branch_id IS NOT NULL, NEW.party_type, branch_party_type);
  SELECT shared_count, branch_count, branch_party_type INTO v_shared, v_branch, v_type
    FROM general_library_code_registry WHERE company_id = NEW.company_id AND code = NEW.code;
  IF v_shared > 0 AND v_branch > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GENLIB_CODE_SHARED_BRANCH_CONFLICT';
  END IF;
  IF NEW.branch_id IS NOT NULL AND UPPER(v_type) <> UPPER(NEW.party_type) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GENLIB_CODE_TYPE_CONFLICT';
  END IF;
END;

DROP TRIGGER IF EXISTS trg_genlib_code_bu;
CREATE TRIGGER trg_genlib_code_bu BEFORE UPDATE ON general_libraries FOR EACH ROW
BEGIN
  DECLARE v_shared INT DEFAULT 0;
  DECLARE v_branch INT DEFAULT 0;
  DECLARE v_type VARCHAR(50) DEFAULT NULL;
  IF NOT (OLD.company_id <=> NEW.company_id) OR OLD.code <> NEW.code
     OR (OLD.branch_id IS NULL) <> (NEW.branch_id IS NULL)
     OR UPPER(OLD.party_type) <> UPPER(NEW.party_type) THEN
    -- take the OLD identity out (locks its registry row) ...
    UPDATE general_library_code_registry
       SET shared_count = shared_count - IF(OLD.branch_id IS NULL, 1, 0),
           branch_count = branch_count - IF(OLD.branch_id IS NULL, 0, 1)
     WHERE company_id = OLD.company_id AND code = OLD.code;
    UPDATE general_library_code_registry SET branch_party_type = NULL
     WHERE company_id = OLD.company_id AND code = OLD.code AND branch_count = 0;
    DELETE FROM general_library_code_registry
     WHERE company_id = OLD.company_id AND code = OLD.code AND shared_count <= 0 AND branch_count <= 0;
    -- ... and put the NEW one in, with the same checks as an insert.
    INSERT INTO general_library_code_registry (company_id, code, shared_count, branch_count, branch_party_type)
    VALUES (NEW.company_id, NEW.code, IF(NEW.branch_id IS NULL, 1, 0), IF(NEW.branch_id IS NULL, 0, 1), IF(NEW.branch_id IS NULL, NULL, NEW.party_type))
    ON DUPLICATE KEY UPDATE
      shared_count = shared_count + IF(NEW.branch_id IS NULL, 1, 0),
      branch_count = branch_count + IF(NEW.branch_id IS NULL, 0, 1),
      branch_party_type = IF(branch_party_type IS NULL AND NEW.branch_id IS NOT NULL, NEW.party_type, branch_party_type);
    SELECT shared_count, branch_count, branch_party_type INTO v_shared, v_branch, v_type
      FROM general_library_code_registry WHERE company_id = NEW.company_id AND code = NEW.code;
    IF v_shared > 0 AND v_branch > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GENLIB_CODE_SHARED_BRANCH_CONFLICT';
    END IF;
    IF NEW.branch_id IS NOT NULL AND UPPER(v_type) <> UPPER(NEW.party_type) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GENLIB_CODE_TYPE_CONFLICT';
    END IF;
  END IF;
END;

DROP TRIGGER IF EXISTS trg_genlib_code_ad;
CREATE TRIGGER trg_genlib_code_ad AFTER DELETE ON general_libraries FOR EACH ROW
BEGIN
  UPDATE general_library_code_registry
     SET shared_count = shared_count - IF(OLD.branch_id IS NULL, 1, 0),
         branch_count = branch_count - IF(OLD.branch_id IS NULL, 0, 1)
   WHERE company_id = OLD.company_id AND code = OLD.code;
  UPDATE general_library_code_registry SET branch_party_type = NULL
   WHERE company_id = OLD.company_id AND code = OLD.code AND branch_count = 0;
  DELETE FROM general_library_code_registry
   WHERE company_id = OLD.company_id AND code = OLD.code AND shared_count <= 0 AND branch_count <= 0;
END;

-- 3. Recompute every registry row from the records (absolute values, so it is
--    correct whatever ran before), then drop rows no record holds any more.
INSERT INTO general_library_code_registry (company_id, code, shared_count, branch_count, branch_party_type)
SELECT company_id, code, SUM(branch_id IS NULL), SUM(branch_id IS NOT NULL), MIN(IF(branch_id IS NULL, NULL, party_type))
  FROM general_libraries
 GROUP BY company_id, code
ON DUPLICATE KEY UPDATE
  shared_count = VALUES(shared_count),
  branch_count = VALUES(branch_count),
  branch_party_type = VALUES(branch_party_type);

DELETE r FROM general_library_code_registry r
  LEFT JOIN general_libraries g ON g.company_id = r.company_id AND g.code = r.code
 WHERE g.id IS NULL;
