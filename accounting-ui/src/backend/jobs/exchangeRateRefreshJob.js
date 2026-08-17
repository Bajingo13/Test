// Scheduled rate refresh - infrastructure only, NOT started anywhere yet
// (mirrors jobs/recurringSchedulerJob.js's exact precedent: correct
// location/shape now, no code calls start() today).
//
// Why not an in-process node-cron: the app deploys on Railway as a single
// web service - an in-process timer is not reliable across deploys/
// restarts/multiple instances, and node-cron isn't even a dependency of
// this project today (checked before proposing it, per
// recurringSchedulerJob.js's own reasoning). The recommended mechanism is
// a Railway Cron Job hitting POST /api/exchange-rates/refresh-all on a
// schedule - stateless, survives redeploys, and needs zero in-process
// timer code.
//
// Also, as of Phase 2, there is genuinely nothing productive for a
// schedule to do yet: BAP and BSP have no verified automated source (see
// the Phase 2 BAP/BSP access report), and no external provider is
// configured, so every refresh-all call today resolves to the
// LAST_APPROVED_RATE/MANUAL/FIXED fallback tiers, which don't change on
// their own between runs. Enabling a schedule now would just be periodic
// no-op activity. This file exists so that the moment a live provider
// (BAP/BSP licensed feed, or an external provider) is connected in a
// later phase, wiring Railway Cron to call refreshAllCompanies() below is
// a one-line addition, not new plumbing.
//
// Duplicate-refresh protection: refreshOne()/refreshAll() in
// exchangeRate.controller.js only ever WRITE a new currency_rates row
// when the resolver found genuinely new data from a live tier - re-
// running this concurrently or redundantly is safe because "nothing new
// to store" is the routine, checked outcome, not a race condition to
// guard against separately.

const pool = require("../db");

async function refreshAllCompanies() {
  const ExchangeRateController = require("../controllers/exchangeRate.controller");
  const [companies] = await pool.execute("SELECT id FROM companies WHERE status = 'Active'");

  const systemUser = { id: null, roleCode: "SUPER_ADMIN" };
  const results = [];
  for (const company of companies) {
    const [currencies] = await pool.execute(
      "SELECT id, currency_code AS currencyCode FROM currencies WHERE company_id = ? AND is_base_currency = 0 AND is_active = 1",
      [company.id]
    );
    for (const currency of currencies) {
      try {
        const result = await ExchangeRateController.refreshOneForJob(systemUser, currency.id);
        results.push({ companyId: company.id, ...result });
      } catch (err) {
        results.push({ companyId: company.id, currencyCode: currency.currencyCode, status: "FAILED", errorMessage: err.message });
      }
    }
  }
  return results;
}

module.exports = { refreshAllCompanies };
