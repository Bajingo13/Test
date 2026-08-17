// Checkpoint 3F: scheduler trigger, now actually wired.
//
// Two interchangeable trigger mechanisms, both calling the exact same
// GenerationService.processDueSchedules() "Generate Now" already uses -
// there is only ever one generation code path regardless of what
// triggers it:
//   1. An in-process node-cron tick (this file), gated by
//      RECURRING_INPROCESS_CRON_ENABLED (default true - works out of the
//      box for a single Railway service or local dev).
//   2. POST /api/recurring-transactions/run-due (server.js), for a
//      Railway Cron Job to call instead - set
//      RECURRING_INPROCESS_CRON_ENABLED=false to disable #1 once a
//      Railway Cron Job is pointed at that endpoint. No code change
//      needed to make that switch, just the env var.
//
// Railway multi-instance safety: duplicate prevention does NOT live in
// this timer. It lives in recurringGenerationService.processSchedule()'s
// row locking (FOR UPDATE on the schedule + template rows) and the
// UNIQUE(schedule_id, occurrence_date) constraint, hardened in 3F to
// cleanly report ALREADY_GENERATED on a raw ER_DUP_ENTRY race. That means
// it is SAFE for the in-process cron to run on every instance
// simultaneously (Railway may run more than one) - at most one of them
// wins a given occurrence, the rest see it already claimed. The
// `running` flag below only prevents a single instance's OWN overlapping
// ticks (e.g. a run taking longer than the interval) - it is a
// within-process courtesy, not a correctness mechanism.

const cron = require("node-cron");
const GenerationService = require("../services/recurringGenerationService");

const INTERVAL_CRON_EXPRESSION = "*/15 * * * *"; // every 15 minutes
let running = false;
let task = null;

async function runDueSchedulesOnce() {
  if (running) {
    console.log("RECURRING SCHEDULER: previous run still in progress, skipping this tick.");
    return { skipped: true };
  }
  running = true;
  try {
    const result = await GenerationService.processDueSchedules({ triggerType: "SCHEDULED" });
    if (result.processed > 0) {
      console.log(
        `RECURRING SCHEDULER: processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} alreadyGenerated=${result.alreadyGenerated}`
      );
    }
    return result;
  } catch (err) {
    console.error("RECURRING SCHEDULER ERROR:", err);
    return { error: err.message };
  } finally {
    running = false;
  }
}

// Starts the in-process cron tick. Safe to call even if the env var
// disables it (becomes a no-op) - server.js always calls this at boot
// unconditionally, keeping the on/off decision in one place (the env var
// default), not scattered across call sites.
function start() {
  const enabled = process.env.RECURRING_INPROCESS_CRON_ENABLED !== "false";
  if (!enabled) {
    console.log("RECURRING SCHEDULER: in-process cron disabled (RECURRING_INPROCESS_CRON_ENABLED=false).");
    return;
  }
  if (task) return; // already started - avoid double-registration on hot reload
  task = cron.schedule(INTERVAL_CRON_EXPRESSION, () => {
    runDueSchedulesOnce();
  });
  console.log(`RECURRING SCHEDULER: in-process cron started (${INTERVAL_CRON_EXPRESSION}, Asia/Manila accounting timezone honored per-schedule).`);
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { runDueSchedulesOnce, start, stop };