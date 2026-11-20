-- RFP supporting documents (receipt images / PDFs): metadata only.
-- Idempotent: CREATE TABLE IF NOT EXISTS. New table only - no existing
-- table, row or permission is changed. Safe to re-run.
--
-- The file bytes are NOT stored in MySQL. They live in the private
-- attachment store (lib/attachmentStorage.js: a directory outside the web
-- root, ATTACHMENT_STORAGE_DIR), under a server-generated key that never
-- contains any part of the uploaded filename. Files are only ever served by
-- the authenticated, company-scoped download routes.
--
-- Ownership: rfp_id + company_id (the RFP's own company, copied at upload so
-- every read can be company-scoped without trusting the client). An APV
-- created from the RFP reaches these rows through rfp_headers.converted_apv_id
-- - the file is never copied to the APV.
--
-- Removal is a soft delete (deleted_at / deleted_by): the row and the file
-- are kept as audit evidence; only a never-submitted DRAFT RFP that is itself
-- hard-deleted takes its attachment rows with it (the audit log keeps their
-- metadata and SHA-256).
--
-- No new permissions: upload / remove use TRANSACTIONS.RFP EDIT, viewing uses
-- TRANSACTIONS.RFP VIEW, and viewing through the APV uses TRANSACTIONS.APV
-- VIEW.
--
-- Rollback (if ever needed): DROP TABLE rfp_attachments; then delete the
-- stored files under ATTACHMENT_STORAGE_DIR/rfp/.

CREATE TABLE IF NOT EXISTS rfp_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rfp_id INT NOT NULL,
  company_id INT NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'RECEIPT',
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  uploaded_by INT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_by INT NULL,
  deleted_at DATETIME NULL,
  UNIQUE KEY uq_rfp_attachment_storage_key (storage_key),
  INDEX idx_rfp_attachments_rfp (rfp_id, deleted_at),
  INDEX idx_rfp_attachments_company (company_id),
  CONSTRAINT fk_rfp_attachments_rfp FOREIGN KEY (rfp_id) REFERENCES rfp_headers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfp_attachments_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rfp_attachments_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_rfp_attachments_deleter FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
