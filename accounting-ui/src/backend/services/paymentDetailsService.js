const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");

// R9: the one place that decides what an OR / CV payment is and which
// payment fields it may carry. Used by POST/PUT /api/or, /api/cv and bulk
// posting; Bank Reconciliation reads the stored result.
//
// Stored payment_method values (existing rows keep theirs):
//   "Cash"           cash; no check fields, no transfer fields
//   "Check"          check_no (the actual check number, kept as text) +
//                    check_date (the date on the check)
//   "Bank Transfer"  payment_reference (the bank's transfer / reference
//                    number) + payment_date (the transfer date)
// bank_account_id: the bank account the money moved through - required to
// post a Check or Bank Transfer, optional for Cash (cash deposited directly).
// It must exist and be ACTIVE. Known limitation BANK-OWNERSHIP-01:
// bank_codes has no company column - bank accounts are shared master data -
// so "this company's bank account" cannot be enforced yet; that ownership
// model is a separate schema / design phase.
//
// An omitted method is only a compatibility fallback for API callers (the
// OR / CV forms always send one): check number -> Check, transfer reference
// -> Bank Transfer, otherwise Cash. An explicit but unknown method is a 400,
// never reinterpreted.
//
// Bank Reconciliation reads these fields (check_no / check date for checks,
// payment_reference / transfer date for transfers). R9 does NOT change how
// Cash vouchers count as bank movement (deferred until the historical
// population is reviewed - see scripts/r9PaymentFieldAudit.sql).
//
// Meaning of the other identifiers (unchanged):
//   reference_no  the document's own number (the form sends the OR / CV No.)
//   receipt_no    OR only: the receipt number typed in the OR header
//                 (labelled "Receipt No."; before R9 the same field was
//                 mislabelled "Check No."). Never a check number.
//
// Drafts may be incomplete (a check number is often not known yet); the
// required fields are enforced when the document is POSTED. Fields that do
// not belong to the method are refused at any status - the server never
// drops or moves them silently.

const PAYMENT_METHOD = Object.freeze({ CASH: "Cash", CHECK: "Check", BANK_TRANSFER: "Bank Transfer" });

const METHOD_ALIASES = {
  cash: PAYMENT_METHOD.CASH,
  check: PAYMENT_METHOD.CHECK,
  cheque: PAYMENT_METHOD.CHECK,
  "bank transfer": PAYMENT_METHOD.BANK_TRANSFER,
  bank_transfer: PAYMENT_METHOD.BANK_TRANSFER,
  banktransfer: PAYMENT_METHOD.BANK_TRANSFER,
  transfer: PAYMENT_METHOD.BANK_TRANSFER,
};

const present = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
const bad = (message, code) => new HttpError(400, message, code);

function isIsoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}

function parseMethod(raw) {
  if (!present(raw)) return null;
  if (typeof raw !== "string") throw bad("Payment method must be Cash, Check or Bank Transfer.", "INVALID_PAYMENT_METHOD");
  const m = METHOD_ALIASES[raw.trim().toLowerCase()];
  if (!m) throw bad("Payment method must be Cash, Check or Bank Transfer.", "INVALID_PAYMENT_METHOD");
  return m;
}

// Identifiers stay exactly as typed (trimmed): a check number "000123" or
// "AB-77" must never become a number.
function parseText(raw, label, max) {
  if (!present(raw)) return null;
  if (typeof raw !== "string") throw bad(`${label} must be sent as text.`, "PAYMENT_FIELD_NOT_TEXT");
  const v = raw.trim();
  if (v.length > max) throw bad(`${label} is too long (maximum ${max} characters).`, "PAYMENT_FIELD_TOO_LONG");
  return v;
}

function parseDate(raw, label) {
  if (!present(raw)) return null;
  const v = typeof raw === "string" ? raw.trim().slice(0, 10) : raw;
  if (!isIsoDate(v)) throw bad(`${label} must be a valid date (YYYY-MM-DD).`, "INVALID_PAYMENT_DATE");
  return v;
}

function parseBankAccountId(raw) {
  if (!present(raw)) return null;
  const s = String(raw).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s)) throw bad("Invalid bank account.", "INVALID_BANK_ACCOUNT");
  return Number(s);
}

