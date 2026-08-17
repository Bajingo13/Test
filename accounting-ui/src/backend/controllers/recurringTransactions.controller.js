const pool = require("../db");
const { logAudit, requestMeta } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const TemplateService = require("../services/recurringTemplateService");
const GenerationService = require("../services/recurringGenerationService");
const DateService = require("../services/recurringDateService");
const CurrencyService = require("../services/currencyService");

// Checkpoint 3F: Railway Cron Job entry point - see routes.js comment.
// Not gated by authenticateToken (no interactive user); gated instead by
// a shared secret configured out-of-band. Calls the exact same
// processDueSchedules() the in-process cron and "Generate Now" both use.
exports.runDue = async (req, res) => {
  const configuredSecret = process.env.RECURRING_CRON_SECRET;
  if (!configuredSecret) {
    return res.status(404).json({ message: "Not found." });
  }
  if (req.headers["x-cron-secret"] !== configuredSecret) {
    return res.status(401).json({ message: "Unauthorized." });
  }
  try {
    const result = await GenerationService.processDueSchedules({ triggerType: "SCHEDULED" });
    res.json(result);
  } catch (err) {
    console.error("RUN-DUE ERROR:", err);
    res.status(500).json({ message: "Failed to process due recurring schedules." });
  }
};

// Templates and schedules are 1:1 in Phase 1 - the external API surface
// only exposes the template id (:id), this resolves the associated
// schedule id internally so callers never need to know two ids exist.
// Joins through the template to verify company ownership before handing
// back a schedule id - every caller below acts on that id without a
// second ownership check, so this is the one place isolation must hold.
async function resolveScheduleId(templateId, companyId) {
  const [rows] = await pool.execute(
    `SELECT s.id FROM recurring_transaction_schedules s
     JOIN recurring_transaction_templates t ON t.id = s.template_id
     WHERE s.template_id = ? AND t.company_id = ?`,
    [templateId, companyId]
  );
  if (rows.length === 0) throw new HttpError(404, "Recurring schedule not found for this template.");
  return rows[0].id;
}

exports.createFromTransaction = async (req, res) => {
  try {
    const { moduleType, id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const bootstrap = await TemplateService.createTemplateFromTransaction(moduleType, id, req.user.id, companyId);
    res.json(bootstrap);
  } catch (err) {
    console.error("CREATE RECURRING FROM TRANSACTION ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to prepare recurring template." });
  }
};

exports.create = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const result = await TemplateService.createTemplate(req.body, req.user.id, companyId);

    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS",
      entityType: "RECURRING_TEMPLATE",
      entityId: result.templateId,
      action: "TEMPLATE_CREATED",
      description: `Recurring template #${result.templateId} created for ${req.body.moduleType} (${req.body.templateName})`,
      afterData: { moduleType: req.body.moduleType, templateName: req.body.templateName, schedule: req.body.schedule },
      user: req.user,
      ...requestMeta(req),
    });

    res.status(201).json(result);
  } catch (err) {
    console.error("CREATE RECURRING TEMPLATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to create recurring template." });
  }
};

exports.list = async (req, res) => {
  try {
    const { moduleType, status } = req.query;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const rows = await TemplateService.listTemplates({ moduleType, status, companyId });
    res.json(rows);
  } catch (err) {
    console.error("LIST RECURRING TEMPLATES ERROR:", err);
    res.status(500).json({ message: "Failed to load recurring templates." });
  }
};

exports.getOne = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const result = await TemplateService.getTemplateById(req.params.id, companyId);
    res.json(result);
  } catch (err) {
    console.error("GET RECURRING TEMPLATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load recurring template." });
  }
};

