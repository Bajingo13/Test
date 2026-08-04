const { DateTime } = require("luxon");

// Pure date-calculation functions - no DB access, independently testable.
// All schedule math runs in the schedule's timezone (default Asia/Manila,
// fixed UTC+8, no DST) via Luxon rather than raw offset arithmetic, so a
// future DST-observing timezone wouldn't silently break this.
//
// No holiday calendar exists anywhere in this app today (confirmed by
// research) - "business day" here means Mon-Fri only. Holiday-awareness
// is a documented future enhancement, not built in Phase 1.

const ZONE = "Asia/Manila";

// mysql2 returns SQL DATE columns as JS Date objects by default (every
// existing query in this codebase wraps date columns in DATE_FORMAT() for
// display, which is why this hasn't bitten anyone yet) - accept both a
// plain 'YYYY-MM-DD' string and a Date object. For a Date object, read
// its LOCAL getters (not toISOString(), which shifts across a UTC
// offset) to recover the calendar date mysql2 actually constructed,
// independent of the Node process's own timezone.
function toDT(dateInput, zone = ZONE) {
  if (dateInput instanceof Date) {
    return DateTime.fromObject(
      { year: dateInput.getFullYear(), month: dateInput.getMonth() + 1, day: dateInput.getDate() },
      { zone }
    );
  }
  return DateTime.fromISO(String(dateInput).slice(0, 10), { zone });
}

function toISODate(dt) {
  return dt.toISODate();
}

function isBusinessDay(dt) {
  return dt.weekday >= 1 && dt.weekday <= 5; // Luxon: 1=Monday..7=Sunday
}

function nextBusinessDay(dt) {
  let d = dt;
  while (!isBusinessDay(d)) d = d.plus({ days: 1 });
  return d;
}

function previousBusinessDay(dt) {
  let d = dt;
  while (!isBusinessDay(d)) d = d.minus({ days: 1 });
  return d;
}

function lastDayOfMonth(dt) {
  return dt.endOf("month").startOf("day");
}

function firstBusinessDayOfMonth(dt) {
  return nextBusinessDay(dt.startOf("month"));
}

function lastBusinessDayOfMonth(dt) {
  return previousBusinessDay(lastDayOfMonth(dt));
}

// ordinal: 'FIRST'|'SECOND'|'THIRD'|'FOURTH'|'LAST', weekday: 1(Mon)-7(Sun) (Luxon convention)
function specificWeekdayOfMonth(dt, ordinal, weekday) {
  if (ordinal === "LAST") {
    let d = lastDayOfMonth(dt);
    while (d.weekday !== weekday) d = d.minus({ days: 1 });
    return d;
  }
  const ordinalIndex = { FIRST: 0, SECOND: 1, THIRD: 2, FOURTH: 3 }[ordinal] ?? 0;
  let d = dt.startOf("month");
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.plus({ weeks: ordinalIndex });
}

// Applies the configured monthRule to a target month (a DateTime anchored
// anywhere in that month). Returns { date, wasClamped } - wasClamped is
// true only for SAME_DAY when the requested day doesn't exist in this
// month (e.g. the 31st in a 30-day month), so callers can distinguish
// "clamped to last valid day" from "this rule always lands here anyway".
function resolveMonthRuleDate(targetMonthDt, monthRule, fallbackDay) {
  const rule = monthRule || { type: "SAME_DAY" };
  switch (rule.type) {
    case "LAST_DAY":
      return { date: lastDayOfMonth(targetMonthDt), wasClamped: false };
    case "FIRST_BUSINESS_DAY":
      return { date: firstBusinessDayOfMonth(targetMonthDt), wasClamped: false };
    case "LAST_BUSINESS_DAY":
      return { date: lastBusinessDayOfMonth(targetMonthDt), wasClamped: false };
    case "SPECIFIC_WEEKDAY":
      return { date: specificWeekdayOfMonth(targetMonthDt, rule.ordinal || "FIRST", rule.weekday || 1), wasClamped: false };
    case "SAME_DAY":
    default: {
      const day = rule.day || fallbackDay || targetMonthDt.day;
      const daysInMonth = targetMonthDt.daysInMonth;
      if (day > daysInMonth) {
        return { date: lastDayOfMonth(targetMonthDt), wasClamped: true };
      }
      return { date: targetMonthDt.set({ day }), wasClamped: false };
    }
  }
}

