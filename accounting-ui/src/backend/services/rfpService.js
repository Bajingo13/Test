// Request for Payment (RFP) - R2 backend foundation: create / list / detail
// / edit / delete of DRAFT requests, with server-side numbering.
//
// An RFP is a pre-accounting request to pay a supplier. Nothing here
// touches the ledger: no journal, APV, AP balance or payment is created.
// Workflow (submit / approve / return / reject / cancel) is R3; R5 converts
// an APPROVED request into a Draft APV (see convertRfp).
//
// Company isolation:
//   - the company of a NEW RFP comes from the strict selector shared with
//     Trial Balance / Account Analysis (explicit + validated; inferred only
//     for a user with exactly one company; never a lowest/first company).
//   - every read/write of an existing RFP carries the company condition in
//     SQL (user_companies sub-select), so another company's RFP is never
//     fetched - it gets the same 404 as an unknown id.
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { isValidDateOnly, toDateOnly } = require("../lib/dateOnly");
const UserAccessService = require("./userAccessService");
const { resolveSelectedCompany } = require("./trialBalanceCheckerService");
const { VAT_TREATMENTS } = require("./vatCalculationService");
const PermissionService = require("./permissionService");
const { createApvRecord } = require("./apvCreateService");

const MODULE = "TRANSACTIONS.RFP";
const ENTITY = "RFP";
const NOT_FOUND = "Request for Payment not found";
const STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "CONVERTED", "RETURNED", "REJECTED", "CANCELLED"];
// A RETURNED request is corrected in place (same id, number and company)
// and stays RETURNED until it is resubmitted.
const EDITABLE_STATUSES = ["DRAFT", "RETURNED"];
const MAX_LINES = 500;
const NUMBER_LOCK_TIMEOUT_SECONDS = 10;
const NUMBER_ATTEMPTS = 3;

// Server-controlled fields: a request carrying any of them is rejected
// outright rather than silently ignored, so a client can never believe it
// set a requester, status, number, snapshot, total-of-record or workflow
// field. (totalAmount is allowed - it is checked against the lines.)
const SERVER_FIELDS = [
  "id", "rfpNo", "rfp_no", "status", "requesterUserId", "requester_user_id", "requester",
  "supplierName", "supplier_name", "supplierTin", "supplier_tin",
  "submittedBy", "submitted_by", "submittedAt", "submitted_at",
  "decidedBy", "decided_by", "decidedAt", "decided_at", "decisionNote", "decision_note",
  "convertedApvId", "converted_apv_id", "convertedBy", "converted_by", "convertedAt", "converted_at",
  "company_id", "branch_id", "currency_id", "total_amount", "createdAt", "created_at", "updatedAt", "updated_at",
];

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function isSuperAdmin(user) {
  return user?.roleCode === "SUPER_ADMIN";
}

function parseId(value, label) {
  const s = String(value ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s) || Number(s) > 2147483647) throw httpError(`${label} must be a valid id.`, 400);
  return Number(s);
}

function optionalId(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return parseId(value, label);
}

// Calendar-exact YYYY-MM-DD (rejects 2026-02-31, which a Date would roll over).
function parseDate(value, label) {
  if (!isValidDateOnly(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw httpError(`${label} must be a valid date (YYYY-MM-DD).`, 400);
  }
  return value;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(`${label} must be text.`, 400);
  const s = value.trim();
  if (s.length > maxLength) throw httpError(`${label} must be at most ${maxLength} characters.`, 400);
  return s || null;
}

function requiredText(value, label, maxLength) {
  const s = optionalText(value, label, maxLength);
  if (!s) throw httpError(`${label} is required.`, 400);
  return s;
}

// Money as integer cents (BigInt) - never floating point. Accepts a
// non-negative number or numeric string with at most 2 decimals; NaN,
// Infinity, exponents, negatives and malformed values are rejected.
function parseCents(value, label, maxIntegerDigits) {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m || m[1].replace(/^0+(?=\d)/, "").length > maxIntegerDigits) {
    throw httpError(`${label} must be a non-negative amount with at most 2 decimal places.`, 400);
  }
  return BigInt(m[1]) * 100n + BigInt((m[2] || "").padEnd(2, "0"));
}

