// Multi-Branch Foundation - THE server-side branch resolver.
//
//   user -> authorized company -> authorized branch -> requested record
//
// A branch id from the request (query or body) is never trusted on its own:
// it must exist, belong to the target company, and be within the user's
// branch authority:
//   SUPER_ADMIN - every branch of the target company (existing bypass; the
//                 branch must still belong to that company).
//   ADMIN       - every branch of a company the admin belongs to
//                 (user_companies).
//   other roles - only branches assigned in user_branches, and only within a
//                 company the user belongs to.
// "All Branches" (consolidated reporting) means all branches THIS user is
// authorized for - never "every branch in the company" for every role - and
// needs REPORTS.ALL_BRANCHES / VIEW (ADMIN; ACCOUNTANT explicit 0).
const pool = require("../db");
const { HttpError } = require("./httpError");
const PermissionService = require("../services/permissionService");

const CONSOLIDATED_PERMISSION = ["REPORTS.ALL_BRANCHES", "VIEW"];
const ALL = "ALL";

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function hasCompany(db, user, companyId) {
  if (user.roleCode === "SUPER_ADMIN") return true;
  const [rows] = await db.execute("SELECT 1 FROM user_companies WHERE user_id = ? AND company_id = ? LIMIT 1", [user.id, companyId]);
  return rows.length > 0;
}

// Branches of `companyId` the user may act on (id order). [] when none.
async function authorizedBranches(user, companyId, db = pool) {
  const cid = toId(companyId);
  if (!cid || !(await hasCompany(db, user, cid))) return [];
  const cols = "b.id, b.company_id AS companyId, b.code, b.name, b.status";
  if (user.roleCode === "SUPER_ADMIN" || user.roleCode === "ADMIN") {
    const [rows] = await db.execute(`SELECT ${cols} FROM branches b WHERE b.company_id = ? ORDER BY b.id`, [cid]);
    return rows;
  }
  const [rows] = await db.execute(
    `SELECT ${cols} FROM branches b JOIN user_branches ub ON ub.branch_id = b.id AND ub.user_id = ?
      WHERE b.company_id = ? ORDER BY b.id`,
    [user.id, cid]
  );
  return rows;
}

async function authorizedBranchIds(user, companyId, db = pool) {
  return (await authorizedBranches(user, companyId, db)).map((b) => Number(b.id));
}

// Every branch the user may act on across all of their companies (used where a
// record is not tied to one company, e.g. the system-wide Chart of Accounts).
async function authorizedBranchIdsAnyCompany(user, db = pool) {
  if (user.roleCode === "SUPER_ADMIN") {
    const [rows] = await db.execute("SELECT id FROM branches");
    return rows.map((r) => Number(r.id));
  }
  if (user.roleCode === "ADMIN") {
    const [rows] = await db.execute(
      "SELECT b.id FROM branches b JOIN user_companies uc ON uc.company_id = b.company_id AND uc.user_id = ?",
      [user.id]
    );
    return rows.map((r) => Number(r.id));
  }
  const [rows] = await db.execute(
    `SELECT b.id FROM branches b
       JOIN user_branches ub ON ub.branch_id = b.id AND ub.user_id = ?
       JOIN user_companies uc ON uc.company_id = b.company_id AND uc.user_id = ub.user_id`,
    [user.id]
  );
  return rows.map((r) => Number(r.id));
}

// Validates one requested branch for `companyId`. Returns the branch id, or
// null when not required and not given. Errors:
//   400 BRANCH_REQUIRED, 404 BRANCH_NOT_FOUND, 403 BRANCH_COMPANY_MISMATCH,
//   403 BRANCH_ACCESS_DENIED.
async function resolveBranch(user, companyId, requestedBranchId, { required = true, db = pool } = {}) {
  if (requestedBranchId === undefined || requestedBranchId === null || requestedBranchId === "") {
    if (required) throw new HttpError(400, "A branch is required.", "BRANCH_REQUIRED");
    return null;
  }
  const branchId = toId(requestedBranchId);
  if (!branchId) throw new HttpError(400, "Invalid branch.", "BRANCH_REQUIRED");
  const [rows] = await db.execute("SELECT id, company_id FROM branches WHERE id = ?", [branchId]);
  if (!rows.length) throw new HttpError(404, "Branch not found.", "BRANCH_NOT_FOUND");
  if (Number(rows[0].company_id) !== Number(companyId)) {
    throw new HttpError(403, "This branch does not belong to the selected company.", "BRANCH_COMPANY_MISMATCH");
  }
  if (!(await authorizedBranchIds(user, companyId, db)).includes(branchId)) {
    throw new HttpError(403, "You do not have access to this branch.", "BRANCH_ACCESS_DENIED");
  }
  return branchId;
}

