// Multi-Branch Foundation - a reversal stays in its original's branch.
//
// Existing APV / CV reversal (Phase 7K.1, performReversal in server.js) creates
// a separate Posted reversing JV and never changes the original. This adds the
// branch rule to it:
//   - the reversal JV gets original.branch_id (NULL stays NULL - never guessed);
//   - the user must be authorized for the original's branch, otherwise
//     403 BRANCH_ACCESS_DENIED (cross-branch reversal);
//   - the original's branch must belong to the original's company
//     (409 BRANCH_COMPANY_MISMATCH - data integrity).
// Company isolation (404 for another company's document) and duplicate
// reversal (409 ALREADY_REVERSED) are the existing checks in the routes.
// Runs inside the reversal's DB transaction: a rejection rolls everything back.
const { HttpError } = require("../lib/httpError");
const BranchResolution = require("../lib/branchResolution");

const ORIGINAL_HEADER = { APV: "apv_headers", CV: "cv_headers" };

async function applyOriginalBranch(conn, { module, originalId, reversalJvId, companyId, user }) {
  const table = ORIGINAL_HEADER[module];
  if (!table) throw new HttpError(500, `Unknown reversal module "${module}".`);
  const [rows] = await conn.execute(
    `SELECT x.branch_id AS branchId, b.company_id AS branchCompanyId
       FROM ${table} x LEFT JOIN branches b ON b.id = x.branch_id
      WHERE x.id = ? AND x.company_id = ?`,
    [originalId, companyId]
  );
  if (!rows.length) throw new HttpError(404, `${module} not found.`);
  const { branchId, branchCompanyId } = rows[0];
  if (branchId !== null && Number(branchCompanyId) !== Number(companyId)) {
    throw new HttpError(409, `This ${module}'s branch does not belong to its company.`, "BRANCH_COMPANY_MISMATCH");
  }
  if (user) await BranchResolution.assertRecordBranchAccess(user, companyId, branchId, conn);
  await conn.execute("UPDATE jv_headers SET branch_id = ? WHERE id = ? AND company_id = ?", [branchId, reversalJvId, companyId]);
  return branchId;
}

module.exports = { applyOriginalBranch };
