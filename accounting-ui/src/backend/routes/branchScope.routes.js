// Multi-Branch Foundation - branch-aware backend APIs (Phase A, no UI yet).
// Mounted at /api/branch-scope. Every branch comes from lib/branchResolution
// (never trusted from the request on its own); company from the existing
// CurrencyService company resolution.
//
//   GET /branches                 the caller's authorized branches + canConsolidate
//   GET /open-items/apv           CV -> APV candidates: company+branch+supplier
//   GET /open-items/invoices      OR -> Invoice candidates: company+branch+customer
//   GET /reports/account-totals   one report for ?branch=<id> or ?branch=ALL
//   GET /unresolved               historical rows left without a branch
const express = require("express");
const { authenticateToken } = require("../lib/auth");
const authorizePermission = require("../middleware/authorizePermission");
const CurrencyService = require("../services/currencyService");
const BranchResolution = require("../lib/branchResolution");
const BranchOpenItems = require("../services/branchOpenItemsService");
const LedgerReportService = require("../services/LedgerReportService");
const pool = require("../db");

const router = express.Router();

function sendError(res, err, fallback) {
  if (err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  console.error(`BRANCH SCOPE ERROR (${fallback}):`, err);
  return res.status(500).json({ message: fallback });
}

const companyOf = (req) => CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

router.get("/branches", authenticateToken, async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const branches = await BranchResolution.authorizedBranches(req.user, companyId);
    res.json({ companyId, branches, canConsolidate: await BranchResolution.canConsolidate(req.user) });
  } catch (err) {
    sendError(res, err, "Failed to load branches");
  }
});

router.get("/open-items/apv", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const branchId = await BranchResolution.resolveBranch(req.user, companyId, req.query.branchId);
    res.json(await BranchOpenItems.listOpenApvs({ companyId, branchId, supplierId: req.query.supplierId }));
  } catch (err) {
    sendError(res, err, "Failed to load unpaid APVs");
  }
});

router.get("/open-items/invoices", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "VIEW"), async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const branchId = await BranchResolution.resolveBranch(req.user, companyId, req.query.branchId);
    res.json(await BranchOpenItems.listOpenInvoices({ companyId, branchId, customerId: req.query.customerId }));
  } catch (err) {
    sendError(res, err, "Failed to load open invoices");
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Consolidated-report foundation: posted account totals over the canonical
// ledger union (LedgerReportService), for one branch or ALL authorized
// branches - always ONE combined result set, never one report per branch.
router.get("/reports/account-totals", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(String(from || "")) || !DATE_RE.test(String(to || ""))) {
      return res.status(400).json({ message: "from and to (YYYY-MM-DD) are required.", code: "DATE_RANGE_REQUIRED" });
    }
    const companyId = await companyOf(req);
    const scope = await BranchResolution.resolveReportBranchScope(req.user, companyId, req.query.branch);
    const unionSql = LedgerReportService.buildTransactionUnionSql("BETWEEN ? AND ?", { branchSql: BranchResolution.branchScopeSql("h", scope) });
    const [rows] = await pool.execute(
      `SELECT tx.account_code AS accountCode, MAX(tx.account_title) AS accountTitle,
              ROUND(SUM(tx.debit), 2) AS debit, ROUND(SUM(tx.credit), 2) AS credit,
              ROUND(SUM(tx.debit - tx.credit), 2) AS net
         FROM (${unionSql}) tx
        WHERE tx.account_code IS NOT NULL AND tx.account_code != ''
        GROUP BY tx.account_code
        ORDER BY tx.account_code`,
      Array(9).fill([from, to, companyId]).flat()
    );
    res.json({ companyId, scope, from, to, rows });
  } catch (err) {
    sendError(res, err, "Failed to load account totals");
  }
});

router.get("/unresolved", authenticateToken, authorizePermission("FILESETUP.BRANCHES", "EDIT"), async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const tables = await BranchOpenItems.unresolvedHistoricalRows(companyId);
    res.json({ companyId, total: tables.reduce((a, t) => a + t.unresolved, 0), tables });
  } catch (err) {
    sendError(res, err, "Failed to load unresolved branch report");
  }
});

module.exports = router;
