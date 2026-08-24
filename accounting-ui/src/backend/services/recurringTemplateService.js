const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const DateService = require("./recurringDateService");
const ValidationService = require("./recurringValidationService");

// Per-module table/column shape needed to bootstrap a template from an
// existing saved transaction. Same MODULE_CONFIG-driven pattern proven in
// the Printing Options framework (transactionPrintDataService.js) -
// extending to APV/JV/PO/OR/CV in Phase 3 is a new entry here, not new
// logic.
const SOURCE_MODULE_CONFIG = {
  invoice: {
    headerTable: "invoice_headers",
    lineTable: "invoice_lines",
    lineIdCol: "invoice_id",
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
  },
  apv: {
    headerTable: "apv_headers",
    lineTable: "apv_lines",
    lineIdCol: "apv_id",
    partyIdCol: "supplier_id",
    partyNameCol: "supplier_name",
  },
  // JV has no party FK anywhere in its schema - its manual route only ever
  // writes free-text `prepared_for` (see recurringGenerationService's jv
  // entry). partyIdCol: null signals "this module has no party column",
  // handled below by selecting a literal NULL instead of a column name.
  jv: {
    headerTable: "jv_headers",
    lineTable: "jv_lines",
    lineIdCol: "jv_id",
    partyIdCol: null,
    partyNameCol: "prepared_for",
  },
  po: {
    headerTable: "purchase_order_headers",
    lineTable: "purchase_order_lines",
    lineIdCol: "po_id",
    partyIdCol: "supplier_id",
    partyNameCol: "supplier_name",
  },
  or: {
    headerTable: "or_headers",
    lineTable: "or_lines",
    lineIdCol: "or_id",
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
  },
  cv: {
    headerTable: "cv_headers",
    lineTable: "cv_lines",
    lineIdCol: "cv_id",
    partyIdCol: "payee_id",
    partyNameCol: "payee_name",
  },
};

async function createTemplateFromTransaction(moduleType, transactionId, userId, companyId) {
  const cfg = SOURCE_MODULE_CONFIG[moduleType];
  if (!cfg) throw new HttpError(400, `Recurring templates from an existing transaction aren't supported yet for: ${moduleType}`);

  const partyIdExpr = cfg.partyIdCol ? `${cfg.partyIdCol} AS partyId` : "NULL AS partyId";
  const [headers] = await pool.execute(
    `SELECT ${partyIdExpr}, ${cfg.partyNameCol} AS partyName, description, currency_id AS currencyId
     FROM ${cfg.headerTable} WHERE id = ? AND company_id = ?`,
    [transactionId, companyId]
  );
  if (headers.length === 0) throw new HttpError(404, "Source transaction not found.");
  const header = headers[0];

  const [lineRows] = await pool.execute(
    `SELECT account_id AS accountId, account_code AS accountCode, account_title AS accountTitle,
      particulars, debit, credit, foreign_debit AS foreignDebit, foreign_credit AS foreignCredit, gen_ref AS genRef, gen_name AS genName
     FROM ${cfg.lineTable} WHERE ${cfg.lineIdCol} = ? ORDER BY id ASC`,
    [transactionId]
  );

  return {
    moduleType,
    partyId: header.partyId,
    partyName: header.partyName,
    descriptionTemplate: header.description || "",
    // So the "Make Recurring" modal can default its currency picker to
    // whatever the source transaction actually used, instead of always
    // defaulting to base currency and relying on the user to remember to
    // change it.
    sourceCurrencyId: header.currencyId || null,
    lines: lineRows.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountTitle: l.accountTitle,
      particularsTemplate: l.particulars,
      // Template lines are defined to hold TRANSACTION-CURRENCY amounts
      // (recurringGenerationService.computeLineAmounts's own doc comment:
      // "templates store business amounts in foreign currency, not
      // pre-converted base") - generation multiplies this by the resolved
      // rate to get base. If the source transaction was itself foreign-
      // denominated, foreign_debit/foreign_credit ARE that amount; only a
      // base-currency source has them NULL (the established convention),
      // in which case debit/credit (already base) is correct as-is.
      debit: l.foreignDebit != null ? Number(l.foreignDebit) : (Number(l.debit) || 0),
      credit: l.foreignCredit != null ? Number(l.foreignCredit) : (Number(l.credit) || 0),
      genRef: l.genRef,
      genName: l.genName,
    })),
  };
}

