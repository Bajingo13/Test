-- SUPER_ADMIN notification e-mail: verification before activation.
--
-- A SUPER_ADMIN registers or changes the e-mail address that receives security
-- notices (Account Security). The new address is NOT written to users.email
-- until its owner proves control of it with a one-time link sent to that
-- address. This table holds those pending requests:
--   - token_hash: SHA-256 of the raw token (the raw token exists only in the
--     e-mailed link - same principle as invitations.token_hash);
--   - expires_at: short lifetime (set by the application);
--   - status: PENDING -> USED (verified) | SUPERSEDED (a newer request replaced
--     it) | CANCELLED (the address became unavailable before verification).
--     A row is never reusable once it leaves PENDING.
-- users.email itself is unchanged (already VARCHAR(255), UNIQUE uq_users_email).
-- New table only - no existing row is changed. Idempotent (CREATE TABLE IF NOT
-- EXISTS) - safe to re-run. Must run AFTER the users table exists.

CREATE TABLE IF NOT EXISTS account_email_verifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  new_email VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_account_email_verifications_token (token_hash),
  KEY idx_account_email_verifications_user_status (user_id, status),
  KEY idx_account_email_verifications_email_status (new_email, status),
  CONSTRAINT fk_account_email_verifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
