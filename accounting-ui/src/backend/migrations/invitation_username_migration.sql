-- Invitation username (login identity model: full name / username / email).
--
-- users already has everything the model needs: users.username (VARCHAR(100),
-- UNIQUE) and users.email (VARCHAR(255), UNIQUE uq_users_email), both
-- utf8mb4_0900_ai_ci - unique and matched case-insensitively. What is missing is
-- a place to keep the username an administrator chooses at invitation time
-- until the invitee accepts (acceptance used to copy the e-mail into
-- users.username). This adds that column and nothing else.
--
-- Nullable on purpose: invitations created before this column existed have no
-- username and keep their previous behaviour on acceptance (username = e-mail).
-- No row is changed. Idempotent (information_schema guard) - safe to re-run.
-- Must run AFTER invitations_migration.sql.

SET @c = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invitations' AND COLUMN_NAME = 'username');
SET @sql = IF(@c = 0, 'ALTER TABLE invitations ADD COLUMN username VARCHAR(100) NULL AFTER email', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Lookup index for the "already pending for this username" check.
SET @c = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invitations' AND INDEX_NAME = 'idx_invitations_username_status');
SET @sql = IF(@c = 0, 'ALTER TABLE invitations ADD INDEX idx_invitations_username_status (username, status)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