// Access to an EXISTING record's branch. NULL branch = company-level/shared
// record (allowed; company access is checked by the caller).
async function assertRecordBranchAccess(user, companyId, branchId, db = pool) {
  if (branchId === null || branchId === undefined) return;
  if (!(await authorizedBranchIds(user, companyId, db)).includes(Number(branchId))) {
    throw new HttpError(403, "You do not have access to this branch.", "BRANCH_ACCESS_DENIED");
  }
}

async function canConsolidate(user) {
  if (user.roleCode === "SUPER_ADMIN") return true;
  return PermissionService.can(user.id, ...CONSOLIDATED_PERMISSION);
}

// Report scope for `?branch=<id>|ALL`:
//   single:  { consolidated: false, branchIds: [id], includeUnassigned: false }
//   ALL:     { consolidated: true,  branchIds: <authorized>, includeUnassigned }
// includeUnassigned (historical rows with branch_id NULL) is true only when the
// user's authority covers EVERY branch of the company, so a full-authority
// consolidated report still reconciles to the company-level report.
async function resolveReportBranchScope(user, companyId, requested, db = pool) {
  if (String(requested || "").toUpperCase() === ALL) {
    if (!(await canConsolidate(user))) {
      throw new HttpError(403, "You are not authorized for consolidated (All Branches) reports.", "CONSOLIDATED_NOT_ALLOWED");
    }
    const branchIds = await authorizedBranchIds(user, companyId, db);
    if (!branchIds.length) throw new HttpError(403, "You do not have access to any branch of this company.", "BRANCH_ACCESS_DENIED");
    const [[all]] = await db.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
    return { consolidated: true, branchIds, includeUnassigned: branchIds.length === Number(all.n) };
  }
  const branchId = await resolveBranch(user, companyId, requested, { required: true, db });
  return { consolidated: false, branchIds: [branchId], includeUnassigned: false };
}

// SQL predicate for a resolved scope on header alias `alias` (ids are
// server-resolved integers, inlined safely).
function branchScopeSql(alias, scope) {
  const ids = (scope?.branchIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const inList = ids.length ? `${alias}.branch_id IN (${ids.join(",")})` : "1 = 0";
  return scope?.includeUnassigned ? `(${inList} OR ${alias}.branch_id IS NULL)` : inList;
}

// Visibility of branch-only setup records (COA / General Libraries):
// shared rows (branch_id NULL) + rows of branches in `branchIds`.
function setupVisibilitySql(alias, branchIds) {
  const ids = (branchIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? `(${alias}.branch_id IS NULL OR ${alias}.branch_id IN (${ids.join(",")}))` : `${alias}.branch_id IS NULL`;
}

// ---- Branch-only setup records (COA / General Libraries) -------------------
// NULL branch_id = shared record (unchanged behavior). A branch-only record is
// visible only to users authorized for that branch; to anyone else it does not
// exist (404, so its existence is not disclosed).

// Optional branch for a setup record that is not tied to a request company
// (the system-wide COA): the branch's OWN company is used for the check.
async function resolveBranchAnyCompany(user, requestedBranchId, db = pool) {
  if (requestedBranchId === undefined || requestedBranchId === null || requestedBranchId === "") return null;
  const branchId = toId(requestedBranchId);
  if (!branchId) throw new HttpError(400, "Invalid branch.", "BRANCH_REQUIRED");
  const [rows] = await db.execute("SELECT company_id FROM branches WHERE id = ?", [branchId]);
  if (!rows.length) throw new HttpError(404, "Branch not found.", "BRANCH_NOT_FOUND");
  return resolveBranch(user, rows[0].company_id, branchId, { required: true, db });
}

// Branch ids whose branch-only setup rows a list request may see:
// ?branchId -> just that (validated) branch; otherwise every authorized branch
// (of `companyId`, or of all the user's companies when companyId is null).
async function setupBranchIds(user, { companyId = null, requestedBranchId } = {}, db = pool) {
  if (requestedBranchId !== undefined && requestedBranchId !== null && requestedBranchId !== "") {
    const id = companyId
      ? await resolveBranch(user, companyId, requestedBranchId, { required: true, db })
      : await resolveBranchAnyCompany(user, requestedBranchId, db);
    return [id];
  }
  return companyId ? authorizedBranchIds(user, companyId, db) : authorizedBranchIdsAnyCompany(user, db);
}

async function assertSetupRecordVisible(user, branchId, db = pool) {
  if (branchId === null || branchId === undefined) return;
  if (!(await authorizedBranchIdsAnyCompany(user, db)).includes(Number(branchId))) {
    throw new HttpError(404, "Record not found", "RECORD_NOT_FOUND");
  }
}

module.exports = {
  ALL,
  resolveBranchAnyCompany,
  setupBranchIds,
  assertSetupRecordVisible,
  CONSOLIDATED_PERMISSION,
  authorizedBranches,
  authorizedBranchIds,
  authorizedBranchIdsAnyCompany,
  resolveBranch,
  assertRecordBranchAccess,
  canConsolidate,
  resolveReportBranchScope,
  branchScopeSql,
  setupVisibilitySql,
};
