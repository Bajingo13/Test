const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const DateService = require("./recurringDateService");
const ValidationService = require("./recurringValidationService");
const NumberingService = require("./recurringNumberingService");
const TemplateService = require("./recurringTemplateService");

// Per-module insert shape, mirroring the exact column list the existing
// manual POST handlers use in server.js (invoice: server.js ~1034-1100).
// Replicated as new, independent code rather than calling into
// server.js's route handlers - those aren't structured as callable
// functions today, and refactoring them is bigger/riskier surgery than
// this phase needs for zero net benefit (see plan).
const GENERATION_MODULE_CONFIG = {
  invoice: {
    headerTable: "invoice_headers",
    lineTable: "invoice_lines",
    lineIdCol: "invoice_id",
    hasDueDate: true,
    buildHeaderInsert: ({ voucherNo, partyId, partyName, transactionDate, dueDate, referenceNo, description, remarks, totalDebit, totalCredit }) => ({
      sql: `INSERT INTO invoice_headers (
        voucher_no, customer_id, customer_name, transaction_date, due_date, reference_no,
        description, remarks, total_debit, total_credit, paid_amount, balance_amount,
        payment_status, status, invoice_type, recurrence_frequency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', 'Draft', 'Standard', NULL)`,
      params: [voucherNo, partyId || null, partyName || "", transactionDate, dueDate, referenceNo || "", description || "", remarks || "", totalDebit, totalCredit, totalDebit],
    }),
  },
};

function substituteVariables(template, ctx) {
  if (!template) return "";
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key]) : match;
  });
}

function buildVariableContext(occurrenceDateISO, party, sequenceNumber) {
  const dt = DateService.toDT(occurrenceDateISO);
  return {
    transaction_date: dt.toFormat("yyyy-LL-dd"),
    month_name: dt.toFormat("LLLL"),
    month_number: String(dt.month),
    year: String(dt.year),
    period_start: dt.startOf("month").toFormat("yyyy-LL-dd"),
    period_end: dt.endOf("month").toFormat("yyyy-LL-dd"),
    customer_name: party?.partyName || "",
    supplier_name: party?.partyName || "",
    sequence_number: String(sequenceNumber),
  };
}

// Computes each line's generation-time amount per the template's
// amount_mode. All lines are scaled by the same factor, so debit/credit
// balance is preserved automatically regardless of mode.
async function computeLineAmounts(conn, template, lines, occurrenceCount) {
  const mode = template.amount_mode || "FIXED";
  const config = template.amount_config || {};

  if (mode === "COPY_LAST") {
    // Fall back to the template's own (FIXED) amounts for the very first
    // occurrence, since there's no prior generated transaction yet.
    if (occurrenceCount === 0) return lines;
    const cfg = GENERATION_MODULE_CONFIG[template.module_type];
    const [lastOccurrence] = await conn.execute(
      `SELECT generated_transaction_id FROM recurring_transaction_occurrences
       WHERE schedule_id = (SELECT id FROM recurring_transaction_schedules WHERE template_id = ?)
         AND status = 'SUCCESS'
       ORDER BY id DESC LIMIT 1`,
      [template.id]
    );
    if (!lastOccurrence.length || !cfg) return lines;
    const [priorLines] = await conn.execute(
      `SELECT account_id, debit, credit FROM ${cfg.lineTable} WHERE ${cfg.lineIdCol} = ? ORDER BY id ASC`,
      [lastOccurrence[0].generated_transaction_id]
    );
    if (priorLines.length !== lines.length) return lines; // shape drifted, fall back safely
    return lines.map((l, idx) => ({ ...l, debit: Number(priorLines[idx].debit) || 0, credit: Number(priorLines[idx].credit) || 0 }));
  }

  if (mode === "PERCENTAGE_ADJUSTMENT") {
    const effectiveAfter = Number(config.effectiveAfterOccurrence) || 0;
    const percent = Number(config.percent) || 0;
    if (occurrenceCount < effectiveAfter) return lines;
    const factor = 1 + percent / 100;
    return lines.map((l) => ({ ...l, debit: round2(l.debit * factor), credit: round2(l.credit * factor) }));
  }

  if (mode === "ESCALATION") {
    const escalations = Array.isArray(config.escalations) ? config.escalations : [];
    return lines; // resolved by occurrence date in generateOccurrenceLines(), see caller
  }

  // FIXED, MANUAL_REVIEW: use the template amounts as-is (MANUAL_REVIEW
  // only differs by flagging the generated header for human review, see
  // description handling in processSchedule).
  return lines;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function applyEscalation(lines, config, occurrenceDateISO) {
  const escalations = Array.isArray(config.escalations) ? config.escalations : [];
  const applicable = escalations
    .filter((e) => e.effectiveDate && e.effectiveDate <= occurrenceDateISO)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1))[0];
  if (!applicable) return lines;
  const factor = 1 + (Number(applicable.percent) || 0) / 100;
  return lines.map((l) => ({ ...l, debit: round2(l.debit * factor), credit: round2(l.credit * factor) }));
}

