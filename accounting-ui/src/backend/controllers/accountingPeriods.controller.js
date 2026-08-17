const { requestMeta } = require("../lib/audit");
const CurrencyService = require("../services/currencyService");
const PeriodService = require("../services/accountingPeriodService");

function sendError(res, err, fallback) {
  const body = { message: err.message || fallback };
  if (err.code) body.code = err.code;
  res.status(err.statusCode || 500).json(body);
}

exports.list = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const year = req.query.year ? Number(req.query.year) : undefined;
    const periods = await PeriodService.listPeriods({ companyId, year });
    res.json(periods);
  } catch (err) {
    console.error("LIST ACCOUNTING PERIODS ERROR:", err);
    sendError(res, err, "Failed to load accounting periods.");
  }
};

exports.getOne = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const period = await PeriodService.getPeriod(req.params.id, companyId);
    res.json(period);
  } catch (err) {
    console.error("GET ACCOUNTING PERIOD ERROR:", err);
    sendError(res, err, "Failed to load accounting period.");
  }
};

exports.generateYear = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await PeriodService.generateYearPeriods({ companyId, year: Number(req.body.year), user: { ...req.user, ...requestMeta(req) } });
    res.json(result);
  } catch (err) {
    console.error("GENERATE ACCOUNTING PERIODS ERROR:", err);
    sendError(res, err, "Failed to generate accounting periods.");
  }
};

exports.checklist = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const checklist = await PeriodService.getCloseChecklist({ companyId, periodId: req.params.id });
    res.json(checklist);
  } catch (err) {
    console.error("PERIOD CHECKLIST ERROR:", err);
    sendError(res, err, "Failed to load close checklist.");
  }
};

exports.softClose = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const period = await PeriodService.softClosePeriod({
      periodId: req.params.id, companyId, notes: req.body.notes,
      user: { ...req.user, ...requestMeta(req) },
    });
    res.json(period);
  } catch (err) {
    console.error("SOFT CLOSE PERIOD ERROR:", err);
    sendError(res, err, "Failed to soft-close accounting period.");
  }
};

exports.close = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const period = await PeriodService.closePeriod({
      periodId: req.params.id, companyId, notes: req.body.notes,
      user: { ...req.user, ...requestMeta(req) },
    });
    res.json(period);
  } catch (err) {
    console.error("CLOSE PERIOD ERROR:", err);
    sendError(res, err, "Failed to close accounting period.");
  }
};

exports.reopen = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const period = await PeriodService.reopenPeriod({
      periodId: req.params.id, companyId, reason: req.body.reason,
      user: { ...req.user, ...requestMeta(req) },
    });
    res.json(period);
  } catch (err) {
    console.error("REOPEN PERIOD ERROR:", err);
    sendError(res, err, "Failed to reopen accounting period.");
  }
};

exports.history = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const history = await PeriodService.getHistory({ companyId, periodId: req.query.periodId });
    res.json(history);
  } catch (err) {
    console.error("PERIOD HISTORY ERROR:", err);
    sendError(res, err, "Failed to load period lock history.");
  }
};