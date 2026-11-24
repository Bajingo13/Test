-- Maker-Checker Release 1 (migration 69): who prepared, last edited and posted
-- each transaction, for the eight posting modules.
--
-- Columns (all NULLable, additive - nothing is dropped or retyped):
--   created_by  on invoice / OR / APV / CV / purchase order (JV, memo and petty
--               cash already have it)
--   updated_by  (last editor) on all eight header tables
--   posted_by / posted_at on invoice / OR / APV / CV / purchase order (JV, memo
--               and petty cash already have them)
-- No foreign keys (a deleted user must never block or cascade into accounting
-- history), the same as the existing created_by / posted_by columns.
--
-- Backfill - ONLY from reliable evidence and ONLY for DRAFT rows (no posted or
-- otherwise finalized accounting record is touched):
--   created_by: the user of the record's single CREATE audit entry, when there
--               is EXACTLY ONE such entry, it names a user that still exists,
--               and its company matches (or is not recorded). Anything else
--               stays NULL - posting is then refused until a Super Admin
--               records the maker through the audited POST /api/posting/maker.
--   updated_by: the user of the most recent EDIT / UPDATE audit entry, only
--               where the maker was established above and such an entry exists.
-- Idempotent (information_schema guards; backfills only fill NULLs) - safe to
-- re-run. Must run after audit_logs and every header table exist.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'created_by');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD COLUMN posted_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD COLUMN posted_at TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE invoice_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'created_by');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN posted_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN posted_at TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'or_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE or_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'created_by');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD COLUMN posted_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD COLUMN posted_at TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'apv_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE apv_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'created_by');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN posted_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN posted_at TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE cv_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'created_by');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN created_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN posted_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN posted_at TIMESTAMP NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_order_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE purchase_order_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jv_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE jv_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memo_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE memo_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'petty_cash_headers' AND COLUMN_NAME = 'updated_by');
SET @sql = IF(@c = 0, 'ALTER TABLE petty_cash_headers ADD COLUMN updated_by INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- backfill (Draft rows only) ----
UPDATE invoice_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'INV' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE invoice_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'INV' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE or_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'OR' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE or_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'OR' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE apv_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'APV' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE apv_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'APV' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE cv_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'CV' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE cv_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'CV' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE purchase_order_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'PO' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE purchase_order_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'PO' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE jv_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'JV' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE jv_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'JV' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE memo_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type IN ('MEMO_DEBIT', 'MEMO_CREDIT') AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE memo_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type IN ('MEMO_DEBIT', 'MEMO_CREDIT') AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
UPDATE petty_cash_headers h
JOIN (SELECT a.entity_id, MAX(a.user_id) AS uid, COUNT(*) AS n, SUM(a.user_id IS NULL) AS no_user,
             COUNT(DISTINCT a.company_id) AS companies, MAX(a.company_id) AS company_id
        FROM audit_logs a WHERE a.entity_type = 'PETTY_CASH' AND a.action = 'CREATE' GROUP BY a.entity_id) c ON c.entity_id = h.id
SET h.created_by = c.uid
WHERE h.created_by IS NULL AND UPPER(h.status) = 'DRAFT'
  AND c.n = 1 AND c.no_user = 0 AND c.companies <= 1 AND (c.company_id IS NULL OR c.company_id = h.company_id)
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.uid);
UPDATE petty_cash_headers h
JOIN (SELECT a.entity_id, MAX(a.id) AS last_id FROM audit_logs a
       WHERE a.entity_type = 'PETTY_CASH' AND a.action IN ('EDIT', 'UPDATE') AND a.user_id IS NOT NULL GROUP BY a.entity_id) e ON e.entity_id = h.id
JOIN audit_logs le ON le.id = e.last_id
SET h.updated_by = le.user_id
WHERE h.updated_by IS NULL AND h.created_by IS NOT NULL AND UPPER(h.status) = 'DRAFT'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = le.user_id);
