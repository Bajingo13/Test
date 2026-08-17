const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const AgingReportService = require("./agingReportService");
const Resolver = require("./exchangeRateResolverService");
const TransactionCurrencyService = require("./transactionCurrencyService");
const FxAccountService = require("./fxAccountService");
const CurrencyService = require("./currencyService");
const AccountingPeriodService = require("./accountingPeriodService");

const { roundMoney } = TransactionCurrencyService;

// mysql2 returns DATE columns as JS Date objects at LOCAL midnight. Both
// `String(dateObject)` (Node's Date#toString, e.g. "Mon Aug 31 2026 ...")
// and JSON serialization (Date#toJSON -> toISOString, which shifts to UTC
// and can roll the calendar day backward for a UTC+8 server) silently
// produce the WRONG date if used directly - the exact bug class
// recurringDateService.js/recurringTemplateService.js already guard
// against elsewhere in this codebase. Normalize to a plain 'YYYY-MM-DD'
// string using LOCAL getters (never .toISOString()) the moment a session
// row is read, before it's used in any voucher number, description, or
// API response.
function normalizeDate(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeSessionDates(session) {
  if (!session) return session;
  return {
    ...session,
    revaluation_date: normalizeDate(session.revaluation_date),
    reversed_date: normalizeDate(session.reversed_date),
  };
}

// Checkpoint 4: Unrealized FX / Month-End Revaluation.
//
// Design summary (see completion report for full rationale):
// - Reuses Checkpoint 3E's agingReportService.getAgingRows() UNCHANGED for
//   "eligible open foreign balance as of a date" - never rebuilds that
//   historical As-Of logic.
// - NEVER touches transaction_currency_snapshots, invoice_headers,
//   apv_headers, or arap_beginning_balance_lines - the source document's
//   historical rate/foreign balance stay exactly as originally posted,
//   forever (sections 5/31/32).
// - Posts through the existing jv_headers/jv_lines tables
//   (source_module='FX_REVALUATION') - the GL/Trial Balance impact is
//   entirely a normal JV, not a parallel ledger.
// - CARRY_FORWARD_REVALUATION policy (the default and only auto-applied
//   policy in this checkpoint): each new revaluation's "carrying rate" for
//   an item is the closing rate from the most recent POSTED, unreversed
//   revaluation of that SAME source item (or the original historical rate,
//   if this is the first revaluation ever) - so a second month-end posts
//   only the INCREMENTAL movement, never re-posts the whole gain again.
// - Realized settlement (paymentApplicationService.js) is extended
//   separately to consult this same carrying basis, so a later real
//   settlement never double-counts FX already recognized here.

const HEADER_LINE_CONFIG = {
  INV: { lineTable: "invoice_lines", lineIdCol: "invoice_id", titleMatch: "%receivable%" },
  APV: { lineTable: "apv_lines", lineIdCol: "apv_id", titleMatch: "%payable%" },
};

// The single most important lookup in this whole checkpoint: "what rate is
// this source item CURRENTLY carried at in the GL, per all PRIOR posted
// revaluations" - used both when calculating THIS period's revaluation and
// when a later real settlement needs to compute realized FX without
// double-counting. A REVERSED session's items are automatically excluded
// (status filter), so reversing a revaluation correctly un-does its effect
// on future carrying-basis lookups without deleting anything.
async function getCarryingBasis(db, sourceType, sourceId, beforeDate) {
  const [rows] = await db.execute(
    `SELECT i.closing_rate AS rate, s.revaluation_date AS asOfDate, s.id AS sessionId
     FROM fx_revaluation_items i
     JOIN fx_revaluation_sessions s ON s.id = i.session_id
     WHERE i.source_type = ? AND i.source_id = ? AND s.status = 'POSTED' AND s.revaluation_date < ?
     ORDER BY s.revaluation_date DESC, s.id DESC
     LIMIT 1`,
    [sourceType, sourceId, beforeDate]
  );
  if (!rows.length || rows[0].rate == null) return null;
  return { rate: Number(rows[0].rate), asOfDate: rows[0].asOfDate, sessionId: rows[0].sessionId };
}

// Locates the AR/AP control account for a source item. INV/APV: the line
// on the source document whose account title matches - identical pattern
// to paymentApplicationService.js's applyForeignSettlementToLines (the
// only account-classification signal this schema has). AR_BEGINNING/
// AP_BEGINNING: the line's own account_id IS the AR/AP account directly.
async function resolveArApAccount(db, sourceType, sourceId) {
  if (sourceType === "AR_BEGINNING" || sourceType === "AP_BEGINNING") {
    const [rows] = await db.execute(
      `SELECT l.account_id AS accountId, coa.code AS accountCode, coa.title AS accountTitle
       FROM arap_beginning_balance_lines l JOIN chart_of_accounts coa ON coa.id = l.account_id
       WHERE l.id = ?`,
      [sourceId]
    );
    return rows[0] || null;
  }
  const cfg = HEADER_LINE_CONFIG[sourceType];
  if (!cfg) return null;
  const [rows] = await db.execute(
    `SELECT l.account_id AS accountId, coa.code AS accountCode, coa.title AS accountTitle
     FROM ${cfg.lineTable} l JOIN chart_of_accounts coa ON coa.id = l.account_id
     WHERE l.${cfg.lineIdCol} = ? AND LOWER(coa.title) LIKE ?
     LIMIT 1`,
    [sourceId, cfg.titleMatch]
  );
  return rows[0] || null;
}

// Section 20 defensive assertion. Groups items by source_type and does one
// membership check per group rather than one query per item. AR_BEGINNING/
// AP_BEGINNING resolve ownership via their header (the line itself has no
// company_id); INV/APV resolve directly off their own company_id column.
async function assertItemsBelongToCompany(db, itemRows, sessionCompanyId) {
  if (!itemRows.length) return;
  const bySourceType = new Map();
  for (const item of itemRows) {
    if (!bySourceType.has(item.source_type)) bySourceType.set(item.source_type, []);
    bySourceType.get(item.source_type).push(item.source_id);
  }

  for (const [sourceType, sourceIds] of bySourceType) {
    let mismatchCount = 0;
    if (sourceType === "INV") {
      const [rows] = await db.query(
        "SELECT COUNT(*) AS c FROM invoice_headers WHERE id IN (?) AND company_id != ?",
        [sourceIds, sessionCompanyId]
      );
      mismatchCount = rows[0].c;
    } else if (sourceType === "APV") {
      const [rows] = await db.query(
        "SELECT COUNT(*) AS c FROM apv_headers WHERE id IN (?) AND company_id != ?",
        [sourceIds, sessionCompanyId]
      );
      mismatchCount = rows[0].c;
    } else if (sourceType === "AR_BEGINNING" || sourceType === "AP_BEGINNING") {
      const [rows] = await db.query(
        `SELECT COUNT(*) AS c FROM arap_beginning_balance_lines l
         JOIN arap_beginning_balance_headers h ON h.id = l.header_id
         WHERE l.id IN (?) AND h.company_id != ?`,
        [sourceIds, sessionCompanyId]
      );
      mismatchCount = rows[0].c;
    }
    if (mismatchCount > 0) {
      throw new HttpError(
        500,
        `FX revaluation integrity error: ${mismatchCount} item(s) of type ${sourceType} do not belong to this session's company. Posting has been aborted.`
      );
    }
  }
}

function directionFor(arApType, difference) {
  if (Math.abs(difference) < 0.005) return "NONE";
  if (arApType === "AR") return difference > 0 ? "UNREALIZED_GAIN" : "UNREALIZED_LOSS";
  return difference > 0 ? "UNREALIZED_LOSS" : "UNREALIZED_GAIN"; // AP: liability increasing = loss
}

async function buildItemsForType(db, { arApType, companyId, revaluationDate }) {
  const rows = await AgingReportService.getAgingRows(arApType, { companyId, asOfDate: revaluationDate, status: "OPEN" });
  const items = [];

  for (const row of rows) {
    if (!row.isForeign) continue; // section 40: base-currency balances excluded entirely

    const carrying = await getCarryingBasis(db, row.sourceType, row.sourceId, revaluationDate);
    const carryingRate = carrying ? carrying.rate : row.historicalRate;
    const carryingBase = roundMoney(row.foreignBalance * carryingRate);

    let closingRate = null;
    let rateEffectiveDate = null;
    let rateSource = null;
    let closingBase = null;
    let difference = null;
    let direction = null;
    let status = "RATE_REQUIRED";

    try {
      const resolved = await Resolver.resolveRate({ companyId, foreignCurrencyId: row.currencyId, transactionDate: revaluationDate });
      if (resolved.rate != null) {
        closingRate = Number(resolved.rate);
        rateEffectiveDate = resolved.effectiveDate;
        rateSource = resolved.provider || resolved.resolvedTier || null;
        closingBase = roundMoney(row.foreignBalance * closingRate);
        difference = roundMoney(closingBase - carryingBase);
        direction = directionFor(arApType, difference);
        status = "CALCULATED";
      }
    } catch {
      status = "RATE_REQUIRED";
    }

    const arApAccount = await resolveArApAccount(db, row.sourceType, row.sourceId);

    items.push({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      arApType,
      documentNumber: row.referenceNo,
      partyName: row.partyName,
      currencyId: row.currencyId,
      currencyCode: row.currencyCode,
      foreignBalance: roundMoney(row.foreignBalance),
      historicalRate: row.historicalRate,
      carryingRate,
      carryingBaseAmount: carryingBase,
      closingRate,
      rateEffectiveDate,
      rateSource,
      closingBaseAmount: closingBase,
      unrealizedDifference: difference,
      direction,
      arApAccountId: arApAccount?.accountId || null,
      arApAccountCode: arApAccount?.accountCode || null,
      arApAccountTitle: arApAccount?.accountTitle || null,
      status,
    });
  }

  return items;
}

// Calculate (or recalculate) a DRAFT/CALCULATED/RATE_REQUIRED session for
// (companyId, revaluationDate). Never touches the GL - purely a preview
// that persists to fx_revaluation_items so the preview survives a page
// reload, per section 20 ("Calculate is not Post").
async function calculate({ companyId, revaluationDate, userId }) {
  // company_id must be a concrete, resolved value (never NULL) - MySQL's
  // UNIQUE KEY treats every NULL as distinct, so a NULL company_id would
  // silently defeat the one-session-per-company-per-date duplicate-
  // prevention guarantee (section 26) that constraint exists to provide.
  // Callers (the controller) resolve it via CurrencyService.resolveCompanyIdForWrite
  // the same way every other write path in this app does.
  if (!companyId) throw new HttpError(400, "A company could not be resolved for this revaluation.");
  const baseCurrency = await Resolver.getBaseCurrencyForCompany(companyId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      "SELECT * FROM fx_revaluation_sessions WHERE company_id = ? AND revaluation_date = ? FOR UPDATE",
      [companyId, revaluationDate]
    );
    if (existing.length && existing[0].status === "POSTED") {
      await conn.rollback();
      throw new HttpError(409, `A revaluation for ${revaluationDate} has already been posted. Reverse it before recalculating, or choose a different date.`);
    }
    if (existing.length && existing[0].status === "REVERSED") {
      await conn.rollback();
      throw new HttpError(409, `The revaluation for ${revaluationDate} was posted and then reversed. Choose a different date to run a new revaluation.`);
    }

    let sessionId;
    if (existing.length) {
      sessionId = existing[0].id;
      await conn.execute("DELETE FROM fx_revaluation_items WHERE session_id = ?", [sessionId]);
    } else {
      const [result] = await conn.execute(
        `INSERT INTO fx_revaluation_sessions (company_id, revaluation_date, base_currency_id, base_currency_code, status, created_by)
         VALUES (?, ?, ?, ?, 'DRAFT', ?)`,
        [companyId, revaluationDate, baseCurrency.id, baseCurrency.currencyCode, userId]
      );
      sessionId = result.insertId;
    }

    const arItems = await buildItemsForType(conn, { arApType: "AR", companyId, revaluationDate });
    const apItems = await buildItemsForType(conn, { arApType: "AP", companyId, revaluationDate });
    const allItems = [...arItems, ...apItems];

    for (const item of allItems) {
      let fxAccountId = null;
      if (item.direction === "UNREALIZED_GAIN" || item.direction === "UNREALIZED_LOSS") {
        try {
          const fxAccount = await FxAccountService.requireFxAccount(companyId, item.direction);
          fxAccountId = fxAccount.accountId;
        } catch {
          fxAccountId = null; // surfaced by the missing-account check at post time
        }
      }
      await conn.execute(
        `INSERT INTO fx_revaluation_items
          (session_id, source_type, source_id, ar_ap_type, document_number, party_name, currency_id, currency_code,
           foreign_balance, historical_rate, carrying_rate, carrying_base_amount, closing_rate, rate_effective_date,
           rate_source, closing_base_amount, unrealized_difference, direction, ar_ap_account_id, fx_account_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId, item.sourceType, item.sourceId, item.arApType, item.documentNumber, item.partyName,
          item.currencyId, item.currencyCode, item.foreignBalance, item.historicalRate, item.carryingRate,
          item.carryingBaseAmount, item.closingRate, item.rateEffectiveDate, item.rateSource,
          item.closingBaseAmount, item.unrealizedDifference, item.direction,
          item.arApAccountId, fxAccountId, item.status,
        ]
      );
    }

    const itemsRequiringRate = allItems.filter((i) => i.status === "RATE_REQUIRED").length;
    const totalGain = roundMoney(allItems.filter((i) => i.direction === "UNREALIZED_GAIN").reduce((s, i) => s + Math.abs(i.unrealizedDifference), 0));
    const totalLoss = roundMoney(allItems.filter((i) => i.direction === "UNREALIZED_LOSS").reduce((s, i) => s + Math.abs(i.unrealizedDifference), 0));
    const netEffect = roundMoney(totalGain - totalLoss);
    const sessionStatus = itemsRequiringRate > 0 ? "RATE_REQUIRED" : "CALCULATED";

    await conn.execute(
      `UPDATE fx_revaluation_sessions
       SET status = ?, item_count = ?, items_requiring_rate = ?, total_gain = ?, total_loss = ?, net_effect = ?
       WHERE id = ?`,
      [sessionStatus, allItems.length, itemsRequiringRate, totalGain, totalLoss, netEffect, sessionId]
    );

    await logAudit(conn, {
      module: "FX_REVALUATION",
      entityType: "FX_REVALUATION_SESSION",
      entityId: sessionId,
      action: "FX_REVALUATION_CALCULATED",
      description: `Calculated FX revaluation for ${revaluationDate}: ${allItems.length} items, gain ${totalGain}, loss ${totalLoss}, ${itemsRequiringRate} requiring rate`,
      afterData: { revaluationDate, itemCount: allItems.length, totalGain, totalLoss, netEffect, itemsRequiringRate },
      user: userId ? { id: userId } : null,
    });

    await conn.commit();
    return getSessionDetail(sessionId, companyId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getSessionDetail(sessionId, companyId) {
  const [sessions] = await pool.execute("SELECT * FROM fx_revaluation_sessions WHERE id = ? AND company_id = ?", [sessionId, companyId]);
  if (!sessions.length) throw new HttpError(404, "Revaluation session not found.");
  const [items] = await pool.execute("SELECT * FROM fx_revaluation_items WHERE session_id = ? ORDER BY ar_ap_type, party_name", [sessionId]);
  return {
    session: normalizeSessionDates(sessions[0]),
    items: items.map((i) => ({ ...i, rate_effective_date: normalizeDate(i.rate_effective_date) })),
  };
}

async function listSessions({ companyId } = {}) {
  const [rows] = await pool.execute(
    "SELECT * FROM fx_revaluation_sessions WHERE company_id <=> ? ORDER BY revaluation_date DESC",
    [companyId ?? null]
  );
  return rows.map(normalizeSessionDates);
}

// Aggregates postable items into netted JV lines per (account), so a
// revaluation touching many documents produces a handful of GL lines
// while fx_revaluation_items still preserves full per-document detail
// (section 23). Returns null if there is nothing to post (all items
// NONE-direction or the session has zero items).
function buildJvLines(items) {
  const totals = new Map(); // accountId -> { code, title, debit, credit }

  const bump = (accountId, code, title, debit, credit) => {
    if (!accountId) return;
    if (!totals.has(accountId)) totals.set(accountId, { code, title, debit: 0, credit: 0 });
    const t = totals.get(accountId);
    t.debit = roundMoney(t.debit + debit);
    t.credit = roundMoney(t.credit + credit);
  };

  for (const item of items) {
    if (item.direction !== "UNREALIZED_GAIN" && item.direction !== "UNREALIZED_LOSS") continue;
    const amount = Math.abs(Number(item.unrealized_difference));
    if (amount < 0.005) continue;

    if (item.direction === "UNREALIZED_GAIN") {
      // AR gain: Dr AR, Cr Gain. AP gain (liability decreased): Dr AP, Cr Gain.
      bump(item.ar_ap_account_id, item.ar_ap_account_code, item.ar_ap_account_title, amount, 0);
      bump(item.fx_account_id, item.fx_account_code, item.fx_account_title, 0, amount);
    } else {
      // AR loss: Dr Loss, Cr AR. AP loss (liability increased): Dr Loss, Cr AP.
      bump(item.fx_account_id, item.fx_account_code, item.fx_account_title, amount, 0);
      bump(item.ar_ap_account_id, item.ar_ap_account_code, item.ar_ap_account_title, 0, amount);
    }
  }

  const lines = [];
  for (const [accountId, t] of totals.entries()) {
    const net = roundMoney(t.debit - t.credit);
    if (Math.abs(net) < 0.005) continue; // fully netted at this account - no line needed
    lines.push({
      accountId,
      code: t.code,
      title: t.title,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    });
  }
  return lines;
}

async function post({ sessionId, userId, companyId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [sessions] = await conn.execute("SELECT * FROM fx_revaluation_sessions WHERE id = ? FOR UPDATE", [sessionId]);
    if (!sessions.length || sessions[0].company_id !== companyId) throw new HttpError(404, "Revaluation session not found.");
    const session = normalizeSessionDates(sessions[0]);

    // Duplicate-posting protection (section 26/59): a second POST attempt
    // for an already-posted session returns the EXISTING journal instead
    // of creating anything new. The row lock above serializes two
    // concurrent posts of the SAME session; the loser sees status=POSTED
    // once it acquires the lock and takes this branch cleanly.
    if (session.status === "POSTED") {
      await conn.rollback();
      const [jvRows] = await pool.execute("SELECT voucher_no AS voucherNo FROM jv_headers WHERE id = ?", [session.jv_id]);
      return { status: "ALREADY_POSTED", sessionId, jvId: session.jv_id, voucherNo: jvRows[0]?.voucherNo || null };
    }
    if (session.status === "RATE_REQUIRED") {
      throw new HttpError(409, "This revaluation has items requiring an approved rate. Resolve them before posting.");
    }
    if (session.status !== "CALCULATED") {
      throw new HttpError(409, `This revaluation cannot be posted from its current status (${session.status}).`);
    }

    // Checkpoint 5 section 19: posting into the revaluation's own period
    // requires that period OPEN (or SOFT_CLOSED + authorized). Preview
    // (calculate()) never reaches here, so it stays unaffected.
    await AccountingPeriodService.assertPeriodOpen({
      companyId: session.company_id, transactionDate: session.revaluation_date,
      operation: "POST", user: userId ? { id: userId } : null,
    }, conn);

    const [itemRows] = await conn.execute(
      `SELECT i.*, ar.code AS ar_ap_account_code, ar.title AS ar_ap_account_title,
              fx.code AS fx_account_code, fx.title AS fx_account_title
       FROM fx_revaluation_items i
       LEFT JOIN chart_of_accounts ar ON ar.id = i.ar_ap_account_id
       LEFT JOIN chart_of_accounts fx ON fx.id = i.fx_account_id
       WHERE i.session_id = ?`,
      [sessionId]
    );

    // Section 20 defensive assertion: every item's underlying source
    // document must belong to this session's own company. fx_revaluation_items
    // has no company_id column of its own (derives ownership via the
    // session), so this re-verifies against each source document's actual
    // header table directly - a structural safety net independent of
    // whatever scoped buildItemsForType() at calculate() time, so a future
    // regression there cannot silently post a cross-company adjustment.
    await assertItemsBelongToCompany(conn, itemRows, session.company_id);

    const postable = itemRows.filter((i) => i.direction === "UNREALIZED_GAIN" || i.direction === "UNREALIZED_LOSS");
    for (const item of postable) {
      if (!item.ar_ap_account_id) {
        throw new HttpError(422, `Document ${item.document_number || item.source_id} has no identifiable AR/AP account - cannot post.`);
      }
      if (!item.fx_account_id) {
        const label = item.direction === "UNREALIZED_GAIN" ? "Unrealized FX Gain" : "Unrealized FX Loss";
        throw new HttpError(422, `The ${label} account is not configured. Configure it under Currency Setup -> FX Accounting before posting.`);
      }
    }

    const jvLines = buildJvLines(itemRows);

    if (jvLines.length > 0) {
      const totalDebit = roundMoney(jvLines.reduce((s, l) => s + l.debit, 0));
      const totalCredit = roundMoney(jvLines.reduce((s, l) => s + l.credit, 0));
      // Section 24: never partially post. Every item contributes matched
      // debit/credit, so this can only fail from a genuine bug - fail loud.
      if (Math.abs(totalDebit - totalCredit) >= 0.01) {
        throw new HttpError(500, "FX revaluation adjustment is not balanced - posting aborted.");
      }

      const voucherNo = `JV-FXR-${companyId || 0}-${String(session.revaluation_date).slice(0, 7).replace("-", "")}-${sessionId}`;
      const [jvResult] = await conn.execute(
        `INSERT INTO jv_headers
          (company_id, voucher_no, transaction_date, reference_no, description, total_debit, total_credit,
           status, source_module, source_reference_id, created_by, posted_by, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Posted', 'FX_REVALUATION', ?, ?, ?, NOW())`,
        [
          session.company_id, voucherNo, session.revaluation_date, `FXR-${sessionId}`,
          `Month-End Unrealized FX Revaluation as of ${session.revaluation_date}`,
          totalDebit, totalCredit, sessionId, userId, userId,
        ]
      );
      const jvId = jvResult.insertId;

      for (const line of jvLines) {
        await conn.execute(
          `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [jvId, line.accountId, line.code || "", line.title || "", `FX Revaluation ${session.revaluation_date}`, line.debit, line.credit]
        );
      }

      await conn.execute(
        "UPDATE fx_revaluation_sessions SET status = 'POSTED', jv_id = ?, posted_by = ?, posted_at = NOW() WHERE id = ?",
        [jvId, userId, sessionId]
      );
      await conn.execute("UPDATE fx_revaluation_items SET status = 'POSTED' WHERE session_id = ?", [sessionId]);

      await logAudit(conn, {
        module: "FX_REVALUATION",
        entityType: "FX_REVALUATION_SESSION",
        entityId: sessionId,
        action: "FX_REVALUATION_POSTED",
        description: `Posted FX revaluation for ${session.revaluation_date} as JV ${voucherNo} (#${jvId}): gain ${session.total_gain}, loss ${session.total_loss}`,
        afterData: { jvId, voucherNo, totalGain: session.total_gain, totalLoss: session.total_loss, netEffect: session.net_effect, itemCount: itemRows.length },
        user: userId ? { id: userId } : null,
      });

      await conn.commit();
      return { status: "POSTED", sessionId, jvId, voucherNo };
    }

    // Nothing to post (every item netted to zero) - still finalize the
    // session so its items become the carrying basis for next period,
    // just with no JV.
    await conn.execute("UPDATE fx_revaluation_sessions SET status = 'POSTED', posted_by = ?, posted_at = NOW() WHERE id = ?", [userId, sessionId]);
    await conn.execute("UPDATE fx_revaluation_items SET status = 'POSTED' WHERE session_id = ?", [sessionId]);
    await logAudit(conn, {
      module: "FX_REVALUATION", entityType: "FX_REVALUATION_SESSION", entityId: sessionId,
      action: "FX_REVALUATION_POSTED",
      description: `Posted FX revaluation for ${session.revaluation_date} - net zero movement, no JV required`,
      user: userId ? { id: userId } : null,
    });
    await conn.commit();
    return { status: "POSTED", sessionId, jvId: null, voucherNo: null };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function reverse({ sessionId, userId, companyId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [sessions] = await conn.execute("SELECT * FROM fx_revaluation_sessions WHERE id = ? FOR UPDATE", [sessionId]);
    if (!sessions.length || sessions[0].company_id !== companyId) throw new HttpError(404, "Revaluation session not found.");
    const session = normalizeSessionDates(sessions[0]);

    if (session.status === "REVERSED") {
      await conn.rollback();
      return { status: "ALREADY_REVERSED", sessionId, reversalJvId: session.reversal_jv_id };
    }
    if (session.status !== "POSTED") {
      throw new HttpError(409, `Only a POSTED revaluation can be reversed (current status: ${session.status}).`);
    }

    // .toISOString() shifts to UTC - near local midnight in Asia/Manila
    // (UTC+8) this could report the WRONG calendar day for "today". Use
    // local getters, same as normalizeDate() above.
    const reversalDate = normalizeDate(new Date());

    // Checkpoint 5 section 20: validates the REVERSAL's own date, not the
    // original session's - reversing a still-open August session dated
    // into a now-closed September must be rejected, and does NOT require
    // (or imply) reopening August.
    await AccountingPeriodService.assertPeriodOpen({
      companyId: session.company_id, transactionDate: reversalDate,
      operation: "REVERSE", user: userId ? { id: userId } : null,
    }, conn);

    let reversalJvId = null;
    let reversalVoucherNo = null;

    if (session.jv_id) {
      const [origLines] = await conn.execute("SELECT * FROM jv_lines WHERE jv_id = ?", [session.jv_id]);
      const [origHeaders] = await conn.execute("SELECT * FROM jv_headers WHERE id = ?", [session.jv_id]);
      const orig = origHeaders[0];

      reversalVoucherNo = `JV-FXR-REV-${sessionId}`;
      const [jvResult] = await conn.execute(
        `INSERT INTO jv_headers
          (company_id, voucher_no, transaction_date, reference_no, description, total_debit, total_credit,
           status, source_module, source_reference_id, created_by, posted_by, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Posted', 'FX_REVALUATION_REVERSAL', ?, ?, ?, NOW())`,
        [
          session.company_id, reversalVoucherNo, reversalDate, `FXR-REV-${sessionId}`,
          `Reversal of Month-End Unrealized FX Revaluation posted for ${session.revaluation_date} (JV ${orig.voucher_no})`,
          orig.total_credit, orig.total_debit, sessionId, userId, userId,
        ]
      );
      reversalJvId = jvResult.insertId;

      for (const line of origLines) {
        // Swap debit/credit - a proper reversing entry, original journal untouched.
        await conn.execute(
          `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [reversalJvId, line.account_id, line.account_code, line.account_title, `Reversal of FX Revaluation ${session.revaluation_date}`, Number(line.credit) || 0, Number(line.debit) || 0]
        );
      }
    }

    await conn.execute(
      "UPDATE fx_revaluation_sessions SET status = 'REVERSED', reversal_jv_id = ?, reversed_date = ?, reversed_by = ?, reversed_at = NOW() WHERE id = ?",
      [reversalJvId, reversalDate, userId, sessionId]
    );

    await logAudit(conn, {
      module: "FX_REVALUATION",
      entityType: "FX_REVALUATION_SESSION",
      entityId: sessionId,
      action: "FX_REVALUATION_REVERSED",
      description: `Reversed FX revaluation for ${session.revaluation_date} via JV ${reversalVoucherNo || "(none)"}`,
      beforeData: { status: "POSTED", jvId: session.jv_id },
      afterData: { status: "REVERSED", reversalJvId },
      user: userId ? { id: userId } : null,
    });

    await conn.commit();
    return { status: "REVERSED", sessionId, reversalJvId, reversalVoucherNo };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getCarryingBasis,
  resolveArApAccount,
  calculate,
  post,
  reverse,
  getSessionDetail,
  listSessions,
};