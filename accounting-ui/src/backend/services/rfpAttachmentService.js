// RFP supporting documents (receipt images / PDFs).
//
// Metadata lives in rfp_attachments; the bytes live in the private
// attachment store (lib/attachmentStorage.js) under a server-generated key.
// Every read and write goes through the RFP's own company scope
// (rfpService.loadAccessibleRfp): another company's RFP, an unknown id and
// a removed attachment all produce the same 404.
//
//   list / download  TRANSACTIONS.RFP VIEW   any status
//   upload / remove  TRANSACTIONS.RFP EDIT   only while DRAFT or RETURNED -
//                    once submitted, the documents the approver saw are
//                    frozen with the request
//   via the APV      TRANSACTIONS.APV VIEW   the APV's company; reaches the
//                    RFP whose converted_apv_id is that APV (no copy)
//
// Removal is a soft delete: the row and the file stay as audit evidence.
// Upload and removal each write one audit_logs row in the same transaction.

const pool = require("../db");
const { logAudit } = require("../lib/audit");
const storage = require("../lib/attachmentStorage");
const { validateAttachmentFile } = require("../lib/attachmentFileType");
const { loadAccessibleRfp, parseId, httpError, EDITABLE_STATUSES } = require("./rfpService");

const MODULE = "TRANSACTIONS.RFP";
const ENTITY = "RFP";
const MAX_ATTACHMENTS_PER_RFP = 10;
const CATEGORIES = ["RECEIPT", "SUPPORTING_DOCUMENT"];
const ATTACHMENT_NOT_FOUND = "Attachment not found";

function parseCategory(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "RECEIPT";
  const c = String(value).trim().toUpperCase();
  if (!CATEGORIES.includes(c)) throw httpError(`Category must be one of: ${CATEGORIES.join(", ")}.`, 400);
  return c;
}

function toDto(row) {
  return {
    id: row.id,
    rfpId: row.rfp_id,
    category: row.category,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
    uploadedBy: row.uploaded_by,
    uploadedByUsername: row.uploaded_by_username ?? null,
    uploadedAt: row.uploaded_at,
  };
}

// The audit view of an attachment: metadata only, never the storage key.
function auditView(row) {
  return {
    attachmentId: row.id,
    category: row.category,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    sha256: row.sha256,
  };
}

async function activeRows(db, rfpId, companyId) {
  const [rows] = await db.execute(
    `SELECT a.*, u.username AS uploaded_by_username
     FROM rfp_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.rfp_id = ? AND a.company_id = ? AND a.deleted_at IS NULL
     ORDER BY a.uploaded_at, a.id`,
    [rfpId, companyId]
  );
  return rows;
}

async function activeRow(db, rfpId, companyId, attachmentId, { forUpdate = false } = {}) {
  const [rows] = await db.execute(
    `SELECT * FROM rfp_attachments
     WHERE id = ? AND rfp_id = ? AND company_id = ? AND deleted_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
    [attachmentId, rfpId, companyId]
  );
  if (!rows.length) throw httpError(ATTACHMENT_NOT_FOUND, 404);
  return rows[0];
}

// Reads the stored bytes and proves they are the bytes that were uploaded.
async function readVerified(row) {
  let buffer;
  try {
    buffer = await storage.read(row.storage_key);
  } catch (err) {
    console.error("RFP ATTACHMENT READ ERROR:", row.id, err.code || err.message);
    throw httpError("The stored file for this attachment is missing.", 410);
  }
  if (buffer.length !== Number(row.file_size) || storage.sha256(buffer) !== row.sha256) {
    console.error("RFP ATTACHMENT INTEGRITY ERROR:", row.id);
    throw httpError("The stored file failed its integrity check and was not sent.", 500);
  }
  return { buffer, mimeType: row.mime_type, filename: row.original_filename, sha256: row.sha256 };
}

async function listRfpAttachments({ id, user }) {
  const rfpId = parseId(id, "RFP id");
  const header = await loadAccessibleRfp(pool, rfpId, user);
  return (await activeRows(pool, rfpId, header.company_id)).map(toDto);
}

async function uploadRfpAttachment({ id, user, file, body = {} }) {
  const rfpId = parseId(id, "RFP id");
  const checked = validateAttachmentFile(file);
  const category = parseCategory(body.category);
  const hash = storage.sha256(file.buffer);

  const conn = await pool.getConnection();
  let storedKey = null;
  try {
    await conn.beginTransaction();
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    if (!EDITABLE_STATUSES.includes(header.status)) {
      throw httpError(`Attachments can only be added while the Request for Payment is DRAFT or RETURNED (this one is ${header.status}).`, 409);
    }
    const existing = await activeRows(conn, rfpId, header.company_id);
    if (existing.length >= MAX_ATTACHMENTS_PER_RFP) {
      throw httpError(`A Request for Payment can have at most ${MAX_ATTACHMENTS_PER_RFP} attachments.`, 409);
    }
    const duplicate = existing.find((r) => r.sha256 === hash);
    if (duplicate) throw httpError(`This file is already attached as "${duplicate.original_filename}".`, 409);

    storedKey = storage.newKey(header.company_id);
    await storage.put(storedKey, file.buffer);
    const [result] = await conn.execute(
      `INSERT INTO rfp_attachments (rfp_id, company_id, category, original_filename, storage_key, mime_type, file_size, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rfpId, header.company_id, category, checked.filename, storedKey, checked.mimeType, file.buffer.length, hash, user.id]
    );
    const [[row]] = await conn.execute(
      `SELECT a.*, u.username AS uploaded_by_username FROM rfp_attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = ?`,
      [result.insertId]
    );
    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action: "ATTACHMENT_UPLOAD",
      description: `${user.username} attached "${checked.filename}" to Request for Payment ${header.rfp_no}`,
      afterData: { rfpNo: header.rfp_no, companyId: header.company_id, status: header.status, ...auditView(row) },
      user,
      companyId: header.company_id,
    });
    await conn.commit();
    return toDto(row);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (storedKey) await storage.remove(storedKey).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function downloadRfpAttachment({ id, attachmentId, user }) {
  const rfpId = parseId(id, "RFP id");
  const attId = parseId(attachmentId, "Attachment id");
  const header = await loadAccessibleRfp(pool, rfpId, user);
  return readVerified(await activeRow(pool, rfpId, header.company_id, attId));
}

