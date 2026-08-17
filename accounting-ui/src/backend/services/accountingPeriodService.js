const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");
const PermissionService = require("./permissionService");

// Checkpoint 5 - Accounting Period Closing & Transaction Locking.
//
// This is the ONE central service every accounting module calls before
// mutating a transaction. It is deliberately NOT built on top of
// authorizePermission()/PermissionService.can() for the CLOSED check,
// because permissionService.can() hardcodes `role_code === 'SUPER_ADMIN'
// -> true` (see permissionService.js:18) - a closed accounting period is
// an accounting control, not a user permission, and must bind Super Admin
// exactly like everyone else. Only an explicit reopenPeriod() call may
// lift it. SOFT_CLOSED is the one status where a permission check
// (ACCOUNTING_PERIODS.POST_SOFT_CLOSED) legitimately participates.

const OPERATIONS = [
  "CREATE", "EDIT", "DELETE", "POST", "VOID", "REVERSE",
  "BULK_POST", "IMPORT", "GENERATE",
];

// mysql2 returns DATE columns as JS Date objects at LOCAL midnight. Using
// .toISOString() on one converts to UTC and can roll the calendar day (and
// sometimes the month) backward on any server whose local timezone is
// ahead of UTC (confirmed live on this system: Asia/Manila, UTC+8) - the
// exact bug class fxRevaluationService.js's normalizeDate() already
// guards against. Every period-lock call site in server.js must go
// through this, never `date.toISOString().slice(0, 10)`, or period
// enforcement can silently check the wrong month.
function toDateOnly(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // last day of month
  const toISO = (d) => d.toISOString().slice(0, 10);
  return { startDate: toISO(start), endDate: toISO(end) };
}

