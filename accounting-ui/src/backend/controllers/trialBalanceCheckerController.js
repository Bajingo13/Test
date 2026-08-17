const TrialBalanceDifferenceService = require("../services/trialBalanceDifferenceService");
const ValidationService = require("../services/trialBalanceValidationService");
const CheckerService = require("../services/trialBalanceCheckerService");
const CurrencyService = require("../services/currencyService");

// Cheap balanced/unbalanced/difference check - backs the persistent badge
// on the Trial Balance report page. Does not run the full investigation or
// persist anything; that's POST /check.
exports.getStatus = async (req, res) => {
  try {
    const { from, to } = req.query;
    const tolerance = req.query.tolerance ?? "0";
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const totals = await TrialBalanceDifferenceService.getTrialBalanceTotals({ from, to, companyId });
    const balance = ValidationService.evaluateBalance({ difference: totals.difference, tolerance });

    res.json({
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      difference: balance.differenceFormatted,
      tolerance,
      status: balance.status,
    });
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER STATUS ERROR:", err.message);
    res.status(500).json({ message: "Failed to compute trial balance status", error: err.message });
  }
};

exports.runCheck = async (req, res) => {
  try {
    const { from, to, tolerance } = req.body;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await CheckerService.runCheck({ from, to, tolerance, user: req.user, companyId });
    res.json(result);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER RUN ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to run the checker" });
  }
};

exports.getRun = async (req, res) => {
  try {
    const result = await CheckerService.getRun(req.params.runId);
    res.json(result);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER GET RUN ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load checker run" });
  }
};

exports.recheck = async (req, res) => {
  try {
    const prior = await CheckerService.getRun(req.params.runId);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const result = await CheckerService.runCheck({
      from: prior.summary.fromDate,
      to: prior.summary.toDate,
      tolerance: prior.summary.tolerance,
      user: req.user,
      companyId,
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
    const run = await CheckerService.getRun(req.params.runId);
    const csv = CheckerService.findingsToCsv(run.findings);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="Trial_Balance_Checker_Run_${req.params.runId}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("TRIAL BALANCE CHECKER EXPORT ERROR:", err.message);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to export findings" });
  }
};