// Phase 1 keeps this deliberately minimal - only template-level display
// fields (not lines/schedule, which per the spec's own EDITING RULES need
// versioning/next-occurrence warnings before they're safe to change; full
// editing workflow is Phase 2).
exports.update = async (req, res) => {
  try {
    const { templateName, descriptionTemplate, amountMode, amountConfig, dueDateRule } = req.body;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);
    const [result] = await pool.execute(
      `UPDATE recurring_transaction_templates
       SET template_name = COALESCE(?, template_name),
           description_template = COALESCE(?, description_template),
           amount_mode = COALESCE(?, amount_mode),
           amount_config = COALESCE(?, amount_config),
           due_date_rule = COALESCE(?, due_date_rule),
           updated_by = ?
       WHERE id = ? AND company_id = ?`,
      [
        templateName || null, descriptionTemplate || null, amountMode || null,
        amountConfig ? JSON.stringify(amountConfig) : null,
        dueDateRule ? JSON.stringify(dueDateRule) : null,
        req.user.id, req.params.id, companyId,
      ]
    );
    if (result.affectedRows === 0) throw new HttpError(404, "Recurring template not found.");

    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS",
      entityType: "RECURRING_TEMPLATE",
      entityId: Number(req.params.id),
      action: "TEMPLATE_EDITED",
      description: `Recurring template #${req.params.id} edited`,
      afterData: req.body,
      user: req.user,
      ...requestMeta(req),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE RECURRING TEMPLATE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update recurring template." });
  }
};

exports.pause = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    await TemplateService.setPaused(scheduleId, true, req.user.id);
    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS", entityType: "RECURRING_TEMPLATE", entityId: Number(req.params.id),
      action: "TEMPLATE_PAUSED", description: `Recurring template #${req.params.id} paused`,
      user: req.user, ...requestMeta(req),
    });
    res.json({ success: true });
  } catch (err) {
    console.error("PAUSE RECURRING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to pause recurring schedule." });
  }
};

exports.resume = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    const { catchUpPolicy } = req.body || {};
    const result = await TemplateService.resumeSchedule(scheduleId, { catchUpPolicy: catchUpPolicy || null, userId: req.user.id });

    if (result.requiresCatchUpDecision) {
      // Not resumed yet - the frontend must ask the user SKIP_TO_NEXT vs
      // GENERATE_MISSED and call this endpoint again with that choice.
      return res.status(409).json({ ...result, message: "This schedule is overdue. Choose how to catch up before resuming." });
    }

    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS", entityType: "RECURRING_TEMPLATE", entityId: Number(req.params.id),
      action: "TEMPLATE_RESUMED", description: `Recurring template #${req.params.id} resumed${result.catchUpPolicy ? ` (catch-up: ${result.catchUpPolicy})` : ""}`,
      afterData: { catchUpPolicy: result.catchUpPolicy || null, newNextRunDate: result.newNextRunDate || null },
      user: req.user, ...requestMeta(req),
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("RESUME RECURRING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to resume recurring schedule." });
  }
};

exports.stop = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    await TemplateService.stopSchedule(scheduleId, req.user.id);
    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS", entityType: "RECURRING_TEMPLATE", entityId: Number(req.params.id),
      action: "TEMPLATE_STOPPED", description: `Recurring template #${req.params.id} stopped`,
      user: req.user, ...requestMeta(req),
    });
    res.json({ success: true });
  } catch (err) {
    console.error("STOP RECURRING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to stop recurring schedule." });
  }
};

// "Generate Now" - uses the exact same processSchedule() the future
// scheduler will call. Requires confirmation client-side (the request
// itself IS the confirmation); records who triggered it via trigger_type=MANUAL + generated_by.
exports.generate = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    // approvedRate: section 25's manual-review workflow - a human supplies
    // the rate to approve for THIS occurrence only, never persisted onto
    // the template itself.
    const { approvedRate } = req.body || {};
    const result = await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId: req.user.id, approvedRate: approvedRate ?? null });
    res.json(result);
  } catch (err) {
    console.error("GENERATE RECURRING ERROR:", err);
    // reasonCode (NO_APPROVED_RATE / CURRENCY_INACTIVE / ...) lets the
    // frontend distinguish "show a Review Rate action" from a generic
    // error, without parsing the message string.
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to generate the recurring transaction.", reasonCode: err.reasonCode || null });
  }
};

