// Multi-Branch Foundation, Phase C-1 - transactions are branch-owned at the API.
//
// Built only on the Phase A / B helpers (lib/branchResolution,
// services/transactionBranchService); it adds no authorization rule of its own.
//
//   transactionScope / visibleSql   list & lookup filter
//   canSee / isolationMiddleware    view / edit / delete / void / cancel /
//                                   email / convert on /api/<module>/:id
//   resolveCreateBranch + assign    CREATE: branch resolved, validated, stored
//   enforceUpdate                   UPDATE / POST: branch kept, re-validated
//   validateReferences              accounts + parties usable in the branch
//
// Branch on CREATE
//   - a submitted branchId is NEVER trusted: it must exist, belong to the
//     resolved company, be ACTIVE and be within the user's branch authority
//     (TransactionBranchService.resolveTransactionBranch);
//   - no branchId (the current entry screens send none - their branch picker is
//     Phase C-2): the documented default applies -
//       company has no branches            -> NULL (company-level, as before);
//       user has exactly ONE authorized ACTIVE branch in the company -> it;
//       user has several                  -> 400 BRANCH_REQUIRED;
//       user has none                     -> 403 BRANCH_ACCESS_DENIED.
// Branch on UPDATE: immutable. A different branchId -> 409
//   BRANCH_CHANGE_NOT_ALLOWED (a posted document is never moved). Saving as
//   Posted needs the branch to be ACTIVE (409 BRANCH_INACTIVE).
// Visibility: rows of the user's authorized branches; rows WITHOUT a branch
//   (company-level / unresolved history) only for users whose authority covers
//   every branch of the company - same rule as the consolidated reports.
//   SUPER_ADMIN sees every branch of the target company.
// Isolation: an unauthorized branch's record answers exactly like an unknown
//   or another company's record (the route's own 404 message).
const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const BranchResolution = require("../lib/branchResolution");
const ActiveBranch = require("../lib/activeBranchContext");
const TransactionBranchService = require("./transactionBranchService");
const UserAccessService = require("./userAccessService");
const { authenticateToken } = require("../middleware/authenticate");

const isSuper = (user) => user?.roleCode === "SUPER_ADMIN";
const sameBranch = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b));

async function transactionScope(user, companyId, db = pool) {
  const branchIds = await BranchResolution.authorizedBranchIds(user, companyId, db);
  const [[all]] = await db.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
  return { branchIds, includeUnassigned: branchIds.length === Number(all.n) };
}

// SQL predicate for list / lookup queries on header alias `alias`.
// System-wide Active Branch: narrowed to the request's active branch when one
// applies (lib/activeBranchContext - can only narrow, never widen).
async function visibleSql(user, companyId, alias, db = pool) {
  const base = isSuper(user) ? "ALL" : await transactionScope(user, companyId, db);
  const scope = await ActiveBranch.narrowScope(companyId, base, db);
  if (scope === "ALL") return "1 = 1";
  return BranchResolution.branchScopeSql(alias, scope);
}

// Multi-Branch Phase C-3 - print isolation. A serializable form of the
// visibility scope (it travels inside short-lived PDF render tokens, so the
// headless renderer sees exactly what the minting user may see):
//   { all: true }                            SUPER_ADMIN
//   { branchIds: [...], includeUnassigned }  everyone else (transaction rule)
async function printScope(user, companyId, db = pool) {
  if (isSuper(user)) return { all: true };
  const scope = await transactionScope(user, companyId, db);
  return { branchIds: scope.branchIds, includeUnassigned: !!scope.includeUnassigned };
}

function scopeSql(alias, scope) {
  if (!scope) return "1 = 1";
  if (scope.all === true) return "1 = 1";
  return BranchResolution.branchScopeSql(alias, scope);
}

// true / false; null when the user has no access to the record's company at
// all (the route's own company check answers that case).
async function canSee(user, companyId, branchId, db = pool) {
  if (isSuper(user)) return true;
  if (!(await UserAccessService.userHasCompanyAccess(user.id, companyId))) return null;
  const scope = await transactionScope(user, companyId, db);
  if (branchId === null || branchId === undefined) return scope.includeUnassigned;
  return scope.branchIds.includes(Number(branchId));
}

// ---- references -------------------------------------------------------------
async function validateReferences(db, { companyId, branchId, partyIds = [], lines = [] }) {
  const accountIds = (Array.isArray(lines) ? lines : []).map((l) => l?.accountId);
  await TransactionBranchService.assertAccountsUsableInBranch(accountIds, branchId, db);
  for (const partyId of partyIds) {
    if (partyId === undefined || partyId === null || partyId === "") continue;
    await TransactionBranchService.assertPartyUsableInBranch({ companyId, partyId, branchId }, db);
  }
  // Line-level parties (Gen Ref = General Library code). A code may be owned
  // by several branches (genlibCodePolicy): it is usable when the document's
  // branch owns it or it is shared, and refused only when EVERY record of
  // that code belongs to another branch.
  const codes = [...new Set((Array.isArray(lines) ? lines : []).map((l) => String(l?.genRef || "").trim()).filter(Boolean))];
  if (codes.length) {
    const [rows] = await db.query("SELECT code, branch_id FROM general_libraries WHERE company_id = ? AND code IN (?)", [companyId, codes]);
    const byCode = new Map();
    for (const r of rows) {
      const k = String(r.code).trim().toLowerCase();
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(r);
    }
    const foreign = [...byCode.values()]
      .filter((list) => !list.some((r) => r.branch_id === null || sameBranch(r.branch_id, branchId)))
      .map((list) => list[0].code);
    if (foreign.length) {
      throw new HttpError(400, `Party ${foreign.join(", ")} belongs to another branch.`, "PARTY_BRANCH_MISMATCH");
    }
  }
}

