// System-wide Active Branch - the request side.
//
// The browser sends the branch the user picked (Dashboard / sidebar selector)
// as the `X-Active-Branch` header on every /api request:
//   absent or "ALL"  -> no narrowing: every branch the user may see (today's
//                       behaviour, unchanged)
//   <branch id>      -> list / report reads are NARROWED to that branch
//
// It is a request CONTEXT, never an authorization grant:
//   - it can only narrow a scope the server already computed from the user's
//     company / branch assignments - never widen it;
//   - a branch the user is not authorized for narrows to NOTHING (fail
//     closed), it never falls back to "everything";
//   - a branch of ANOTHER company than the one the request reads does not
//     apply to that request (the request's own company scope stands);
//   - an explicit branch in the request (?branchId= / ?branch=) always wins:
//     a form looking up another branch's open items is never emptied by it;
//   - writes never take their branch from it (forms send branchId
//     explicitly and the server validates that as before).
// Kept in a request-scoped AsyncLocalStorage, like lib/reportBranchContext.
const { AsyncLocalStorage } = require("async_hooks");
const pool = require("../db");

const HEADER = "x-active-branch";
const als = new AsyncLocalStorage();

const present = (v) => v !== undefined && v !== null && String(v).trim() !== "";

// Mounted once on /api (after the JSON body parser).
function middleware(req, res, next) {
  const raw = String(req.headers?.[HEADER] ?? "").trim();
  if (!raw || raw.toUpperCase() === "ALL") return next();
  const branchId = Number(raw);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    return res.status(400).json({ message: "Invalid active branch.", code: "ACTIVE_BRANCH_INVALID" });
  }
  const explicit = present(req.query?.branchId) || present(req.query?.branch);
  return als.run({ branchId, explicit }, () => next());
}

// The active branch id for this request, or null (none / ALL / an explicit
// branch parameter takes precedence).
function requestedBranchId() {
  const ctx = als.getStore();
  return ctx && !ctx.explicit ? ctx.branchId : null;
}

async function branchCompany(branchId, db = pool) {
  const [[row]] = await db.execute("SELECT company_id FROM branches WHERE id = ?", [branchId]);
  return row ? Number(row.company_id) : null;
}

async function companyBranchCount(companyId, db = pool) {
  const [[row]] = await db.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
  return Number(row.n);
}

// Narrows a visibility scope of `companyId` to the active branch.
//   scope = "ALL" (no restriction, e.g. SUPER_ADMIN) or
//           { branchIds: [...], includeUnassigned }
// Returns the scope unchanged when no active branch applies to this company;
// otherwise { branchIds: [id], includeUnassigned } when the user may see the
// branch, or an EMPTY scope when they may not. Rows without a branch
// (company-level history) stay visible only in a one-branch company, as in
// the report scope.
async function narrowScope(companyId, scope, db = pool) {
  const branchId = requestedBranchId();
  if (!branchId || !companyId) return scope;
  const owner = await branchCompany(branchId, db);
  if (owner === null || owner !== Number(companyId)) return scope;
  const all = scope === "ALL";
  const allowed = all || (scope?.branchIds || []).map(Number).includes(branchId);
  if (!allowed) return { branchIds: [], includeUnassigned: false };
  const single = (await companyBranchCount(companyId, db)) === 1;
  return { branchIds: [branchId], includeUnassigned: single && (all || !!scope?.includeUnassigned) };
}

module.exports = { HEADER, middleware, requestedBranchId, narrowScope, branchCompany };
