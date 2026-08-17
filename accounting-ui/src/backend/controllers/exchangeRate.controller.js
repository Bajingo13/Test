const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const CurrencyService = require("../services/currencyService");
const Resolver = require("../services/exchangeRateResolverService");
const ImportService = require("../services/exchangeRateImportService");
const { PROVIDERS } = require("../services/exchangeRateProviders");

function handleError(res, err, fallbackMessage) {
  console.error(fallbackMessage, err);
  res.status(err.statusCode || 500).json({ message: err.message || fallbackMessage });
}

// Read-only lookup for transaction forms (Phase 3's "when a foreign
// currency is selected, show a rate card") - calls the exact same
// resolveRate() Phase 2 already built, but never persists anything. A
// transaction currency selection is not a company-wide "refresh" of that
// currency's stored rate (see exports.refresh above), so this must not
// write to currency_rates or currencies.current_rate.
exports.resolve = async (req, res) => {
  try {
    const { currencyId, transactionDate, requestedRateType } = req.body;
    if (!currencyId) return res.status(400).json({ message: "currencyId is required." });

    const currency = await CurrencyService.getCurrencyById(req.user, currencyId);
    const result = await Resolver.resolveRate({
      companyId: currency.companyId,
      foreignCurrencyId: currencyId,
      transactionDate,
      requestedRateType,
    });

    res.json({ currencyCode: currency.currencyCode, ...result });
  } catch (err) {
    handleError(res, err, "Failed to resolve exchange rate");
  }
};

// A refresh only WRITES a new currency_rates row when the resolver
// actually found new data from a live DIRECT provider call or a fresh
// derivation - reading back an existing MANUAL/FIXED/LAST_APPROVED rate
// isn't a "refresh", it's just re-reporting what's already stored, so
// nothing new is written in that case (honest per section 27 - "store"
// only happens when there is something new to store).
//
// Keyed off resolvedTier + provider together, NOT provider alone: a
// LAST_APPROVED hit can carry provider="BAP" (that was simply the
// provider recorded on the historical row it read back, e.g. a manually
// entered official rate) - checking provider alone would wrongly treat
// "re-read a manual BAP entry" as "freshly retrieved from BAP".
const LIVE_DIRECT_PROVIDERS = ["BAP", "BSP", "EXTERNAL"];

function isGenuineLiveResult(result) {
  if (["FAILED", "MANUAL_ONLY"].includes(result.status) || result.rate == null) return false;
  if (result.resolvedTier === "DERIVED_VIA_USD") return true;
  return result.resolvedTier === "DIRECT" && LIVE_DIRECT_PROVIDERS.includes(result.provider);
}

async function refreshOne(user, currencyId, { transactionDate, requestedRateType } = {}) {
  const currency = await CurrencyService.getCurrencyById(user, currencyId);
  const result = await Resolver.resolveRate({
    companyId: currency.companyId,
    foreignCurrencyId: currencyId,
    transactionDate,
    requestedRateType,
  });

  if (isGenuineLiveResult(result)) {
    const updated = await CurrencyService.recordRate(user, currencyId, {
      rateMode: "MANUAL",
      rate: result.rate,
      effectiveDate: result.effectiveDate,
      reason: `Refreshed from ${result.provider}`,
      provider: result.provider,
      rateBasis: result.rateBasis,
      providerRateDescription: result.providerRateDescription,
      ingestionMethod: result.derivationMethod ? "DERIVED" : "API",
      status: result.status,
      publicationTimestamp: result.publicationTimestamp,
      retrievalTimestamp: result.retrievalTimestamp,
      sourceReference: result.sourceReference,
      derivationMethod: result.derivationMethod,
    });
    if (result.derivation && updated.rateId) {
      await Resolver.saveDerivationComponents(updated.rateId, result.derivation);
    }
    return { currencyCode: currency.currencyCode, ...result, stored: true, currentRate: updated.currentRate };
  }

  return { currencyCode: currency.currencyCode, ...result, stored: false };
}

// Exported so jobs/exchangeRateRefreshJob.js (dormant infrastructure, not
// started - see that file) can call the exact same refresh logic the
// HTTP endpoint uses, rather than a second copy of it.
exports.refreshOneForJob = refreshOne;

exports.refresh = async (req, res) => {
  try {
    const { currencyId, transactionDate, requestedRateType } = req.body;
    if (!currencyId) return res.status(400).json({ message: "currencyId is required." });

    const result = await refreshOne(req.user, currencyId, { transactionDate, requestedRateType });

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: Number(currencyId),
      action: result.stored ? "RATE_REFRESHED" : "RATE_RETRIEVAL_FAILED",
      description: `${result.currencyCode} refresh: provider=${result.provider || "none"}, status=${result.status}${result.stored ? `, rate=${result.rate}` : ""}`,
      afterData: result,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    handleError(res, err, "Failed to refresh exchange rate");
  }
};

