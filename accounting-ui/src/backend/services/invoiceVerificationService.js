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

// ---------------------------------------------------------------------------
// Canonical signature input (signature format v2)
// ---------------------------------------------------------------------------
// The defect this fixes: issuance used to sign the totals as JavaScript
// numbers taken from the request (9000), while verification re-signed the
// persisted row, where mysql2 returns DECIMAL columns as strings ("9000.00").
// JSON.stringify(9000) !== JSON.stringify("9000.00"), so no normally posted
// invoice could ever verify.
//
// Now BOTH sides (a) read the protected fields from the PERSISTED row with the
// same SELECT (SIGNED_ROW_COLUMNS) and (b) pass every value through the same
// canonicalizer before signing. Each logical value has exactly ONE byte
// representation:
//   money    fixed-scale decimal string, MONEY_SCALE (2) places - the scale of
//            invoice_headers.total_debit / total_credit DECIMAL(15,2).
//            9000, "9000", "9000.0", "9000.00" -> "9000.00"; 100.5 -> "100.50".
//            Parsed and padded as TEXT - no floating-point arithmetic. A value
//            with non-zero digits beyond the scale (one the column cannot
//            hold) or a non-decimal / exponent form is refused, never rounded.
//   integer  ids as base-10 integer strings ("55"), whether the driver or a
//            caller supplied 55 or "55"; null stays null.
//   date     "YYYY-MM-DD" only.
//   text     the exact stored string (no trimming / case folding - the
//            persisted bytes are the document's identity); null stays null.
// The payload carries "v": 2, so a v2 payload can never collide with the
// legacy format below.
const SIGNATURE_VERSION = 2;
const MONEY_SCALE = 2;

class CanonicalValueError extends Error {}

function canonicalMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalValueError("money value is not finite");
    text = String(value); // shortest round-trip form; no arithmetic is done on it
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new CanonicalValueError("money value has an unsupported type");
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new CanonicalValueError("money value is not a plain decimal");
  const [, sign, intDigits, fracDigits = ""] = m;
  const extra = fracDigits.slice(MONEY_SCALE);
  if (/[^0]/.test(extra)) throw new CanonicalValueError(`money value has more than ${MONEY_SCALE} decimal places`);
  const intPart = intDigits.replace(/^0+(?=\d)/, "");
  const fracPart = fracDigits.slice(0, MONEY_SCALE).padEnd(MONEY_SCALE, "0");
  const isZero = /^0+$/.test(intPart) && /^0+$/.test(fracPart);
  return `${sign === "-" && !isZero ? "-" : ""}${intPart}.${fracPart}`;
}

function canonicalInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : null) : String(value).trim();
  if (text === null || !/^-?\d+$/.test(text)) throw new CanonicalValueError("id value is not an integer");
  return text.replace(/^(-?)0+(?=\d)/, "$1");
}

function canonicalDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new CanonicalValueError("date value is not YYYY-MM-DD");
  return text;
}

