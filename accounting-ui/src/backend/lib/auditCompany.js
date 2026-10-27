// Company attribution for audit events whose entity is not itself a
// company-owned row - users, invitations and per-user permission
// overrides. Such an event is attributed to a company only when exactly
// ONE company is involved (directly, or through an assigned branch, since
// every branch belongs to one company). Zero or several companies return
// null, so the row stays a SYSTEM event (Super Admin only). Never "the
// first/lowest company": a user in A and B is not an A event.

function parseIdList(value) {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list : [];
}

function soleCompanyId(ids) {
  const distinct = new Set(
    parseIdList(ids)
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  return distinct.size === 1 ? [...distinct][0] : null;
}

// For an explicit company/branch selection (invitations, the before/after
// sets of a user-access change).
async function soleCompanyForAccess(db, { companyIds = [], branchIds = [] } = {}) {
  const ids = parseIdList(companyIds);
  const branches = parseIdList(branchIds).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (branches.length) {
    const [rows] = await db.execute(
      `SELECT DISTINCT company_id FROM branches WHERE id IN (${branches.map(() => "?").join(",")})`,
      branches
    );
    ids.push(...rows.map((r) => r.company_id));
  }
  return soleCompanyId(ids);
}

// For an action on an existing user account (status, unlock, sessions,
// permission overrides): that user's current company/branch membership.
async function soleCompanyOfUser(db, userId) {
  const [companies] = await db.execute("SELECT company_id FROM user_companies WHERE user_id = ?", [userId]);
  const [branches] = await db.execute(
    "SELECT b.company_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ?",
    [userId]
  );
  return soleCompanyId([...companies, ...branches].map((r) => r.company_id));
}

module.exports = { soleCompanyId, soleCompanyForAccess, soleCompanyOfUser };
