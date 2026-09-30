const pool = require("../db");
const { HttpError } = require("../lib/httpError");

// Phase M.1: Report Section master data. This is the database-backed
// authority for what report_section values a Group Code may take - it
// replaces the hard-coded catalog that used to live only in
// groupCodeClassification.js's REPORT_SECTIONS array / groupCodeSections.mjs
// on the frontend. Purely metadata: no accounting/ledger/balance data is
// ever read or written here, same as account_group_codes itself.
//
// Deliberately NOT wired into financialStatementStructureService.js's
// resolveSection() - that function's synchronous SECTION_CODES/
// ALLOWED_SECTIONS_BY_CLASS imports from groupCodeClassification.js are
// left untouched (see that file's own comment), so the already-shipped
// structured Income Statement / Balance Sheet skeleton is provably
// unaffected by this phase. A section code beyond the original 11 this
// table is seeded with will validate fine here and on Group Code, but will
// not yet have a bespoke slot in that skeleton - a future phase's concern.

const CANONICAL_ACCOUNT_CLASSES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

function normalizeClass(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function toRow(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    accountClass: r.account_class,
    displayOrder: r.display_order,
    status: r.status,
  };
}

// List, optionally filtered by accountClass and/or status. Ordering matches
// Group Code's own list convention: display_order ascending (NULLs last),
// then name ascending.
async function listReportSections({ accountClass, status } = {}) {
  const where = [];
  const params = [];
  if (accountClass) {
    where.push("account_class = ?");
    params.push(normalizeClass(accountClass));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status).trim().toUpperCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.execute(
    `SELECT id, code, name, account_class, display_order, status
     FROM report_sections
     ${whereSql}
     ORDER BY (display_order IS NULL), display_order ASC, name ASC`,
    params
  );
  return rows.map(toRow);
}

async function getActiveCodesByClass(accountClass) {
  const [rows] = await pool.execute(
    "SELECT code FROM report_sections WHERE account_class = ? AND status = 'ACTIVE'",
    [normalizeClass(accountClass)]
  );
  return rows.map((r) => r.code);
}

function validateFields({ code, name, accountClass }) {
  const errors = [];
  if (!code || !String(code).trim()) errors.push("Report Section Code is required.");
  if (!name || !String(name).trim()) errors.push("Report Section Name is required.");
  const cls = normalizeClass(accountClass);
  if (!CANONICAL_ACCOUNT_CLASSES.includes(cls)) {
    errors.push(`Account Class must be one of: ${CANONICAL_ACCOUNT_CLASSES.join(", ")}.`);
  }
  return errors;
}

async function createReportSection({ code, name, accountClass, displayOrder, status }) {
  const errors = validateFields({ code, name, accountClass });
  if (errors.length) throw new HttpError(400, errors.join(" "));

  const normCode = normalizeCode(code);
  const cls = normalizeClass(accountClass);
  const order =
    displayOrder === null || displayOrder === undefined || displayOrder === ""
      ? null
      : Number(displayOrder);
  if (order !== null && !Number.isInteger(order)) {
    throw new HttpError(400, "Display order must be a whole number or blank.");
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO report_sections (code, name, account_class, display_order, status)
       VALUES (?, ?, ?, ?, ?)`,
      [normCode, String(name).trim(), cls, order, status || "ACTIVE"]
    );
    return { id: result.insertId };
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      if (String(err.sqlMessage || err.message || "").includes("uq_report_sections_code")) {
        throw new HttpError(400, `Report Section code "${normCode}" already exists.`, "DUPLICATE_CODE");
      }
      throw new HttpError(
        400,
        `A Report Section named "${String(name).trim()}" already exists for account class ${cls}.`,
        "DUPLICATE_NAME"
      );
    }
    throw err;
  }
}

async function updateReportSection(id, { code, name, accountClass, displayOrder, status }) {
  const errors = validateFields({ code, name, accountClass });
  if (errors.length) throw new HttpError(400, errors.join(" "));

  const normCode = normalizeCode(code);
  const cls = normalizeClass(accountClass);
  const order =
    displayOrder === null || displayOrder === undefined || displayOrder === ""
      ? null
      : Number(displayOrder);
  if (order !== null && !Number.isInteger(order)) {
    throw new HttpError(400, "Display order must be a whole number or blank.");
  }

  try {
    const [result] = await pool.execute(
      `UPDATE report_sections
       SET code = ?, name = ?, account_class = ?, display_order = ?, status = ?
       WHERE id = ?`,
      [normCode, String(name).trim(), cls, order, status || "ACTIVE", id]
    );
    if (result.affectedRows === 0) {
      throw new HttpError(404, "Report Section not found.");
    }
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      if (String(err.sqlMessage || err.message || "").includes("uq_report_sections_code")) {
        throw new HttpError(400, `Report Section code "${normCode}" already exists.`, "DUPLICATE_CODE");
      }
      throw new HttpError(
        400,
        `A Report Section named "${String(name).trim()}" already exists for account class ${cls}.`,
        "DUPLICATE_NAME"
      );
    }
    throw err;
  }
}

// Delete-in-use guard, same shape as Group Code's own Phase H.1 safeguard:
// application-level reference check (report_sections.code is referenced by
// account_group_codes.report_section as a plain string match, no DB FK -
// consistent with how account_group_codes.group_code <-> coa_groups.
// group_code already works), blocking with 409 rather than orphaning any
// Group Code's classification.
async function deleteReportSection(id) {
  const [ownerRows] = await pool.execute("SELECT code FROM report_sections WHERE id = ?", [id]);
  if (!ownerRows.length) {
    // Pre-existing lenient behavior, same as Group Code delete: id not
    // found is treated as already-deleted, not an error.
    return;
  }

  const [usageRows] = await pool.execute(
    "SELECT COUNT(*) AS refCount FROM account_group_codes WHERE report_section = ?",
    [ownerRows[0].code]
  );
  const refCount = Number(usageRows[0].refCount) || 0;
  if (refCount > 0) {
    // HttpError's constructor only takes (statusCode, message, code) - the
    // reference count is attached as a plain extra property (JS allows this
    // on any Error instance) so the route can still build the same
    // {message, code, references} shape Group Code's own delete-in-use 409
    // uses, without changing the shared HttpError class.
    const err = new HttpError(
      409,
      "This Report Section cannot be deleted because it is assigned to one or more Group Codes.",
      "REPORT_SECTION_IN_USE"
    );
    err.references = { groupCodes: refCount };
    throw err;
  }

  await pool.execute("DELETE FROM report_sections WHERE id = ?", [id]);
}

module.exports = {
  CANONICAL_ACCOUNT_CLASSES,
  listReportSections,
  getActiveCodesByClass,
  createReportSection,
  updateReportSection,
  deleteReportSection,
};