// Applies the schedule's date_adjustment_rule to a raw computed date.
// Returns { date: DateTime|null, skipped: boolean } - skipped=true means
// this occurrence should be omitted entirely (SKIP rule, only meaningful
// when wasClamped is true - e.g. Feb 31 doesn't exist, so SKIP drops that
// month's occurrence entirely rather than moving it).
function applyDateAdjustmentRule(dt, rule, wasClamped) {
  switch (rule) {
    case "NEXT_BUSINESS_DAY":
      return { date: nextBusinessDay(dt), skipped: false };
    case "PREVIOUS_BUSINESS_DAY":
      return { date: previousBusinessDay(dt), skipped: false };
    case "LAST_VALID_DAY":
      return { date: dt, skipped: false }; // resolveMonthRuleDate already clamped to the last valid day
    case "SKIP":
      return wasClamped ? { date: null, skipped: true } : { date: dt, skipped: false };
    case "KEEP_ORIGINAL":
    default:
      return { date: dt, skipped: false };
  }
}

// Luxon weekday: 1=Monday..7=Sunday. Our stored `weekday` column follows
// the common JS/UI convention 0=Sunday..6=Saturday - convert at the edge.
function luxonWeekdayFromJs(jsWeekday) {
  const w = Number(jsWeekday);
  return w === 0 ? 7 : w;
}

// Computes the single next occurrence strictly after `afterDate` (or the
// schedule's start_date if afterDate is null - the first occurrence).
// Returns an ISO date string, or null if the SKIP rule dropped this cycle
// (caller advances the anchor and retries - see computeNextRunDate).
function computeNextOccurrenceDate(schedule, afterDate) {
  const zone = schedule.timezone || ZONE;
  const interval = Math.max(Number(schedule.interval_value) || 1, 1);
  const isFirstOccurrence = !afterDate;
  const anchor = isFirstOccurrence ? toDT(schedule.start_date, zone) : toDT(afterDate, zone);

  let raw;
  let wasClamped = false;

  switch (schedule.frequency) {
    case "DAILY":
      raw = isFirstOccurrence ? anchor : anchor.plus({ days: interval });
      break;

    case "WEEKLY":
    case "BIWEEKLY": {
      const targetWeekday = luxonWeekdayFromJs(schedule.weekday);
      const stepWeeks = schedule.frequency === "BIWEEKLY" ? 2 : interval;
      if (isFirstOccurrence) {
        // First occurrence: first occurrence of targetWeekday on/after start_date.
        let d = anchor;
        while (d.weekday !== targetWeekday) d = d.plus({ days: 1 });
        raw = d;
      } else {
        // Subsequent: the prior occurrence is already on the target weekday,
        // so stepping by whole weeks keeps it on that weekday.
        raw = anchor.plus({ weeks: stepWeeks });
      }
      break;
    }

    case "MONTHLY":
    case "BIMONTHLY":
    case "QUARTERLY":
    case "SEMIANNUAL": {
      const monthStep = schedule.frequency === "BIMONTHLY" ? 2
        : schedule.frequency === "QUARTERLY" ? 3
        : schedule.frequency === "SEMIANNUAL" ? 6
        : interval;
      const targetMonth = isFirstOccurrence ? anchor.startOf("month") : anchor.plus({ months: monthStep }).startOf("month");
      const resolved = resolveMonthRuleDate(targetMonth, schedule.month_rule, schedule.month_day);
      raw = resolved.date;
      wasClamped = resolved.wasClamped;
      break;
    }

    case "ANNUAL": {
      const yearStep = isFirstOccurrence ? 0 : interval;
      const targetYear = anchor.year + yearStep;
      const month = schedule.month_rule?.month || anchor.month;
      const day = schedule.month_rule?.day || anchor.day;
      const daysInTargetMonth = DateTime.fromObject({ year: targetYear, month }, { zone }).daysInMonth;
      const clampedDay = Math.min(day, daysInTargetMonth);
      wasClamped = clampedDay !== day;
      raw = DateTime.fromObject({ year: targetYear, month, day: clampedDay }, { zone });
      break;
    }

    case "CUSTOM": {
      const unit = (schedule.custom_unit || "DAYS").toLowerCase();
      raw = isFirstOccurrence ? anchor : anchor.plus({ [unit]: interval });
      break;
    }

    default:
      throw new Error(`Unsupported recurrence frequency: ${schedule.frequency}`);
  }

  const { date, skipped } = applyDateAdjustmentRule(raw, schedule.date_adjustment_rule, wasClamped);
  if (skipped || !date) return null;
  return toISODate(date);
}

