// Multi-Branch Foundation, Phase C-2A - branch scope for the Reports module.
//
// One middleware on /api/reports resolves the branch scope of the request and
// keeps it in a request-scoped context (AsyncLocalStorage). Every report
// recognizes transactions through reportRecognitionService.postedOnlySql(alias)
// on the transaction HEADER, and that helper appends this scope's predicate -
// so Income Statement, Balance Sheet, Trial Balance, General Ledger, Account
// Analysis, Subsidiary Ledger, books, aging, statements, VAT/EWT and the rest
// are branch-filtered by the same, single rule. Outside a report request there
// is no context and postedOnlySql is exactly what it was (payment lookups,
// open items, transaction lists are unaffected).
//
// Scope (authorization is the Phase A resolver - never the browser):
//   ?branch=<id>  that branch (403 / 404 / 400 if not allowed). When it is the
//                 company's ONLY branch, rows without a branch are included too,
//                 so a single-branch company's report equals its company report.
//   ?branch=ALL   ONE consolidated report over every branch the user may see;
//                 needs REPORTS.ALL_BRANCHES (ADMIN; ACCOUNTANT explicit 0).
//   no branch     full-authority users (every branch of the company): no filter
//                 (the report exactly as before); a branch-restricted user: only
//                 their authorized branches - never another branch's data.
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

function current() {
  return als.getStore() || null;
}

// SQL predicate on header alias `alias` ("" -> bare column) for the current
// request's scope; "" when no scope applies.
function predicate(alias) {
  const ctx = current();
  if (!ctx) return "";
  const col = alias ? `${alias}.branch_id` : "branch_id";
  const ids = ctx.branchIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const inList = ids.length ? `${col} IN (${ids.join(",")})` : "1 = 0";
  return ctx.includeUnassigned ? `(${inList} OR ${col} IS NULL)` : inList;
}

// authenticateToken writes its own 401/403; here it must never answer for the
// route (print pipelines under /api/reports may authenticate differently), so a
// failed check simply leaves the request without a branch scope.
function tryAuthenticate(authenticateToken, req) {
  return new Promise((resolve) => {
    const quiet = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json() { resolve(false); return this; },
      send() { resolve(false); return this; },
      end() { resolve(false); return this; },
      set() { return this; },
      setHeader() { return this; },
    };
    Promise.resolve(authenticateToken(req, quiet, () => resolve(true))).catch(() => resolve(false));
  });
}

async function middleware(req, res, next) {
  const hasBearer = /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""));
  if (!hasBearer) return next();
  const { authenticateToken } = require("../middleware/authenticate");
  const CurrencyService = require("../services/currencyService");
  const BranchResolution = require("./branchResolution");
  const TxBranch = require("../services/transactionBranchEnforcement");
  const pool = require("../db");

  let ctx = null;
  try {
    if (!(await tryAuthenticate(authenticateToken, req)) || !req.user) return next();
    let companyId;
    try {
      companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    } catch (err) {
      // With a branch requested, answer the company refusal here (a clean 403);
      // without one the route keeps answering exactly as it always has.
      if (req.query.branch !== undefined && req.query.branch !== "" && err.statusCode && err.statusCode < 500) {
        return res.status(err.statusCode).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
      }
      return next();
    }
    let requested = req.query.branch;
    // System-wide Active Branch: with no ?branch, the request's active branch
    // (X-Active-Branch) is the report branch - validated exactly like ?branch
    // (403 when not authorized). One of another company does not apply.
    if (requested === undefined || requested === "") {
      const ActiveBranch = require("./activeBranchContext");
      const active = ActiveBranch.requestedBranchId();
      if (active && (await ActiveBranch.branchCompany(active)) === Number(companyId)) requested = String(active);
    }
    if (requested !== undefined && requested !== "") {
      const scope = await BranchResolution.resolveReportBranchScope(req.user, companyId, requested);
      if (!scope.consolidated) {
        const [[all]] = await pool.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
        if (Number(all.n) === 1) scope.includeUnassigned = true;
      }
      ctx = { companyId, ...scope };
    } else {
      const scope = await TxBranch.transactionScope(req.user, companyId);
      if (!scope.includeUnassigned && req.user.roleCode !== "SUPER_ADMIN") {
        ctx = { companyId, consolidated: false, branchIds: scope.branchIds, includeUnassigned: false };
      }
    }
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    console.error("REPORT BRANCH SCOPE ERROR:", err);
    return res.status(500).json({ message: "Failed to resolve the report branch" });
  }
  if (!ctx) return next();
  return als.run(ctx, () => next());
}

module.exports = { middleware, current, predicate };