function centsToString(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function assertNoServerFields(body) {
  const sent = SERVER_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (sent.length) throw httpError(`These fields are set by the server and cannot be supplied: ${sent.join(", ")}.`, 400);
}

// --- company scope -------------------------------------------------------

// SQL fragment limiting rfp_headers (alias h) to the caller's companies.
function companyScopeSql(user) {
  if (isSuperAdmin(user)) return { sql: "", params: [] };
  return { sql: " AND h.company_id IN (SELECT uc.company_id FROM user_companies uc WHERE uc.user_id = ?)", params: [user?.id ?? 0] };
}

// Locks (optionally) and returns an RFP the caller may see; another
// company's RFP and an unknown id produce the same 404.
async function loadAccessibleRfp(db, id, user, { forUpdate = false } = {}) {
  const scope = companyScopeSql(user);
  const [rows] = await db.execute(
    `SELECT h.* FROM rfp_headers h WHERE h.id = ?${scope.sql}${forUpdate ? " FOR UPDATE" : ""}`,
    [id, ...scope.params]
  );
  if (!rows.length) throw httpError(NOT_FOUND, 404);
  return rows[0];
}

// --- payload validation ----------------------------------------------------

// Validates everything a create/edit writes, against the RFP's company.
// Returns the normalized record; nothing is written here.
async function validatePayload(db, { companyId, body, user }) {
  const rfpDate = parseDate(body.rfpDate, "RFP date");
  const requestedPaymentDate = parseDate(body.requestedPaymentDate, "Requested payment date");
  const purpose = requiredText(body.purpose, "Purpose", 5000);
  const supportingReference = optionalText(body.supportingReference, "Supporting reference", 100);
  const remarks = optionalText(body.remarks, "Remarks", 5000);

  if (body.supplierId === undefined || body.supplierId === null || body.supplierId === "") throw httpError("Supplier is required.", 400);
  const supplierId = parseId(body.supplierId, "supplierId");
  if (body.currencyId === undefined || body.currencyId === null || body.currencyId === "") throw httpError("Currency is required.", 400);
  const currencyId = parseId(body.currencyId, "currencyId");
  const branchId = optionalId(body.branchId, "branchId");

  if (!Array.isArray(body.lines) || body.lines.length === 0) throw httpError("At least one line is required.", 400);
  if (body.lines.length > MAX_LINES) throw httpError(`An RFP can have at most ${MAX_LINES} lines.`, 400);

  const lines = body.lines.map((line, i) => {
    const n = i + 1;
    if (!line || typeof line !== "object" || Array.isArray(line)) throw httpError(`Line ${n} is malformed.`, 400);
    if (line.grossAmount === undefined || line.grossAmount === null || line.grossAmount === "") {
      throw httpError(`Line ${n}: gross amount is required.`, 400);
    }
    let vatTreatment = null;
    if (line.vatTreatment !== undefined && line.vatTreatment !== null && String(line.vatTreatment).trim() !== "") {
      vatTreatment = String(line.vatTreatment).trim().toUpperCase();
      if (!VAT_TREATMENTS.includes(vatTreatment)) {
        throw httpError(`Line ${n}: VAT treatment must be one of ${VAT_TREATMENTS.join(", ")}.`, 400);
      }
    }
    return {
      description: requiredText(line.description, `Line ${n}: description`, 255),
      cents: parseCents(line.grossAmount, `Line ${n}: gross amount`, 13),
      accountId: optionalId(line.accountId, `Line ${n}: accountId`),
      vatTreatment,
      reference: optionalText(line.reference, `Line ${n}: reference`, 100),
    };
  });

  const totalCents = lines.reduce((sum, l) => sum + l.cents, 0n);
  if (totalCents >= 10n ** 18n) throw httpError("The total amount is too large.", 400);
  if (body.totalAmount !== undefined && body.totalAmount !== null && body.totalAmount !== "") {
    const claimed = parseCents(body.totalAmount, "Total amount", 16);
    if (claimed !== totalCents) {
      throw httpError(`Total amount ${centsToString(claimed)} does not match the sum of the lines (${centsToString(totalCents)}).`, 400);
    }
  }

  // Supplier: a general_libraries row of THIS company, of type SUPPLIER.
  // Unknown and another company's supplier get the same message.
  const [suppliers] = await db.execute(
    "SELECT id, name, tin, party_type, status FROM general_libraries WHERE id = ? AND company_id = ?",
    [supplierId, companyId]
  );
  const supplier = suppliers[0];
  if (!supplier) throw httpError("Supplier not found for the selected company.", 400);
  if (String(supplier.party_type || "").toUpperCase() !== "SUPPLIER") throw httpError("The selected party is not a supplier.", 400);
  if (String(supplier.status || "").toUpperCase() !== "ACTIVE") throw httpError("The selected supplier is not active.", 400);

  // Branch (optional): must belong to the company and, below Super Admin,
  // be one of the user's assigned branches (same rule as branchScope.js).
  if (branchId !== null) {
    const [branches] = await db.execute("SELECT id FROM branches WHERE id = ? AND company_id = ?", [branchId, companyId]);
    if (!branches.length) throw httpError("Branch not found for the selected company.", 400);
    if (!isSuperAdmin(user) && !(await UserAccessService.userHasBranchAccess(user?.id, branchId))) {
      throw httpError("You do not have access to this branch", 403);
    }
  }

  // Currency: currencies are company-scoped; no rate is resolved here
  // (exchange rates belong to the APV at conversion).
  const [currencies] = await db.execute(
    "SELECT id, is_active FROM currencies WHERE id = ? AND company_id = ?",
    [currencyId, companyId]
  );
  if (!currencies.length) throw httpError("Currency not found for the selected company.", 400);
  if (!currencies[0].is_active) throw httpError("The selected currency is not active.", 400);

  // Accounts: chart_of_accounts is global by design - existence only.
  const accountIds = [...new Set(lines.map((l) => l.accountId).filter((v) => v !== null))];
  if (accountIds.length) {
    const [found] = await db.query("SELECT id FROM chart_of_accounts WHERE id IN (?)", [accountIds]);
    const known = new Set(found.map((r) => r.id));
    const missing = lines.findIndex((l) => l.accountId !== null && !known.has(l.accountId));
    if (missing >= 0) throw httpError(`Line ${missing + 1}: account not found.`, 400);
  }

  return {
    rfpDate,
    requestedPaymentDate,
    purpose,
    supportingReference,
    remarks,
    supplierId,
    supplierName: supplier.name,
    supplierTin: supplier.tin || null,
    branchId,
    currencyId,
    totalAmount: centsToString(totalCents),
    lines: lines.map(({ cents, ...l }) => ({ ...l, grossAmount: centsToString(cents) })),
  };
}

// --- numbering ---------------------------------------------------------------

// RFP<yy>-<5 digits>, per company, year taken from the RFP date. Only
// well-formed numbers of that company and year drive the sequence (same
// rule as generateQuotationNo). Callers hold the per-company number lock.
async function nextRfpNo(conn, companyId, rfpDate) {
  const prefix = `RFP${rfpDate.slice(2, 4)}-`;
  const [rows] = await conn.execute(
    `SELECT rfp_no FROM rfp_headers
     WHERE company_id = ? AND rfp_no REGEXP '^RFP[0-9][0-9]-[0-9]+$' AND rfp_no LIKE ?
     ORDER BY CAST(SUBSTRING_INDEX(rfp_no, '-', -1) AS UNSIGNED) DESC LIMIT 1`,
    [companyId, `${prefix}%`]
  );
  const seq = rows.length ? Number(rows[0].rfp_no.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, "0")}`;
}

// Serializes number generation per company for the life of the
// transaction (a MySQL named lock, as runMigrations.js uses), so two
// concurrent creates never compute the same next number. The
// UNIQUE(company_id, rfp_no) key stays the final guarantee.
async function acquireNumberLock(conn, companyId) {
  const name = `astrea_rfp_no_${companyId}`;
  const [[row]] = await conn.query("SELECT GET_LOCK(?, ?) AS got", [name, NUMBER_LOCK_TIMEOUT_SECONDS]);
  if (row.got !== 1) throw httpError("Another Request for Payment is being numbered for this company. Please try again.", 409);
  return name;
}

async function releaseNumberLock(conn, name) {
  if (!name) return;
  try {
    await conn.query("SELECT RELEASE_LOCK(?)", [name]);
  } catch (err) {
    console.error("RFP NUMBER LOCK RELEASE ERROR:", err.message);
  }
}

function isRfpNoConflict(err) {
  return err?.code === "ER_DUP_ENTRY" && /uq_rfp_company_no/.test(err.message || "");
}

// --- persistence helpers -------------------------------------------------------

async function insertLines(conn, rfpId, lines) {
  for (const l of lines) {
    await conn.execute(
      "INSERT INTO rfp_lines (rfp_id, description, account_id, gross_amount, vat_treatment, reference) VALUES (?, ?, ?, ?, ?, ?)",
      [rfpId, l.description, l.accountId, l.grossAmount, l.vatTreatment, l.reference]
    );
  }
}

async function readLines(db, rfpId) {
  const [rows] = await db.execute(
    `SELECT id, description, account_id, gross_amount, vat_treatment, reference
     FROM rfp_lines WHERE rfp_id = ? ORDER BY id`,
    [rfpId]
  );
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    accountId: r.account_id,
    grossAmount: r.gross_amount,
    vatTreatment: r.vat_treatment,
    reference: r.reference,
  }));
}

function toDateString(value) {
  return value ? toDateOnly(value) : null;
}

// The audit/state view of an RFP: business fields only.
function auditState(header, lines) {
  return {
    rfpNo: header.rfp_no,
    companyId: header.company_id,
    branchId: header.branch_id,
    rfpDate: toDateString(header.rfp_date),
    requesterUserId: header.requester_user_id,
    supplierId: header.supplier_id,
    supplierName: header.supplier_name,
    supplierTin: header.supplier_tin,
    purpose: header.purpose,
    requestedPaymentDate: toDateString(header.requested_payment_date),
    currencyId: header.currency_id,
    totalAmount: header.total_amount,
    supportingReference: header.supporting_reference,
    remarks: header.remarks,
    status: header.status,
    lines: lines.map(({ id, ...l }) => l),
  };
}

function changedFields(before, after) {
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// --- operations ------------------------------------------------------------

async function createRfp({ body, user }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("Request body is required.", 400);
  assertNoServerFields(body);
  const companyId = await resolveSelectedCompany(user, body.companyId);

  for (let attempt = 1; ; attempt += 1) {
    const conn = await pool.getConnection();
    let lockName = null;
    try {
      // The lock is taken BEFORE the transaction starts: under REPEATABLE
      // READ the read snapshot is fixed at the transaction's first read, so
      // it must postdate the previous holder's commit for nextRfpNo to see
      // that holder's number. The lock is released only after commit.
      lockName = await acquireNumberLock(conn, companyId);
      await conn.beginTransaction();
      const data = await validatePayload(conn, { companyId, body, user });
      const rfpNo = await nextRfpNo(conn, companyId, data.rfpDate);

      const [result] = await conn.execute(
        `INSERT INTO rfp_headers (
          company_id, branch_id, rfp_no, rfp_date, requester_user_id,
          supplier_id, supplier_name, supplier_tin, purpose, requested_payment_date,
          currency_id, total_amount, remarks, supporting_reference, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
        [
          companyId, data.branchId, rfpNo, data.rfpDate, user.id,
          data.supplierId, data.supplierName, data.supplierTin, data.purpose, data.requestedPaymentDate,
          data.currencyId, data.totalAmount, data.remarks, data.supportingReference,
        ]
      );
      const rfpId = result.insertId;
      await insertLines(conn, rfpId, data.lines);

      const [[header]] = await conn.execute("SELECT * FROM rfp_headers WHERE id = ?", [rfpId]);
      const state = auditState(header, await readLines(conn, rfpId));
      await logAudit(conn, {
        module: MODULE,
        entityType: ENTITY,
        entityId: rfpId,
        action: "CREATE",
        description: `${user.username} created Request for Payment ${rfpNo}`,
        afterData: state,
        user,
        companyId,
      });

      await conn.commit();
      return { id: rfpId, rfpNo, companyId, status: "DRAFT", totalAmount: data.totalAmount };
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (isRfpNoConflict(err)) {
        if (attempt < NUMBER_ATTEMPTS) continue;
        throw httpError("Could not assign a unique RFP number. Please try again.", 409);
      }
      throw err;
    } finally {
      await releaseNumberLock(conn, lockName);
      conn.release();
    }
  }
}