// ---- create -----------------------------------------------------------------
async function resolveCreateBranch(db, user, { companyId, requestedBranchId, forcedBranchId }) {
  const fixed = forcedBranchId !== undefined;
  const requested = fixed ? forcedBranchId : requestedBranchId;
  if (requested !== undefined && requested !== null && requested !== "") {
    return TransactionBranchService.resolveTransactionBranch(user, companyId, requested, db);
  }
  const [[all]] = await db.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
  if (Number(all.n) === 0) return null;
  const active = (await BranchResolution.authorizedBranches(user, companyId, db))
    .filter((b) => String(b.status || "").toUpperCase() === "ACTIVE");
  if (active.length === 1) return Number(active[0].id);
  if (!active.length) throw new HttpError(403, "You are not assigned to an active branch of this company.", "BRANCH_ACCESS_DENIED");
  throw new HttpError(400, "Select the branch this transaction belongs to.", "BRANCH_REQUIRED");
}

// Validate before the header INSERT and return the branch to store.
async function prepareCreate(conn, user, { companyId, body, partyIds = [], lines, forcedBranchId }) {
  const branchId = await resolveCreateBranch(conn, user, { companyId, requestedBranchId: body?.branchId, forcedBranchId });
  await validateReferences(conn, { companyId, branchId, partyIds, lines: lines ?? body?.lines });
  return branchId;
}

// Store the branch on the freshly inserted header (same DB transaction).
async function assign(conn, table, id, branchId) {
  await conn.execute(`UPDATE ${table} SET branch_id = ? WHERE id = ?`, [branchId, id]);
}

// ---- update -----------------------------------------------------------------
async function enforceUpdate(conn, user, { table, id, companyId, body, partyIds = [], lines, status }) {
  const [rows] = await conn.execute(
    `SELECT x.company_id, x.branch_id, b.status AS branch_status
       FROM ${table} x LEFT JOIN branches b ON b.id = x.branch_id WHERE x.id = ?`,
    [id]
  );
  if (!rows.length || Number(rows[0].company_id) !== Number(companyId)) return undefined; // route's own 404
  const current = rows[0].branch_id;
  if (body && Object.prototype.hasOwnProperty.call(body, "branchId") && body.branchId !== undefined && body.branchId !== "") {
    if (!sameBranch(body.branchId, current)) {
      throw new HttpError(409, "A transaction's branch cannot be changed after it is created.", "BRANCH_CHANGE_NOT_ALLOWED");
    }
  }
  if (!(await canSee(user, companyId, current, conn))) throw new HttpError(404, "Record not found", "RECORD_NOT_FOUND");
  if (current !== null && String(status || "").toUpperCase() === "POSTED" && String(rows[0].branch_status || "").toUpperCase() !== "ACTIVE") {
    throw new HttpError(409, "This branch is inactive; the transaction cannot be posted.", "BRANCH_INACTIVE");
  }
  await validateReferences(conn, { companyId, branchId: current, partyIds, lines: lines ?? body?.lines });
  return current;
}

// ---- /:id isolation middleware -----------------------------------------------
// Runs before the module's own routes. For an existing record of a company the
// user belongs to but a branch they may not see, it answers with the route's
// own "not found" - indistinguishable from an unknown id or another company's
// record. Everything else (unknown id, other company, allowed) falls through
// to the route unchanged. /reverse keeps its Phase A/B behavior.
const MODULES = {
  invoices: { table: "invoice_headers", label: "Invoice" },
  or: { table: "or_headers", label: "OR" },
  apv: { table: "apv_headers", label: "APV" },
  cv: { table: "cv_headers", label: "CV" },
  jv: { table: "jv_headers", label: "JV" },
  "purchase-orders": { table: "purchase_order_headers", label: "Purchase Order" },
  "petty-cash": { table: "petty_cash_headers", label: "Petty Cash Voucher" },
  quotations: { table: "quotation_headers", label: "Quotation" },
  "debit-memos": { table: "memo_headers", label: "Debit Memo", memoType: "DEBIT" },
  "credit-memos": { table: "memo_headers", label: "Credit Memo", memoType: "CREDIT" },
};

function isolationMiddleware(prefix) {
  const mod = MODULES[prefix];
  return (req, res, next) => {
    const id = String(req.params.id || "");
    if (!/^\d+$/.test(id) || /^\/reverse\b/.test(req.path || "")) return next();
    return authenticateToken(req, res, async () => {
      try {
        const [rows] = await pool.execute(
          `SELECT company_id, branch_id${mod.memoType ? ", memo_type" : ""} FROM ${mod.table} WHERE id = ?`,
          [id]
        );
        if (!rows.length || (mod.memoType && rows[0].memo_type !== mod.memoType)) return next();
        const visible = await canSee(req.user, rows[0].company_id, rows[0].branch_id);
        if (visible === false) return res.status(404).json({ message: `${mod.label} not found` });
        return next();
      } catch (err) {
        console.error("TRANSACTION BRANCH ISOLATION ERROR:", err);
        return res.status(500).json({ message: "Failed to verify branch access" });
      }
    });
  };
}

function registerIsolation(app) {
  for (const prefix of Object.keys(MODULES)) app.use(`/api/${prefix}/:id`, isolationMiddleware(prefix));
}

module.exports = {
  printScope,
  scopeSql,
  MODULES,
  transactionScope,
  visibleSql,
  canSee,
  validateReferences,
  resolveCreateBranch,
  prepareCreate,
  assign,
  enforceUpdate,
  isolationMiddleware,
  registerIsolation,
};
