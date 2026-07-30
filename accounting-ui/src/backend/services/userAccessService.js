const pool = require("../db");

async function getAccessibleCompanyIds(userId) {
  const [rows] = await pool.execute("SELECT company_id FROM user_companies WHERE user_id = ?", [userId]);
  return rows.map((r) => r.company_id);
}

async function getAccessibleBranchIds(userId) {
  const [rows] = await pool.execute("SELECT branch_id FROM user_branches WHERE user_id = ?", [userId]);
  return rows.map((r) => r.branch_id);
}

async function getUserAccessSummary(userId) {
  const [companies] = await pool.execute(
    `SELECT c.id, c.name FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = ? ORDER BY c.name`,
    [userId]
  );
  const [branches] = await pool.execute(
    `SELECT b.id, b.name, b.company_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.name`,
    [userId]
  );
  return { companies, branches };
}

// SUPER_ADMIN bypasses company/branch scoping entirely (full access to all
// companies and branches, per spec) - callers should check role first via
// req.user.roleCode and skip this check for SUPER_ADMIN.
async function userHasCompanyAccess(userId, companyId) {
  const [rows] = await pool.execute(
    "SELECT 1 FROM user_companies WHERE user_id = ? AND company_id = ? LIMIT 1",
    [userId, companyId]
  );
  return rows.length > 0;
}

async function userHasBranchAccess(userId, branchId) {
  const [rows] = await pool.execute(
    "SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ? LIMIT 1",
    [userId, branchId]
  );
  return rows.length > 0;
}

module.exports = {
  getAccessibleCompanyIds,
  getAccessibleBranchIds,
  getUserAccessSummary,
  userHasCompanyAccess,
  userHasBranchAccess,
};
