const { ExchangeRateProvider, manualOnlyResult } = require("./baseProvider");

// Plug-in point for a licensed third-party FX data provider, per the
// spec's "Approved external exchange-rate provider" fallback tier. No
// specific provider has been chosen or licensed as of Phase 2, so this
// class deliberately does NOT call any network endpoint - inventing a
// concrete API contract for an unspecified/unlicensed provider would be
// exactly the "Do NOT invent API endpoints" the spec forbids.
//
// EXCHANGE_RATE_PROVIDER / EXCHANGE_RATE_API_URL / EXCHANGE_RATE_API_KEY /
// EXCHANGE_RATE_TIMEOUT_MS env vars are read here (never logged, never
// sent to the frontend) so that once a specific provider is licensed, a
// future phase implements the actual HTTP call using them - the env var
// names are reserved now, the request logic is not invented.
class ExternalExchangeRateProvider extends ExchangeRateProvider {
  get code() {
    return "EXTERNAL";
  }

  get label() {
    return process.env.EXCHANGE_RATE_PROVIDER || "External Provider (not configured)";
  }

  isConfigured() {
    return Boolean(process.env.EXCHANGE_RATE_API_URL);
  }

  async getLatestRate({ foreignCurrencyCode, baseCurrencyCode }) {
    if (!this.isConfigured()) {
      return manualOnlyResult(
        this.code,
        "No external exchange-rate provider is configured (EXCHANGE_RATE_API_URL is unset). " +
        "Configure a licensed provider before this tier can return live rates."
      );
    }
    // Intentionally unimplemented: no specific external provider has been
    // selected/licensed yet, so there is no verified request/response
    // contract to build against without inventing one.
    return manualOnlyResult(
      this.code,
      `EXCHANGE_RATE_API_URL is set but no provider integration has been implemented yet for ${foreignCurrencyCode}/${baseCurrencyCode}.`
    );
  }

  async getRateForDate({ foreignCurrencyCode, baseCurrencyCode }) {
    return this.getLatestRate({ foreignCurrencyCode, baseCurrencyCode });
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { status: "UNAVAILABLE", message: "No external provider configured (EXCHANGE_RATE_API_URL unset)." };
    }
    return { status: "UNAVAILABLE", message: "External provider is configured but not yet implemented." };
  }
}

module.exports = { ExternalExchangeRateProvider };