async function listRfps({ user, query = {} }) {
  const where = [];
  const params = [];

  const hasCompany = query.companyId !== undefined && query.companyId !== null && String(query.companyId).trim() !== "";
  if (hasCompany) {
    // Explicit filter: validated exactly like a selection (unknown 400,
    // inaccessible 403).
    const companyId = await resolveSelectedCompany(user, query.companyId);
    where.push("h.company_id = ?");
    params.push(companyId);
  } else if (!isSuperAdmin(user)) {
    // No filter: the union of the caller's companies (Super Admin: all).
    const scope = companyScopeSql(user);
    where.push(scope.sql.replace(/^ AND /, ""));
    params.push(...scope.params);
  }

  if (query.status !== undefined && String(query.status).trim() !== "") {
    const status = String(query.status).trim().toUpperCase();
    if (!STATUSES.includes(status)) throw httpError(`status must be one of ${STATUSES.join(", ")}.`, 400);
    where.push("h.status = ?");
    params.push(status);
  }

  const [rows] = await pool.execute(
    `SELECT h.id, h.rfp_no, h.company_id, c.name AS company_name, h.branch_id, b.name AS branch_name,
            DATE_FORMAT(h.rfp_date, '%Y-%m-%d') AS rfp_date, h.requester_user_id, u.username AS requester_username,
            h.supplier_id, h.supplier_name, h.purpose,
            DATE_FORMAT(h.requested_payment_date, '%Y-%m-%d') AS requested_payment_date,
            h.currency_id, cur.currency_code, h.total_amount, h.status, h.created_at, h.updated_at
     FROM rfp_headers h
     JOIN companies c ON c.id = h.company_id
     LEFT JOIN branches b ON b.id = h.branch_id
     LEFT JOIN users u ON u.id = h.requester_user_id
     LEFT JOIN currencies cur ON cur.id = h.currency_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY h.id DESC`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    rfpNo: r.rfp_no,
    companyId: r.company_id,
    companyName: r.company_name,
    branchId: r.branch_id,
    branchName: r.branch_name,
    rfpDate: r.rfp_date,
    requesterUserId: r.requester_user_id,
    requesterUsername: r.requester_username,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    purpose: r.purpose,
    requestedPaymentDate: r.requested_payment_date,
    currencyId: r.currency_id,
    currencyCode: r.currency_code,
    totalAmount: r.total_amount,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function getRfp({ id, user }) {
  const rfpId = parseId(id, "RFP id");
  const scope = companyScopeSql(user);
  const [rows] = await pool.execute(
    `SELECT h.*, DATE_FORMAT(h.rfp_date, '%Y-%m-%d') AS rfp_date_fmt,
            DATE_FORMAT(h.requested_payment_date, '%Y-%m-%d') AS requested_payment_date_fmt,
            c.name AS company_name, b.name AS branch_name, u.username AS requester_username,
            cur.currency_code, sb.username AS submitted_by_username, dcu.username AS decided_by_username,
            cvu.username AS converted_by_username, apv.voucher_no AS converted_apv_no, apv.status AS converted_apv_status
     FROM rfp_headers h
     JOIN companies c ON c.id = h.company_id
     LEFT JOIN branches b ON b.id = h.branch_id
     LEFT JOIN users u ON u.id = h.requester_user_id
     LEFT JOIN currencies cur ON cur.id = h.currency_id
     LEFT JOIN users sb ON sb.id = h.submitted_by
     LEFT JOIN users dcu ON dcu.id = h.decided_by
     LEFT JOIN users cvu ON cvu.id = h.converted_by
     LEFT JOIN apv_headers apv ON apv.id = h.converted_apv_id AND apv.company_id = h.company_id
     WHERE h.id = ?${scope.sql}`,
    [rfpId, ...scope.params]
  );
  const h = rows[0];
  if (!h) throw httpError(NOT_FOUND, 404);
  return {
    id: h.id,
    rfpNo: h.rfp_no,
    companyId: h.company_id,
    companyName: h.company_name,
    branchId: h.branch_id,
    branchName: h.branch_name,
    rfpDate: h.rfp_date_fmt,
    requesterUserId: h.requester_user_id,
    requesterUsername: h.requester_username,
    supplierId: h.supplier_id,
    supplierName: h.supplier_name,
    supplierTin: h.supplier_tin,
    purpose: h.purpose,
    requestedPaymentDate: h.requested_payment_date_fmt,
    currencyId: h.currency_id,
    currencyCode: h.currency_code,
    totalAmount: h.total_amount,
    supportingReference: h.supporting_reference,
    remarks: h.remarks,
    status: h.status,
    submittedBy: h.submitted_by,
    submittedByUsername: h.submitted_by_username,
    submittedAt: h.submitted_at,
    decidedBy: h.decided_by,
    decidedByUsername: h.decided_by_username,
    decidedAt: h.decided_at,
    decisionNote: h.decision_note,
    convertedApvId: h.converted_apv_id,
    convertedApvNo: h.converted_apv_no ?? null,
    convertedApvStatus: h.converted_apv_status ?? null,
    convertedBy: h.converted_by,
    convertedByUsername: h.converted_by_username ?? null,
    convertedAt: h.converted_at,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    lines: await readLines(pool, h.id),
  };
}

async function updateRfp({ id, body, user }) {
  const rfpId = parseId(id, "RFP id");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("Request body is required.", 400);
  assertNoServerFields(body);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    // Ownership is fixed at creation: a companyId may be echoed back but
    // never changed.
    if (body.companyId !== undefined && body.companyId !== null && String(body.companyId).trim() !== ""
        && Number(body.companyId) !== header.company_id) {
      throw httpError("The company of a Request for Payment cannot be changed.", 400);
    }
    if (!EDITABLE_STATUSES.includes(header.status)) {
      throw httpError(`Only a DRAFT or RETURNED Request for Payment can be edited (this one is ${header.status}).`, 409);
    }

    const data = await validatePayload(conn, { companyId: header.company_id, body, user });
    const before = auditState(header, await readLines(conn, rfpId));

    await conn.execute(
      `UPDATE rfp_headers SET
         branch_id = ?, rfp_date = ?, supplier_id = ?, supplier_name = ?, supplier_tin = ?,
         purpose = ?, requested_payment_date = ?, currency_id = ?, total_amount = ?,
         remarks = ?, supporting_reference = ?
       WHERE id = ? AND company_id = ? AND status = ?`,
      [
        data.branchId, data.rfpDate, data.supplierId, data.supplierName, data.supplierTin,
        data.purpose, data.requestedPaymentDate, data.currencyId, data.totalAmount,
        data.remarks, data.supportingReference, rfpId, header.company_id, header.status,
      ]
    );
    await conn.execute("DELETE FROM rfp_lines WHERE rfp_id = ?", [rfpId]);
    await insertLines(conn, rfpId, data.lines);

    const [[updated]] = await conn.execute("SELECT * FROM rfp_headers WHERE id = ?", [rfpId]);
    const after = auditState(updated, await readLines(conn, rfpId));
    const changed = changedFields(before, after);
    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action: "EDIT",
      description: `${user.username} edited Request for Payment ${header.rfp_no}${changed.length ? ` (${changed.join(", ")})` : " (no changes)"}`,
      beforeData: before,
      afterData: { ...after, changedFields: changed },
      user,
      companyId: header.company_id,
    });

    await conn.commit();
    // Editing never changes the status: a RETURNED request stays RETURNED
    // until it is explicitly resubmitted.
    return { id: rfpId, rfpNo: header.rfp_no, companyId: header.company_id, status: header.status, totalAmount: data.totalAmount, changedFields: changed };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function deleteRfp({ id, user }) {
  const rfpId = parseId(id, "RFP id");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    if (header.status !== "DRAFT") {
      throw httpError(`Only a DRAFT Request for Payment can be deleted (this one is ${header.status}).`, 409);
    }
    // rfp_status_history is RESTRICT: an RFP with any workflow history is
    // kept (it can only be cancelled, in R3).
    const [[history]] = await conn.execute("SELECT COUNT(*) AS n FROM rfp_status_history WHERE rfp_id = ?", [rfpId]);
    if (history.n > 0) {
      throw httpError("This Request for Payment has workflow history and cannot be deleted.", 409);
    }

    const before = auditState(header, await readLines(conn, rfpId));
    await conn.execute("DELETE FROM rfp_lines WHERE rfp_id = ?", [rfpId]);
    await conn.execute("DELETE FROM rfp_headers WHERE id = ? AND company_id = ? AND status = 'DRAFT'", [rfpId, header.company_id]);
    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action: "DELETE",
      description: `${user.username} deleted Request for Payment ${header.rfp_no}`,
      beforeData: before,
      user,
      companyId: header.company_id,
    });

    await conn.commit();
    return { id: rfpId, rfpNo: header.rfp_no, deleted: true };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// --- workflow (R3) -------------------------------------------------------------