const RATE_POLICIES = ["RESOLVE_ON_GENERATION", "FIXED_RATE", "MANUAL_REVIEW"];

// Checkpoint 3D: currencyId/ratePolicy/fixedRate validation. Kept here
// (not in recurringValidationService.js) since it needs a DB lookup
// (currency existence/active), unlike that file's pure checks.
async function validateCurrencyPolicy({ currencyId, ratePolicy, fixedRate, companyId }) {
  const policy = ratePolicy || "RESOLVE_ON_GENERATION";
  if (!RATE_POLICIES.includes(policy)) {
    throw new HttpError(400, `rate_policy must be one of: ${RATE_POLICIES.join(", ")}.`);
  }
  if (!currencyId) return { currencyId: null, ratePolicy: policy, fixedRate: null };

  const [rows] = await pool.execute(
    "SELECT id, is_active AS isActive, is_base_currency AS isBaseCurrency, company_id AS companyId FROM currencies WHERE id = ?",
    [currencyId]
  );
  if (!rows.length) throw new HttpError(400, "Selected currency does not exist.");
  if (companyId && rows[0].companyId !== Number(companyId)) {
    throw new HttpError(400, "Selected currency does not belong to this company.");
  }
  if (!rows[0].isActive) throw new HttpError(400, "Selected currency is not active.");

  // Base currency: rate is always 1, policy/fixedRate are meaningless -
  // store as if unset (section 4/22).
  if (rows[0].isBaseCurrency) return { currencyId, ratePolicy: "RESOLVE_ON_GENERATION", fixedRate: null };

  if (policy === "FIXED_RATE") {
    const rate = Number(fixedRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new HttpError(400, "A Fixed Rate policy requires a fixed rate greater than zero.");
    }
    return { currencyId, ratePolicy: policy, fixedRate: rate };
  }

  return { currencyId, ratePolicy: policy, fixedRate: null };
}