exports.refreshAll = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const [currencies] = await pool.execute(
      "SELECT id, currency_code AS currencyCode FROM currencies WHERE company_id = ? AND is_base_currency = 0 AND is_active = 1",
      [companyId]
    );

    // Controlled, sequential batching - not hundreds of simultaneous
    // requests, and ready to respect a real provider's rate limit once one
    // is connected (per section 28).
    const results = [];
    for (const c of currencies) {
      try {
        const result = await refreshOne(req.user, c.id, {});
        results.push(result);
      } catch (err) {
        results.push({ currencyCode: c.currencyCode, status: "FAILED", errorMessage: err.message, stored: false });
      }
    }

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: null,
      action: "RATE_REFRESHED",
      description: `Refresh all: ${results.filter((r) => r.stored).length}/${results.length} currencies updated`,
      afterData: { companyId, results },
      user: req.user,
      ...requestMeta(req),
    });

    res.json({ companyId, results });
  } catch (err) {
    handleError(res, err, "Failed to refresh exchange rates");
  }
};

exports.officialRateEntry = async (req, res) => {
  try {
    const { currencyId, provider, rateBasis, rate, effectiveDate, sourceReference } = req.body;
    if (!currencyId) return res.status(400).json({ message: "currencyId is required." });
    if (!["BAP", "BSP"].includes(provider)) return res.status(400).json({ message: "provider must be BAP or BSP." });

    // The distinction the spec requires: source is BAP/BSP, but the entry
    // method is manual - never indistinguishable from an automated fetch.
    const currency = await CurrencyService.recordRate(req.user, currencyId, {
      rateMode: "MANUAL",
      rate,
      effectiveDate,
      reason: `Official ${provider} rate entered manually`,
      provider,
      rateBasis: rateBasis || null,
      providerRateDescription: rateBasis || null,
      ingestionMethod: "MANUAL_ENTRY",
      status: "FINAL",
      retrievalTimestamp: new Date().toISOString(),
      sourceReference: sourceReference || null,
    });

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: currency.id,
      action: "OFFICIAL_RATE_ENTERED_MANUALLY",
      description: `${currency.currencyCode} official ${provider} rate ${rate} entered manually (effective ${effectiveDate})`,
      afterData: { provider, rateBasis, rate, effectiveDate, sourceReference: sourceReference || null, ingestionMethod: "MANUAL_ENTRY" },
      user: req.user,
      ...requestMeta(req),
    });

    res.json(currency);
  } catch (err) {
    handleError(res, err, "Failed to record official rate");
  }
};

exports.importPreview = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    const currency = req.body.currencyId ? await CurrencyService.getCurrencyById(req.user, req.body.currencyId) : null;
    const companyId = currency ? currency.companyId : await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);

    const preview = await ImportService.parsePreview({ buffer: req.file.buffer, filename: req.file.originalname, companyId });
    res.json({ companyId, ...preview });
  } catch (err) {
    handleError(res, err, "Failed to parse rate import file");
  }
};

exports.importConfirm = async (req, res) => {
  try {
    const { companyId, rows } = req.body;
    if (!companyId) return res.status(400).json({ message: "companyId is required." });
    await CurrencyService.assertCompanyAccess(req.user, companyId);

    const result = await ImportService.confirmImport({ user: req.user, companyId, rows });

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY",
      entityId: null,
      action: "RATE_IMPORTED",
      description: `Official rate import: ${result.imported} imported, ${result.failed} failed`,
      afterData: result,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    handleError(res, err, "Failed to import rates");
  }
};

exports.getPolicy = async (req, res) => {
  try {
    const companyId = req.params.companyId;
    if (!companyId) return res.status(400).json({ message: "companyId is required." });
    await CurrencyService.assertCompanyAccess(req.user, companyId);
    const policy = await Resolver.getCompanyPolicy(companyId);
    res.json(policy);
  } catch (err) {
    handleError(res, err, "Failed to load rate policy");
  }
};

exports.updatePolicy = async (req, res) => {
  try {
    const companyId = req.params.companyId;
    await CurrencyService.assertCompanyAccess(req.user, companyId);
    const before = await Resolver.getCompanyPolicy(companyId);
    const policy = await Resolver.upsertCompanyPolicy(companyId, req.body);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "COMPANY_RATE_POLICY",
      entityId: Number(companyId),
      action: "PROVIDER_CHANGED",
      description: `Rate policy updated for company ${companyId}`,
      beforeData: before,
      afterData: policy,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(policy);
  } catch (err) {
    handleError(res, err, "Failed to update rate policy");
  }
};

exports.providerStatus = async (req, res) => {
  try {
    const statuses = {};
    for (const [code, provider] of Object.entries(PROVIDERS)) {
      statuses[code] = { label: provider.label, ...(await provider.healthCheck()) };
    }
    res.json(statuses);
  } catch (err) {
    handleError(res, err, "Failed to load provider status");
  }
};

exports.approveRate = async (req, res) => {
  try {
    const result = await Resolver.approveRate(req.user, req.params.rateId);

    await logAudit(pool, {
      module: "FILESETUP.CURRENCY_SETUP",
      entityType: "CURRENCY_RATE",
      entityId: Number(req.params.rateId),
      action: "RATE_APPROVED",
      description: `${result.currencyCode} rate #${result.id} approved`,
      afterData: result,
      user: req.user,
      ...requestMeta(req),
    });

    res.json(result);
  } catch (err) {
    handleError(res, err, "Failed to approve rate");
  }
};

exports.getDerivation = async (req, res) => {
  try {
    const components = await Resolver.getDerivationComponents(req.params.rateId);
    res.json(components);
  } catch (err) {
    handleError(res, err, "Failed to load rate derivation");
  }
};