function periodLabel(year, month) {
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[month - 1]} ${year}`;
}

// Row-lock the period for the given (companyId, date) so a concurrent
// close/reopen and a concurrent posting transaction serialize correctly
// (Checkpoint 5 section 48/49) - ONLY race-safe when `conn` is a
// connection already inside conn.beginTransaction()/conn.commit(), since
// SELECT ... FOR UPDATE holds its lock only for the life of the
// transaction it runs in. Called with the bare pool (no active
// transaction), it still returns the correct row - just without the
// concurrency guarantee, which is fine for read-only/preview call sites.
async function getPeriodForDateLocked(conn, companyId, dateStr) {
  // Accepts a plain 'YYYY-MM-DD' string (the normal case - every call site
  // passes one, via toDateOnly() where the value originated as a DB Date)
  // or a Date object as a defensive fallback, parsed with LOCAL getters
  // per the toDateOnly() comment above - never UTC getters on a Date
  // object, which reintroduces the same off-by-a-day/month bug.
  const normalized = toDateOnly(dateStr);
  if (typeof normalized !== "string" || Number.isNaN(new Date(normalized).getTime())) {
    throw new HttpError(400, "Invalid transaction date", "INVALID_DATE");
  }
  const [yearStr, monthStr] = normalized.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const [rows] = await conn.execute(
    "SELECT * FROM accounting_periods WHERE company_id = ? AND year = ? AND period_month = ? FOR UPDATE",
    [companyId, year, month]
  );
  return { period: rows[0] || null, year, month };
}

async function getPeriodForDate(companyId, dateStr) {
  const { period } = await getPeriodForDateLocked(pool, companyId, dateStr);
  return period;
}

// Core invariant enforcement. Every accounting write path calls this
// before mutating rows. `conn` should be the same connection/transaction
// the caller is about to write with, for operations that carry a real
// accounting effect (POST/BULK_POST/IMPORT/GENERATE/DELETE-of-posted/
// REVERSE/VOID) - see the module comment above and the completion
// report's "Concurrency/race protection" section for exactly which call
// sites pass a live transaction vs. the bare pool.
//
// Missing-period policy (documented decision, not silently assumed):
// a company that has NEVER generated any accounting_periods rows is
// treated as "period management not enabled for this company" and is
// waved through unconditionally - this preserves every pre-Checkpoint-5
// fixture/company across the existing 335-test regression, none of which
// ever created a period row. The moment a company has at least one
// period row anywhere, it has opted in: a gap for a specific month is
// then a real configuration problem and blocks POST-class operations
// (never CREATE of a Draft, which has no ledger effect).
async function assertPeriodOpen({ companyId, transactionDate, operation, user }, conn = pool) {
  if (!companyId) throw new HttpError(400, "companyId is required for period enforcement", "MISSING_COMPANY");
  if (!transactionDate) throw new HttpError(400, "transactionDate is required for period enforcement", "MISSING_DATE");
  if (!OPERATIONS.includes(operation)) throw new HttpError(500, `Unknown period-lock operation: ${operation}`, "INVALID_OPERATION");

  const [[{ anyPeriods }]] = await conn.query(
    "SELECT COUNT(*) AS anyPeriods FROM accounting_periods WHERE company_id = ?",
    [companyId]
  );
  if (anyPeriods === 0) return { status: "NOT_MANAGED" };

  const { period, year, month } = await getPeriodForDateLocked(conn, companyId, transactionDate);
  const label = periodLabel(year, month);

  if (!period) {
    // Company uses period management but this specific month was never
    // generated. Drafts (CREATE only, never resulting in a ledger effect)
    // are allowed through so a company mid-rollout isn't bricked; every
    // other operation is blocked per section 42's explicit instruction.
    if (operation === "CREATE") return { status: "NOT_CONFIGURED", period: null };
    throw new HttpError(
      409,
      `Accounting period ${label} has not been configured for this company.`,
      "ACCOUNTING_PERIOD_NOT_CONFIGURED"
    );
  }

  if (period.status === "OPEN") {
    return { status: "OPEN", period };
  }

  if (period.status === "SOFT_CLOSED") {
    if (operation === "CREATE") return { status: "SOFT_CLOSED", period };
    const authorized = user && (await PermissionService.can(user.id, "ACCOUNTING_PERIODS", "POST_SOFT_CLOSED"));
    if (authorized) return { status: "SOFT_CLOSED_AUTHORIZED", period };
    throw new HttpError(
      409,
      `Accounting period ${label} is soft-closed. Only authorized users may post adjustments.`,
      "ACCOUNTING_PERIOD_SOFT_CLOSED"
    );
  }

  // CLOSED - unconditional, including SUPER_ADMIN. Only reopenPeriod()
  // can lift this.
  throw new HttpError(
    409,
    `Accounting period ${label} is closed.`,
    "ACCOUNTING_PERIOD_CLOSED"
  );
}

async function listPeriods({ companyId, year }) {
  const params = [companyId];
  let sql = `
    SELECT ap.*, cb.username AS closed_by_username, scb.username AS soft_closed_by_username, rb.username AS reopened_by_username
    FROM accounting_periods ap
    LEFT JOIN users cb ON cb.id = ap.closed_by
    LEFT JOIN users scb ON scb.id = ap.soft_closed_by
    LEFT JOIN users rb ON rb.id = ap.reopened_by
    WHERE ap.company_id = ?`;
  if (year) {
    sql += " AND ap.year = ?";
    params.push(year);
  }
  sql += " ORDER BY ap.year DESC, ap.period_month DESC";
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getPeriod(periodId, companyId) {
  const [rows] = await pool.execute(
    "SELECT * FROM accounting_periods WHERE id = ? AND company_id = ?",
    [periodId, companyId]
  );
  if (!rows.length) throw new HttpError(404, "Accounting period not found");
  return rows[0];
}

// Generates 12 monthly periods for a year, OPEN by default. Idempotent
// per (company, year, month) via the migration's UNIQUE key - re-running
// for a year that's already (partially) generated only fills gaps,
// never duplicates or resets an existing period's status.
async function generateYearPeriods({ companyId, year, user }) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, "Invalid year");
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const created = [];
    for (let month = 1; month <= 12; month++) {
      const { startDate, endDate } = monthBounds(year, month);
      const [existing] = await conn.execute(
        "SELECT id FROM accounting_periods WHERE company_id = ? AND year = ? AND period_month = ?",
        [companyId, year, month]
      );
      if (existing.length) continue;
      const [result] = await conn.execute(
        `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`,
        [companyId, year, month, startDate, endDate, user.id]
      );
      await conn.execute(
        `INSERT INTO accounting_period_history (period_id, company_id, action, previous_status, new_status, user_id, username, reason)
         VALUES (?, ?, 'GENERATED', NULL, 'OPEN', ?, ?, ?)`,
        [result.insertId, companyId, user.id, user.username, `Generated as part of year ${year}`]
      );
      created.push({ id: result.insertId, month });
    }
    await conn.commit();
    await logAudit(pool, {
      module: "ACCOUNTING_PERIODS", entityType: "ACCOUNTING_PERIOD", entityId: null,
      action: "ACCOUNTING_PERIOD_GENERATED",
      description: `Generated ${created.length} accounting period(s) for ${year}`,
      afterData: { companyId, year, createdMonths: created.map((c) => c.month) },
      user,
    });
    return { createdCount: created.length, skippedCount: 12 - created.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getCloseChecklist({ companyId, periodId }) {
  const period = await getPeriod(periodId, companyId);
  const { start_date: from, end_date: to } = period;

  const countQuery = async (table, dateCol, extraWhere = "") => {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${table} WHERE company_id = ? AND ${dateCol} BETWEEN ? AND ? ${extraWhere}`,
      [companyId, from, to]
    );
    return row.c;
  };

  const draftInvoices = await countQuery("invoice_headers", "transaction_date", "AND status = 'Draft'");
  const draftApv = await countQuery("apv_headers", "transaction_date", "AND status = 'Draft'");
  const draftOr = await countQuery("or_headers", "transaction_date", "AND status = 'Draft'");
  const draftCv = await countQuery("cv_headers", "transaction_date", "AND status = 'Draft'");
  const draftJv = await countQuery("jv_headers", "transaction_date", "AND status = 'Draft'");

  const [[fxRow]] = await pool.query(
    `SELECT COUNT(*) AS c FROM fx_revaluation_sessions WHERE company_id = ? AND revaluation_date BETWEEN ? AND ? AND status IN ('CALCULATED','RATE_REQUIRED')`,
    [companyId, from, to]
  );

  const draftTransactions = draftInvoices + draftApv + draftOr + draftCv + draftJv;

  const blockers = [];
  const warnings = [];
  if (draftTransactions > 0) {
    warnings.push({ code: "DRAFT_TRANSACTIONS", message: `${draftTransactions} draft transaction(s) in this period`, count: draftTransactions });
  }
  if (fxRow.c > 0) {
    warnings.push({ code: "FX_REVALUATION_UNRESOLVED", message: `${fxRow.c} unposted FX revaluation session(s) for this period`, count: fxRow.c });
  }

  return {
    period,
    draftTransactions: { invoices: draftInvoices, apv: draftApv, or: draftOr, cv: draftCv, jv: draftJv, total: draftTransactions },
    fxRevaluationPending: fxRow.c,
    blockers,
    warnings,
    canClose: blockers.length === 0,
  };
}

