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
    // totalBranches (additive): lets the Active Branch selector say "All
    // Branches" (the user covers every branch of the company) or "All
    // Assigned Branches" (a subset) - display only, never a permission.
    const [[total]] = await pool.execute("SELECT COUNT(*) AS n FROM branches WHERE company_id = ?", [companyId]);
    res.json({ companyId, branches, canConsolidate: await BranchResolution.canConsolidate(req.user), totalBranches: Number(total.n) });
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

// ===================== Phase B: transaction-entry preparation =====================
// Read-only endpoints the (collaborator-owned) entry screens will call. Each
// validates the branch server-side; none writes anything.
const TransactionBranchService = require("../services/transactionBranchService");
const FinancialStatementService = require("../services/financialStatementService");
const PermissionService = require("../services/permissionService");

async function requireCan(user, moduleKey, action) {
  if (user.roleCode === "SUPER_ADMIN") return;
  if (!(await PermissionService.can(user.id, moduleKey, action))) {
    const { HttpError } = require("../lib/httpError");
    throw new HttpError(403, "You do not have permission to perform this action.", "ACCESS_DENIED");
  }
}

// Account picker for one branch: shared accounts + that branch's own.
router.get("/accounts", authenticateToken, authorizePermission("FILESETUP.COA", "VIEW"), async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const branchId = await BranchResolution.resolveBranch(req.user, companyId, req.query.branchId);
    const [rows] = await pool.execute(
      `SELECT id, code, title, account_class AS accountClass, branch_id AS branchId
         FROM chart_of_accounts c
        WHERE ${BranchResolution.setupVisibilitySql("c", [branchId])}
        ORDER BY code, id`
    );
    res.json({ companyId, branchId, accounts: rows });
  } catch (err) {
    sendError(res, err, "Failed to load accounts");
  }
});

// Party picker for one branch: the company's shared parties + that branch's own.
router.get("/parties", authenticateToken, authorizePermission("FILESETUP.GENLIB", "VIEW"), async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const branchId = await BranchResolution.resolveBranch(req.user, companyId, req.query.branchId);
    const type = String(req.query.type || "").trim().toUpperCase();
    const [rows] = await pool.execute(
      `SELECT id, code, name, party_type AS type, status, branch_id AS branchId
         FROM general_libraries g
        WHERE g.company_id = ? AND ${BranchResolution.setupVisibilitySql("g", [branchId])}
          ${type ? "AND UPPER(g.party_type) = ?" : ""}
        ORDER BY name, id`,
      type ? [companyId, type] : [companyId]
    );
    res.json({ companyId, branchId, parties: rows });
  } catch (err) {
    sendError(res, err, "Failed to load parties");
  }
});

// Pre-save check of a transaction's branch, party and accounts.
router.post("/validate-transaction", authenticateToken, authorizePermission("FILESETUP.COA", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const branchId = await TransactionBranchService.resolveTransactionBranch(req.user, companyId, req.body?.branchId);
    await TransactionBranchService.assertPartyUsableInBranch({ companyId, partyId: req.body?.partyId, branchId });
    await TransactionBranchService.assertAccountsUsableInBranch(req.body?.accountIds, branchId);
    res.json({ valid: true, companyId, branchId });
  } catch (err) {
    sendError(res, err, "Failed to validate transaction");
  }
});

// CV -> APV / OR -> Invoice application pre-check (read-only).
router.post("/applications/validate", authenticateToken, async (req, res) => {
  try {
    const paymentType = String(req.body?.paymentType || "").toUpperCase();
    await requireCan(req.user, paymentType === "OR" ? "TRANSACTIONS.INVOICE" : "TRANSACTIONS.APV", "VIEW");
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const result = await TransactionBranchService.validateApplications(req.user, {
      companyId, branchId: req.body?.branchId, paymentType, partyId: req.body?.partyId, applications: req.body?.applications,
    });
    res.status(result.valid ? 200 : 422).json(result);
  } catch (err) {
    sendError(res, err, "Failed to validate payment application");
  }
});

// APV / CV reversal pre-check (read-only; the reverse routes enforce the same rules).
router.post("/reversals/check", authenticateToken, async (req, res) => {
  try {
    const module = String(req.body?.module || "").toUpperCase();
    await requireCan(req.user, module === "CV" ? "TRANSACTIONS.CV" : "TRANSACTIONS.APV", "VOID");
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    res.json(await TransactionBranchService.checkReversal(req.user, { companyId, module, originalId: req.body?.id }));
  } catch (err) {
    sendError(res, err, "Failed to check reversal");
  }
});

// Income Statement / Balance Sheet rows for one branch or ALL authorized
// branches - always one combined report.
router.get("/reports/income-statement", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(String(from || "")) || !DATE_RE.test(String(to || ""))) {
      return res.status(400).json({ message: "from and to (YYYY-MM-DD) are required.", code: "DATE_RANGE_REQUIRED" });
    }
    const companyId = await companyOf(req);
    const scope = await BranchResolution.resolveReportBranchScope(req.user, companyId, req.query.branch);
    const rows = await FinancialStatementService.getIncomeStatementRows({ companyId, from, to, branchSql: BranchResolution.branchScopeSql("h", scope) });
    res.json({ companyId, scope, from, to, rows });
  } catch (err) {
    sendError(res, err, "Failed to load income statement");
  }
});

router.get("/reports/balance-sheet", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { to } = req.query;
    if (!DATE_RE.test(String(to || ""))) return res.status(400).json({ message: "to (YYYY-MM-DD) is required.", code: "DATE_REQUIRED" });
    const companyId = await companyOf(req);
    const scope = await BranchResolution.resolveReportBranchScope(req.user, companyId, req.query.branch);
    const rows = await FinancialStatementService.getBalanceSheetRows({ companyId, to, branchSql: BranchResolution.branchScopeSql("h", scope) });
    res.json({ companyId, scope, to, rows });
  } catch (err) {
    sendError(res, err, "Failed to load balance sheet");
  }
});

module.exports = router;
