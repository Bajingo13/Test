const UserAccessService = require("../services/userAccessService");

// Validates that a company_id the request is targeting (e.g. assigning a
// user to a company) is one the ACTING user themselves has access to -
// never trusts a company_id sent by the frontend at face value. SUPER_ADMIN
// bypasses this (full access to all companies, per spec).
//
// Phase 1 note: this is not yet wired into any existing transaction route,
// since none of those tables have a company_id column yet - it's used by
// this phase's own new user-management routes and is ready for when a
// later phase adds company scoping to existing modules.
function companyScope({ source = "body", field = "companyId" } = {}) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Access token required" });
    }
    if (req.user.roleCode === "SUPER_ADMIN") {
      return next();
    }

    const companyId = req[source]?.[field];
    if (!companyId) {
      return next();
    }

    try {
      const hasAccess = await UserAccessService.userHasCompanyAccess(req.user.id, companyId);
      if (!hasAccess) {
        return res.status(403).json({ message: "You do not have access to this company" });
      }
      next();
    } catch (err) {
      console.error("COMPANY SCOPE ERROR:", err);
      res.status(500).json({ message: "Failed to verify company access" });
    }
  };
}

module.exports = companyScope;