async function softClosePeriod({ periodId, companyId, user, notes }) {
  return transitionPeriod({
    periodId, companyId, user, notes,
    fromStatuses: ["OPEN"],
    toStatus: "SOFT_CLOSED",
    historyAction: "SOFT_CLOSED",
    auditAction: "ACCOUNTING_PERIOD_SOFT_CLOSED",
    setColumns: { soft_closed_by: user.id, soft_closed_at: new Date(), soft_close_notes: notes || null },
  });
}

async function closePeriod({ periodId, companyId, user, notes }) {
  return transitionPeriod({
    periodId, companyId, user, notes,
    fromStatuses: ["OPEN", "SOFT_CLOSED"],
    toStatus: "CLOSED",
    historyAction: "CLOSED",
    auditAction: "ACCOUNTING_PERIOD_CLOSED",
    setColumns: { closed_by: user.id, closed_at: new Date(), close_notes: notes || null },
  });
}

async function reopenPeriod({ periodId, companyId, user, reason }) {
  if (!reason || !reason.trim()) {
    throw new HttpError(400, "A reason is required to reopen an accounting period.", "REOPEN_REASON_REQUIRED");
  }
  return transitionPeriod({
    periodId, companyId, user, notes: reason,
    fromStatuses: ["SOFT_CLOSED", "CLOSED"],
    toStatus: "OPEN",
    historyAction: "REOPENED",
    auditAction: "ACCOUNTING_PERIOD_REOPENED",
    setColumns: { reopened_by: user.id, reopened_at: new Date(), reopen_reason: reason },
  });
}

// Shared transactional state-transition core for soft-close/close/reopen.
// Takes SELECT ... FOR UPDATE on the period row inside a real transaction
// so a concurrent posting transaction that also calls assertPeriodOpen()
// with its own conn correctly serializes against this (section 48/49).
async function transitionPeriod({ periodId, companyId, user, notes, fromStatuses, toStatus, historyAction, auditAction, setColumns }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT * FROM accounting_periods WHERE id = ? AND company_id = ? FOR UPDATE",
      [periodId, companyId]
    );
    if (!rows.length) throw new HttpError(404, "Accounting period not found");
    const current = rows[0];
    if (!fromStatuses.includes(current.status)) {
      throw new HttpError(
        409,
        `Cannot transition period from ${current.status} to ${toStatus}.`,
        "INVALID_PERIOD_TRANSITION"
      );
    }

    const setClauses = Object.keys(setColumns).map((k) => `${k} = ?`).join(", ");
    const setValues = Object.values(setColumns);
    await conn.execute(
      `UPDATE accounting_periods SET status = ?, ${setClauses} WHERE id = ?`,
      [toStatus, ...setValues, periodId]
    );
    await conn.execute(
      `INSERT INTO accounting_period_history (period_id, company_id, action, previous_status, new_status, user_id, username, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [periodId, companyId, historyAction, current.status, toStatus, user.id, user.username, notes || null]
    );
    await conn.commit();

    await logAudit(pool, {
      module: "ACCOUNTING_PERIODS", entityType: "ACCOUNTING_PERIOD", entityId: periodId,
      action: auditAction,
      description: `Period ${periodLabel(current.year, current.period_month)} transitioned ${current.status} -> ${toStatus}`,
      beforeData: { status: current.status },
      afterData: { status: toStatus, notes },
      user,
    });

    return await getPeriod(periodId, companyId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getHistory({ companyId, periodId }) {
  const params = [companyId];
  let sql = "SELECT * FROM accounting_period_history WHERE company_id = ?";
  if (periodId) {
    sql += " AND period_id = ?";
    params.push(periodId);
  }
  sql += " ORDER BY created_at DESC";
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = {
  assertPeriodOpen,
  getPeriodForDate,
  listPeriods,
  getPeriod,
  generateYearPeriods,
  getCloseChecklist,
  softClosePeriod,
  closePeriod,
  reopenPeriod,
  getHistory,
  toDateOnly,
};