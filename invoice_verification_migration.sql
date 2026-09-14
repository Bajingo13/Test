-- Invoice Verification (QR + tamper detection).
--
-- Adds two additive, nullable columns to invoice_headers:
--   verification_token     - a cryptographically random, public-facing
--                             identifier (never the voucher_no, never the
--                             internal id) used by the public /api/verify/:token
--                             route and the QR code printed beside the
--                             ORIGINAL COPY label. Minted once, at issuance,
--                             by invoiceVerificationService.js and never
--                             regenerated on reprint/PDF export/email, so a
--                             single QR code stays valid for the life of the
--                             document.
--   verification_signature - an HMAC-SHA256 (hex, 64 chars) over a fixed set
--                             of protected, issuance-time fields (see
--                             invoiceVerificationService.js's PROTECTED_FIELDS
--                             for the exact list and rationale). Recomputed
--                             at verification time from current persisted
--                             data and compared with a timing-safe equality
--                             check; a mismatch means the protected data
--                             changed after issuance.
--
-- Both columns are NULL for every historical invoice (no backfill) - the
-- verification service treats a NULL token/signature as "not yet issued /
-- not verifiable", never as an error. Guarded by information_schema, same
-- pattern as invoice_terms_migration.sql; re-run is a no-op.

SET @token_col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoice_headers'
    AND COLUMN_NAME = 'verification_token'
);
SET @sql = IF(
  @token_col_exists = 0,
  "ALTER TABLE invoice_headers ADD COLUMN verification_token CHAR(32) NULL AFTER currency_id",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sig_col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoice_headers'
    AND COLUMN_NAME = 'verification_signature'
);
SET @sql = IF(
  @sig_col_exists = 0,
  "ALTER TABLE invoice_headers ADD COLUMN verification_signature CHAR(64) NULL AFTER verification_token",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Uniqueness matters for the token (it is a lookup key on a public,
-- unauthenticated route) - guarded separately since ADD COLUMN and ADD
-- INDEX use different information_schema checks.
SET @token_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'invoice_headers'
    AND INDEX_NAME = 'uq_invoice_headers_verification_token'
);
SET @sql = IF(
  @token_index_exists = 0,
  "ALTER TABLE invoice_headers ADD UNIQUE INDEX uq_invoice_headers_verification_token (verification_token)",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
