const pool = require("../../db");
const { ExchangeRateProvider, nowIso } = require("./baseProvider");

// Wraps Phase 1's existing fixed-rate mechanism (currencyService.recordRate
// with rateMode: "FIXED"). A fixed rate stays in effect until an
// authorized user changes it (Phase 1 rule) - "latest" is simply the most
// recent FIXED currency_rates row.
class FixedExchangeRateProvider extends ExchangeRateProvider {
  get code() {
    return "FIXED";
  }

  get label() {
    return "Fixed Company Rate";
  }

  async getLatestRate({ currencyId }) {
    const [rows] = await pool.execute(
      `SELECT new_rate AS rate, rate_basis AS rateBasis, effective_date AS effectiveDate,
              publication_timestamp AS publicationTimestamp, source_reference AS sourceReference
       FROM currency_rates
       WHERE currency_id = ? AND provider = 'FIXED'
       ORDER BY effective_date DESC, created_at DESC
       LIMIT 1`,
      [currencyId]
    );
    if (!rows.length) {
      return { rate: null, provider: this.code, rateBasis: null, providerRateDescription: null, effectiveDate: null, publicationTimestamp: null, retrievalTimestamp: nowIso(), status: "FAILED", sourceReference: null, errorMessage: "No fixed rate has been recorded for this currency yet." };
    }
    const row = rows[0];
    return {
      rate: Number(row.rate),
      provider: this.code,
      rateBasis: row.rateBasis || null,
      providerRateDescription: "Fixed company rate",
      effectiveDate: row.effectiveDate,
      publicationTimestamp: row.publicationTimestamp,
      retrievalTimestamp: nowIso(),
      status: "FIXED",
      sourceReference: row.sourceReference || null,
      errorMessage: null,
    };
  }

  async getRateForDate({ currencyId }) {
    // A fixed rate has no historical timeline by definition - it's
    // "whatever is currently fixed," so the by-date lookup just returns
    // the current fixed rate rather than pretending there's a per-date
    // history to look up.
    return this.getLatestRate({ currencyId });
  }

  async healthCheck() {
    return { status: "AVAILABLE", message: "Fixed rate entry is always available to authorized users." };
  }
}

module.exports = { FixedExchangeRateProvider };