// The single, safe, idempotent core - called by "Generate Now" (Phase 1),
// and later by the scheduler job / Railway Cron endpoint (Phase 4). One
// code path, not duplicated per trigger source.
async function processSchedule(scheduleId, { triggerType = "MANUAL", userId = null } = {}) {
  const conn = await pool.getConnection();
  let occurrenceDate = null;
  let moduleType = null;

  try {
    await conn.beginTransaction();

    // 1. Lock the schedule row - serializes concurrent attempts at this schedule.
    const schedule = await TemplateService.getScheduleForUpdate(conn, scheduleId);

    // 3. Validate schedule is active.
    if (!schedule.is_active) throw new HttpError(409, "This recurring schedule is not active.");
    if (schedule.is_paused) throw new HttpError(409, "This recurring schedule is paused.");

    if (!schedule.next_run_date) throw new HttpError(409, "This schedule has no due occurrence.");
    // Normalize to a clean ISO string immediately - mysql2 returns DATE
    // columns as JS Date objects, and leaving one to flow through inserts/
    // JSON responses risks a UTC-shift display bug (see recurringDateService.toDT).
    occurrenceDate = DateService.toISODate(DateService.toDT(schedule.next_run_date));

    const [templateRows] = await conn.execute("SELECT * FROM recurring_transaction_templates WHERE id = ? FOR UPDATE", [schedule.template_id]);
    if (templateRows.length === 0) throw new HttpError(404, "Recurring template not found.");
    const template = templateRows[0];
    template.amount_config = TemplateService.parseJsonColumn(template.amount_config, {});
    template.due_date_rule = TemplateService.parseJsonColumn(template.due_date_rule, {});
    moduleType = template.module_type;

    if (template.status !== "ACTIVE") throw new HttpError(409, "This recurring template is not active.");

    const genCfg = GENERATION_MODULE_CONFIG[moduleType];
    if (!genCfg) throw new HttpError(400, `Generation isn't implemented yet for module type: ${moduleType}`);

    // 2. Check whether the occurrence was already generated (defensive
    // check - the UNIQUE(schedule_id, occurrence_date) constraint is the
    // authoritative backstop below).
    const [existing] = await conn.execute(
      "SELECT id, status FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
      [scheduleId, occurrenceDate]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return { status: "ALREADY_GENERATED", occurrenceDate, occurrenceId: existing[0].id };
    }

    const [lineRows] = await conn.execute(
      "SELECT * FROM recurring_transaction_template_lines WHERE template_id = ? ORDER BY sort_order ASC",
      [template.id]
    );
    if (lineRows.length === 0) throw new HttpError(422, "This template has no lines.");

    // 4-7. Revalidate all master data fresh (party active, accounts exist, balanced).
    await ValidationService.revalidateForGeneration(conn, {
      moduleType,
      partyId: template.party_id,
      lines: lineRows,
    });

    // Compute this occurrence's line amounts per amount_mode.
    let computedLines = await computeLineAmounts(conn, template, lineRows, schedule.generated_count);
    if (template.amount_mode === "ESCALATION") {
      computedLines = applyEscalation(computedLines, template.amount_config, occurrenceDate);
    }

    const totalDebit = computedLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = computedLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) >= 0.01) {
      throw new HttpError(422, "Computed amounts for this occurrence are not balanced.");
    }

    const ctx = buildVariableContext(occurrenceDate, template, schedule.generated_count + 1);
    let description = substituteVariables(template.description_template, ctx);
    if (template.amount_mode === "MANUAL_REVIEW") {
      description = `[REVIEW REQUIRED] ${description}`.trim();
    }

    const dueDate = genCfg.hasDueDate ? DateService.computeDueDate(occurrenceDate, template.due_date_rule) : null;

    // 9. Generate the transaction number (atomic, scoped to recurring generation only).
    const voucherNo = await NumberingService.generateVoucherNumber(conn, moduleType, occurrenceDate);

    // 8/10/11. Insert the generated header.
    const { sql, params } = genCfg.buildHeaderInsert({
      voucherNo,
      partyId: template.party_id,
      partyName: template.party_name,
      transactionDate: occurrenceDate,
      dueDate,
      referenceNo: voucherNo,
      description,
      remarks: `Auto-generated from recurring template #${template.id}`,
      totalDebit,
      totalCredit,
    });
    const [headerResult] = await conn.execute(sql, params);
    const generatedId = headerResult.insertId;

    for (const line of computedLines) {
      const particulars = substituteVariables(line.particulars_template, ctx);
      await conn.execute(
        `INSERT INTO ${genCfg.lineTable} (${genCfg.lineIdCol}, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, line.account_id, line.account_code || "", line.account_title || "", particulars || "", Number(line.debit) || 0, Number(line.credit) || 0, line.gen_ref || "", line.gen_name || ""]
      );
    }

    // 14. Save the occurrence record (DB-backstop UNIQUE constraint lives here).
    const [occurrenceResult] = await conn.execute(
      `INSERT INTO recurring_transaction_occurrences
        (schedule_id, occurrence_date, generated_module_type, generated_transaction_id, trigger_type, status, generated_by)
       VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`,
      [scheduleId, occurrenceDate, moduleType, generatedId, triggerType, userId]
    );

    // 15. Advance the schedule.
    const newGeneratedCount = schedule.generated_count + 1;
    const nextRunDate = DateService.computeNextRunDate({ ...schedule, generated_count: newGeneratedCount }, occurrenceDate);

    if (nextRunDate) {
      await conn.execute(
        "UPDATE recurring_transaction_schedules SET generated_count = ?, last_run_date = ?, next_run_date = ? WHERE id = ?",
        [newGeneratedCount, occurrenceDate, nextRunDate, scheduleId]
      );
    } else {
      await conn.execute(
        "UPDATE recurring_transaction_schedules SET generated_count = ?, last_run_date = ?, next_run_date = ?, is_active = 0, completed_at = NOW() WHERE id = ?",
        [newGeneratedCount, occurrenceDate, occurrenceDate, scheduleId]
      );
    }

    // 16. Audit log (within the same transaction - a logging failure rolls back the generation, per lib/audit.js's own convention).
    await logAudit(conn, {
      module: "RECURRING.TRANSACTIONS",
      entityType: moduleType.toUpperCase(),
      entityId: generatedId,
      action: "OCCURRENCE_GENERATED",
      description: `Generated ${moduleType.toUpperCase()} ${voucherNo} from recurring template #${template.id} for ${occurrenceDate} (trigger=${triggerType})`,
      afterData: { scheduleId, occurrenceDate, generatedId, voucherNo },
      user: userId ? { id: userId } : null,
    });

    await conn.commit();
    return { status: "SUCCESS", occurrenceDate, generatedId, voucherNo, nextRunDate, occurrenceId: occurrenceResult.insertId };
  } catch (err) {
    await conn.rollback();

    // Record the failure in its own short transaction (the main one just
    // rolled back) - never leave a partial header/lines pair, always know why it failed.
    if (occurrenceDate) {
      try {
        await pool.execute(
          `INSERT IGNORE INTO recurring_transaction_occurrences
            (schedule_id, occurrence_date, generated_module_type, trigger_type, status, error_message, generated_by)
           VALUES (?, ?, ?, ?, 'FAILED', ?, ?)`,
          [scheduleId, occurrenceDate, moduleType || "unknown", triggerType, safeErrorMessage(err), userId]
        );
        await logAudit(pool, {
          module: "RECURRING.TRANSACTIONS",
          entityType: "RECURRING_SCHEDULE",
          entityId: scheduleId,
          action: "OCCURRENCE_FAILED",
          description: `Failed to generate occurrence for ${occurrenceDate} (trigger=${triggerType}): ${safeErrorMessage(err)}`,
          user: userId ? { id: userId } : null,
        });
      } catch (loggingErr) {
        console.error("RECURRING GENERATION - FAILED TO RECORD FAILURE:", loggingErr);
      }
    }

    if (err instanceof HttpError) throw err;
    console.error("RECURRING GENERATION ERROR:", err);
    throw new HttpError(500, "Failed to generate the recurring transaction.");
  } finally {
    conn.release();
  }
}

function safeErrorMessage(err) {
  if (err instanceof HttpError) return err.message;
  return "An unexpected error occurred during generation.";
}

// Batch entry point for the future scheduler (Phase 4) - processes every
// currently-due, active, unpaused schedule, each in its own transaction so
// one failure doesn't affect the others.
async function processDueSchedules({ triggerType = "SCHEDULED", limit = 50 } = {}) {
  const [due] = await pool.execute(
    `SELECT id FROM recurring_transaction_schedules
     WHERE is_active = 1 AND is_paused = 0 AND next_run_date <= CURDATE()
     ORDER BY next_run_date ASC LIMIT ?`,
    [limit]
  );

  const results = [];
  for (const row of due) {
    try {
      const result = await processSchedule(row.id, { triggerType });
      results.push({ scheduleId: row.id, ...result });
    } catch (err) {
      results.push({ scheduleId: row.id, status: "FAILED", error: safeErrorMessage(err) });
    }
  }

  return {
    processed: results.length,
    succeeded: results.filter((r) => r.status === "SUCCESS").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    alreadyGenerated: results.filter((r) => r.status === "ALREADY_GENERATED").length,
    results,
  };
}

module.exports = { processSchedule, processDueSchedules };
