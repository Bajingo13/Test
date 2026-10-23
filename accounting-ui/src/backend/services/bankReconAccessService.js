const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const UserAccessService = require("./userAccessService");

// Company ownership for Bank Reconciliation lives on bank_recon_sessions
// (company_id); every child row (import batch, statement line, match,
// adjustment, AI conversation) belongs to whatever company its session
// belongs to. Super Admin may open any session, including legacy sessions
// whose company_id is still NULL; everyone else only sessions owned by a
// company they're assigned to.
//
// An out-of-scope id and an id that doesn't exist get exactly the same
// 404 (same message per record type), so the response never reveals that
// another company's reconciliation exists.

const KINDS = {
  session: { sql: null, notFound: "Reconciliation session not found" },
  batch: { sql: "SELECT session_id FROM bank_recon_import_batches WHERE id = ?", notFound: "Import batch not found" },
  line: { sql: "SELECT session_id FROM bank_recon_statement_lines WHERE id = ?", notFound: "Statement line not found" },
  match: { sql: "SELECT session_id FROM bank_recon_matches WHERE id = ?", notFound: "Match not found" },
  adjustment: { sql: "SELECT session_id FROM bank_recon_adjustments WHERE id = ?", notFound: "Adjustment not found" },
};

function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function canSeeCompany(user, companyId) {
  if (user?.roleCode === "SUPER_ADMIN") return true;
  if (!companyId) return false; // legacy NULL-company session: Super Admin only
  return UserAccessService.userHasCompanyAccess(user.id, companyId);
}

// Returns { id, companyId, status } or throws the session 404.
async function assertSessionAccess(sessionId, user, notFoundMessage = KINDS.session.notFound) {
  const id = toId(sessionId);
  if (!id) throw new HttpError(404, notFoundMessage);
  const [rows] = await pool.execute("SELECT id, company_id, status FROM bank_recon_sessions WHERE id = ?", [id]);
  const session = rows[0];
  if (!session || !(await canSeeCompany(user, session.company_id))) {
    throw new HttpError(404, notFoundMessage);
  }
  return { id: session.id, companyId: session.company_id, status: session.status };
}

// child id -> session -> company, same rules and same 404 for the child type.
async function assertRecordAccess(kind, recordId, user) {
  const def = KINDS[kind];
  if (!def) throw new Error(`Unknown bank recon record kind: ${kind}`);
  if (!def.sql) return assertSessionAccess(recordId, user, def.notFound);
  const id = toId(recordId);
  if (!id) throw new HttpError(404, def.notFound);
  const [rows] = await pool.execute(def.sql, [id]);
  if (!rows[0]) throw new HttpError(404, def.notFound);
  return assertSessionAccess(rows[0].session_id, user, def.notFound);
}

// Route middleware: guards the id in req.params / req.body before the
// handler runs and leaves the owning session on req.reconSession (used for
// audit company_id). A missing id is left to the handler's own 400.
function requireAccess(kind, { from = "params", field = "id" } = {}) {
  return async (req, res, next) => {
    const raw = req[from]?.[field];
    if (raw === undefined || raw === null || raw === "") return next();
    try {
      req.reconSession = await assertRecordAccess(kind, raw, req.user);
      next();
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.statusCode).json({ message: err.message });
      console.error("BANK RECON ACCESS ERROR:", err);
      res.status(500).json({ message: "Failed to verify access" });
    }
  };
}

// WHERE fragment for listing sessions (alias s).
async function sessionListFilter(user) {
  if (user?.roleCode === "SUPER_ADMIN") return { sql: "", params: [] };
  const companyIds = await UserAccessService.getAccessibleCompanyIds(user.id);
  if (companyIds.length === 0) return { sql: " WHERE 1 = 0", params: [] };
  return { sql: " WHERE s.company_id IN (?)", params: [companyIds] };
}

// Company for a new session: an explicit, permitted choice - never the
// user's lowest company. Single-company users (and a single-company
// system for Super Admin) don't need to pick.
async function resolveCompanyForNewSession(user, requestedCompanyId) {
  if (requestedCompanyId !== undefined && requestedCompanyId !== null && requestedCompanyId !== "") {
    const companyId = toId(requestedCompanyId);
    if (!companyId) throw new HttpError(400, "Select a valid company for this reconciliation.");
    const [rows] = await pool.execute("SELECT id FROM companies WHERE id = ?", [companyId]);
    if (!rows[0] || !(await canSeeCompany(user, companyId))) {
      throw new HttpError(403, "You do not have access to this company");
    }
    return companyId;
  }
  const candidates =
    user?.roleCode === "SUPER_ADMIN"
      ? (await pool.execute("SELECT id FROM companies"))[0].map((r) => r.id)
      : await UserAccessService.getAccessibleCompanyIds(user.id);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new HttpError(403, "You are not assigned to any company.");
  throw new HttpError(400, "Select the company this reconciliation belongs to.");
}

const BOOK_TABLES = { CV: "cv_headers", OR: "or_headers", JV: "jv_headers" };

// A manually matched book document must belong to the session's company.
async function assertBookDocumentInCompany(sourceType, sourceId, companyId) {
  const table = BOOK_TABLES[sourceType];
  const id = toId(sourceId);
  if (!table || !id) throw new HttpError(404, "Book document not found");
  const [rows] = await pool.execute(`SELECT company_id FROM ${table} WHERE id = ?`, [id]);
  if (!rows[0] || (companyId && Number(rows[0].company_id) !== Number(companyId))) {
    throw new HttpError(404, "Book document not found");
  }
}

module.exports = {
  assertSessionAccess,
  assertRecordAccess,
  requireAccess,
  sessionListFilter,
  resolveCompanyForNewSession,
  assertBookDocumentInCompany,
};
