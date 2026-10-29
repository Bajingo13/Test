const { HttpError } = require("../lib/httpError");
const { logAudit } = require("../lib/audit");

// Reconciliation-session integrity (R8.4-A), shared by the workspace routes
// and the AI assistant's findOrCreateSession.
//
// OVERLAP - one company + bank account may not have two reconciliation
// sessions whose periods overlap (finalized or not): they would compete for
// the same statement history. MySQL cannot express an interval-overlap
// constraint, so every create / period change takes a row lock on the bank
// account (bank_codes) first and then checks for overlap inside the same
// transaction - two simultaneous requests for one bank account serialize,
// and the second sees the first one's session.
//
// OPENING BALANCE - the nearest EARLIER session of the same company + bank
// account (period ending before the new period starts) decides:
//   * it is FINALIZED  -> its statement_ending_balance (the bank statement's
//     own figure) is carried as the opening balance: source CARRIED, with
//     the source session recorded; a client-supplied different figure is
//     refused;
//   * it is not finalized, or there is none -> the accountant enters the
//     opening balance: source MANUAL (required - never defaulted).
// Never another company, another bank account, an overlapping or later
// session, or simply the latest-created one.

const OPENING_SOURCE = { MANUAL: "MANUAL", CARRIED: "CARRIED" };

function conflict(statusCode, message, code, details) {
  const err = new HttpError(statusCode, message, code);
  err.details = details;
  return err;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

async function lockBankAccount(conn, bankAccountId) {
  const [rows] = await conn.execute("SELECT id FROM bank_codes WHERE id = ? FOR UPDATE", [bankAccountId]);
  if (!rows[0]) throw new HttpError(404, "Bank account not found");
}

// Call after lockBankAccount, inside the same transaction.
async function assertNoOverlap(conn, { companyId, bankAccountId, periodStart, periodEnd, excludeId = null }) {
  const [rows] = await conn.execute(
    `SELECT id, status, DATE_FORMAT(period_start, '%Y-%m-%d') AS periodStart, DATE_FORMAT(period_end, '%Y-%m-%d') AS periodEnd
     FROM bank_recon_sessions
     WHERE bank_account_id = ? AND company_id <=> ? AND period_start <= ? AND period_end >= ? AND (? IS NULL OR id <> ?)
     ORDER BY period_start, id
     FOR UPDATE`,
    [bankAccountId, companyId ?? null, periodEnd, periodStart, excludeId, excludeId]
  );
  const clash = rows[0];
  if (!clash) return;
  const details = { conflictingSessionId: clash.id, conflictingPeriod: { periodStart: clash.periodStart, periodEnd: clash.periodEnd }, conflictingStatus: clash.status };
  if (clash.periodStart === periodStart && clash.periodEnd === periodEnd) {
    throw conflict(409, `A reconciliation for this bank account and period already exists (session #${clash.id}, ${clash.status}). Open it instead of creating another.`, "SESSION_DUPLICATE", details);
  }
  throw conflict(
    409,
    `This period overlaps reconciliation session #${clash.id} (${clash.periodStart} to ${clash.periodEnd}, ${clash.status}). Reconciliation periods for one bank account cannot overlap.`,
    "SESSION_OVERLAP",
    details
  );
}

// { source: CARRIED, amount, fromSession, gapDays } or
// { source: MANUAL, reason: FIRST_SESSION | PREVIOUS_NOT_FINALIZED | NO_COMPANY, previousSession? }
async function resolveOpeningBalance(conn, { companyId, bankAccountId, periodStart }) {
  if (!companyId) return { source: OPENING_SOURCE.MANUAL, reason: "NO_COMPANY" };
  const [rows] = await conn.execute(
    `SELECT id, status, statement_ending_balance AS endingBalance,
            DATE_FORMAT(period_start, '%Y-%m-%d') AS periodStart, DATE_FORMAT(period_end, '%Y-%m-%d') AS periodEnd
     FROM bank_recon_sessions
     WHERE company_id = ? AND bank_account_id = ? AND period_end < ?
     ORDER BY period_end DESC, id DESC
     LIMIT 1`,
    [companyId, bankAccountId, periodStart]
  );
  const prev = rows[0];
  if (!prev) return { source: OPENING_SOURCE.MANUAL, reason: "FIRST_SESSION" };
  const previousSession = { id: prev.id, periodStart: prev.periodStart, periodEnd: prev.periodEnd, status: prev.status };
  if (prev.status !== "FINALIZED") {
    return { source: OPENING_SOURCE.MANUAL, reason: "PREVIOUS_NOT_FINALIZED", previousSession };
  }
  return {
    source: OPENING_SOURCE.CARRIED,
    amount: Number(prev.endingBalance),
    fromSession: { ...previousSession, endingBalance: Number(prev.endingBalance) },
    gapDays: Math.max(daysBetween(prev.periodEnd, periodStart) - 1, 0),
  };
}

function providedNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, "The opening balance must be a number.", "OPENING_BALANCE_INVALID");
  return Math.round(n * 100) / 100;
}