// Advances from `afterDate`, skipping over any SKIP-rule-dropped cycles,
// until it finds a real occurrence date or hits end_date/max_occurrences.
// Returns null when the schedule is exhausted (caller should mark it
// COMPLETED).
function computeNextRunDate(schedule, afterDate) {
  let cursor = afterDate || null;
  let candidate = computeNextOccurrenceDate(schedule, cursor);
  let guard = 0;
  while (candidate === null && guard < 36) {
    // SKIP rule dropped this cycle - advance the anchor by one cycle and
    // retry. Using the schedule's own start_date as the very first cursor
    // when none exists yet, otherwise step from wherever we are.
    const zone = schedule.timezone || ZONE;
    cursor = cursor ? cursor : schedule.start_date;
    cursor = toISODate(toDT(cursor, zone).plus({ days: 1 }));
    candidate = computeNextOccurrenceDate(schedule, cursor);
    guard++;
  }
  if (!candidate) return null;

  if (schedule.end_date && candidate > schedule.end_date) return null;
  if (schedule.max_occurrences && schedule.generated_count >= schedule.max_occurrences) return null;

  return candidate;
}

// Returns up to `count` future occurrence dates (ISO strings) - pure
// preview, no DB writes. Starts from the schedule's own next_run_date if
// already computed, otherwise derives the first occurrence from scratch.
function previewOccurrences(schedule, count = 5) {
  const results = [];
  let cursor = null;
  let occurrencesSoFar = schedule.generated_count || 0;

  let next = schedule.next_run_date || computeNextRunDate(schedule, null);
  while (next && results.length < count) {
    if (schedule.max_occurrences && occurrencesSoFar >= schedule.max_occurrences) break;
    results.push(next);
    cursor = next;
    occurrencesSoFar++;
    next = computeNextRunDate({ ...schedule, generated_count: occurrencesSoFar }, cursor);
  }

  return results;
}

const DUE_DATE_RULE_HANDLERS = {
  SAME_AS_TRANSACTION_DATE: (dt) => dt,
  ADD_DAYS: (dt, cfg) => dt.plus({ days: Number(cfg.days) || 0 }),
  ADD_WEEKS: (dt, cfg) => dt.plus({ weeks: Number(cfg.weeks) || 0 }),
  ADD_MONTHS: (dt, cfg) => dt.plus({ months: Number(cfg.months) || 0 }),
  END_OF_CURRENT_MONTH: (dt) => lastDayOfMonth(dt),
  END_OF_NEXT_MONTH: (dt) => lastDayOfMonth(dt.plus({ months: 1 })),
  PAYMENT_TERMS: (dt, cfg) => dt.plus({ days: Number(cfg.termDays) || 0 }),
};

// dueDateRule: { mode, ...params }. Recalculated fresh for every generated
// occurrence (never copied from the template's original due date).
function computeDueDate(transactionDateISO, dueDateRule, zone = ZONE) {
  const dt = toDT(transactionDateISO, zone);
  const rule = dueDateRule || { mode: "SAME_AS_TRANSACTION_DATE" };
  const handler = DUE_DATE_RULE_HANDLERS[rule.mode] || DUE_DATE_RULE_HANDLERS.SAME_AS_TRANSACTION_DATE;
  return toISODate(handler(dt, rule));
}

module.exports = {
  ZONE,
  toDT,
  toISODate,
  isBusinessDay,
  nextBusinessDay,
  previousBusinessDay,
  lastDayOfMonth,
  computeNextOccurrenceDate,
  computeNextRunDate,
  previewOccurrences,
  computeDueDate,
};