// Validates the payment fields of an OR / CV request body and returns the
// values to store. `conn` checks the bank account; `isPosting` enforces the
// fields a posted payment needs.
async function resolvePaymentDetails(conn, body, { isPosting }) {
  const checkNo = parseText(body.checkNo, "Check number", 100);
  const checkDate = parseDate(body.checkDate, "Check date");
  const paymentReference = parseText(body.paymentReference, "Transfer reference", 100);
  const paymentDate = parseDate(body.paymentDate, "Transfer date");
  const bankAccountId = parseBankAccountId(body.bankAccountId);

  // An omitted method is read from the fields actually sent - never assumed
  // to be a check without a check number.
  let method = parseMethod(body.paymentMethod);
  if (!method) {
    if (checkNo || checkDate) method = PAYMENT_METHOD.CHECK;
    else if (paymentReference || paymentDate) method = PAYMENT_METHOD.BANK_TRANSFER;
    else method = PAYMENT_METHOD.CASH;
  }

  const notAllowed = (field) => bad(`${field} does not belong to a ${method} payment.`, "PAYMENT_FIELD_NOT_ALLOWED");
  if (method !== PAYMENT_METHOD.CHECK) {
    if (checkNo) throw notAllowed("A check number");
    if (checkDate) throw notAllowed("A check date");
  }
  if (method !== PAYMENT_METHOD.BANK_TRANSFER) {
    if (paymentReference) throw notAllowed("A transfer reference");
    if (paymentDate) throw notAllowed("A transfer date");
  }

  if (bankAccountId) {
    const [[bank]] = await conn.execute("SELECT id, status FROM bank_codes WHERE id = ?", [bankAccountId]);
    if (!bank) throw new HttpError(404, "Bank account not found.", "BANK_ACCOUNT_NOT_FOUND");
    if (String(bank.status || "").toUpperCase() !== "ACTIVE") throw bad("The selected bank account is not active.", "BANK_ACCOUNT_INACTIVE");
  }

  if (isPosting) {
    const missing = [];
    if (method === PAYMENT_METHOD.CHECK) {
      if (!bankAccountId) missing.push("bank account");
      if (!checkNo) missing.push("check number");
      if (!checkDate) missing.push("check date");
    } else if (method === PAYMENT_METHOD.BANK_TRANSFER) {
      if (!bankAccountId) missing.push("bank account");
      if (!paymentReference) missing.push("transfer reference");
      if (!paymentDate) missing.push("transfer date");
    }
    if (missing.length) {
      throw bad(`A ${method} payment needs its ${missing.join(", ")} before it can be posted.`, "PAYMENT_DETAILS_INCOMPLETE");
    }
  }

  return {
    paymentMethod: method,
    bankAccountId,
    checkNo: method === PAYMENT_METHOD.CHECK ? checkNo || "" : "",
    checkDate: method === PAYMENT_METHOD.CHECK ? checkDate : null,
    paymentReference: method === PAYMENT_METHOD.BANK_TRANSFER ? paymentReference : null,
    paymentDate: method === PAYMENT_METHOD.BANK_TRANSFER ? paymentDate : null,
  };
}

// The stored payment fields of one document (for edit audits and posting).
async function loadPaymentDetails(conn, table, id) {
  if (!["or_headers", "cv_headers"].includes(table)) throw new Error(`Unknown payment table ${table}`);
  const [[row]] = await conn.execute(
    `SELECT payment_method AS paymentMethod, bank_account_id AS bankAccountId, check_no AS checkNo,
            DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate, payment_reference AS paymentReference,
            DATE_FORMAT(payment_date, '%Y-%m-%d') AS paymentDate
     FROM ${table} WHERE id = ?`,
    [id]
  );
  return row ? normalizeStored(row) : null;
}

function normalizeStored(row) {
  return {
    paymentMethod: row.paymentMethod,
    bankAccountId: row.bankAccountId === null || row.bankAccountId === undefined ? null : Number(row.bankAccountId),
    checkNo: row.checkNo || "",
    checkDate: row.checkDate || null,
    paymentReference: row.paymentReference || null,
    paymentDate: row.paymentDate || null,
  };
}

// What a stored document still needs before it can be posted (bulk
// posting uses this to skip incomplete payments instead of posting them).
function postingGaps(stored) {
  const m = String(stored.paymentMethod || "");
  const gaps = [];
  if (m === PAYMENT_METHOD.CHECK) {
    if (!stored.bankAccountId) gaps.push("bank account");
    if (!stored.checkNo) gaps.push("check number");
    if (!stored.checkDate) gaps.push("check date");
  } else if (m === PAYMENT_METHOD.BANK_TRANSFER) {
    if (!stored.bankAccountId) gaps.push("bank account");
    if (!stored.paymentReference) gaps.push("transfer reference");
    if (!stored.paymentDate) gaps.push("transfer date");
  }
  return gaps;
}

// Audit only when a payment field actually changed (existing audit
// infrastructure; payment identifiers only - nothing sensitive).
async function auditPaymentChange(conn, { module, entityType, entityId, companyId, label, before, after, user }) {
  const keys = ["paymentMethod", "bankAccountId", "checkNo", "checkDate", "paymentReference", "paymentDate"];
  const prev = before ? normalizeStored(before) : null;
  const next = normalizeStored(after);
  if (prev && keys.every((k) => String(prev[k] ?? "") === String(next[k] ?? ""))) return;
  await logAudit(conn, {
    module,
    entityType,
    entityId,
    companyId,
    action: "PAYMENT_DETAILS_CHANGED",
    description: prev
      ? `${label} payment changed from ${prev.paymentMethod} to ${next.paymentMethod}${prev.paymentMethod === next.paymentMethod ? " (details updated)" : ""}`
      : `${label} payment recorded as ${next.paymentMethod}`,
    beforeData: prev,
    afterData: next,
    user,
  });
}

module.exports = { PAYMENT_METHOD, resolvePaymentDetails, loadPaymentDetails, postingGaps, auditPaymentChange, parseMethod };