exports.skip = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    const [scheduleRows] = await pool.execute("SELECT next_run_date FROM recurring_transaction_schedules WHERE id = ?", [scheduleId]);
    if (scheduleRows.length === 0) throw new HttpError(404, "Recurring schedule not found.");
    const occurrenceDate = DateService.toISODate(DateService.toDT(scheduleRows[0].next_run_date));

    const { reason } = req.body || {};
    const result = await TemplateService.recordSkip(scheduleId, occurrenceDate, { reason, userId: req.user.id });

    await logAudit(pool, {
      module: "RECURRING.TRANSACTIONS", entityType: "RECURRING_TEMPLATE", entityId: Number(req.params.id),
      action: "OCCURRENCE_SKIPPED", description: `Occurrence ${occurrenceDate} skipped for recurring template #${req.params.id}: ${reason || "(no reason given)"}`,
      user: req.user, ...requestMeta(req),
    });

    res.json({ success: true, skippedDate: occurrenceDate, ...result });
  } catch (err) {
    console.error("SKIP RECURRING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to skip occurrence." });
  }
};

exports.history = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const scheduleId = await resolveScheduleId(req.params.id, companyId);
    const rows = await TemplateService.getHistory(scheduleId);
    res.json(rows);
  } catch (err) {
    console.error("RECURRING HISTORY ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to load history." });
  }
};

// Stateless dry-run preview for the "create template" form, before a
// schedule row exists to look up - reuses the exact same pure date-calc
// functions as the saved-template preview below, just fed a
// not-yet-saved schedule config directly instead of loading one from the
// DB. No DB writes.
exports.previewSchedule = async (req, res) => {
  try {
    const schedule = req.body || {};
    if (!schedule.frequency || !schedule.startDate) {
      throw new HttpError(400, "frequency and startDate are required to preview a schedule.");
    }
    const count = Math.min(Number(req.query.count) || 5, 24);
    const dates = DateService.previewOccurrences(
      {
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
      },
      count
    );
    res.json({ dates });
  } catch (err) {
    console.error("PREVIEW SCHEDULE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to preview schedule." });
  }
};

exports.preview = async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const { template, lines, schedule } = await TemplateService.getTemplateById(req.params.id, companyId);
    if (!schedule) throw new HttpError(404, "Recurring schedule not found.");
    const count = Math.min(Number(req.query.count) || 5, 24);
    const dates = DateService.previewOccurrences(schedule, count);

    // Section 36: "Preview Next Transaction" - shows the CURRENT available
    // rate for display only, clearly labeled as subject to change unless
    // FIXED_RATE. Never resolves/writes anything - a plain read.
    let currencyPreview = null;
    if (template.currency_id) {
      const foreignTotal = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0) || lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      const [currencyRows] = await pool.execute("SELECT currency_code AS currencyCode FROM currencies WHERE id = ?", [template.currency_id]);
      const currencyCode = currencyRows[0]?.currencyCode || null;

      if (template.rate_policy === "FIXED_RATE") {
        currencyPreview = {
          currencyCode, ratePolicy: "FIXED_RATE", rate: Number(template.fixed_rate), rateWillChange: false,
          foreignTotal, estimatedBaseAmount: Math.round(foreignTotal * Number(template.fixed_rate) * 100) / 100,
        };
      } else if (template.rate_policy === "MANUAL_REVIEW") {
        currencyPreview = { currencyCode, ratePolicy: "MANUAL_REVIEW", rate: null, rateWillChange: true, foreignTotal, estimatedBaseAmount: null };
      } else {
        try {
          const Resolver = require("../services/exchangeRateResolverService");
          const CurrencyService = require("../services/currencyService");
          const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, template.company_id);
          const resolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: template.currency_id, transactionDate: dates[0] || new Date().toISOString().slice(0, 10) });
          currencyPreview = {
            currencyCode, ratePolicy: "RESOLVE_ON_GENERATION", rate: resolved.rate, rateEffectiveDate: resolved.effectiveDate,
            rateWillChange: true, foreignTotal,
            estimatedBaseAmount: resolved.rate != null ? Math.round(foreignTotal * resolved.rate * 100) / 100 : null,
          };
        } catch {
          currencyPreview = { currencyCode, ratePolicy: "RESOLVE_ON_GENERATION", rate: null, rateWillChange: true, foreignTotal, estimatedBaseAmount: null };
        }
      }
    }

    res.json({ dates, currencyPreview, moduleType: template.module_type, isPaused: !!schedule.is_paused });
  } catch (err) {
    console.error("PREVIEW RECURRING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to preview occurrences." });
  }
};