// Creates a session inside the caller's transaction. `input` carries the
// already-validated company, bank account and period plus the optional
// settings. Returns { id, opening }.
async function createSessionRecord(conn, { user, companyId, bankAccountId, periodStart, periodEnd, input = {}, auditPrefix = "" }) {
  await lockBankAccount(conn, bankAccountId);
  await assertNoOverlap(conn, { companyId, bankAccountId, periodStart, periodEnd });
  const opening = await resolveOpeningBalance(conn, { companyId, bankAccountId, periodStart });
  const requested = providedNumber(input.statementBeginningBalance);

  let beginning;
  if (opening.source === OPENING_SOURCE.CARRIED) {
    if (requested !== undefined && Math.abs(requested - opening.amount) > 0.005) {
      throw conflict(
        400,
        `The opening balance is carried from reconciliation session #${opening.fromSession.id} (${opening.fromSession.periodStart} to ${opening.fromSession.periodEnd}): ${opening.amount.toFixed(2)}. It cannot be replaced by a different figure.`,
        "OPENING_BALANCE_CARRIED",
        { opening }
      );
    }
    beginning = opening.amount;
  } else {
    if (requested === undefined) {
      throw conflict(
        400,
        opening.reason === "PREVIOUS_NOT_FINALIZED"
          ? `The previous reconciliation (session #${opening.previousSession.id}, ${opening.previousSession.periodStart} to ${opening.previousSession.periodEnd}) is not finalized, so its ending balance cannot be carried. Enter the opening balance.`
          : "There is no earlier finalized reconciliation for this bank account. Enter the opening balance.",
        "OPENING_BALANCE_REQUIRED",
        { opening }
      );
    }
    beginning = requested;
  }

  const [result] = await conn.execute(
    `INSERT INTO bank_recon_sessions(
      company_id, bank_account_id, period_start, period_end,
      statement_beginning_balance, opening_balance_source, opening_balance_source_session_id,
      statement_ending_balance, date_tolerance_days, amount_variance_type, amount_variance_value,
      status, notes, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      companyId,
      bankAccountId,
      periodStart,
      periodEnd,
      beginning,
      opening.source,
      opening.source === OPENING_SOURCE.CARRIED ? opening.fromSession.id : null,
      providedNumber(input.statementEndingBalance) ?? 0,
      Number(input.dateToleranceDays) || 3,
      input.amountVarianceType === "PERCENT" ? "PERCENT" : "FIXED",
      Number(input.amountVarianceValue) || 1.0,
      "IN_PROGRESS",
      input.notes || "",
      user?.id || null,
    ]
  );
  const sessionId = result.insertId;

  await logAudit(conn, {
    module: "BANK_RECON",
    entityType: "SESSION",
    entityId: sessionId,
    action: "CREATE",
    description: `${auditPrefix}Reconciliation session #${sessionId} created for bank account ${bankAccountId} (${periodStart} to ${periodEnd})`,
    afterData: {
      companyId,
      bankAccountId,
      periodStart,
      periodEnd,
      statementBeginningBalance: beginning,
      openingBalanceSource: opening.source,
      openingBalanceSourceSessionId: opening.source === OPENING_SOURCE.CARRIED ? opening.fromSession.id : null,
      statementEndingBalance: providedNumber(input.statementEndingBalance) ?? 0,
    },
    user,
    companyId,
  });

  return { id: sessionId, opening: { ...opening, amount: beginning } };
}

module.exports = {
  OPENING_SOURCE,
  lockBankAccount,
  assertNoOverlap,
  resolveOpeningBalance,
  createSessionRecord,
};