async function createTemplate(input, userId, companyId = null) {
  const { moduleType, templateName, partyId, partyName, descriptionTemplate, currency, currencyId, ratePolicy, fixedRate, amountMode, amountConfig, dueDateRule, lines, schedule } = input;

  ValidationService.validateTemplateInput({
    moduleType,
    templateName,
    partyId,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    schedule,
  });

  const currencyPolicy = await validateCurrencyPolicy({ currencyId, ratePolicy, fixedRate, companyId });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Checkpoint 3D: company_id is stored at creation time (previously
    // always NULL - nothing ever set it) so recurringGenerationService can
    // resolve the CORRECT company's currency/rate at generation time
    // instead of guessing "the first company in the table".
    const [templateResult] = await conn.execute(
      `INSERT INTO recurring_transaction_templates
        (module_type, template_name, party_id, party_name, description_template, currency, amount_mode, amount_config, due_date_rule, status, created_by, updated_by, currency_id, rate_policy, fixed_rate, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
      [
        moduleType, templateName, partyId || null, partyName || null, descriptionTemplate || null,
        currency || "PHP", amountMode || "FIXED", JSON.stringify(amountConfig || {}),
        JSON.stringify(dueDateRule || { mode: "SAME_AS_TRANSACTION_DATE" }),
        userId, userId,
        currencyPolicy.currencyId, currencyPolicy.ratePolicy, currencyPolicy.fixedRate, companyId,
      ]
    );
    const templateId = templateResult.insertId;

    let sortOrder = 0;
    for (const line of lines) {
      await conn.execute(
        `INSERT INTO recurring_transaction_template_lines
          (template_id, account_id, account_code, account_title, particulars_template, debit, credit, gen_ref, gen_name, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          templateId, line.accountId, line.accountCode || "", line.accountTitle || "",
          line.particularsTemplate || "", Number(line.debit) || 0, Number(line.credit) || 0,
          line.genRef || "", line.genName || "", sortOrder++,
        ]
      );
    }

    const scheduleRow = {
      frequency: schedule.frequency,
      interval_value: schedule.intervalValue || 1,
      custom_unit: schedule.customUnit || null,
      weekday: schedule.weekday ?? null,
      month_day: schedule.monthDay ?? null,
      month_rule: schedule.monthRule || null,
      start_date: schedule.startDate,
      end_date: schedule.endDate || null,
      max_occurrences: schedule.maxOccurrences || null,
      generated_count: 0,
      timezone: schedule.timezone || DateService.ZONE,
      date_adjustment_rule: schedule.dateAdjustmentRule || "KEEP_ORIGINAL",
    };
    const firstRunDate = DateService.computeNextRunDate(scheduleRow, null);
    if (!firstRunDate) {
      throw new HttpError(400, "This recurrence configuration never produces a valid occurrence - check the start/end dates and rules.");
    }

    const [scheduleResult] = await conn.execute(
      `INSERT INTO recurring_transaction_schedules
        (template_id, frequency, interval_value, custom_unit, weekday, month_day, month_rule,
         start_date, end_date, max_occurrences, generated_count, next_run_date, timezone,
         date_adjustment_rule, is_active, is_paused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 0)`,
      [
        templateId, scheduleRow.frequency, scheduleRow.interval_value, scheduleRow.custom_unit,
        scheduleRow.weekday, scheduleRow.month_day, scheduleRow.month_rule ? JSON.stringify(scheduleRow.month_rule) : null,
        scheduleRow.start_date, scheduleRow.end_date, scheduleRow.max_occurrences, firstRunDate,
        scheduleRow.timezone, scheduleRow.date_adjustment_rule,
      ]
    );

    await conn.commit();
    return { templateId, scheduleId: scheduleResult.insertId, nextRunDate: firstRunDate };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// mysql2 returns SQL DATE columns as JS Date objects by default - normalize
// every schedule date field to a clean 'YYYY-MM-DD' string in this one
// shared place, both for downstream date-arithmetic correctness and so a
// raw Date object never leaks into a JSON response (see
// recurringDateService.toDT's comment for why that matters).
function normalizeDate(value) {
  if (value === null || value === undefined) return value;
  return DateService.toISODate(DateService.toDT(value));
}

// mysql2 auto-deserializes native MySQL JSON columns into JS objects/
// arrays already - JSON.parse()-ing an already-parsed object throws
// ("[object Object]" is not valid JSON). Handles both shapes defensively
// in case that ever changes.
function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function parseScheduleRow(row) {
  return {
    ...row,
    month_rule: parseJsonColumn(row.month_rule, null),
    is_active: !!row.is_active,
    is_paused: !!row.is_paused,
    start_date: normalizeDate(row.start_date),
    end_date: normalizeDate(row.end_date),
    next_run_date: normalizeDate(row.next_run_date),
    last_run_date: normalizeDate(row.last_run_date),
  };
}

async function getTemplateById(id, companyId) {
  const [templates] = await pool.execute("SELECT * FROM recurring_transaction_templates WHERE id = ? AND company_id = ?", [id, companyId]);
  if (templates.length === 0) throw new HttpError(404, "Recurring template not found.");
  const template = templates[0];
  template.amount_config = parseJsonColumn(template.amount_config, {});
  template.due_date_rule = parseJsonColumn(template.due_date_rule, {});

  const [lines] = await pool.execute(
    "SELECT * FROM recurring_transaction_template_lines WHERE template_id = ? ORDER BY sort_order ASC",
    [id]
  );

  const [schedules] = await pool.execute(
    "SELECT * FROM recurring_transaction_schedules WHERE template_id = ?",
    [id]
  );
  const schedule = schedules[0] ? parseScheduleRow(schedules[0]) : null;

  return { template, lines, schedule };
}

async function listTemplates({ moduleType, status, companyId } = {}) {
  const params = [companyId];
  let where = "WHERE t.company_id = ?";
  if (moduleType) {
    where += " AND t.module_type = ?";
    params.push(moduleType);
  }
  if (status) {
    where += " AND t.status = ?";
    params.push(status);
  }

  // Checkpoint 3F: the list/management UI needs currency + rate policy
  // (section 4) and a needs-attention signal (section 39's summary cards)
  // without a second round-trip per row - a correlated subquery for each
  // schedule's MOST RECENT occurrence status/reason is cheap at this
  // table's scale (one row per template, not per line item) and avoids an
  // N+1 pattern of fetching history separately for every template.
  const [rows] = await pool.execute(
    `SELECT
      t.id, t.module_type, t.template_name, t.party_name, t.status,
      t.currency_id, cur.currency_code AS currencyCode, t.rate_policy, t.fixed_rate,
      t.created_by, t.created_at,
      s.id AS scheduleId, s.frequency, s.start_date, s.end_date,
      s.next_run_date, s.last_run_date, s.generated_count, s.max_occurrences,
      s.is_active, s.is_paused,
      lo.status AS latestOccurrenceStatus, lo.reason AS latestOccurrenceReason
    FROM recurring_transaction_templates t
    LEFT JOIN recurring_transaction_schedules s ON s.template_id = t.id
    LEFT JOIN currencies cur ON cur.id = t.currency_id
    LEFT JOIN recurring_transaction_occurrences lo ON lo.id = (
      SELECT id FROM recurring_transaction_occurrences
      WHERE schedule_id = s.id ORDER BY id DESC LIMIT 1
    )
    ${where}
    ORDER BY t.id DESC`,
    params
  );
  return rows.map((r) => ({
    ...r,
    is_active: !!r.is_active,
    is_paused: !!r.is_paused,
    start_date: normalizeDate(r.start_date),
    end_date: normalizeDate(r.end_date),
    next_run_date: normalizeDate(r.next_run_date),
    last_run_date: normalizeDate(r.last_run_date),
  }));
}

async function getScheduleForUpdate(conn, scheduleId) {
  const [rows] = await conn.execute(
    "SELECT * FROM recurring_transaction_schedules WHERE id = ? FOR UPDATE",
    [scheduleId]
  );
  if (rows.length === 0) throw new HttpError(404, "Recurring schedule not found.");
  return parseScheduleRow(rows[0]);
}

async function setPaused(scheduleId, paused, userId) {
  const [result] = await pool.execute(
    "UPDATE recurring_transaction_schedules SET is_paused = ? WHERE id = ?",
    [paused ? 1 : 0, scheduleId]
  );
  if (result.affectedRows === 0) throw new HttpError(404, "Recurring schedule not found.");
}

// Checkpoint 3F, section 31: resuming a template whose next_run_date fell
// in the past while it was paused must NOT silently generate every missed
// occurrence, and must not silently skip them either - the user decides.
// - No catchUpPolicy + overdue -> resolve() returns a decision request
//   instead of resuming, with an approximate count of missed occurrences.
// - catchUpPolicy: 'SKIP_TO_NEXT' -> record each missed date as a SKIPPED
//   occurrence (audit-visible, same as the existing manual Skip action)
//   and fast-forward next_run_date to the first date on/after today.
// - catchUpPolicy: 'GENERATE_MISSED' (or not overdue at all) -> resume
//   as-is; the scheduler/Generate Now will then generate the missed
//   occurrences one at a time on subsequent ticks, each with its own
//   correct historical rate for that occurrence's own date - this is the
//   existing processSchedule/processDueSchedules behavior, now reached
//   only via an explicit, informed choice rather than as a silent default.
async function resumeSchedule(scheduleId, { catchUpPolicy, userId } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const schedule = await getScheduleForUpdate(conn, scheduleId);
    const today = DateService.toISODate(DateService.toDT(new Date()));
    const isOverdue = !!schedule.next_run_date && schedule.next_run_date < today;

    if (isOverdue && !catchUpPolicy) {
      let missedCount = 0;
      let cursor = schedule.next_run_date;
      while (cursor && cursor < today && missedCount < 60) {
        missedCount++;
        cursor = DateService.computeNextRunDate(schedule, cursor);
      }
      await conn.rollback();
      return { requiresCatchUpDecision: true, nextRunDate: schedule.next_run_date, missedCount };
    }

    if (isOverdue && catchUpPolicy === "SKIP_TO_NEXT") {
      const [templateRows] = await conn.execute("SELECT module_type FROM recurring_transaction_templates WHERE id = ?", [schedule.template_id]);
      const moduleType = templateRows[0]?.module_type || null;

      let cursor = schedule.next_run_date;
      let guard = 0;
      while (cursor && cursor < today && guard < 60) {
        await conn.execute(
          `INSERT IGNORE INTO recurring_transaction_occurrences
            (schedule_id, occurrence_date, generated_module_type, trigger_type, status, reason, generated_by)
           VALUES (?, ?, ?, 'MANUAL', 'SKIPPED', 'Skipped via resume catch-up (SKIP_TO_NEXT)', ?)`,
          [scheduleId, cursor, moduleType, userId]
        );
        cursor = DateService.computeNextRunDate(schedule, cursor);
        guard++;
      }
      await conn.execute("UPDATE recurring_transaction_schedules SET next_run_date = ?, is_paused = 0 WHERE id = ?", [cursor, scheduleId]);
      await conn.commit();
      return { resumed: true, catchUpPolicy: "SKIP_TO_NEXT", newNextRunDate: cursor };
    }

    await conn.execute("UPDATE recurring_transaction_schedules SET is_paused = 0 WHERE id = ?", [scheduleId]);
    await conn.commit();
    return { resumed: true, catchUpPolicy: isOverdue ? "GENERATE_MISSED" : null };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function stopSchedule(scheduleId, userId) {
  const [result] = await pool.execute(
    "UPDATE recurring_transaction_schedules SET is_active = 0, is_paused = 0, completed_at = NOW() WHERE id = ?",
    [scheduleId]
  );
  if (result.affectedRows === 0) throw new HttpError(404, "Recurring schedule not found.");
}

async function recordSkip(scheduleId, occurrenceDate, { reason, userId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const schedule = await getScheduleForUpdate(conn, scheduleId);

    const [templateRows] = await conn.execute(
      "SELECT module_type FROM recurring_transaction_templates WHERE id = ?",
      [schedule.template_id]
    );
    if (templateRows.length === 0) throw new HttpError(404, "Recurring template not found.");
    const moduleType = templateRows[0].module_type;

    const [existing] = await conn.execute(
      "SELECT id FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
      [scheduleId, occurrenceDate]
    );
    if (existing.length > 0) {
      throw new HttpError(409, "This occurrence has already been generated or skipped.");
    }

    await conn.execute(
      `INSERT INTO recurring_transaction_occurrences
        (schedule_id, occurrence_date, generated_module_type, trigger_type, status, reason, generated_by)
       VALUES (?, ?, ?, 'MANUAL', 'SKIPPED', ?, ?)`,
      [scheduleId, occurrenceDate, moduleType, reason || null, userId]
    );

    const nextRunDate = DateService.computeNextRunDate(schedule, occurrenceDate);
    if (nextRunDate) {
      await conn.execute("UPDATE recurring_transaction_schedules SET next_run_date = ? WHERE id = ?", [nextRunDate, scheduleId]);
    } else {
      await conn.execute("UPDATE recurring_transaction_schedules SET is_active = 0, completed_at = NOW() WHERE id = ?", [scheduleId]);
    }

    await conn.commit();
    return { nextRunDate };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Checkpoint 3F, section 27/28: History must show the GENERATED
// transaction's own stored document number/currency/rate/totals - never
// re-resolve a current rate for a past occurrence. voucher_no/currency
// come straight from each module's own header table +
// transaction_currency_snapshots (the same snapshot row generation itself
// wrote with lockNow:false), joined read-only here - nothing is
// recalculated.
//
// Checkpoint 6: generalized from the original invoice-only single JOIN to
// one LEFT JOIN per supported module type, each gated on
// o.generated_module_type so exactly one (or none, for FAILED/SKIPPED/
// PERIOD_CLOSED/RATE_REVIEW_REQUIRED occurrences with no generated row)
// ever matches per occurrence row - COALESCE picks whichever one fired.
// `or_headers` is aliased `ors` since OR is a reserved SQL word. This is
// exactly the "future module type adds its own LEFT JOIN branch" shape
// the original comment anticipated, not a rewritten query structure.
async function getHistory(scheduleId) {
  const [rows] = await pool.execute(
    `SELECT
      o.*,
      COALESCE(inv.voucher_no, apv.voucher_no, jv.voucher_no, po.voucher_no, ors.voucher_no, cv.voucher_no) AS documentNumber,
      COALESCE(inv.status, apv.status, jv.status, po.status, ors.status, cv.status) AS documentStatus,
      snap.currency_code AS currencyCode,
      snap.exchange_rate AS exchangeRate,
      snap.rate_date AS rateEffectiveDate,
      snap.rate_source AS rateSource,
      snap.foreign_total AS foreignTotal,
      snap.base_total AS baseTotal
    FROM recurring_transaction_occurrences o
    LEFT JOIN invoice_headers inv ON o.generated_module_type = 'invoice' AND inv.id = o.generated_transaction_id
    LEFT JOIN apv_headers apv ON o.generated_module_type = 'apv' AND apv.id = o.generated_transaction_id
    LEFT JOIN jv_headers jv ON o.generated_module_type = 'jv' AND jv.id = o.generated_transaction_id
    LEFT JOIN purchase_order_headers po ON o.generated_module_type = 'po' AND po.id = o.generated_transaction_id
    LEFT JOIN or_headers ors ON o.generated_module_type = 'or' AND ors.id = o.generated_transaction_id
    LEFT JOIN cv_headers cv ON o.generated_module_type = 'cv' AND cv.id = o.generated_transaction_id
    LEFT JOIN transaction_currency_snapshots snap
      ON snap.transaction_type = (CASE o.generated_module_type WHEN 'invoice' THEN 'INV' ELSE UPPER(o.generated_module_type) END)
     AND snap.transaction_id = o.generated_transaction_id
    WHERE o.schedule_id = ?
    ORDER BY o.id DESC`,
    [scheduleId]
  );
  return rows.map((r) => ({
    ...r,
    occurrence_date: normalizeDate(r.occurrence_date),
    rateEffectiveDate: r.rateEffectiveDate ? normalizeDate(r.rateEffectiveDate) : null,
    exchangeRate: r.exchangeRate == null ? null : Number(r.exchangeRate),
    foreignTotal: r.foreignTotal == null ? null : Number(r.foreignTotal),
    baseTotal: r.baseTotal == null ? null : Number(r.baseTotal),
  }));
}

module.exports = {
  createTemplateFromTransaction,
  createTemplate,
  getTemplateById,
  listTemplates,
  getScheduleForUpdate,
  setPaused,
  resumeSchedule,
  stopSchedule,
  recordSkip,
  getHistory,
  parseJsonColumn,
};
