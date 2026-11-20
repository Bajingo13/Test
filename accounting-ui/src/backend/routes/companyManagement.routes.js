// /api/company-management - Super Admin company creation (FILESETUP.COMPANIES /
// CREATE, granted to no role; Super Admin passes by bypass). authorizePermission
// records ACCESS_DENIED for everyone else. GET /api/companies (roles.routes.js,
// the caller's own companies for the pickers) is unchanged.
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const { requestMeta } = require("../lib/audit");
const CompanyService = require("../services/companyService");

const requireCreate = authorizePermission("FILESETUP.COMPANIES", "CREATE");

function handleError(res, err, fallback) {
  if (!err.statusCode) console.error(fallback, err);
  res.status(err.statusCode || 500).json(err.statusCode ? { message: err.message, code: err.code } : { message: fallback });
}

router.get("/", authenticateToken, requireCreate, async (req, res) => {
  try {
    res.json(await CompanyService.listCompanies());
  } catch (err) {
    handleError(res, err, "Failed to load companies.");
  }
});

router.post("/", authenticateToken, requireCreate, async (req, res) => {
  try {
    const company = await CompanyService.createCompany({ ...req.user, ...requestMeta(req) }, req.body || {});
    res.status(201).json({ message: "Company created.", company });
  } catch (err) {
    handleError(res, err, "Failed to create company.");
  }
});

module.exports = router;
