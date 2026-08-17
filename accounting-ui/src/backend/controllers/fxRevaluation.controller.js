const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const FxRevaluationService = require("../services/fxRevaluationService");
const CurrencyService = require("../services/currencyService");

exports.calculate = async (req, res) => {
  try {
    const { revaluationDate } = req.body || {};
    if (!revaluationDate) return res.status(400).json({ message: "revaluationDate is required." });
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await FxRevaluationService.calculate({ companyId, revaluationDate, userId: req.user.id });
    res.json(result);
  } catch (err) {
    console.error("CALCULATE FX REVALUATION ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to calculate FX revaluation." });
  }
};

exports.post = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await FxRevaluationService.post({ sessionId: req.params.id, userId: req.user.id, companyId });
    res.json(result);
  } catch (err) {
    console.error("POST FX REVALUATION ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to post FX revaluation.", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  }
};

exports.reverse = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await FxRevaluationService.reverse({ sessionId: req.params.id, userId: req.user.id, companyId });
    res.json(result);
  } catch (err) {
    console.error("REVERSE FX REVALUATION ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to reverse FX revaluation.", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  }
};

exports.getOne = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const result = await FxRevaluationService.getSessionDetail(req.params.id, companyId);
    res.json(result);
  } catch (err) {
    console.error("GET FX REVALUATION ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load FX revaluation." });
  }
};

exports.list = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const rows = await FxRevaluationService.listSessions({ companyId });
    res.json(rows);
  } catch (err) {
    console.error("LIST FX REVALUATION ERROR:", err);
    res.status(500).json({ message: "Failed to load FX revaluation history." });
  }
};