//
// The endpoint names the action; the action alone decides the target
// status - a client never supplies one. Every other move is refused with
// 409. A RETURNED request is corrected through the normal edit (it stays
// RETURNED) and resubmitted with the same SUBMIT action and full
// revalidation; CONVERTED is reached only by the R5 conversion.
//
//   SUBMIT   DRAFT | RETURNED   -> SUBMITTED  (TRANSACTIONS.RFP.SUBMIT)
//   APPROVE  SUBMITTED          -> APPROVED   (TRANSACTIONS.RFP.APPROVE)
//   RETURN   SUBMITTED          -> RETURNED   (TRANSACTIONS.RFP.APPROVE, note required)
//   REJECT   SUBMITTED          -> REJECTED   (TRANSACTIONS.RFP.APPROVE, note required)
//   CANCEL   DRAFT | SUBMITTED  -> CANCELLED  (TRANSACTIONS.RFP.SUBMIT - requester-side withdrawal)
//
// APPROVE / RETURN / REJECT are decisions: they set decided_by / decided_at
// / decision_note, and the decider can be neither the requester nor the
// submitter (maker-checker). No action here touches the ledger, an APV or
// the conversion columns.
//
// Decision fields are never cleared (same convention as accounting
// periods, whose reopen keeps closed_by / closed_at): after a resubmission
// they still describe the last decision until the next one overwrites
// them, the status says which metadata is current, and
// rfp_status_history keeps every decision. A resubmission overwrites
// submitted_by / submitted_at with the resubmitter - the requester never
// changes, so maker-checker still blocks them.
const WORKFLOW = {
  SUBMIT: { from: ["DRAFT", "RETURNED"], to: "SUBMITTED", note: "optional", verb: "submitted" },
  APPROVE: { from: ["SUBMITTED"], to: "APPROVED", note: "optional", decision: true, verb: "approved" },
  RETURN: { from: ["SUBMITTED"], to: "RETURNED", note: "required", decision: true, verb: "returned" },
  REJECT: { from: ["SUBMITTED"], to: "REJECTED", note: "required", decision: true, verb: "rejected" },
  CANCEL: { from: ["DRAFT", "SUBMITTED"], to: "CANCELLED", note: "optional", verb: "cancelled" },
};
const WORKFLOW_NOTE_MAX = 500;