function canonicalText(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

const CANONICALIZERS = {
  voucherNo: canonicalText,
  transactionDate: canonicalDate,
  customerId: canonicalInteger,
  customerName: canonicalText,
  totalDebit: canonicalMoney,
  totalCredit: canonicalMoney,
  currencyId: canonicalInteger,
  companyId: canonicalInteger,
  verificationToken: canonicalText,
};

// Canonical, order-fixed JSON: {"v":2, <PROTECTED_FIELDS in order>}.
function buildCanonicalPayload(row) {
  const ordered = { v: SIGNATURE_VERSION };
  for (const key of PROTECTED_FIELDS) ordered[key] = CANONICALIZERS[key](row[key]);
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// Legacy signature format (v1) - verification only, never issued any more
// ---------------------------------------------------------------------------
// Every signature minted before this fix is v1: JSON of PROTECTED_FIELDS with
// the totals as the JavaScript NUMBER issuance had (currencyResult's
// base totals, the same value stored in the DECIMAL(15,2) column) and the
// other fields exactly as persisted. Those invoices are already printed /
// emailed with their QR code, so they are not silently invalidated:
// verification reconstructs that ONE legacy form from the persisted row
// (totals = Number(stored DECIMAL); every other field as stored) and accepts
// it only on an exact HMAC match. This is a single deterministic
// reconstruction, not a set of formatting variants, and it is computed from
// the same persisted values - any change to a protected field still breaks it.
function buildLegacyPayload(row) {
  const ordered = {};
  for (const key of PROTECTED_FIELDS) {
    const v = row[key] ?? null;
    ordered[key] = (key === "totalDebit" || key === "totalCredit") && v !== null ? Number(v) : v;
  }
  return JSON.stringify(ordered);
}

function getHmacSecret() {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new Error(
      "HMAC_SECRET environment variable is not set - invoice verification signing/verification is unavailable."
    );
  }
  return secret;
}

function hmac(payload) {
  return crypto.createHmac("sha256", getHmacSecret()).update(payload).digest("hex");
}

// The signature every issuance / re-sign now produces (canonical v2).
function computeSignature(row) {
  return hmac(buildCanonicalPayload(row));
}

// Verification-only reconstruction of a pre-fix (v1) signature.
function computeLegacySignature(row) {
  return hmac(buildLegacyPayload(row));
}

// The persisted protected fields, read exactly the same way by issuance,
// re-signing and verification (DATE_FORMAT keeps the date timezone-free).
const SIGNED_ROW_COLUMNS = `
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
      verification_signature AS verificationSignature`;

async function loadSignedRowById(conn, invoiceId) {
  const [rows] = await conn.execute(`SELECT ${SIGNED_ROW_COLUMNS} FROM invoice_headers WHERE id = ?`, [invoiceId]);
  if (!rows.length) throw new Error(`Invoice ${invoiceId} not found while signing its verification data.`);
  return rows[0];
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
//
// QR fix: the signature is computed from the PERSISTED row (read back in this
// same transaction with SIGNED_ROW_COLUMNS - the exact query verification
// uses), never from the request's own values. The caller's field arguments
// are accepted for call-site compatibility but are deliberately not signed:
// signing what was stored is what guarantees issuance and verification see
// byte-identical input.
async function issueVerification(conn, { invoiceId }) {
  const verificationToken = generateVerificationToken();
  await conn.execute(`UPDATE invoice_headers SET verification_token = ? WHERE id = ?`, [verificationToken, invoiceId]);
  const row = await loadSignedRowById(conn, invoiceId);
  const signature = computeSignature(row);
  await conn.execute(`UPDATE invoice_headers SET verification_signature = ? WHERE id = ?`, [signature, invoiceId]);
  return { verificationToken, signature };
}

// Public lookup path - by token ONLY, never by id/voucher_no, so a caller
// who doesn't already hold a valid token cannot probe for one.
// DATE_FORMAT on transaction_date follows the same plain-YYYY-MM-DD
// convention as GET /api/invoices/:id and the atp_date fixes, so the same
// bytes get signed/verified regardless of server timezone.
async function findByToken(token) {
  const [rows] = await pool.execute(`SELECT ${SIGNED_ROW_COLUMNS} FROM invoice_headers WHERE verification_token = ?`, [token]);
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

  // Canonical v2 first (every signature issued since the QR fix), then the
  // single legacy v1 reconstruction (signatures issued before it). Both are
  // exact, timing-safe HMAC comparisons over the CURRENT persisted values.
  // A value that cannot be canonicalized (corrupted / out-of-scale data) can
  // never produce a valid v2 signature - it is classified "altered", never a
  // server error.
  let expected = null;
  try {
    expected = computeSignature(row);
  } catch (err) {
    if (!(err instanceof CanonicalValueError)) throw err;
  }
  if (expected && signaturesMatch(expected, row.verificationSignature)) {
    return { valid: true, reason: "valid" };
  }
  if (signaturesMatch(computeLegacySignature(row), row.verificationSignature)) {
    return { valid: true, reason: "valid_legacy" };
  }
  return { valid: false, reason: "altered" };
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
//
// QR fix: like issuance, the new signature is computed from the PERSISTED
// (already-updated) row with SIGNED_ROW_COLUMNS; the field arguments are
// accepted for call-site compatibility only.
async function reSignVerification(conn, { invoiceId, verificationToken }) {
  if (!verificationToken) {
    // Defensive only: every row reaches here through issueVerification()
    // first (POST always runs before any PUT can target the same id), so
    // this should be unreachable - but if it somehow isn't, silently
    // leaving verification_signature NULL is safer than signing over a
    // token that doesn't exist yet.
    return null;
  }

  const row = await loadSignedRowById(conn, invoiceId);
  if (row.verificationToken !== verificationToken) {
    throw new Error(`Invoice ${invoiceId} verification token changed while re-signing.`);
  }
  const signature = computeSignature(row);
  await conn.execute(`UPDATE invoice_headers SET verification_signature = ? WHERE id = ?`, [signature, invoiceId]);
  return signature;
}

module.exports = {
  PROTECTED_FIELDS,
  SIGNATURE_VERSION,
  MONEY_SCALE,
  CanonicalValueError,
  canonicalMoney,
  canonicalInteger,
  canonicalDate,
  buildCanonicalPayload,
  buildLegacyPayload,
  issueVerification,
  reSignVerification,
  findByToken,
  classifyInvoice,
  computeSignature,
  computeLegacySignature,
  generateVerificationToken,
};
