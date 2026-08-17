// Shared contract every exchange-rate provider implements. This is the
// only file that documents the shape - BAP/BSP-specific logic never leaks
// into React components, transaction forms, server.js, or the currency
// formatting utilities (per Phase 2 scope: "Do NOT put BAP/BSP-specific
// code" anywhere but here and the resolver).
//
// A RateResult is ALWAYS returned, even on failure - callers (the
// resolver) branch on `status`/`rate` rather than catching exceptions for
// the "no data available" case, since "no automated source" is an
// expected, routine outcome for BAP/BSP today, not an exceptional one.
//
// @typedef {Object} RateResult
// @property {number|null} rate - null when unavailable
// @property {string} provider - BAP | BSP | EXTERNAL | MANUAL | FIXED
// @property {string|null} rateBasis - normalized enum, e.g. DAILY_WEIGHTED_AVERAGE
// @property {string|null} providerRateDescription - the source's own label, preserved verbatim
// @property {string|null} effectiveDate - YYYY-MM-DD, null if unavailable
// @property {string|null} publicationTimestamp - ISO datetime, when the source published it (if known)
// @property {string} retrievalTimestamp - ISO datetime, when THIS call ran
// @property {string} status - INDICATIVE | PROVISIONAL | FINAL | FAILED | MANUAL_ONLY
// @property {string|null} sourceReference
// @property {string|null} errorMessage - populated only when status is FAILED/MANUAL_ONLY

class ExchangeRateProvider {
  /** Short stable code stored in currency_rates.provider (BAP, BSP, ...). */
  get code() {
    throw new Error("ExchangeRateProvider.code must be implemented by subclass");
  }

  /** Human label for UI ("Bankers Association of the Philippines"). */
  get label() {
    throw new Error("ExchangeRateProvider.label must be implemented by subclass");
  }

  // eslint-disable-next-line no-unused-vars
  async getLatestRate({ foreignCurrencyCode, baseCurrencyCode }) {
    throw new Error("getLatestRate must be implemented by subclass");
  }

  // eslint-disable-next-line no-unused-vars
  async getRateForDate({ foreignCurrencyCode, baseCurrencyCode, date }) {
    throw new Error("getRateForDate must be implemented by subclass");
  }

  // Historical lookups reuse the by-date path - there is no separate
  // "historical" mechanism to fake for providers that don't have one.
  async getHistoricalRate({ foreignCurrencyCode, baseCurrencyCode, date }) {
    return this.getRateForDate({ foreignCurrencyCode, baseCurrencyCode, date });
  }

  async getSupportedCurrencies() {
    return [];
  }

  async getSupportedRateTypes() {
    return [];
  }

  // { status: "AVAILABLE" | "MANUAL_ONLY" | "UNAVAILABLE", message }
  // Never returns AVAILABLE just because configuration/credentials exist -
  // must reflect verified, actual capability (Phase 2 spec section 32).
  async healthCheck() {
    throw new Error("healthCheck must be implemented by subclass");
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Shared shape for the routine "no verified automated source" outcome -
// BAP and BSP both return this today (see their provider files for why).
function manualOnlyResult(provider, reason) {
  return {
    rate: null,
    provider,
    rateBasis: null,
    providerRateDescription: null,
    effectiveDate: null,
    publicationTimestamp: null,
    retrievalTimestamp: nowIso(),
    status: "MANUAL_ONLY",
    sourceReference: null,
    errorMessage: reason,
  };
}

module.exports = { ExchangeRateProvider, nowIso, manualOnlyResult };