async function removeRfpAttachment({ id, attachmentId, user }) {
  const rfpId = parseId(id, "RFP id");
  const attId = parseId(attachmentId, "Attachment id");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    const row = await activeRow(conn, rfpId, header.company_id, attId, { forUpdate: true });
    if (!EDITABLE_STATUSES.includes(header.status)) {
      throw httpError(`Attachments can only be removed while the Request for Payment is DRAFT or RETURNED (this one is ${header.status}).`, 409);
    }
    await conn.execute(
      "UPDATE rfp_attachments SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL",
      [user.id, attId]
    );
    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action: "ATTACHMENT_REMOVE",
      description: `${user.username} removed attachment "${row.original_filename}" from Request for Payment ${header.rfp_no}`,
      beforeData: { rfpNo: header.rfp_no, companyId: header.company_id, status: header.status, ...auditView(row) },
      user,
      companyId: header.company_id,
    });
    await conn.commit();
    return { id: attId, rfpId, removed: true };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// --- through the APV -------------------------------------------------------

function isSuperAdmin(user) {
  return user?.roleCode === "SUPER_ADMIN";
}

// The APV must be in one of the caller's companies (404 otherwise, same as
// an unknown id). Its source RFP is the one whose converted_apv_id is this
// APV, in the same company; an APV not created from an RFP has none.
async function loadApvSource(apvId, user) {
  const scope = isSuperAdmin(user)
    ? { sql: "", params: [] }
    : { sql: " AND a.company_id IN (SELECT uc.company_id FROM user_companies uc WHERE uc.user_id = ?)", params: [user?.id ?? 0] };
  const [apvs] = await pool.execute(`SELECT a.id, a.company_id, a.voucher_no FROM apv_headers a WHERE a.id = ?${scope.sql}`, [apvId, ...scope.params]);
  if (!apvs.length) throw httpError("APV not found", 404);
  const apv = apvs[0];
  const [rfps] = await pool.execute(
    "SELECT id, rfp_no, status, company_id FROM rfp_headers WHERE converted_apv_id = ? AND company_id = ?",
    [apv.id, apv.company_id]
  );
  return { apv, rfp: rfps[0] || null };
}

async function listApvAttachments({ apvId, user }) {
  const id = parseId(apvId, "APV id");
  const { apv, rfp } = await loadApvSource(id, user);
  return {
    apvId: apv.id,
    sourceRfp: rfp ? { id: rfp.id, rfpNo: rfp.rfp_no, status: rfp.status } : null,
    attachments: rfp ? (await activeRows(pool, rfp.id, rfp.company_id)).map(toDto) : [],
  };
}

async function downloadApvAttachment({ apvId, attachmentId, user }) {
  const id = parseId(apvId, "APV id");
  const attId = parseId(attachmentId, "Attachment id");
  const { rfp } = await loadApvSource(id, user);
  if (!rfp) throw httpError(ATTACHMENT_NOT_FOUND, 404);
  return readVerified(await activeRow(pool, rfp.id, rfp.company_id, attId));
}

module.exports = {
  MAX_ATTACHMENTS_PER_RFP,
  CATEGORIES,
  listRfpAttachments,
  uploadRfpAttachment,
  downloadRfpAttachment,
  removeRfpAttachment,
  listApvAttachments,
  downloadApvAttachment,
};
