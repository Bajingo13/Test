const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const DateService = require("./recurringDateService");
const ValidationService = require("./recurringValidationService");
const NumberingService = require("./recurringNumberingService");
const TemplateService = require("./recurringTemplateService");
const Resolver = require("./exchangeRateResolverService");
const TransactionCurrencyService = require("./transactionCurrencyService");
const AccountingPeriodService = require("./accountingPeriodService");

// Per-module insert shape, mirroring the exact column list the existing
// manual POST handlers use in server.js (invoice: server.js ~1034-1100).
// Replicated as new, independent code rather than calling into
// server.js's route handlers - those aren't structured as callable
// functions today, and refactoring them is bigger/riskier surgery than
// this phase needs for zero net benefit (see plan).
//
// Checkpoint 3D: totalDebit/totalCredit here are BASE-currency (already
// converted by the caller) - foreignBalance seeds foreign_balance_amount
// exactly like a manually-created foreign invoice does.
// Checkpoint 6 (cross-module generalization): apv/jv/po/or/cv entries added
// below, same shape as invoice's own entry - column lists copied verbatim
// from each module's real manual POST /api/... handler in server.js so the
// generated row is structurally identical to a manually-created one.
//
// Deliberate, audited omission across ALL FIVE new entries: none of them
// set atc_code/tax_type/tax_rate/tax_withheld_amount/taxable_base (EWT
// header-annotation columns), even though apv_headers/or_headers/
// cv_headers/purchase_order_headers all have them. This exactly mirrors
// the EXISTING, already-shipped, already-tested invoice entry above, which
// has never set them either - invoice_headers has the same columns and
// GENERATION_MODULE_CONFIG.invoice.buildHeaderInsert has never touched
// them. The underlying GL amounts are NOT lost: any VAT/EWT-bearing line
// (e.g. "Output VAT Payable", "Withholding Tax Payable") is a normal
// template line and is copied/generated exactly like every other line -
// only the header-level ATC-code/rate ANNOTATION used for BIR-form
// reporting UI is not recomputed automatically. A user can add it back
// when reviewing the Draft, exactly as they would for a manually-typed
// entry missing that annotation. Recomputing it automatically would mean
// either duplicating resolveTaxWithholding's math in a second place (drift
// risk) or refactoring server.js's inline function into a shared module
// neither of which the approved plan asked for - "preserve existing
// Invoice behavior" was read as license to extend the SAME preserved
// pattern, not to add a new capability invoice doesn't have.
const GENERATION_MODULE_CONFIG = {
  invoice: {
    headerTable: "invoice_headers",
    lineTable: "invoice_lines",
    lineIdCol: "invoice_id",
    hasDueDate: true,
    buildHeaderInsert: ({ companyId, voucherNo, partyId, partyName, transactionDate, dueDate, referenceNo, description, remarks, totalDebit, totalCredit, currencyId, isForeign, foreignBalance }) => ({
      sql: `INSERT INTO invoice_headers (
        company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, reference_no,
        description, remarks, total_debit, total_credit, paid_amount, balance_amount,
        payment_status, status, invoice_type, recurrence_frequency, currency_id,
        foreign_paid_amount, foreign_balance_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', 'Draft', 'Standard', NULL, ?, ?, ?)`,
      params: [companyId, voucherNo, partyId || null, partyName || "", transactionDate, dueDate, referenceNo || "", description || "", remarks || "", totalDebit, totalCredit, totalDebit, currencyId, isForeign ? 0 : null, isForeign ? foreignBalance : null],
    }),
  },
  apv: {
    headerTable: "apv_headers",
    lineTable: "apv_lines",
    lineIdCol: "apv_id",
    hasDueDate: true,
    buildHeaderInsert: ({ companyId, voucherNo, partyId, partyName, transactionDate, dueDate, referenceNo, description, remarks, totalDebit, totalCredit, currencyId }) => ({
      sql: `INSERT INTO apv_headers (
        company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, reference_no,
        description, remarks, total_debit, total_credit, paid_amount, balance_amount,
        payment_status, status, source_po_id, currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Unpaid', 'Draft', NULL, ?)`,
      // balance_amount tracks total_credit (the AP liability side) - the
      // manual POST /api/apv route uses currencyResult.baseTotalCredit
      // here, not baseTotalDebit like Invoice's AR-side balance_amount.
      params: [companyId, voucherNo, partyId || null, partyName || "", transactionDate, dueDate, referenceNo || "", description || "", remarks || "", totalDebit, totalCredit, totalCredit, currencyId],
    }),
  },
  jv: {
    headerTable: "jv_headers",
    lineTable: "jv_lines",
    lineIdCol: "jv_id",
    hasDueDate: false,
    // No party: JV's own manual route uses free-text `prepared_for`
    // (supplierName || customerName || req.body.preparedFor), never a
    // party_id FK - the template's party_name (optional, per
    // MODULES_WITHOUT_PARTY) is reused the same way here.
    buildHeaderInsert: ({ companyId, voucherNo, partyName, transactionDate, referenceNo, description, remarks, totalDebit, totalCredit, currencyId }) => ({
      sql: `INSERT INTO jv_headers (
        company_id, voucher_no, transaction_date, reference_no, prepared_for,
        description, remarks, total_debit, total_credit, status, currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
      params: [companyId, voucherNo, transactionDate, referenceNo || "", partyName || "", description || "", remarks || "", totalDebit, totalCredit, currencyId],
    }),
  },
  po: {
    headerTable: "purchase_order_headers",
    lineTable: "purchase_order_lines",
    lineIdCol: "po_id",
    hasDueDate: false,
    // PO never posts to GL (server.js's own comment on POST /api/purchase-
    // orders: "PO never posts to GL - confirmed non-GL, absent from every
    // ledger/trial-balance union"). Status is hardcoded 'Draft' here
    // (never the manual route's default 'Open') exactly per the approved
    // plan - a generated PO is a commitment placeholder to review, not an
    // already-issued order.
    buildHeaderInsert: ({ companyId, voucherNo, partyId, partyName, transactionDate, referenceNo, description, remarks, totalDebit, totalCredit, currencyId }) => ({
      sql: `INSERT INTO purchase_order_headers (
        company_id, voucher_no, supplier_id, supplier_name, transaction_date, reference_no,
        description, remarks, total_debit, total_credit, status, currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
      params: [companyId, voucherNo, partyId || null, partyName || "", transactionDate, referenceNo || "", description || "", remarks || "", totalDebit, totalCredit, currencyId],
    }),
  },
  or: {
    headerTable: "or_headers",
    lineTable: "or_lines",
    lineIdCol: "or_id",
    hasDueDate: false,
    // Direct-only enforcement (approved plan, OR section): this function
    // has no `invoiceApplications` parameter and never touches
    // transaction_applications - there is structurally no way for a
    // generated OR to carry a settlement/source-application link, since
    // the recurring template schema itself has no field capable of
    // expressing "this settles Invoice #X" (a template line is only
    // account+particulars+debit/credit). payment_method is hardcoded
    // 'Cash' with bank_account_id/check_no/check_date all blank/NULL -
    // never auto-filling physical check details, per the approved plan.
    buildHeaderInsert: ({ companyId, voucherNo, partyId, partyName, transactionDate, referenceNo, description, totalDebit, totalCredit, currencyId }) => ({
      sql: `INSERT INTO or_headers (
        company_id, voucher_no, customer_id, customer_name, transaction_date, reference_no, receipt_no,
        description, total_debit, total_credit, status, payment_method, bank_account_id, check_no, check_date, currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'Draft', 'Cash', NULL, '', NULL, ?)`,
      params: [companyId, voucherNo, partyId || null, partyName || "", transactionDate, referenceNo || "", description || "", totalDebit, totalCredit, currencyId],
    }),
  },
  cv: {
    headerTable: "cv_headers",
    lineTable: "cv_lines",
    lineIdCol: "cv_id",
    hasDueDate: false,
    // Direct-only enforcement: same reasoning as `or` above - no
    // `apvApplications` parameter, structurally cannot link a source
    // application. check_no left '' (never auto-filled from a physical
    // checkbook) and payment_method hardcoded 'Cash' so no check fields
    // are implied at all on a generated Draft.
    buildHeaderInsert: ({ companyId, voucherNo, partyId, partyName, transactionDate, referenceNo, description, totalDebit, totalCredit, currencyId }) => ({
      sql: `INSERT INTO cv_headers (
        company_id, voucher_no, payee_id, payee_name, transaction_date, reference_no, check_no,
        description, total_debit, total_credit, status, payment_method, bank_account_id, check_date, currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'Draft', 'Cash', NULL, NULL, ?)`,
      params: [companyId, voucherNo, partyId || null, partyName || "", transactionDate, referenceNo || "", description || "", totalDebit, totalCredit, currencyId],
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
async function processSchedule(scheduleId, { triggerType = "MANUAL", userId = null, approvedRate = null } = {}) {
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
    // authoritative backstop below). RATE_REVIEW_REQUIRED is NOT terminal -
    // it's a pause state waiting for a human to supply approvedRate, so a
    // retry must be allowed to replace that placeholder row rather than
    // being treated as "already generated" forever.
    const [existing] = await conn.execute(
      "SELECT id, status FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
      [scheduleId, occurrenceDate]
    );
    // Checkpoint 3F: FAILED is also retryable (not just RATE_REVIEW_REQUIRED)
    // - a rate that couldn't resolve, or an inactive currency, is exactly
    // the kind of thing a user fixes and retries. SUCCESS/SKIPPED remain
    // terminal - a second attempt at those returns ALREADY_GENERATED
    // rather than ever producing a second transaction for the same date.
    if (existing.length > 0 && (existing[0].status === "RATE_REVIEW_REQUIRED" || existing[0].status === "FAILED" || existing[0].status === "PERIOD_CLOSED")) {
      await conn.execute("DELETE FROM recurring_transaction_occurrences WHERE id = ?", [existing[0].id]);
    } else if (existing.length > 0) {
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

    // computedLines/totalDebit/totalCredit are in the TEMPLATE's TRANSACTION
    // currency (section 34 - templates store business amounts in foreign
    // currency, not pre-converted base). Foreign-side balance check first.
    const totalDebit = computedLines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = computedLines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) >= 0.01) {
      throw new HttpError(422, "Computed amounts for this occurrence are not balanced.");
    }

    // Sections 21-26: resolve THIS occurrence's own currency/rate per the
    // template's rate_policy - never reuses or locks a prior occurrence's
    // rate into the template.
    const companyId = await resolveTemplateCompanyId(template);

    // Checkpoint 5 section 22/23: a due occurrence landing in a closed
    // period is never silently generated (even as a Draft) and never
    // silently moved to today - it's recorded as its own non-terminal
    // status, exactly like RATE_REVIEW_REQUIRED below, so it stays visible
    // and retryable once the period reopens rather than being lost.
    try {
      await AccountingPeriodService.assertPeriodOpen({
        companyId, transactionDate: occurrenceDate, operation: "GENERATE", user: userId ? { id: userId } : null,
      }, conn);
    } catch (periodErr) {
      if (periodErr.statusCode === 409 && periodErr.code && periodErr.code.startsWith("ACCOUNTING_PERIOD")) {
        const [closedResult] = await conn.execute(
          `INSERT INTO recurring_transaction_occurrences
            (schedule_id, occurrence_date, generated_module_type, trigger_type, status, reason, generated_by)
           VALUES (?, ?, ?, ?, 'PERIOD_CLOSED', ?, ?)`,
          [scheduleId, occurrenceDate, moduleType, triggerType, periodErr.message, userId]
        );
        await logAudit(conn, {
          module: "RECURRING.TRANSACTIONS",
          entityType: "RECURRING_SCHEDULE",
          entityId: scheduleId,
          action: "OCCURRENCE_PERIOD_CLOSED",
          description: `Occurrence for ${occurrenceDate} on template #${template.id} was not generated - ${periodErr.message} (trigger=${triggerType}).`,
          user: userId ? { id: userId } : null,
        });
        await conn.commit();
        return { status: "PERIOD_CLOSED", occurrenceDate, occurrenceId: closedResult.insertId, message: periodErr.message };
      }
      throw periodErr;
    }

    let currencyResult;
    try {
      currencyResult = await resolveOccurrenceCurrency({ template, companyId, occurrenceDate, approvedRate });
    } catch (rateErr) {
      if (rateErr instanceof HttpError) rateErr.reasonCode = rateErr.reasonCode || "NO_APPROVED_RATE";
      throw rateErr;
    }

    if (currencyResult.reviewRequired) {
      // Section 25: hold for human rate approval instead of generating on
      // a stale/unapproved rate. Not a failure - commits cleanly with a
      // distinct status, schedule is NOT advanced (still due next attempt).
      const [reviewResult] = await conn.execute(
        `INSERT INTO recurring_transaction_occurrences
          (schedule_id, occurrence_date, generated_module_type, trigger_type, status, reason, generated_by)
         VALUES (?, ?, ?, ?, 'RATE_REVIEW_REQUIRED', 'RATE_REVIEW_REQUIRED', ?)`,
        [scheduleId, occurrenceDate, moduleType, triggerType, userId]
      );
      await logAudit(conn, {
        module: "RECURRING.TRANSACTIONS",
        entityType: "RECURRING_SCHEDULE",
        entityId: scheduleId,
        action: "OCCURRENCE_RATE_REVIEW_REQUIRED",
        description: `Occurrence for ${occurrenceDate} on template #${template.id} needs manual rate approval before it can generate (trigger=${triggerType}).`,
        user: userId ? { id: userId } : null,
      });
      await conn.commit();
      return { status: "RATE_REVIEW_REQUIRED", occurrenceDate, occurrenceId: reviewResult.insertId };
    }

    // Convert this occurrence's lines to BASE currency at the resolved
    // rate - debit/credit stay base-currency GL values (authoritative),
    // foreign_debit/foreign_credit preserve the template's transaction-
    // currency amounts, exactly the same rule every other module follows.
    const rate = Number(currencyResult.rateInfo.exchangeRate) || 1;
    const baseLines = computedLines.map((l) => ({
      ...l,
      foreignDebit: TransactionCurrencyService.roundMoney(l.debit || 0),
      foreignCredit: TransactionCurrencyService.roundMoney(l.credit || 0),
      baseDebit: TransactionCurrencyService.roundMoney((Number(l.debit) || 0) * rate),
      baseCredit: TransactionCurrencyService.roundMoney((Number(l.credit) || 0) * rate),
    }));
    const baseTotalDebit = TransactionCurrencyService.roundMoney(totalDebit * rate);
    const baseTotalCredit = TransactionCurrencyService.roundMoney(totalCredit * rate);

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
      companyId,
      voucherNo,
      partyId: template.party_id,
      partyName: template.party_name,
      transactionDate: occurrenceDate,
      dueDate,
      referenceNo: voucherNo,
      description,
      remarks: `Auto-generated from recurring template #${template.id}`,
      totalDebit: baseTotalDebit,
      totalCredit: baseTotalCredit,
      currencyId: currencyResult.currencyId,
      isForeign: currencyResult.isForeign,
      foreignBalance: totalDebit || totalCredit,
    });
    const [headerResult] = await conn.execute(sql, params);
    const generatedId = headerResult.insertId;

    for (const line of baseLines) {
      const particulars = substituteVariables(line.particulars_template, ctx);
      await conn.execute(
        `INSERT INTO ${genCfg.lineTable} (${genCfg.lineIdCol}, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name, foreign_debit, foreign_credit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generatedId, line.account_id, line.account_code || "", line.account_title || "", particulars || "", line.baseDebit, line.baseCredit, line.gen_ref || "", line.gen_name || "", line.foreignDebit, line.foreignCredit]
      );
    }

    // Section 35: every generated transaction gets its own
    // transaction_currency_snapshots row via the SAME shared service every
    // other module uses - lockNow: false, since generated transactions are
    // always Draft (never lock a Draft's rate).
    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId,
      transactionType: moduleType === "invoice" ? "INV" : moduleType.toUpperCase(),
      transactionId: generatedId,
      currencyId: currencyResult.currencyId,
      currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrency.id,
      baseCurrencyCode: currencyResult.baseCurrency.currencyCode,
      rateInfo: currencyResult.rateInfo,
      foreignTotals: { foreignSubtotal: 0, foreignTax: 0, foreignEwt: 0, foreignTotal: totalDebit || totalCredit },
      baseTotals: { baseSubtotal: 0, baseTax: 0, baseEwt: 0, baseTotal: baseTotalDebit },
      userId,
      lockNow: false,
    });

    // 14. Save the occurrence record (DB-backstop UNIQUE constraint lives
    // here). This is the true cross-instance safety net: the FOR UPDATE
    // locks above serialize concurrent attempts against ONE MySQL
    // connection pool, but Railway can run more than one app instance, so
    // a second instance racing this exact (schedule_id, occurrence_date)
    // is still possible in principle. If it happens, this INSERT is where
    // it surfaces - caught explicitly so the loser cleanly reports
    // ALREADY_GENERATED instead of a raw 500, and rolls back its own
    // half-built header/lines/snapshot rather than leaving them orphaned.
    let occurrenceResult;
    try {
      [occurrenceResult] = await conn.execute(
        `INSERT INTO recurring_transaction_occurrences
          (schedule_id, occurrence_date, generated_module_type, generated_transaction_id, trigger_type, status, generated_by)
         VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`,
        [scheduleId, occurrenceDate, moduleType, generatedId, triggerType, userId]
      );
    } catch (dupErr) {
      if (dupErr.code === "ER_DUP_ENTRY") {
        await conn.rollback();
        const [winner] = await pool.execute(
          "SELECT id FROM recurring_transaction_occurrences WHERE schedule_id = ? AND occurrence_date = ?",
          [scheduleId, occurrenceDate]
        );
        return { status: "ALREADY_GENERATED", occurrenceDate, occurrenceId: winner[0]?.id || null };
      }
      throw dupErr;
    }

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
            (schedule_id, occurrence_date, generated_module_type, trigger_type, status, error_message, reason, generated_by)
           VALUES (?, ?, ?, ?, 'FAILED', ?, ?, ?)`,
          [scheduleId, occurrenceDate, moduleType || "unknown", triggerType, safeErrorMessage(err), err.reasonCode || null, userId]
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

// This app is effectively single-company today (see Checkpoint 3D
// investigation - most transaction tables have no company_id column at
// all yet). A recurring template's own company_id is used when present;
// otherwise this falls back to "the only/first company", the same
// simplification CurrencyService.resolveCompanyIdForWrite's SUPER_ADMIN
// branch already makes for interactive requests - there is no interactive
// user to ask when a scheduled/background trigger runs this.
async function resolveTemplateCompanyId(template) {
  if (template.company_id) return template.company_id;
  const [rows] = await pool.execute("SELECT id FROM companies ORDER BY id LIMIT 1");
  if (!rows.length) throw new HttpError(400, "No company exists yet - create a company first.");
  return rows[0].id;
}

// Resolves the currency + rate for ONE occurrence per the template's
// rate_policy (sections 21-26) - never permanently locks a rate into the
// template, only returns what THIS occurrence should use. Throws
// HttpError(422, ...) with a reason code in err.reasonCode for the FAILED-
// occurrence paths (section 43); returns { reviewRequired: true } instead
// of throwing for the MANUAL_REVIEW-without-an-approved-rate case, since
// that is an expected pause state, not a failure.
async function resolveOccurrenceCurrency({ template, companyId, occurrenceDate, approvedRate }) {
  const baseCurrency = await Resolver.getBaseCurrencyForCompany(companyId);

  if (!template.currency_id || Number(template.currency_id) === baseCurrency.id) {
    return {
      isForeign: false,
      currencyId: baseCurrency.id,
      currencyCode: baseCurrency.currencyCode,
      baseCurrency,
      rateInfo: { currencyCode: baseCurrency.currencyCode, exchangeRate: 1, rateDate: occurrenceDate, rateSource: "BASE", rateBasis: null, rateStatus: "FINAL", rateRetrievedAt: null, rateIngestionMethod: null, systemRate: null, overrideRate: null, overrideReason: null },
    };
  }

  const [currencyRows] = await pool.execute(
    "SELECT id, currency_code AS currencyCode, is_active AS isActive, company_id AS companyId FROM currencies WHERE id = ?",
    [template.currency_id]
  );
  if (!currencyRows.length || !currencyRows[0].isActive) {
    // Section 39: a deactivated template currency must never silently fall
    // back to base - the occurrence is held for review instead.
    const e = new HttpError(422, `Currency for this recurring template is no longer active. Reactivate it or update the template's currency before this occurrence can generate.`);
    e.reasonCode = "CURRENCY_INACTIVE";
    throw e;
  }
  const currency = currencyRows[0];

  const policy = template.rate_policy || "RESOLVE_ON_GENERATION";

  if (policy === "FIXED_RATE") {
    const fixedRate = Number(template.fixed_rate);
    if (!Number.isFinite(fixedRate) || fixedRate <= 0) {
      const e = new HttpError(422, "This template's rate policy is Fixed Rate, but no valid fixed rate is configured.");
      e.reasonCode = "NO_APPROVED_RATE";
      throw e;
    }
    return {
      isForeign: true,
      currencyId: currency.id,
      currencyCode: currency.currencyCode,
      baseCurrency,
      rateInfo: { currencyCode: currency.currencyCode, exchangeRate: fixedRate, rateDate: occurrenceDate, rateSource: "FIXED", rateBasis: null, rateStatus: "FINAL", rateRetrievedAt: null, rateIngestionMethod: null, systemRate: null, overrideRate: null, overrideReason: null },
    };
  }

  if (policy === "MANUAL_REVIEW" && approvedRate == null) {
    // Section 25: never silently generate on a stale/unapproved rate - the
    // caller (processSchedule) turns this into a RATE_REVIEW_REQUIRED
    // occurrence instead of throwing, since it's an expected pause, not an
    // error.
    return { reviewRequired: true };
  }

  if (policy === "MANUAL_REVIEW" && approvedRate != null) {
    const rate = Number(approvedRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      const e = new HttpError(400, "Approved rate must be greater than zero.");
      e.reasonCode = "NO_APPROVED_RATE";
      throw e;
    }
    return {
      isForeign: true,
      currencyId: currency.id,
      currencyCode: currency.currencyCode,
      baseCurrency,
      rateInfo: { currencyCode: currency.currencyCode, exchangeRate: rate, rateDate: occurrenceDate, rateSource: "MANUAL_APPROVED", rateBasis: null, rateStatus: "APPROVED", rateRetrievedAt: new Date().toISOString(), rateIngestionMethod: "MANUAL_ENTRY", systemRate: null, overrideRate: rate, overrideReason: "Manual review approval for recurring occurrence" },
    };
  }

  // RESOLVE_ON_GENERATION (default): re-resolve fresh every time, exactly
  // like a brand-new manual transaction would (section 23) - never reads
  // or reuses a rate from a prior occurrence.
  const resolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: currency.id, transactionDate: occurrenceDate });
  if (resolved.rate == null) {
    const e = new HttpError(422, resolved.errorMessage || `No approved exchange rate is available for ${currency.currencyCode}/${baseCurrency.currencyCode} on ${occurrenceDate}.`);
    e.reasonCode = "NO_APPROVED_RATE";
    throw e;
  }
  return {
    isForeign: true,
    currencyId: currency.id,
    currencyCode: currency.currencyCode,
    baseCurrency,
    rateInfo: {
      currencyCode: currency.currencyCode, exchangeRate: resolved.rate, rateDate: resolved.effectiveDate,
      rateSource: resolved.provider, rateBasis: resolved.rateBasis, rateStatus: resolved.status,
      rateRetrievedAt: resolved.retrievalTimestamp, rateIngestionMethod: resolved.derivationMethod ? "DERIVED" : "API",
      systemRate: resolved.rate, overrideRate: null, overrideReason: null,
    },
  };
}

// Batch entry point for the future scheduler (Phase 4) - processes every
// currently-due, active, unpaused schedule, each in its own transaction so
// one failure doesn't affect the others.
async function processDueSchedules({ triggerType = "SCHEDULED", limit = 50 } = {}) {
  // LIMIT as a bound placeholder trips "Incorrect arguments to
  // mysqld_stmt_execute" on this mysql2/MySQL combo (a known mysql2
  // gotcha with LIMIT specifically). Safe to inline directly since limit
  // is never derived from external/user input - only internal callers
  // (the in-process cron and the secret-gated /run-due endpoint) invoke
  // this function, always with a hardcoded or default value.
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);
  const [due] = await pool.execute(
    `SELECT id FROM recurring_transaction_schedules
     WHERE is_active = 1 AND is_paused = 0 AND next_run_date <= CURDATE()
     ORDER BY next_run_date ASC LIMIT ${safeLimit}`
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