function parseWorkflowBody(action, body) {
  const input = body === undefined || body === null ? {} : body;
  if (typeof input !== "object" || Array.isArray(input)) throw httpError("Request body must be an object.", 400);
  const unknown = Object.keys(input).filter((k) => k !== "note");
  if (unknown.length) throw httpError(`Unsupported field(s) for ${action}: ${unknown.join(", ")}. Only "note" is accepted.`, 400);
  const note = optionalText(input.note, "Note", WORKFLOW_NOTE_MAX);
  if (WORKFLOW[action].note === "required" && !note) {
    throw httpError(`A note explaining why is required to ${action.toLowerCase()} a Request for Payment.`, 400);
  }
  return note;
}

// Re-checks the STORED RFP against the same rules a create/edit enforces
// (supplier / branch / currency of its company, lines, dates, purpose,
// total) - the database state is authoritative, never an earlier request.
async function assertSubmittable(conn, header, user) {
  const [requester] = await conn.execute("SELECT id FROM users WHERE id = ?", [header.requester_user_id]);
  if (!requester.length) throw httpError("This Request for Payment cannot be submitted: its requester no longer exists.", 409);
  const lines = await readLines(conn, header.id);
  const stored = {
    rfpDate: toDateString(header.rfp_date) ?? undefined,
    requestedPaymentDate: toDateString(header.requested_payment_date) ?? undefined,
    purpose: header.purpose ?? undefined,
    supportingReference: header.supporting_reference,
    remarks: header.remarks,
    supplierId: header.supplier_id ?? undefined,
    currencyId: header.currency_id ?? undefined,
    branchId: header.branch_id,
    totalAmount: header.total_amount,
    lines: lines.map((l) => ({
      description: l.description,
      grossAmount: l.grossAmount,
      accountId: l.accountId,
      vatTreatment: l.vatTreatment,
      reference: l.reference,
    })),
  };
  try {
    await validatePayload(conn, { companyId: header.company_id, body: stored, user });
  } catch (err) {
    if (err.statusCode === 400) throw httpError(`This Request for Payment cannot be submitted: ${err.message}`, 409);
    throw err;
  }
}

