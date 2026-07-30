-- Email invitation workflow (Phase 2). Additive only. CREATE TABLE IF NOT
-- EXISTS is natively idempotent, safe to re-run.

CREATE TABLE IF NOT EXISTS invitations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role_id INT NOT NULL,
  company_ids JSON NULL,
  branch_ids JSON NULL,
  permission_template_id INT NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMP NOT NULL,
  invited_by INT NULL,
  accepted_at TIMESTAMP NULL,
  accepted_user_id INT NULL,
  revoked_at TIMESTAMP NULL,
  revoked_by INT NULL,
  resend_count INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP NULL,
  email_delivery_status VARCHAR(20) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (invited_by) REFERENCES users(id),
  FOREIGN KEY (accepted_user_id) REFERENCES users(id),
  FOREIGN KEY (revoked_by) REFERENCES users(id),
  UNIQUE KEY uq_invitations_token_hash (token_hash),
  INDEX idx_invitations_email_status (email, status),
  INDEX idx_invitations_status (status)
);

-- Enforce duplicate-email prevention at the DB level too (not just app
-- logic) - users.email was added nullable in Phase 1, this adds a unique
-- index on it if one doesn't already exist. NULL values don't collide
-- under a UNIQUE index in MySQL, so the pre-invitation admin row (still
-- NULL email) is unaffected.
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_email'
);
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE users ADD UNIQUE INDEX uq_users_email (email)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
