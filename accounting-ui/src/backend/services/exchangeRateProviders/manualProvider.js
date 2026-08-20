const pool = require("../../db");
const { ExchangeRateProvider, nowIso } = require("./baseProvider");
const { toDateOnly } = require("../../lib/dateOnly");

// Wraps Phase 1's existing manual-rate mechanism (currencyService.recordRate
// with rateMode: "MANUAL") as a resolver-priority-list provider. "Latest
// rate" here means the most recent MANUAL currency_rates row for this
// currency - there is nothing to fetch, only to read back what an
// authorized user already entered.
class ManualExchangeRateProvider extends ExchangeRateProvider {
  get code() {
    return "MANUAL";
  }

  get label() {
    return "Manual Rate";
  }

  async getLatestRate({ currencyId }) {
    const [rows] = await pool.execute(
      `SELECT new_rate AS rate, rate_basis AS rateBasis, effective_date AS effectiveDate,
              publication_timestamp AS publicationTimestamp, source_reference AS sourceReference
       FROM currency_rates
       WHERE currency_id = ? AND provider = 'MANUAL'
       ORDER BY effective_date DESC, created_at DESC
       LIMIT 1`,
      [currencyId]
    );
    if (!rows.length) {
      return {
        rate: null,
        provider: this.code,
        rateBasis: null,
        providerRateDescription: null,
        effectiveDate: null,
        publicationTimestamp: null,
        retrievalTimestamp: nowIso(),
        status: "FAILED",
        sourceReference: null,
        errorMessage: "No manual rate has been recorded for this currency yet.",
      };
    }
    const row = rows[0];
    return {
      rate: Number(row.rate),
      provider: this.code,
      rateBasis: row.rateBasis || null,
      providerRateDescription: "Manually entered rate",
      // Checkpoint 6C: effective_date is a MySQL DATE column - normalize
      // here at the read boundary (same fix as lookupLastApproved already
      // applies in exchangeRateResolverService.js) rather than let a raw
      // Date object leak out to callers. See lib/dateOnly.js.
      effectiveDate: toDateOnly(row.effectiveDate),
      publicationTimestamp: row.publicationTimestamp,
      retrievalTimestamp: nowIso(),
      status: "MANUAL",
      sourceReference: row.sourceReference || null,
      errorMessage: null,
    };
  }

  async getRateForDate({ currencyId, date }) {
    const [rows] = await pool.execute(
      `SELECT new_rate AS rate, rate_basis AS rateBasis, effective_date AS effectiveDate
       FROM currency_rates
       WHERE currency_id = ? AND provider = 'MANUAL' AND effective_date <= ?
       ORDER BY effective_date DESC, created_at DESC
       LIMIT 1`,
      [currencyId, date]
    );
    if (!rows.length) {
      return { rate: null, provider: this.code, rateBasis: null, providerRateDescription: null, effectiveDate: null, publicationTimestamp: null, retrievalTimestamp: nowIso(), status: "FAILED", sourceReference: null, errorMessage: "No manual rate available on or before that date." };
    }
    return { rate: Number(rows[0].rate), provider: this.code, rateBasis: rows[0].rateBasis || null, providerRateDescription: "Manually entered rate", effectiveDate: toDateOnly(rows[0].effectiveDate), publicationTimestamp: null, retrievalTimestamp: nowIso(), status: "MANUAL", sourceReference: null, errorMessage: null };
  }

  async healthCheck() {
    return { status: "AVAILABLE", message: "Manual rate entry is always available to authorized users." };
  }
}

module.exports = { ManualExchangeRateProvider };
