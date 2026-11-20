// Multi-Branch Foundation, Phase B - code-keyed Chart of Accounts lookups.
//
// From Phase B a branch-only account code may be reused in ANOTHER branch
// (Branch 1 and Branch 2 may both own 1100 Accounts Receivable). Every query
// that joins the COA by CODE (reports, trial-balance tools, dashboard,
// beginning-balance template/import) would then match the code twice and
// double its amounts. coaByCodeSql() is the one place that prevents that: a
// derived table with exactly ONE row per account code -
//   1. the shared account (branch_id NULL) when one exists - by rule a shared
//      code is never reused by a branch, so it is the only row;
//   2. otherwise the lowest-id branch account with that code - by rule all
//      branch accounts sharing a code have the same account class, so the
//      classification used by consolidation is the same whichever row is used.
// While no code is duplicated (all data before branch-only accounts are
// created) it returns exactly the chart_of_accounts rows, so existing report
// output is byte-identical. Joins by account ID are unaffected and unchanged.
const COA_COLUMNS = "id, code, account_date, title, account_class, description, branch_id, created_at, updated_at";

function coaByCodeSql() {
  return `(SELECT ${COA_COLUMNS} FROM (
      SELECT ${COA_COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")},
             ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(CAST(c.code AS CHAR))) ORDER BY (c.branch_id IS NULL) DESC, c.id) AS coa_rank
        FROM chart_of_accounts c) coa_ranked
     WHERE coa_ranked.coa_rank = 1)`;
}

// Code rules the schema cannot express (the schema enforces "unique within a
// branch scope"). Run inside the create/update transaction: the locking read
// takes next-key locks on (code, *) so a concurrent create of the same code
// waits instead of slipping past the check.
//   409 COA_CODE_USED_BY_BRANCH   - a shared code already owned by a branch
//   409 COA_CODE_SHARED_CONFLICT  - a branch code already used by a shared account
//   409 COA_CODE_CLASS_CONFLICT   - a reused branch code with a different class
const { HttpError } = require("../lib/httpError");

async function assertCoaCodeAllowed(conn, { code, branchId, accountClass, excludeId = null }) {
  const [rows] = await conn.execute(
    "SELECT id, branch_id, account_class FROM chart_of_accounts WHERE code = ? FOR UPDATE",
    [code]
  );
  const others = rows.filter((r) => excludeId === null || Number(r.id) !== Number(excludeId));
  if (branchId === null || branchId === undefined) {
    if (others.some((r) => r.branch_id !== null)) {
      throw new HttpError(409, `Account code ${code} is already used by a branch account; a shared account cannot reuse it.`, "COA_CODE_USED_BY_BRANCH");
    }
    return;
  }
  if (others.some((r) => r.branch_id === null)) {
    throw new HttpError(409, `Account code ${code} is a shared account; a branch account cannot reuse it.`, "COA_CODE_SHARED_CONFLICT");
  }
  const otherBranches = others.filter((r) => r.branch_id !== null && Number(r.branch_id) !== Number(branchId));
  if (otherBranches.some((r) => String(r.account_class).toUpperCase() !== String(accountClass).toUpperCase())) {
    throw new HttpError(409, `Account code ${code} is used by another branch with a different account class; branches sharing a code must use the same class.`, "COA_CODE_CLASS_CONFLICT");
  }
}

module.exports = { coaByCodeSql, COA_COLUMNS, assertCoaCodeAllowed };
