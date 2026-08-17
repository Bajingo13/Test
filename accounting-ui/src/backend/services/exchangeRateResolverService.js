const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { getProvider } = require("./exchangeRateProviders");

// The policy engine that decides WHICH provider/tier answers a rate
// request, per the Phase 2 priority hierarchy. BAP/BSP-specific behavior
// lives only in their provider classes (see exchangeRateProviders/) - this
// file only sequences tiers and combines results, so it works identically
// regardless of which providers are actually connected.
//
// Rate direction, unchanged from Phase 1: 1 unit of foreign currency = X
// units of the company's base currency. baseAmount = foreignAmount * rate.

const FALLBACK_MODES = ["LAST_APPROVED_RATE", "MANUAL_REQUIRED", "FIXED_RATE", "BLOCK_TRANSACTION"];
const DEFAULT_MAX_AGE_DAYS = 3;
const BUSINESS_DAY_LOOKBACK_LIMIT = 7; // don't wander arbitrarily far into the past

function nowIso() {
  return new Date().toISOString();
}

// Deliberately avoids .toISOString() for this: mysql2 returns DATE
// columns as JS Date objects at LOCAL midnight (matching the stored date
// value, e.g. for a server on Asia/Manila / UTC+8), but .toISOString()
// converts to UTC - local midnight Aug 7 becomes "...Aug 6T16:00:00Z",
// silently shifting the date backward by one. A plain "YYYY-MM-DD" string
// input is passed through untouched (never reinterpreted through a Date
// at all) and a Date object's LOCAL getters are used instead of UTC ones.
function toDateOnly(d) {
  if (typeof d === "string") return d.slice(0, 10);
  const date = d instanceof Date ? d : new Date(d);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function getCompanyPolicy(companyId) {
  const [rows] = await pool.execute("SELECT * FROM company_rate_policies WHERE company_id = ?", [companyId]);
  if (rows.length) {
    const p = rows[0];
    return {
      preferredUsdPhpProvider: p.preferred_usd_php_provider,
      preferredCrossRateProvider: p.preferred_cross_rate_provider,
      draftRateType: p.draft_rate_type,
      postingRateType: p.posting_rate_type,
      allowPreviousBusinessDay: !!p.allow_previous_business_day,
      maxRateAgeDays: p.max_rate_age_days,
      allowManualOverride: !!p.allow_manual_override,
      requireRateApproval: !!p.require_rate_approval,
      fallbackMode: p.fallback_mode,
    };
  }
  // Sensible defaults when a company hasn't configured a policy yet -
  // matches the column defaults in company_rate_policies so behavior is
  // identical whether or not a row exists.
  return {
    preferredUsdPhpProvider: "BAP",
    preferredCrossRateProvider: "BSP",
    draftRateType: "INDICATIVE",
    postingRateType: "FINAL",
    allowPreviousBusinessDay: true,
    maxRateAgeDays: DEFAULT_MAX_AGE_DAYS,
    allowManualOverride: true,
    requireRateApproval: false,
    fallbackMode: "LAST_APPROVED_RATE",
  };
}

async function upsertCompanyPolicy(companyId, updates) {
  const current = await getCompanyPolicy(companyId);
  const merged = { ...current, ...updates };
  await pool.execute(
    `INSERT INTO company_rate_policies (
      company_id, preferred_usd_php_provider, preferred_cross_rate_provider, draft_rate_type, posting_rate_type,
      allow_previous_business_day, max_rate_age_days, allow_manual_override, require_rate_approval, fallback_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      preferred_usd_php_provider = VALUES(preferred_usd_php_provider),
      preferred_cross_rate_provider = VALUES(preferred_cross_rate_provider),
      draft_rate_type = VALUES(draft_rate_type),
      posting_rate_type = VALUES(posting_rate_type),
      allow_previous_business_day = VALUES(allow_previous_business_day),
      max_rate_age_days = VALUES(max_rate_age_days),
      allow_manual_override = VALUES(allow_manual_override),
      require_rate_approval = VALUES(require_rate_approval),
      fallback_mode = VALUES(fallback_mode)`,
    [
      companyId,
      merged.preferredUsdPhpProvider,
      merged.preferredCrossRateProvider,
      merged.draftRateType,
      merged.postingRateType,
      merged.allowPreviousBusinessDay ? 1 : 0,
      merged.maxRateAgeDays,
      merged.allowManualOverride ? 1 : 0,
      merged.requireRateApproval ? 1 : 0,
      merged.fallbackMode,
    ]
  );
  return getCompanyPolicy(companyId);
}

async function getBaseCurrencyForCompany(companyId) {
  const [rows] = await pool.execute(
    "SELECT id, currency_code AS currencyCode FROM currencies WHERE company_id = ? AND is_base_currency = 1 LIMIT 1",
    [companyId]
  );
  if (!rows.length) throw new HttpError(400, "This company has no base currency configured.");
  return rows[0];
}

async function getCurrencyRow(id) {
  const [rows] = await pool.execute(
    "SELECT id, company_id AS companyId, currency_code AS currencyCode, is_base_currency AS isBaseCurrency FROM currencies WHERE id = ?",
    [id]
  );
  if (!rows.length) throw new HttpError(404, "Currency not found");
  return rows[0];
}

// Priority chain per Phase 2 section 12/13 - only reaches for BAP/BSP when
// the pair actually involves PHP (they are Philippine-specific providers,
// never baked into the universal conversion engine, per section 13).
function buildPriorityChain({ baseCurrencyCode, foreignCurrencyCode, policy }) {
  if (foreignCurrencyCode === baseCurrencyCode) return [{ tier: "BASE" }];

  const involvesPhp = baseCurrencyCode === "PHP" || foreignCurrencyCode === "PHP";
  const isUsdPhpPair = involvesPhp && (baseCurrencyCode === "USD" || foreignCurrencyCode === "USD");

  const chain = [];
  if (isUsdPhpPair) {
    chain.push({ tier: "DIRECT", provider: policy.preferredUsdPhpProvider || "BAP" });
    if (policy.preferredUsdPhpProvider !== "BSP") chain.push({ tier: "DIRECT", provider: "BSP" });
  } else if (involvesPhp) {
    chain.push({ tier: "DIRECT", provider: policy.preferredCrossRateProvider || "BSP" });
    chain.push({ tier: "DERIVED_VIA_USD" });
  }
  chain.push({ tier: "DIRECT", provider: "EXTERNAL" });
  chain.push({ tier: "LAST_APPROVED" });
  chain.push({ tier: "DIRECT", provider: "MANUAL" });
  chain.push({ tier: "DIRECT", provider: "FIXED" });
  return chain;
}

// "LAST_APPROVED" tier: the most recent stored currency_rates row on or
// before the requested date, regardless of provider - this is what
// implements LATEST_PREVIOUS_BUSINESS_DAY (section 20): if the found
// effective_date differs from the requested transactionDate, that's
// surfaced explicitly (never silently presented as same-day).
async function lookupLastApproved({ currencyId, transactionDate, allowPreviousBusinessDay, maxRateAgeDays }) {
  const earliestAllowed = new Date(transactionDate);
  earliestAllowed.setDate(earliestAllowed.getDate() - BUSINESS_DAY_LOOKBACK_LIMIT);

  const [rows] = await pool.execute(
    `SELECT new_rate AS rate, provider, rate_basis AS rateBasis, provider_rate_description AS providerRateDescription,
            effective_date AS effectiveDate, publication_timestamp AS publicationTimestamp,
            retrieval_timestamp AS retrievalTimestamp, status, source_reference AS sourceReference
     FROM currency_rates
     WHERE currency_id = ? AND effective_date <= ? AND effective_date >= ?
     ORDER BY effective_date DESC, created_at DESC
     LIMIT 1`,
    [currencyId, transactionDate, toDateOnly(earliestAllowed)]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const rateEffectiveDate = toDateOnly(row.effectiveDate);
  const requestedDate = toDateOnly(transactionDate);
  const usedPreviousBusinessDay = rateEffectiveDate !== requestedDate;

  if (usedPreviousBusinessDay && !allowPreviousBusinessDay) return null;

  const ageDays = Math.floor((new Date(requestedDate) - new Date(rateEffectiveDate)) / 86400000);
  const isStale = ageDays > (maxRateAgeDays ?? DEFAULT_MAX_AGE_DAYS);

  return {
    rate: Number(row.rate),
    provider: row.provider,
    rateBasis: row.rateBasis,
    providerRateDescription: row.providerRateDescription,
    effectiveDate: rateEffectiveDate,
    publicationTimestamp: row.publicationTimestamp,
    retrievalTimestamp: row.retrievalTimestamp,
    status: isStale ? "STALE" : row.status,
    sourceReference: row.sourceReference,
    errorMessage: null,
    usedPreviousBusinessDay,
    transactionDate: requestedDate,
  };
}

// Combines two already-resolved legs (foreign/USD and USD/base) into a
// single cross rate, per section 5. A pure function over already-fetched
// results - independently testable without any live provider call.
function deriveViaUsd({ foreignUsdLeg, usdBaseLeg }) {
  if (!foreignUsdLeg || foreignUsdLeg.rate == null || !usdBaseLeg || usdBaseLeg.rate == null) {
    return { rate: null, status: "FAILED", errorMessage: "One or both legs of the USD derivation are unavailable." };
  }
  if (foreignUsdLeg.effectiveDate !== usdBaseLeg.effectiveDate) {
    // Section 6: never silently mix rate dates.
    return {
      rate: null,
      status: "FAILED",
      errorMessage:
        `Cannot derive rate: the foreign/USD leg is dated ${foreignUsdLeg.effectiveDate} but the USD/base leg is dated ` +
        `${usdBaseLeg.effectiveDate}. Derivation across different dates requires an explicit approval policy, which is not yet configured.`,
    };
  }

  const effectiveRate = Number(foreignUsdLeg.rate) * Number(usdBaseLeg.rate);
  return {
    rate: effectiveRate,
    status: "FINAL",
    errorMessage: null,
    effectiveDate: foreignUsdLeg.effectiveDate,
    derivationMethod: "CROSS_VIA_USD",
    components: [
      { currencyPair: `${foreignUsdLeg.currencyCode}/USD`, rate: Number(foreignUsdLeg.rate), provider: foreignUsdLeg.provider, rateBasis: foreignUsdLeg.rateBasis, effectiveDate: foreignUsdLeg.effectiveDate, publicationTimestamp: foreignUsdLeg.publicationTimestamp },
      { currencyPair: `USD/${usdBaseLeg.baseCurrencyCode}`, rate: Number(usdBaseLeg.rate), provider: usdBaseLeg.provider, rateBasis: usdBaseLeg.rateBasis, effectiveDate: usdBaseLeg.effectiveDate, publicationTimestamp: usdBaseLeg.publicationTimestamp },
    ],
  };
}

async function tryDirectProvider(providerCode, { currencyId, foreignCurrencyCode, baseCurrencyCode, transactionDate }) {
  const provider = getProvider(providerCode);
  if (["MANUAL", "FIXED"].includes(providerCode)) {
    return provider.getRateForDate({ currencyId, date: transactionDate });
  }
  const result = await provider.getRateForDate({ foreignCurrencyCode, baseCurrencyCode, date: transactionDate });
  return { ...result, currencyCode: foreignCurrencyCode, baseCurrencyCode };
}

async function tryDerivedViaUsd({ foreignCurrencyCode, baseCurrencyCode, transactionDate }) {
  // Foreign leg (e.g. EUR/USD): a genuine global FX cross, only available
  // through the external provider tier - BAP/BSP publish PHP-denominated
  // rates, not foreign/USD crosses, and Manual/Fixed in this system are
  // scoped to "this company's base currency," not USD specifically.
  const externalProvider = getProvider("EXTERNAL");
  const foreignUsdLeg = await externalProvider.getRateForDate({ foreignCurrencyCode, baseCurrencyCode: "USD", date: transactionDate });

  // USD/base leg: when base is PHP, this is exactly BAP's USD/PHP slot.
  const usdLegProviderCode = baseCurrencyCode === "PHP" ? "BAP" : "EXTERNAL";
  const usdLegProvider = getProvider(usdLegProviderCode);
  const usdBaseLeg = await usdLegProvider.getRateForDate({ foreignCurrencyCode: "USD", baseCurrencyCode, date: transactionDate });

  if (foreignUsdLeg.rate == null || usdBaseLeg.rate == null) {
    return {
      rate: null,
      status: "FAILED",
      errorMessage: [foreignUsdLeg.errorMessage, usdBaseLeg.errorMessage].filter(Boolean).join(" "),
    };
  }

  const derived = deriveViaUsd({
    foreignUsdLeg: { ...foreignUsdLeg, currencyCode: foreignCurrencyCode },
    usdBaseLeg: { ...usdBaseLeg, baseCurrencyCode },
  });
  return { ...derived, provider: "DERIVED" };
}

// Section 22: applied only once every live/derived/last-approved tier has
// been exhausted - never a silent default, always an explicit, labeled
// outcome the caller/UI must surface.
async function applyFallbackMode(fallbackMode, { currencyId, transactionDate }) {
  switch (fallbackMode) {
    case "FIXED_RATE": {
      const result = await getProvider("FIXED").getRateForDate({ currencyId, date: transactionDate });
      return { ...result, fallbackApplied: "FIXED_RATE" };
    }
    case "MANUAL_REQUIRED":
      return {
        rate: null,
        provider: null,
        status: "MANUAL_REQUIRED",
        errorMessage: "No automated or approved rate is available. This company's policy requires a manual rate entry before proceeding.",
        fallbackApplied: "MANUAL_REQUIRED",
      };
    case "BLOCK_TRANSACTION":
      return {
        rate: null,
        provider: null,
        status: "BLOCKED",
        errorMessage: "No automated or approved rate is available. This company's policy blocks the transaction until a rate is approved.",
        fallbackApplied: "BLOCK_TRANSACTION",
      };
    case "LAST_APPROVED_RATE":
    default:
      return {
        rate: null,
        provider: null,
        status: "FAILED",
        errorMessage: "No rate is available from any configured source, including the last-approved-rate fallback.",
        fallbackApplied: "LAST_APPROVED_RATE",
      };
  }
}

// Main entry point. Returns the RateResult shape from baseProvider.js,
// plus `derivation` (array, only for CROSS_VIA_USD) and `usedPreviousBusinessDay`.
async function resolveRate({ companyId, foreignCurrencyId, transactionDate, requestedRateType }) {
  if (!companyId) throw new HttpError(400, "companyId is required.");
  if (!foreignCurrencyId) throw new HttpError(400, "foreignCurrencyId is required.");
  const date = transactionDate ? toDateOnly(transactionDate) : toDateOnly(new Date());

  const foreignCurrency = await getCurrencyRow(foreignCurrencyId);
  if (foreignCurrency.companyId !== Number(companyId)) {
    throw new HttpError(403, "This currency does not belong to the requested company.");
  }

  if (foreignCurrency.isBaseCurrency) {
    return {
      rate: 1,
      provider: "BASE",
      rateBasis: null,
      providerRateDescription: "Base currency",
      effectiveDate: date,
      publicationTimestamp: null,
      retrievalTimestamp: nowIso(),
      status: "FINAL",
      sourceReference: null,
      errorMessage: null,
      derivation: null,
      usedPreviousBusinessDay: false,
      requestedRateType: requestedRateType || null,
      resolvedTier: "BASE",
    };
  }

  const baseCurrency = await getBaseCurrencyForCompany(companyId);
  const policy = await getCompanyPolicy(companyId);
  const chain = buildPriorityChain({ baseCurrencyCode: baseCurrency.currencyCode, foreignCurrencyCode: foreignCurrency.currencyCode, policy });

  const attempts = [];
  for (const step of chain) {
    let result;
    if (step.tier === "LAST_APPROVED") {
      result = await lookupLastApproved({
        currencyId: foreignCurrency.id,
        transactionDate: date,
        allowPreviousBusinessDay: policy.allowPreviousBusinessDay,
        maxRateAgeDays: policy.maxRateAgeDays,
      });
    } else if (step.tier === "DERIVED_VIA_USD") {
      result = await tryDerivedViaUsd({ foreignCurrencyCode: foreignCurrency.currencyCode, baseCurrencyCode: baseCurrency.currencyCode, transactionDate: date });
    } else if (step.tier === "DIRECT") {
      result = await tryDirectProvider(step.provider, {
        currencyId: foreignCurrency.id,
        foreignCurrencyCode: foreignCurrency.currencyCode,
        baseCurrencyCode: baseCurrency.currencyCode,
        transactionDate: date,
      });
    }

    attempts.push({ tier: step.tier, provider: step.provider || result?.provider, status: result?.status, errorMessage: result?.errorMessage });

    if (result && result.rate != null && !["FAILED", "MANUAL_ONLY"].includes(result.status)) {
      return {
        rate: result.rate,
        provider: result.provider,
        rateBasis: result.rateBasis || null,
        providerRateDescription: result.providerRateDescription || null,
        effectiveDate: result.effectiveDate || date,
        publicationTimestamp: result.publicationTimestamp || null,
        retrievalTimestamp: result.retrievalTimestamp || nowIso(),
        status: result.status,
        sourceReference: result.sourceReference || null,
        errorMessage: null,
        derivationMethod: result.derivationMethod || null,
        derivation: result.components || null,
        usedPreviousBusinessDay: !!result.usedPreviousBusinessDay,
        requestedRateType: requestedRateType || null,
        // Which TIER answered, not just which provider code ended up on
        // the result - a LAST_APPROVED hit can carry provider="BAP" (that
        // was the provider on the historical row it read back), which is
        // NOT the same as a DIRECT BAP tier actually fetching new data.
        // Callers (e.g. the refresh endpoint) must key off this, not
        // provider alone, to avoid mistaking "re-read a manual BAP entry"
        // for "freshly retrieved from BAP".
        resolvedTier: step.tier,
        attempts,
      };
    }
  }

  const fallback = await applyFallbackMode(policy.fallbackMode, { currencyId: foreignCurrency.id, transactionDate: date });
  return {
    rate: fallback.rate,
    provider: fallback.provider,
    rateBasis: fallback.rateBasis || null,
    providerRateDescription: fallback.providerRateDescription || null,
    effectiveDate: fallback.effectiveDate || date,
    publicationTimestamp: null,
    retrievalTimestamp: nowIso(),
    status: fallback.status,
    sourceReference: null,
    errorMessage: fallback.errorMessage,
    derivation: null,
    usedPreviousBusinessDay: false,
    requestedRateType: requestedRateType || null,
    resolvedTier: "FALLBACK",
    fallbackApplied: fallback.fallbackApplied,
    attempts,
  };
}

// Persists the component legs of a CROSS_VIA_USD derivation against the
// currency_rates row that was just created for the combined rate - see
// currencies_migration/currency_provider_migration's currency_rate_derivations
// table. Section 5: "Store the complete derivation... Do NOT store only
// the final number."
async function saveDerivationComponents(currencyRateId, components) {
  if (!components || !components.length) return;
  let seq = 1;
  for (const c of components) {
    await pool.execute(
      `INSERT INTO currency_rate_derivations (
        currency_rate_id, sequence_order, component_currency_pair, component_rate,
        component_provider, component_rate_basis, component_effective_date, component_publication_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [currencyRateId, seq++, c.currencyPair, c.rate, c.provider, c.rateBasis || null, c.effectiveDate, c.publicationTimestamp || null]
    );
  }
}

// Section 18: distinguishes "current indicative rate" from "approved
// accounting rate" - marks a specific stored rate as APPROVED without
// touching its rate value (approval is a status change, never a silent
// recalculation).
async function approveRate(user, rateId) {
  const CurrencyService = require("./currencyService"); // required lazily to avoid a require cycle at module-load time
  const [rows] = await pool.execute(
    `SELECT cr.id, cr.company_id AS companyId, cr.status, c.currency_code AS currencyCode
     FROM currency_rates cr JOIN currencies c ON c.id = cr.currency_id
     WHERE cr.id = ?`,
    [rateId]
  );
  if (!rows.length) throw new HttpError(404, "Rate record not found");
  await CurrencyService.assertCompanyAccess(user, rows[0].companyId);

  await pool.execute("UPDATE currency_rates SET status = 'APPROVED' WHERE id = ?", [rateId]);
  return { id: Number(rateId), currencyCode: rows[0].currencyCode, status: "APPROVED" };
}

async function getDerivationComponents(currencyRateId) {
  const [rows] = await pool.execute(
    `SELECT id, sequence_order AS sequenceOrder, component_currency_pair AS currencyPair, component_rate AS rate,
            component_provider AS provider, component_rate_basis AS rateBasis,
            component_effective_date AS effectiveDate, component_publication_timestamp AS publicationTimestamp
     FROM currency_rate_derivations WHERE currency_rate_id = ? ORDER BY sequence_order ASC`,
    [currencyRateId]
  );
  return rows.map((r) => ({ ...r, rate: Number(r.rate) }));
}

module.exports = {
  FALLBACK_MODES,
  buildPriorityChain,
  deriveViaUsd,
  lookupLastApproved,
  saveDerivationComponents,
  getDerivationComponents,
  approveRate,
  getCompanyPolicy,
  upsertCompanyPolicy,
  getBaseCurrencyForCompany,
  resolveRate,
};
