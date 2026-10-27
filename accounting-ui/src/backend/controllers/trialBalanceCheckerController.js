const TrialBalanceDifferenceService = require("../services/trialBalanceDifferenceService");
const ValidationService = require("../services/trialBalanceValidationService");
const CheckerService = require("../services/trialBalanceCheckerService");

// Cheap balanced/unbalanced/difference check - backs the persistent badge
// on the Trial Balance report page. Does not run the full investigation or
// persist anything; that's POST /check. Same company resolution as the
// report and the checker run (explicit, validated, no lowest-company
// default), and the resolved company is echoed back so the page can match
// a response to the company it asked about.
exports.getStatus = async (req, res) => {
  try {
    const { from, to } = req.query;
    const tolerance = req.query.tolerance ?? "0";
    const companyId = await CheckerService.resolveSelectedCompany(req.user, req.query.companyId);

    const totals = await TrialBalanceDifferenceService.getTrialBalanceTotals({ from, to, companyId });
    const balance = ValidationService.evaluateBalance({ difference: totals.difference, tolerance });

    res.json({
      companyId,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      difference: balance.differenceFormatted,
      tolerance,
      status: balance.status,
    });
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER STATUS ERROR:", err.message);
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    res.status(500).json({ message: "Failed to compute trial balance status", error: err.message });
  }
};

exports.runCheck = async (req, res) => {
  try {
    const { from, to, tolerance } = req.body;
    // Explicit, validated company - no lowest-company default.
    const companyId = await CheckerService.resolveSelectedCompany(req.user, req.body.companyId);
    const result = await CheckerService.runCheck({ from, to, tolerance, user: req.user, companyId });
    res.json(result);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER RUN ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to run the checker" });
  }
};

exports.getRun = async (req, res) => {
  try {
    const result = await CheckerService.getRun(req.params.runId, req.user);
    res.json(result);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER GET RUN ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load checker run" });
  }
};

exports.recheck = async (req, res) => {
  try {
    // A recheck stays in the prior run's own company (access-checked by
    // getRun); a company in the request body is ignored.
    const prior = await CheckerService.getRun(req.params.runId, req.user);
    if (!prior.companyId) {
      return res.status(409).json({
        message: "This checker run has no company assigned, so it cannot be re-run. Run a new check for the company instead.",
      });
    }
    const result = await CheckerService.runCheck({
      from: prior.summary.fromDate,
      to: prior.summary.toDate,
      tolerance: prior.summary.tolerance,
      user: req.user,
      companyId: prior.companyId,
    });
    res.json(result);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER RECHECK ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to re-run the checker" });
  }
};

exports.markInvestigated = async (req, res) => {
  try {
    const { note } = req.body;
    const finding = await CheckerService.markInvestigated(req.params.findingId, { note, user: req.user });
    res.json({ success: true, finding });
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER MARK INVESTIGATED ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to mark as investigated" });
  }
};

exports.createAdjustmentDraft = async (req, res) => {
  try {
    const { debitAccountCode, creditAccountCode, amount, explanation } = req.body;
    const result = await CheckerService.createAdjustmentDraft(req.params.findingId, {
      debitAccountCode,
      creditAccountCode,
      amount,
      explanation,
      user: req.user,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER ADJUSTMENT DRAFT ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create adjustment draft" });
  }
};

exports.exportRun = async (req, res) => {
  try {
    const run = await CheckerService.getRun(req.params.runId, req.user);
    const csv = CheckerService.findingsToCsv(run.findings);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="Trial_Balance_Checker_Run_${req.params.runId}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER EXPORT ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to export findings" });
  }
};
