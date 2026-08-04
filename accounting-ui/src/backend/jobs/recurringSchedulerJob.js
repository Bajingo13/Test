// Scheduler trigger - Phase 4 per the approved plan. This file exists now
// (correct location, correct shape) but is NOT started anywhere yet - no
// code calls start() today. When Phase 4 wires this in, it will call the
// exact same GenerationService.processDueSchedules() that "Generate Now"
// already uses in Phase 1, so there is only ever one generation code path
// regardless of what triggers it.
//
// Planned Phase 4 behavior (not implemented yet):
//   - node-cron running inside this same server.js process, on an
//     interval like every 15 minutes, gated by an env var
//     (RECURRING_INPROCESS_CRON_ENABLED, default true) so it can be
//     switched off once a Railway Cron Job is pointed at the /generate
//     or a dedicated /run-due endpoint instead - no code change needed
//     to make that switch, just the env var.
//   - Every invocation is safe to run concurrently or redundantly with
//     another instance, because the safety lives in
//     recurringGenerationService.processSchedule()'s row locking and the
//     UNIQUE(schedule_id, occurrence_date) constraint, not in the
//     scheduler itself.

const GenerationService = require("../services/recurringGenerationService");

async function runDueSchedulesOnce() {
  return GenerationService.processDueSchedules({ triggerType: "SCHEDULED" });
}

module.exports = { runDueSchedulesOnce };
