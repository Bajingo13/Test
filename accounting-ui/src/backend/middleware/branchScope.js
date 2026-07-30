const UserAccessService = require("../services/userAccessService");

// Same shape as companyScope.js, for branch_id. SUPER_ADMIN bypasses (full
// access to all branches, per spec). See companyScope.js for the Phase 1
// scoping note - not yet wired into existing transaction routes.
function branchScope({ source = "body", field = "branchId" } = {}) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Access token required" });
    }
    if (req.user.roleCode === "SUPER_ADMIN") {
      return next();
    }

    const branchId = req[source]?.[field];
    if (!branchId) {
      return next();
    }

    try {
      const hasAccess = await UserAccessService.userHasBranchAccess(req.user.id, branchId);
      if (!hasAccess) {
        return res.status(403).json({ message: "You do not have access to this branch" });
      }
      next();
    } catch (err) {
      console.error("BRANCH SCOPE ERROR:", err);
      res.status(500).json({ message: "Failed to verify branch access" });
    }
  };
}

module.exports = branchScope;
