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
};

async function createTemplateFromTransaction(moduleType, transactionId, userId) {
  const cfg = SOURCE_MODULE_CONFIG[moduleType];
  if (!cfg) throw new HttpError(400, `Recurring templates from an existing transaction aren't supported yet for: ${moduleType}`);

  const [headers] = await pool.execute(
    `SELECT ${cfg.partyIdCol} AS partyId, ${cfg.partyNameCol} AS partyName, description
     FROM ${cfg.headerTable} WHERE id = ?`,
    [transactionId]
  );
  if (headers.length === 0) throw new HttpError(404, "Source transaction not found.");
  const header = headers[0];

  const [lineRows] = await pool.execute(
    `SELECT account_id AS accountId, account_code AS accountCode, account_title AS accountTitle,
      particulars, debit, credit, gen_ref AS genRef, gen_name AS genName
     FROM ${cfg.lineTable} WHERE ${cfg.lineIdCol} = ? ORDER BY id ASC`,
    [transactionId]
  );

  return {
    moduleType,
    partyId: header.partyId,
    partyName: header.partyName,
    descriptionTemplate: header.description || "",
    lines: lineRows.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountTitle: l.accountTitle,
      particularsTemplate: l.particulars,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      genRef: l.genRef,
      genName: l.genName,
    })),
  };
}

async function createTemplate(input, userId) {
  const { moduleType, templateName, partyId, partyName, descriptionTemplate, currency, amountMode, amountConfig, dueDateRule, lines, schedule } = input;

  ValidationService.validateTemplateInput({
    moduleType,
    templateName,
    partyId,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    schedule,
  });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [templateResult] = await conn.execute(
      `INSERT INTO recurring_transaction_templates
        (module_type, template_name, party_id, party_name, description_template, currency, amount_mode, amount_config, due_date_rule, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [
        moduleType, templateName, partyId || null, partyName || null, descriptionTemplate || null,
        currency || "PHP", amountMode || "FIXED", JSON.stringify(amountConfig || {}),
        JSON.stringify(dueDateRule || { mode: "SAME_AS_TRANSACTION_DATE" }),
        userId, userId,
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

async function getTemplateById(id) {
  const [templates] = await pool.execute("SELECT * FROM recurring_transaction_templates WHERE id = ?", [id]);
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

async function listTemplates({ moduleType, status } = {}) {
  const params = [];
  let where = "WHERE 1=1";
  if (moduleType) {
    where += " AND t.module_type = ?";
    params.push(moduleType);
  }
  if (status) {
    where += " AND t.status = ?";
    params.push(status);
  }

  const [rows] = await pool.execute(
    `SELECT
      t.id, t.module_type, t.template_name, t.party_name, t.status,
      t.created_by, t.created_at,
      s.id AS scheduleId, s.frequency, s.start_date, s.end_date,
      s.next_run_date, s.last_run_date, s.generated_count, s.max_occurrences,
      s.is_active, s.is_paused
    FROM recurring_transaction_templates t
    LEFT JOIN recurring_transaction_schedules s ON s.template_id = t.id
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

async function getHistory(scheduleId) {
  const [rows] = await pool.execute(
    "SELECT * FROM recurring_transaction_occurrences WHERE schedule_id = ? ORDER BY id DESC",
    [scheduleId]
  );
  return rows.map((r) => ({ ...r, occurrence_date: normalizeDate(r.occurrence_date) }));
}

module.exports = {
  createTemplateFromTransaction,
  createTemplate,
  getTemplateById,
  listTemplates,
  getScheduleForUpdate,
  setPaused,
  stopSchedule,
  recordSkip,
  getHistory,
  parseJsonColumn,
};
