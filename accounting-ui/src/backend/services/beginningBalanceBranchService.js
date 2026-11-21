// Multi-Branch Phase C-3 - branch-aware Beginning Balances (GL / AR / AP).
//
// Model: a beginning-balance header is owned by Company + Branch + Balance
// Date (AR / AP additionally by balance type and header currency - the
// header's currency is what the AR / AP list prints for its lines, so a USD
// line must never be filed under a PHP header). One header per key: a
// second save / import for the same key adds lines to the existing header.
//
// Branch on CREATE / IMPORT: the same rule as a transaction
// (TransactionBranchEnforcement.resolveCreateBranch) - a submitted branchId
// is never trusted on its own (company, ownership, user authority, ACTIVE):
//   company has no branches                -> NULL (legacy, unchanged);
//   one authorized ACTIVE branch            -> that branch, automatically;
//   several                                 -> 400 BRANCH_REQUIRED;
//   none                                    -> 403 BRANCH_ACCESS_DENIED.
// Accounts / parties must be shared or the branch's own
// (validateReferences).
//
// Visibility: the transaction rule - rows of the user's authorized branches;
// unresolved history (branch_id NULL in a multi-branch company) only for
// users whose authority covers every branch of the company (never guessed
// into a branch, never shown to a single-branch accountant).
//
// Concurrency: find-or-create runs under a per-company named lock held until
// the caller's transaction ends, so two concurrent saves for the same key
// cannot both create a header. The lookup is a LOCKING read (FOR UPDATE): the
// caller's REPEATABLE READ snapshot may predate the lock, and a plain SELECT
// would not see a header the previous lock holder just committed. (No UNIQUE index: legacy data may already hold
// several headers for one company + date, and history is not rewritten.)
const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const TransactionBranchEnforcement = require("./transactionBranchEnforcement");

const LOCK_TIMEOUT_SECONDS = 10;
const lockName = (kind, companyId) => `astrea:bb-header:${kind}:${Number(companyId)}`;

async function resolveBeginningBalanceBranch(db, user, { companyId, requestedBranchId }) {
  try {
    return await TransactionBranchEnforcement.resolveCreateBranch(db, user, { companyId, requestedBranchId });
  } catch (err) {
    if (err.code === "BRANCH_REQUIRED") {
      throw new HttpError(400, "Select the branch this beginning balance belongs to.", "BRANCH_REQUIRED");
    }
    throw err;
  }
}

// Accounts (lines[].accountId) and parties usable in the branch.
async function validateBeginningBalanceReferences(db, { companyId, branchId, partyIds = [], accountIds = [] }) {
  await TransactionBranchEnforcement.validateReferences(db, {
    companyId,
    branchId,
    partyIds,
    lines: accountIds.map((accountId) => ({ accountId })),
  });
}

// Manual GL rows carry an account CODE (no id). A code that exists only as
// another branch's own account is refused; a code usable in the branch
// (shared, or this branch's own) or unknown to the chart (unchanged legacy
// free-text behavior) passes.
async function assertAccountCodesUsable(db, { branchId, codes = [] }) {
  const list = [...new Set(codes.map((c) => String(c || "").trim()).filter(Boolean))];
  if (!list.length) return;
  const [rows] = await db.query("SELECT code, branch_id FROM chart_of_accounts WHERE code IN (?)", [list]);
  const usable = new Set();
  const seen = new Set();
  for (const r of rows) {
    const code = String(r.code).trim();
    seen.add(code);
    if (r.branch_id === null || (branchId !== null && branchId !== undefined && Number(r.branch_id) === Number(branchId))) usable.add(code);
  }
  const foreign = [...seen].filter((c) => !usable.has(c));
  if (foreign.length) {
    throw new HttpError(400, `Account ${foreign.join(", ")} belongs to another branch.`, "ACCOUNT_BRANCH_MISMATCH");
  }
}

async function acquireHeaderLock(conn, kind, companyId) {
  const [[row]] = await conn.query("SELECT GET_LOCK(?, ?) AS ok", [lockName(kind, companyId), LOCK_TIMEOUT_SECONDS]);
  if (Number(row.ok) !== 1) {
    throw new HttpError(409, "Another beginning balance save for this company is in progress. Please try again.", "BEGINNING_BALANCE_BUSY");
  }
}

// Always safe to call (a lock this session does not hold is a no-op).
async function releaseHeaderLock(conn, kind, companyId) {
  try {
    await conn.query("SELECT RELEASE_LOCK(?)", [lockName(kind, companyId)]);
  } catch (err) {
    console.error("BEGINNING BALANCE HEADER LOCK RELEASE ERROR:", err);
  }
}

async function findOrCreateGLHeader(conn, { companyId, branchId = null, balanceDate, filterCode, currencyCode, currencyName, title }) {
  const [existing] = await conn.execute(
    "SELECT id FROM gl_beginning_balance_headers WHERE company_id = ? AND balance_date = ? AND branch_id <=> ? ORDER BY id LIMIT 1 FOR UPDATE",
    [companyId, balanceDate, branchId]
  );
  if (existing.length) return existing[0].id;
  const [result] = await conn.execute(
    `INSERT INTO gl_beginning_balance_headers (company_id, branch_id, filter_code, balance_date, currency_code, currency_name, title, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, filterCode || "NON", balanceDate, currencyCode || "PHP", currencyName || "PHILIPPINE PESO", title || null, "Posted"]
  );
  return result.insertId;
}

async function findOrCreateARAPHeader(conn, { companyId, branchId = null, balanceType, balanceDate, currencyCode, currencyName, remarks, status = "Posted" }) {
  const code = currencyCode || "PHP";
  const [existing] = await conn.execute(
    `SELECT id FROM arap_beginning_balance_headers
      WHERE company_id = ? AND balance_type = ? AND balance_date = ? AND branch_id <=> ? AND currency_code = ?
      ORDER BY id LIMIT 1 FOR UPDATE`,
    [companyId, balanceType, balanceDate, branchId, code]
  );
  if (existing.length) return existing[0].id;
  const [result] = await conn.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, branch_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, balanceType, balanceDate, code, currencyName || "PHILIPPINE PESO", remarks || "", status]
  );
  return result.insertId;
}

// List predicate on header alias `alias`.
async function visibleSql(user, companyId, alias, db = pool) {
  return TransactionBranchEnforcement.visibleSql(user, companyId, alias, db);
}

// true when the user may see / change a header of `branchId`.
async function canSeeHeader(user, companyId, branchId, db = pool) {
  return (await TransactionBranchEnforcement.canSee(user, companyId, branchId, db)) === true;
}

module.exports = {
  resolveBeginningBalanceBranch,
  validateBeginningBalanceReferences,
  assertAccountCodesUsable,
  acquireHeaderLock,
  releaseHeaderLock,
  findOrCreateGLHeader,
  findOrCreateARAPHeader,
  visibleSql,
  canSeeHeader,
};
