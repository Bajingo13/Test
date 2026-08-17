const { ExchangeRateProvider, manualOnlyResult } = require("./baseProvider");

// Bangko Sentral ng Pilipinas - daily Reference Exchange Rate Bulletin
// (RERB) and PHP cross-rate statistics.
//
// VERIFIED FINDING (Phase 2 research, not assumed): bsp.gov.ph genuinely
// publishes downloadable Excel files (daily/monthly/annual USD/PHP, and
// PHP/USD/EUR cross rates) - a real official machine-readable channel, in
// principle exactly the kind of source Phase 2 prefers. However,
// bsp.gov.ph/robots.txt explicitly states `User-agent: * / Disallow: /`
// and only allow-lists named search-engine crawlers (Googlebot, Bingbot,
// MSNBOT-Media). An automated backend fetcher is not one of those, so
// programmatic retrieval would violate the site's own stated automated-
// access policy. This provider does NOT attempt any network call for that
// reason - a human downloading the same Excel file through a normal
// browser and uploading it via the Official Rate Import workflow is a
// different, permitted use (individual manual access, not bulk automated
// scraping), which is why that workflow exists instead.
//
// This class exists so the resolver has a real, addressable BSP slot in
// the priority hierarchy, and so an authorized/licensed BSP data
// arrangement can be dropped in here later without changing anything else.
class BspExchangeRateProvider extends ExchangeRateProvider {
  get code() {
    return "BSP";
  }

  get label() {
    return "Bangko Sentral ng Pilipinas";
  }

  async getLatestRate({ foreignCurrencyCode, baseCurrencyCode }) {
    return manualOnlyResult(
      this.code,
      `No verified automated BSP source is connected for ${foreignCurrencyCode}/${baseCurrencyCode}. ` +
      "bsp.gov.ph's robots.txt disallows automated access for non-search-engine agents - use manual official rate entry or file import instead."
    );
  }

  async getRateForDate({ foreignCurrencyCode, baseCurrencyCode }) {
    return this.getLatestRate({ foreignCurrencyCode, baseCurrencyCode });
  }

  async getSupportedCurrencies() {
    // BSP's verified published cross-rate tables cover USD and EUR
    // directly, plus a broader PHP cross-rate table - listing the
    // currencies actually named on the verified statistics page rather
    // than assuming full ISO 4217 coverage.
    return ["USD", "EUR", "JPY", "GBP", "AUD", "CAD", "SGD", "CNY", "HKD", "CHF", "KRW", "THB", "MYR"];
  }

  async getSupportedRateTypes() {
    // Terminology actually used on the verified BSP statistics/RERB
    // pages - not manufactured categories.
    return ["DAILY_REFERENCE_RATE", "PHP_CROSS_RATE", "MONTHLY_AVERAGE", "ANNUAL_AVERAGE"];
  }

  async healthCheck() {
    return {
      status: "MANUAL_ONLY",
      message:
        "bsp.gov.ph's robots.txt disallows automated retrieval for this application. Rates can be entered via " +
        "Manual Official Rate Entry or imported from an official BSP Excel/RERB file you download yourself. " +
        "See the Phase 2 BSP access report for details.",
    };
  }
}

module.exports = { BspExchangeRateProvider };