async function transitionRfp({ id, action, body, user }) {
  const rule = WORKFLOW[action];
  if (!rule) throw httpError("Unsupported workflow action.", 400);
  const rfpId = parseId(id, "RFP id");
  const note = parseWorkflowBody(action, body);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locks the row, company-scoped in SQL: another company's RFP is the
    // same 404 as an unknown one, and concurrent actions on one RFP queue
    // here - the loser then sees the new status and gets 409.
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    const previous = header.status;
    if (!rule.from.includes(previous)) {
      throw httpError(`Cannot ${action.toLowerCase()} a Request for Payment that is ${previous} (allowed from: ${rule.from.join(", ")}).`, 409);
    }
    if (rule.decision && (user.id === header.requester_user_id || user.id === header.submitted_by)) {
      throw httpError("You cannot decide on a Request for Payment you requested or submitted.", 403);
    }
    if (action === "SUBMIT") await assertSubmittable(conn, header, user);

    let set = "status = ?";
    const params = [rule.to];
    if (action === "SUBMIT") {
      set += ", submitted_by = ?, submitted_at = NOW()";
      params.push(user.id);
    } else if (rule.decision) {
      set += ", decided_by = ?, decided_at = NOW(), decision_note = ?";
      params.push(user.id, note);
    }
    const [result] = await conn.execute(
      `UPDATE rfp_headers SET ${set} WHERE id = ? AND company_id = ? AND status = ?`,
      [...params, rfpId, header.company_id, previous]
    );
    if (result.affectedRows !== 1) throw httpError("The Request for Payment changed while this action was running. Reload and try again.", 409);

    await conn.execute(
      "INSERT INTO rfp_status_history (rfp_id, previous_status, new_status, action, user_id, note) VALUES (?, ?, ?, ?, ?, ?)",
      [rfpId, previous, rule.to, action, user.id, note]
    );

    const [[updated]] = await conn.execute(
      `SELECT status, submitted_by, submitted_at, decided_by, decided_at, decision_note FROM rfp_headers WHERE id = ?`,
      [rfpId]
    );
    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action,
      description: `${user.username} ${rule.verb} Request for Payment ${header.rfp_no} (${previous} -> ${rule.to})${note ? `: ${note}` : ""}`,
      beforeData: { rfpNo: header.rfp_no, companyId: header.company_id, status: previous },
      afterData: {
        rfpNo: header.rfp_no,
        companyId: header.company_id,
        previousStatus: previous,
        status: updated.status,
        note,
        ...(action === "SUBMIT" ? { submittedBy: updated.submitted_by, submittedAt: updated.submitted_at } : {}),
        ...(rule.decision ? { decidedBy: updated.decided_by, decidedAt: updated.decided_at, decisionNote: updated.decision_note } : {}),
      },
      user,
      companyId: header.company_id,
    });

    await conn.commit();
    return { id: rfpId, rfpNo: header.rfp_no, companyId: header.company_id, previousStatus: previous, status: rule.to };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function getRfpHistory({ id, user }) {
  const rfpId = parseId(id, "RFP id");
  await loadAccessibleRfp(pool, rfpId, user);
  const [rows] = await pool.execute(
    `SELECT h.id, h.previous_status, h.new_status, h.action, h.user_id, u.username, h.note, h.created_at
     FROM rfp_status_history h LEFT JOIN users u ON u.id = h.user_id
     WHERE h.rfp_id = ? ORDER BY h.id`,
    [rfpId]
  );
  return rows.map((r) => ({
    id: r.id,
    previousStatus: r.previous_status,
    newStatus: r.new_status,
    action: r.action,
    userId: r.user_id,
    username: r.username,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// --- conversion to a Draft APV (R5) ----------------------------------------
//
//   CONVERT_TO_APV   APPROVED -> CONVERTED   (TRANSACTIONS.RFP.CONVERT, and
//                                             TRANSACTIONS.APV.CREATE)
//
// One transaction: lock the RFP (company-scoped, FOR UPDATE), create the APV
// through the same createApvRecord the APV page uses, link it, write the
// history row and the audit row. Any failure rolls all of it back. The APV
// is created in the RFP's STORED company - a client company is never used.
//
// The APV is a Draft journal: one debit per RFP line (its account, its
// gross amount) and one Accounts Payable credit for the total. VAT and
// withholding are NOT split here - the RFP's VAT treatment is a hint (see
// the R1 migration) carried into the line particulars, and the VAT / EWT
// entries are recorded on the APV with its own tax modals before posting.
// Nothing is posted, paid or applied.
const CONVERT_FIELDS = ["voucherNo", "apvDate", "apAccountId", "lineAccounts", "companyId"];
const AP_CONTROL_VALIDATION = "AP CODE";
// Same set the transaction grid keeps off ordinary journal lines
// (taxAccountRules.mjs PROTECTED_TAX_VALIDATIONS): these accounts enter a
// journal only through the tax modals.
const TAX_CONTROL_VALIDATIONS = ["INPUT VAT", "OUTPUT VAT", "EXPANDED TAX", "FINAL TAX"];
const VOUCHER_NO_MAX = 50;
const PARTICULARS_MAX = 255;
const VAT_LABELS = { STANDARD: "VAT standard (gross, VAT not yet split)", ZERO_RATED: "VAT zero-rated", EXEMPT: "VAT exempt" };

function parseConvertBody(body) {
  const input = body === undefined || body === null ? {} : body;
  if (typeof input !== "object" || Array.isArray(input)) throw httpError("Request body must be an object.", 400);
  const unknown = Object.keys(input).filter((k) => !CONVERT_FIELDS.includes(k));
  if (unknown.length) throw httpError(`Unsupported field(s) for conversion: ${unknown.join(", ")}.`, 400);

  const voucherNo = optionalText(input.voucherNo, "APV number", VOUCHER_NO_MAX);
  if (input.apvDate === undefined || input.apvDate === null || input.apvDate === "") throw httpError("APV date is required.", 400);
  const apvDate = parseDate(input.apvDate, "APV date");
  if (input.apAccountId === undefined || input.apAccountId === null || input.apAccountId === "") {
    throw httpError("Accounts Payable account is required.", 400);
  }
  const apAccountId = parseId(input.apAccountId, "apAccountId");

  const lineAccounts = new Map();
  if (input.lineAccounts !== undefined && input.lineAccounts !== null) {
    if (typeof input.lineAccounts !== "object" || Array.isArray(input.lineAccounts)) {
      throw httpError("lineAccounts must be an object of RFP line id to account id.", 400);
    }
    for (const [lineId, accountId] of Object.entries(input.lineAccounts)) {
      lineAccounts.set(parseId(lineId, "lineAccounts line id"), parseId(accountId, "lineAccounts account id"));
    }
  }
  const companyId = optionalId(input.companyId, "companyId");
  return { voucherNo, apvDate, apAccountId, lineAccounts, companyId };
}

async function loadAccounts(conn, ids) {
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT a.id, a.code, a.title, GROUP_CONCAT(v.validation_name SEPARATOR '\\n') AS validations
     FROM chart_of_accounts a LEFT JOIN coa_validations v ON v.coa_id = a.id
     WHERE a.id IN (?) GROUP BY a.id, a.code, a.title`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, {
    id: r.id,
    code: r.code,
    title: r.title,
    validations: new Set(String(r.validations || "").split("\n").map((v) => v.trim().toUpperCase()).filter(Boolean)),
  }]));
}

function isTaxControl(account) {
  return TAX_CONTROL_VALIDATIONS.some((v) => account.validations.has(v));
}

function particularsFor(line) {
  const parts = [line.description];
  if (line.reference) parts.push(`Ref ${line.reference}`);
  if (line.vatTreatment) parts.push(VAT_LABELS[line.vatTreatment] || `VAT ${line.vatTreatment}`);
  return parts.join(" | ").slice(0, PARTICULARS_MAX);
}

async function convertRfp({ id, body, user }) {
  const rfpId = parseId(id, "RFP id");
  const input = parseConvertBody(body);
  // An RFP CONVERT grant is not a way around APV rights: the caller must
  // also be allowed to create APVs (Super Admin bypasses, as everywhere).
  if (!isSuperAdmin(user) && !(await PermissionService.can(user.id, "TRANSACTIONS.APV", "CREATE"))) {
    throw httpError("Converting a Request for Payment creates an APV, which you do not have permission to create.", 403);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locks the row, company-scoped in SQL (another company's RFP is the
    // same 404 as an unknown one). A concurrent conversion of the same RFP
    // waits here and then sees CONVERTED -> 409.
    const header = await loadAccessibleRfp(conn, rfpId, user, { forUpdate: true });
    if (input.companyId !== null && input.companyId !== header.company_id) {
      throw httpError("The APV is always created in the Request for Payment's own company; a different company cannot be chosen.", 400);
    }
    if (header.status !== "APPROVED") {
      throw httpError(`Only an APPROVED Request for Payment can be converted to an APV (this one is ${header.status}).`, 409);
    }
    if (header.converted_apv_id !== null) {
      throw httpError("This Request for Payment has already been converted to an APV.", 409);
    }

    const lines = await readLines(conn, rfpId);
    if (!lines.length) throw httpError("This Request for Payment has no lines to convert.", 409);
    for (const [lineId] of input.lineAccounts) {
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw httpError(`lineAccounts: line ${lineId} is not a line of this Request for Payment.`, 400);
      if (line.accountId !== null) {
        throw httpError(`Line ${lines.indexOf(line) + 1} already has its approved account; only lines without an account can be given one.`, 400);
      }
    }
    const resolved = lines.map((l) => ({ ...l, apvAccountId: l.accountId ?? input.lineAccounts.get(l.id) ?? null }));
    const missing = resolved.findIndex((l) => l.apvAccountId === null);
    if (missing >= 0) throw httpError(`Line ${missing + 1} has no account. Choose an account for it before converting.`, 400);

    const accounts = await loadAccounts(conn, [...new Set([input.apAccountId, ...resolved.map((l) => l.apvAccountId)])]);
    const ap = accounts.get(input.apAccountId);
    if (!ap) throw httpError("Accounts Payable account not found.", 400);
    if (!ap.validations.has(AP_CONTROL_VALIDATION)) {
      throw httpError(`The Accounts Payable account must be flagged "${AP_CONTROL_VALIDATION}" in the Chart of Accounts.`, 400);
    }
    for (const [i, l] of resolved.entries()) {
      const account = accounts.get(l.apvAccountId);
      if (!account) throw httpError(`Line ${i + 1}: account not found.`, l.accountId === null ? 400 : 409);
      if (isTaxControl(account)) {
        throw httpError(
          `Line ${i + 1}: ${account.code} is a VAT / withholding control account; record tax on the APV with its tax entries instead.`,
          l.accountId === null ? 400 : 409
        );
      }
    }

    // The supplier code becomes the AP line's subsidiary reference, as the
    // APV page sets it when a supplier is picked.
    const [suppliers] = await conn.execute(
      "SELECT code FROM general_libraries WHERE id = ? AND company_id = ?",
      [header.supplier_id, header.company_id]
    );
    if (!suppliers.length) throw httpError("This Request for Payment's supplier no longer exists in its company.", 409);
    const [[requester]] = await conn.execute("SELECT username FROM users WHERE id = ?", [header.requester_user_id]);
    const [[branch]] = header.branch_id
      ? await conn.execute("SELECT name FROM branches WHERE id = ?", [header.branch_id])
      : [[null]];

    const total = Number(header.total_amount);
    const voucherNo = input.voucherNo || `APV-${header.rfp_no}`;
    const apvLines = [
      ...resolved.map((l) => {
        const account = accounts.get(l.apvAccountId);
        return {
          accountId: account.id, accountCode: account.code, accountTitle: account.title,
          particulars: particularsFor(l), debit: Number(l.grossAmount), credit: 0, genRef: "", genName: "",
        };
      }),
      {
        accountId: ap.id, accountCode: ap.code, accountTitle: ap.title,
        particulars: `Accounts Payable - ${header.supplier_name || ""}`.slice(0, PARTICULARS_MAX),
        debit: 0, credit: total, genRef: suppliers[0].code || "", genName: header.supplier_name || "",
      },
    ];
    const remarks = [
      `Converted from Request for Payment ${header.rfp_no} (requested by ${requester?.username || "unknown"}${branch?.name ? `, branch ${branch.name}` : ""}).`,
      "Line amounts are the RFP gross amounts: record VAT and withholding on this APV before posting.",
      header.remarks ? `RFP remarks: ${header.remarks}` : null,
    ].filter(Boolean).join("\n");

    const apv = await createApvRecord(conn, {
      user,
      body: {
        voucherNo,
        supplierId: header.supplier_id,
        supplierName: header.supplier_name,
        transactionDate: input.apvDate,
        dueDate: toDateString(header.requested_payment_date),
        referenceNo: header.supporting_reference || "",
        description: header.purpose,
        remarks,
        totalDebit: total,
        totalCredit: total,
        status: "Draft",
        lines: apvLines,
        currency: { currencyId: header.currency_id, rateDate: input.apvDate },
      },
      resolveCompanyId: async () => header.company_id,
    });

    const [result] = await conn.execute(
      `UPDATE rfp_headers SET status = 'CONVERTED', converted_apv_id = ?, converted_by = ?, converted_at = NOW()
       WHERE id = ? AND company_id = ? AND status = 'APPROVED' AND converted_apv_id IS NULL`,
      [apv.id, user.id, rfpId, header.company_id]
    );
    if (result.affectedRows !== 1) throw httpError("The Request for Payment changed while it was being converted. Reload and try again.", 409);

    await conn.execute(
      "INSERT INTO rfp_status_history (rfp_id, previous_status, new_status, action, user_id, note) VALUES (?, ?, ?, ?, ?, ?)",
      [rfpId, "APPROVED", "CONVERTED", "CONVERT_TO_APV", user.id, `APV ${apv.voucherNo}`]
    );
    const [[updated]] = await conn.execute("SELECT converted_at FROM rfp_headers WHERE id = ?", [rfpId]);

    await logAudit(conn, {
      module: MODULE,
      entityType: ENTITY,
      entityId: rfpId,
      action: "CONVERT_TO_APV",
      description: `${user.username} converted Request for Payment ${header.rfp_no} to Draft APV ${apv.voucherNo} (APPROVED -> CONVERTED)`,
      beforeData: { rfpNo: header.rfp_no, companyId: header.company_id, status: "APPROVED", convertedApvId: null },
      afterData: {
        rfpNo: header.rfp_no,
        companyId: header.company_id,
        previousStatus: "APPROVED",
        status: "CONVERTED",
        apvId: apv.id,
        apvVoucherNo: apv.voucherNo,
        apvStatus: apv.status,
        apvDate: input.apvDate,
        apAccountId: ap.id,
        totalAmount: header.total_amount,
        convertedBy: user.id,
        convertedAt: updated.converted_at,
      },
      user,
      companyId: header.company_id,
    });

    await conn.commit();
    return {
      id: rfpId,
      rfpNo: header.rfp_no,
      companyId: header.company_id,
      previousStatus: "APPROVED",
      status: "CONVERTED",
      convertedAt: updated.converted_at,
      convertedBy: user.id,
      apv: { id: apv.id, voucherNo: apv.voucherNo, status: apv.status, companyId: apv.companyId, totalAmount: header.total_amount },
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err?.code === "ER_DUP_ENTRY") {
      // Race backstops: the unique APV link, or the per-company voucher number.
      if (/uq_rfp_converted_apv/.test(err.message || "")) throw httpError("This Request for Payment has already been converted to an APV.", 409);
      throw httpError("That APV number already exists for this company.", 409);
    }
    throw err;
  } finally {
    conn.release();
  }
}

// --- form lookups (R4) -----------------------------------------------------
//
// The choices the RFP form may offer for ONE explicitly selected company,
// filtered by exactly the rules validatePayload enforces: active SUPPLIER
// parties and active currencies of that company, its branches the caller
// may use (Super Admin: all of them), and the global chart of accounts.
// Exists because the generic /api/genlib and /api/coa lists need
// FILESETUP.* permissions an Accountant (who may create RFPs) doesn't hold.
async function getLookups({ user, query = {} }) {
  const companyId = await resolveSelectedCompany(user, query.companyId);
  const [suppliers] = await pool.execute(
    `SELECT id, code, name, tin FROM general_libraries
     WHERE company_id = ? AND UPPER(party_type) = 'SUPPLIER' AND UPPER(status) = 'ACTIVE'
     ORDER BY name, id`,
    [companyId]
  );
  const [currencies] = await pool.execute(
    `SELECT id, currency_code, currency_name, is_base_currency FROM currencies
     WHERE company_id = ? AND is_active = 1 ORDER BY is_base_currency DESC, currency_code`,
    [companyId]
  );
  const [branches] = isSuperAdmin(user)
    ? await pool.execute("SELECT id, name, code FROM branches WHERE company_id = ? ORDER BY name, id", [companyId])
    : await pool.execute(
        `SELECT b.id, b.name, b.code FROM branches b
         JOIN user_branches ub ON ub.branch_id = b.id AND ub.user_id = ?
         WHERE b.company_id = ? ORDER BY b.name, b.id`,
        [user.id, companyId]
      );
  // Validation flags drive the R5 conversion dialog: AP CODE accounts are
  // the payable-credit choices; tax-control accounts never take a line.
  const [accounts] = await pool.execute(
    `SELECT a.id, a.code, a.title,
            MAX(UPPER(v.validation_name) = ?) AS is_ap_control,
            MAX(UPPER(v.validation_name) IN (?, ?, ?, ?)) AS is_tax_control
     FROM chart_of_accounts a LEFT JOIN coa_validations v ON v.coa_id = a.id
     GROUP BY a.id, a.code, a.title ORDER BY a.code, a.id`,
    [AP_CONTROL_VALIDATION, ...TAX_CONTROL_VALIDATIONS]
  );
  return {
    companyId,
    suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, name: s.name, tin: s.tin || null })),
    currencies: currencies.map((c) => ({ id: c.id, code: c.currency_code, name: c.currency_name, isBase: !!c.is_base_currency })),
    branches: branches.map((b) => ({ id: b.id, name: b.name, code: b.code || null })),
    accounts: accounts.map((a) => ({ id: a.id, code: a.code, title: a.title, isApControl: !!a.is_ap_control, isTaxControl: !!a.is_tax_control })),
  };
}

module.exports = {
  STATUSES,
  WORKFLOW,
  getLookups,
  createRfp,
  listRfps,
  getRfp,
  updateRfp,
  deleteRfp,
  transitionRfp,
  getRfpHistory,
  convertRfp,
};
