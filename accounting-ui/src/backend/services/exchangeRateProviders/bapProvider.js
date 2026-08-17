const { ExchangeRateProvider, manualOnlyResult } = require("./baseProvider");

// Bankers Association of the Philippines - USD/PHP spot benchmark
// (PHIREF, calculation agent Bloomberg).
//
// VERIFIED FINDING (Phase 2 research, not assumed): bap.org.ph publishes
// an FX Historical Data Summary page (AM/PM Weighted Average, Weighted
// Average, FX Settlement Rate) but exposes no REST/JSON/XML API. More
// importantly, BAP's own disclaimer page states the benchmark data "shall
// not be distributed, licensed, modified, published, re-posted,
// reproduced, reused, sold, transmitted, used to create a derivative work
// or otherwise used for public or commercial purposes without the prior
// written permission of Bloomberg." Automated ingestion into this system
// would violate that stated policy, so this provider does NOT attempt any
// network call - doing so would be exactly the "fake a successful BAP
// connection" the spec explicitly forbids.
//
// This class exists so the resolver has a real, addressable BAP slot in
// the priority hierarchy, and so a future licensed Bloomberg/BAP feed can
// be dropped in here (implementing getLatestRate/getRateForDate for real)
// without changing anything else in the system.
class BapExchangeRateProvider extends ExchangeRateProvider {
  get code() {
    return "BAP";
  }

  get label() {
    return "Bankers Association of the Philippines";
  }

  async getLatestRate({ foreignCurrencyCode, baseCurrencyCode }) {
    return manualOnlyResult(
      this.code,
      `No verified automated BAP source is connected for ${foreignCurrencyCode}/${baseCurrencyCode}. ` +
      "BAP's benchmark data requires Bloomberg's written permission for reuse - use manual official rate entry or file import instead."
    );
  }

  async getRateForDate({ foreignCurrencyCode, baseCurrencyCode }) {
    return this.getLatestRate({ foreignCurrencyCode, baseCurrencyCode });
  }

  async getSupportedCurrencies() {
    // BAP's verified public benchmark is USD/PHP specifically (PHIREF) -
    // do not claim broader coverage than what was actually verified.
    return ["USD"];
  }

  async getSupportedRateTypes() {
    // Rate-basis labels actually observed on bap.org.ph's FX Historical
    // Data Summary table - not manufactured categories.
    return ["AM_WEIGHTED_AVERAGE", "PM_WEIGHTED_AVERAGE", "DAILY_WEIGHTED_AVERAGE", "FX_SETTLEMENT_RATE"];
  }

  async healthCheck() {
    return {
      status: "MANUAL_ONLY",
      message:
        "No verified, licensed automated BAP source is connected. Rates can be entered via Manual Official Rate Entry " +
        "or imported from an official BAP file export. See the Phase 2 BAP access report for details.",
    };
  }
}

module.exports = { BapExchangeRateProvider };
