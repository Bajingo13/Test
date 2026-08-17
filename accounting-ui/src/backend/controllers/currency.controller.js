const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const CurrencyService = require("../services/currencyService");
const PermissionService = require("../services/permissionService");
const FxAccountService = require("../services/fxAccountService");

const MODULE_KEY = "FILESETUP.CURRENCY_SETUP";

// Used by handlers whose required permission depends on the request body
// (ACTIVATE vs DEACTIVATE, MANUAL_RATE vs FIXED_RATE) - the static
// route-level authorizePermission middleware can only bind one action per
// route, so these two branch on an already-resolved action string.
async function requirePermission(req, res, action) {
  const allowed = await PermissionService.can(req.user.id, MODULE_KEY, action);
  if (!allowed) {
    await logAudit(pool, {
      module: "ACCESS_CONTROL",
      entityType: "PERMISSION",
      entityId: null,
      action: "ACCESS_DENIED",
      description: `User ${req.user.username} was denied ${action} on ${MODULE_KEY}`,
      afterData: { moduleKey: MODULE_KEY, action, path: req.originalUrl, method: req.method },
      user: req.user,
    });
    res.status(403).json({ message: "You do not have permission to perform this action" });
    return false;
  }
  return true;
}

function handleError(res, err, fallbackMessage) {
  console.error(fallbackMessage, err);
  res.status(err.statusCode || 500).json({ message: err.message || fallbackMessage });
}

exports.list = async (req, res) => {
  try {
    const currencies = await CurrencyService.listCurrencies(req.user, { companyId: req.query.companyId });
    res.json(currencies);
  } catch (err) {
    handleError(res, err, "Failed to load currencies");
  }
};

exports.getOne = async (req, res) => {
  try {
    const currency = await CurrencyService.getCurrencyById(req.user, req.params.id);
    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to load currency");
  }
};

exports.create = async (req, res) => {
  try {
    const currency = await CurrencyService.createCurrency(req.user, req.body);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: "CURRENCY_CREATED",
      description: `Currency ${currency.currencyCode} (${currency.currencyName}) created`,
      afterData: currency,
      user: req.user,
      ...requestMeta(req),
    });

    res.status(201).json(currency);
  } catch (err) {
    handleError(res, err, "Failed to create currency");
  }
};

exports.update = async (req, res) => {
  try {
    const before = await CurrencyService.getCurrencyById(req.user, req.params.id);
    const currency = await CurrencyService.updateCurrency(req.user, req.params.id, req.body);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: "CURRENCY_UPDATED",
      description: `Currency ${currency.currencyCode} updated`,
      beforeData: before,
      afterData: currency,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to update currency");
  }
};

exports.setStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive (boolean) is required." });
    }
    if (!(await requirePermission(req, res, isActive ? "ACTIVATE" : "DEACTIVATE"))) return;

    const before = await CurrencyService.getCurrencyById(req.user, req.params.id);
    const currency = await CurrencyService.setStatus(req.user, req.params.id, isActive);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: isActive ? "CURRENCY_ACTIVATED" : "CURRENCY_DEACTIVATED",
      description: `Currency ${currency.currencyCode} ${isActive ? "activated" : "deactivated"}`,
      beforeData: { isActive: before.isActive },
      afterData: { isActive: currency.isActive },
      user: req.user,
      ...requestMeta(req),
    });

    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to update currency status");
  }
};

exports.setBase = async (req, res) => {
  try {
    const before = await CurrencyService.getCurrencyById(req.user, req.params.id);
    const currency = await CurrencyService.setBaseCurrency(req.user, req.params.id);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: "BASE_CURRENCY_CHANGED",
      description: `${currency.currencyCode} set as base currency`,
      beforeData: { wasBase: before.isBaseCurrency },
      afterData: { currencyCode: currency.currencyCode, isBaseCurrency: currency.isBaseCurrency },
      user: req.user,
      ...requestMeta(req),
    });

    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to set base currency");
  }
};

exports.recordRate = async (req, res) => {
  try {
    const { rateMode, rate, effectiveDate, reason } = req.body;
    if (!["MANUAL", "FIXED"].includes(rateMode)) {
      return res.status(400).json({ message: "rateMode must be MANUAL or FIXED." });
    }
    if (!(await requirePermission(req, res, rateMode === "FIXED" ? "FIXED_RATE" : "MANUAL_RATE"))) return;

    const currency = await CurrencyService.recordRate(req.user, req.params.id, { rateMode, rate, effectiveDate, reason });

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: rateMode === "FIXED" ? "FIXED_RATE_CHANGED" : "MANUAL_RATE_CREATED",
      description: `${currency.currencyCode} ${rateMode.toLowerCase()} rate set to ${rate}`,
      afterData: { rateMode, rate, effectiveDate, reason: reason || null },
      user: req.user,
      ...requestMeta(req),
    });

    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to record exchange rate");
  }
};

exports.rateHistory = async (req, res) => {
  try {
    const history = await CurrencyService.getRateHistory(req.user, req.params.id);
    res.json(history);
  } catch (err) {
    handleError(res, err, "Failed to load rate history");
  }
};

// Checkpoint 3FX: company-level Realized FX Gain/Loss account
// configuration. Read is gated on VIEW (same as the rest of Currency
// Setup) since any user posting a foreign settlement benefits from seeing
// which account it will hit; only the write is gated on the dedicated
// CONFIGURE_FX_ACCOUNTS permission.
exports.getFxAccounts = async (req, res) => {
  try {
    const config = await FxAccountService.getFxAccounts(req.user, req.query.companyId);
    res.json(config);
  } catch (err) {
    handleError(res, err, "Failed to load FX account configuration");
  }
};

exports.updateFxAccounts = async (req, res) => {
  try {
    const { companyId, gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId } = req.body;
    const before = await FxAccountService.getFxAccounts(req.user, companyId);
    const config = await FxAccountService.upsertFxAccounts(req.user, companyId, { gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId });

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "COMPANY_FX_ACCOUNTS",
      entityId: config.companyId,
      action: "FX_ACCOUNT_CONFIGURATION_CHANGED",
      description: `FX accounts for company ${config.companyId} set to Gain=${config.gainAccount?.code || "none"}, Loss=${config.lossAccount?.code || "none"}, UnrealizedGain=${config.unrealizedGainAccount?.code || "none"}, UnrealizedLoss=${config.unrealizedLossAccount?.code || "none"}`,
      beforeData: { gainAccountId: before.gainAccountId, lossAccountId: before.lossAccountId, unrealizedGainAccountId: before.unrealizedGainAccountId, unrealizedLossAccountId: before.unrealizedLossAccountId },
      afterData: { gainAccountId: config.gainAccountId, lossAccountId: config.lossAccountId, unrealizedGainAccountId: config.unrealizedGainAccountId, unrealizedLossAccountId: config.unrealizedLossAccountId },
      user: req.user,
      ...requestMeta(req),
    });

    res.json(config);
  } catch (err) {
    handleError(res, err, "Failed to update FX account configuration");
  }
};
