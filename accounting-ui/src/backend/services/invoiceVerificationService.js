const crypto = require("crypto");
const pool = require("../db");

// Public invoice verification: QR-scannable token + HMAC tamper detection.
//
// Two concerns, kept in one small service since they share the same
// protected-field definition:
//   1. verification_token - a cryptographically random, public identifier
//      (never the voucher_no, never the internal id) minted once at
//      issuance (first successful POST /api/invoices) and never
//      regenerated on reprint/PDF export/email - see issueVerification().
//   2. verification_signature - an HMAC-SHA256 over a fixed, intentionally
//      narrow set of protected fields (see PROTECTED_FIELDS below),
//      recomputed at verification time from the CURRENT persisted row and
//      compared with a timing-safe equality check.
//
// PROTECTED_FIELDS deliberately excludes anything that legitimately
// changes after issuance through normal business operations:
//   - paid_amount / balance_amount change every time a payment is applied
//     - including them would flag every partially-paid invoice as
//       "altered" the moment a real payment posts.
//   - status changes on legitimate DRAFT -> POSTED progression, and later
//     VOID/CANCELLED - included here it would cause the exact same false
//     positive. A voided/cancelled invoice is instead classified
//     separately (see classifyInvoice below), not via signature mismatch.
//   - updated_at/remarks/UI-layout/template config are display/audit
//     metadata, never the substance of what was issued.
// What IS protected is the financial/legal identity of the document as
// issued: who it's billed to, when, how much, in what currency, for which
// company, under which voucher number - anything a forger would want to
// alter without detection.
const PROTECTED_FIELDS = [
  "voucherNo",
  "transactionDate",
  "customerId",
  "customerName",
  "totalDebit",
  "totalCredit",
  "currencyId",
  "companyId",
  "verificationToken",
];

function getHmacSecret() {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new Error(
      "HMAC_SECRET environment variable is not set - invoice verification signing/verification is unavailable."
    );
  }
  return secret;
}

// Canonical, order-fixed JSON (PROTECTED_FIELDS' own order, not object key
// insertion order) so the exact same logical data always signs to the
// exact same bytes.
function buildProtectedPayload(row) {
  const ordered = {};
  for (const key of PROTECTED_FIELDS) ordered[key] = row[key] ?? null;
  return JSON.stringify(ordered);
}

function computeSignature(row) {
  return crypto.createHmac("sha256", getHmacSecret()).update(buildProtectedPayload(row)).digest("hex");
}

function signaturesMatch(expectedHex, actualHex) {
  if (!expectedHex || !actualHex) return false;
  const a = Buffer.from(String(expectedHex), "hex");
  const b = Buffer.from(String(actualHex), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 32 hex chars - fits verification_token CHAR(32), effectively unguessable
// (128 bits of randomness) and carries no structure that reveals the
// internal id or voucher number.
function generateVerificationToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Called once, inside the same transaction as invoice creation
// (POST /api/invoices in server.js), immediately after the INSERT so the
// row already has its id. Never called again for this invoice afterward -
// reprints, PDF exports, and emails all reuse the token/signature this
// mints here, which is what keeps one QR code valid for the document's
// whole life.
async function issueVerification(conn, { invoiceId, voucherNo, transactionDate, customerId, customerName, totalDebit, totalCredit, currencyId, companyId }) {
  const verificationToken = generateVerificationToken();
  const signature = computeSignature({
    voucherNo,
    transactionDate,
    customerId,
    customerName,
    totalDebit,
    totalCredit,
    currencyId,
    companyId,
    verificationToken,
  });

  await conn.execute(
    `UPDATE invoice_headers SET verification_token = ?, verification_signature = ? WHERE id = ?`,
    [verificationToken, signature, invoiceId]
  );

  return { verificationToken, signature };
}

// Public lookup path - by token ONLY, never by id/voucher_no, so a caller
// who doesn't already hold a valid token cannot probe for one.
// DATE_FORMAT on transaction_date follows the same plain-YYYY-MM-DD
// convention as GET /api/invoices/:id and the atp_date fixes, so the same
// bytes get signed/verified regardless of server timezone.
async function findByToken(token) {
  const [rows] = await pool.execute(
    `SELECT
      id,
      company_id AS companyId,
      voucher_no AS voucherNo,
      customer_id AS customerId,
      customer_name AS customerName,
      DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
      total_debit AS totalDebit,
      total_credit AS totalCredit,
      currency_id AS currencyId,
      status,
      verification_token AS verificationToken,
      verification_signature AS verificationSignature
    FROM invoice_headers
    WHERE verification_token = ?`,
    [token]
  );
  return rows[0] || null;
}

// Internal classification (server-side only - never exposed verbatim to
// the public response, see invoiceVerification.controller.js's "same
// minimal shape for every non-valid case" rule). Useful for audit logging
// and for deciding which invoice to hand to the PDF download path.
function classifyInvoice(row) {
  if (!row) return { valid: false, reason: "not_found" };
  if (!row.verificationToken || !row.verificationSignature) return { valid: false, reason: "not_issued" };

  const statusUpper = String(row.status || "").toUpperCase();
  if (statusUpper === "VOID" || statusUpper === "CANCELLED") {
    return { valid: false, reason: "voided" };
  }

  const expected = computeSignature({
    voucherNo: row.voucherNo,
    transactionDate: row.transactionDate,
    customerId: row.customerId,
    customerName: row.customerName,
    totalDebit: row.totalDebit,
    totalCredit: row.totalCredit,
    currencyId: row.currencyId,
    companyId: row.companyId,
    verificationToken: row.verificationToken,
  });

  if (!signaturesMatch(expected, row.verificationSignature)) {
    return { valid: false, reason: "altered" };
  }

  return { valid: true, reason: "valid" };
}

// Called from PUT /api/invoices/:id, only ever reachable while the
// invoice's stored status is still not POSTED (that route rejects any edit
// to an already-posted row with 409 TRANSACTION_ALREADY_POSTED before this
// could run) - so this always represents a legitimate pre-issuance
// revision, never tampering with an already-issued document. Reuses the
// SAME verification_token minted at creation (never regenerates it -
// keeping the token stable is what lets a QR code printed from an earlier
// draft preview still resolve to the same document later) and simply
// recomputes the signature over the edited protected fields. Once a
// PROTECTED_FIELDS-affecting edit moves the row to POSTED, server.js's own
// immutability rule means this signature can never legitimately change
// again - any later mismatch is exactly the "altered after issuance" case
// classifyInvoice() is meant to catch.
async function reSignVerification(conn, { invoiceId, verificationToken, voucherNo, transactionDate, customerId, customerName, totalDebit, totalCredit, currencyId, companyId }) {
  if (!verificationToken) {
    // Defensive only: every row reaches here through issueVerification()
    // first (POST always runs before any PUT can target the same id), so
    // this should be unreachable - but if it somehow isn't, silently
    // leaving verification_signature NULL is safer than signing over a
    // token that doesn't exist yet.
    return null;
  }

  const signature = computeSignature({
    voucherNo,
    transactionDate,
    customerId,
    customerName,
    totalDebit,
    totalCredit,
    currencyId,
    companyId,
    verificationToken,
  });

  await conn.execute(`UPDATE invoice_headers SET verification_signature = ? WHERE id = ?`, [signature, invoiceId]);
  return signature;
}

module.exports = {
  PROTECTED_FIELDS,
  issueVerification,
  reSignVerification,
  findByToken,
  classifyInvoice,
  computeSignature,
  generateVerificationToken,
};
