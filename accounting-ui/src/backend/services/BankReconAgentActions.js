// Actions both AI providers (Anthropic and the deterministic mock) call
// into. This is the entire "AI can touch the system" surface - see the
// Tier 1 / Tier 2 split below. Nothing here decides, scores or confirms a
// match: running the matcher, listing candidates and every confirmation go
// through bankReconMatchService, the same service the workspace REST
// controller uses (R8.1), on the AI_ASSISTANT channel.
// Requirement: the matching engine itself never depends on AI - these
// functions are plain, provider-agnostic backend code that a deterministic
// parser can call exactly as well as an LLM tool-call can.
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const { BANK_RECON_SESSION_SELECT, computeSessionSummary } = require("./BankMatchingService");
const MatchService = require("./bankReconMatchService");
const QueueService = require("./bankReconQueueService");
const { resolveDateRange } = require("./PromptParser");
const { AsyncLocalStorage } = require("async_hooks");
const PermissionService = require("./permissionService");
const {
  assertSessionAccess,
  assertRecordAccess,
  resolveCompanyForNewSession,
} = require("./bankReconAccessService");

// ---- Access control for every agent action ----
// The AI route itself only requires REPORTS.AI_RECONCILIATION/VIEW. Each turn
// runs inside runAs(user, ...), and every exported action below goes through
// a guard that (1) takes the user from that context - never from the
// provider - (2) applies the same session/company guard as the REST routes,
// and (3) requires the same Bank Reconciliation permission the equivalent
// manual action needs (VIEW to read, CREATE to change). Outside runAs every
// action is refused.
const agentContext = new AsyncLocalStorage();

function runAs(user, fn) {
  return agentContext.run({ user, companyId: null }, fn);
}

function contextOrDeny() {
  const ctx = agentContext.getStore();
  if (!ctx?.user) throw new HttpError(403, "AI reconciliation actions require a signed-in user");
  return ctx;
}

// Company of the session the current action is working on (audit rows).
function agentCompany() {
  return agentContext.getStore()?.companyId ?? null;
}

async function requireReconPermission(user, action) {
  const allowed = await PermissionService.can(user.id, "REPORTS.BANK_RECONCILIATION", action);
  if (!allowed) {
    throw new HttpError(403, action === "VIEW"
      ? "You do not have permission to view bank reconciliations."
      : "You do not have permission to change bank reconciliations.");
  }
}

// ---- Tier 1: always available (read-only or safely-reversible staging) ----

async function listBankAccounts() {
  const [rows] = await pool.execute(
    `SELECT id, bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo, account_name AS accountName
     FROM bank_codes WHERE status = 'ACTIVE' ORDER BY bank_code ASC`
  );
  return rows;
}

async function findOrCreateSession(input, user) {
  const { periodStart, periodEnd } = resolveDateRange(input);

  if (!input.bankAccountId) {
    throw new HttpError(400, "bankAccountId is required");
  }

  const companyId = await resolveCompanyForNewSession(user, input.companyId);
  const ctx = agentContext.getStore();
  if (ctx) ctx.companyId = companyId;

  const [existing] = await pool.execute(
    `${BANK_RECON_SESSION_SELECT} WHERE s.company_id = ? AND s.bank_account_id = ? AND s.period_start = ? AND s.period_end = ?`,
    [companyId, input.bankAccountId, periodStart, periodEnd]
  );

  if (existing.length > 0) {
    return { created: false, session: existing[0] };
  }

  await requireReconPermission(user, "CREATE");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_sessions(
        company_id, bank_account_id, period_start, period_end,
        statement_beginning_balance, statement_ending_balance,
        date_tolerance_days, amount_variance_type, amount_variance_value,
        status, notes, created_by
      ) VALUES (?,?,?,?,0,0,?,?,?, 'IN_PROGRESS', ?, ?)`,
      [
        companyId,
        input.bankAccountId,
        periodStart,
        periodEnd,
        input.dateToleranceDays || 3,
        input.amountVarianceType || "FIXED",
        input.amountVarianceValue || 1.0,
        "[AI Agent] Created from a chat prompt",
        user?.id || null,
      ]
    );

    const sessionId = result.insertId;

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: sessionId,
      action: "CREATE",
      description: `[AI Agent] Reconciliation session #${sessionId} created for bank account ${input.bankAccountId} (${periodStart} to ${periodEnd})`,
      afterData: { bankAccountId: input.bankAccountId, periodStart, periodEnd },
      user,
      companyId: agentCompany(),
    });

    await conn.commit();

    const [rows] = await pool.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [sessionId]);
    return { created: true, session: rows[0] };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getSession(sessionId) {
  const [rows] = await pool.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [sessionId]);
  if (rows.length === 0) {
    throw new HttpError(404, "Reconciliation session not found");
  }
  return rows[0];
}

async function getSessionSummary(sessionId) {
  const session = await getSession(sessionId);
  const conn = await pool.getConnection();
  try {
    const summary = await computeSessionSummary(conn, session);
    return { session, summary };
  } finally {
    conn.release();
  }
}

async function getOutstandingItems(sessionId) {
  const session = await getSession(sessionId);
  const { summary } = await getSessionSummary(sessionId);
  return {
    session,
    outstandingChecks: summary.outstandingChecks,
    depositsInTransit: summary.depositsInTransit,
  };
}

async function listAdjustments(sessionId) {
  const [rows] = await pool.execute(
    `SELECT
      a.id, a.statement_line_id AS statementLineId, a.adjustment_type AS adjustmentType,
      a.suggested_account_id AS suggestedAccountId, a.amount, a.description, a.status,
      a.jv_id AS jvId, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
      sl.reference_no AS referenceNo, sl.check_no AS checkNo
     FROM bank_recon_adjustments a
     JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
     WHERE a.session_id = ?
     ORDER BY a.status = 'PENDING' DESC, sl.txn_date ASC`,
    [sessionId]
  );
  return rows;
}

async function getLowConfidenceLines(sessionId, thresholdPercent) {
  const [rows] = await pool.execute(
    `SELECT m.id, m.statement_line_id AS statementLineId, m.book_source_type AS bookSourceType,
            m.book_source_id AS bookSourceId, m.confidence_score AS confidenceScore, m.amount,
            DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, sl.description
     FROM bank_recon_matches m
     JOIN bank_recon_statement_lines sl ON sl.id = m.statement_line_id
     WHERE m.session_id = ? AND m.status = 'PENDING' AND m.confidence_score < ?
     ORDER BY m.confidence_score ASC`,
    [sessionId, thresholdPercent]
  );
  return rows;
}

// Same engine, same suggestions, same audit event as the workspace's
// "Run Matching" (it only ever writes PENDING suggestions).
async function runMatchingForSession(sessionId, user) {
  const { processed, suggested } = await MatchService.runMatching({ sessionId, user, channel: MatchService.CHANNEL.AI_ASSISTANT });
  return { processed, suggested };
}

// Advisory: exactly the candidate list the workspace shows for a statement
// line - the engine's evidence level, AMBIGUOUS reason and plain
// explanation - for the assistant to relay, never to re-score.
async function getMatchCandidates(statementLineId, user) {
  return MatchService.listCandidates({ statementLineId, user });
}

// Advisory (R8.3): the session's reconciliation queue - exactly what the
// workspace shows: high-confidence matches, items to review, unmatched bank
// and book items, and exceptions, each with the engine's own explanation.
async function getReconciliationQueue(sessionId, user) {
  return QueueService.buildQueue({ sessionId, user });
}

// Deliberately narrower than the REST PATCH /sessions/:id endpoint - only
// the matching-engine knobs, never statementBeginningBalance/EndingBalance.
// Those are facts from the real bank statement; an AI (or a keyword parser)
// silently "correcting" them would be exactly the kind of AI-decides-a-
// number behavior this whole module is designed to prevent.
async function updateSessionTolerance(sessionId, input, user) {
  const conn = await pool.getConnection();
  try {
    const [existingRows] = await conn.execute(
      "SELECT date_tolerance_days, amount_variance_type, amount_variance_value, status FROM bank_recon_sessions WHERE id = ?",
      [sessionId]
    );
    if (existingRows.length === 0) throw new HttpError(404, "Reconciliation session not found");
    const existing = existingRows[0];
    if (existing.status === "FINALIZED") {
      throw new HttpError(400, "Cannot edit a finalized session. Reopen it first.");
    }

    const next = {
      dateToleranceDays:
        input.dateToleranceDays !== undefined
          ? Number(input.dateToleranceDays)
          : existing.date_tolerance_days,
      amountVarianceType:
        input.amountVarianceType === "PERCENT" || input.amountVarianceType === "FIXED"
          ? input.amountVarianceType
          : existing.amount_variance_type,
      amountVarianceValue:
        input.amountVarianceValue !== undefined
          ? Number(input.amountVarianceValue)
          : existing.amount_variance_value,
    };

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_sessions SET date_tolerance_days = ?, amount_variance_type = ?, amount_variance_value = ? WHERE id = ?",
      [next.dateToleranceDays, next.amountVarianceType, next.amountVarianceValue, sessionId]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(sessionId),
      action: "CONFIG_UPDATE",
      description: `[AI Agent] Reconciliation session #${sessionId} tolerance/variance updated`,
      beforeData: existing,
      afterData: next,
      user,
      companyId: agentCompany(),
    });

    await conn.commit();
    return next;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---- Tier 2: only on an explicit imperative in the user's own message ----
// (the caller - MockProvider/AnthropicProvider - enforces that gating
// before calling these; these functions themselves don't re-check phrasing)
//
// Both go through bankReconMatchService with strict rules: only a statement
// line's single EXACT suggestion (check or document number + identical
// amount) can be confirmed from the assistant. AMBIGUOUS and amount/date
// suggestions are refused (409 MATCH_NOT_STRICT_EXACT) and left for the
// accountant's own choice in the workspace. The matched amount, company,
// bank account, Posted status and already-reconciled checks are the same
// locked server-side checks as every other confirmation; there is no
// assistant parameter for any of them.

async function confirmMatch(matchId, user) {
  return MatchService.confirmMatch({ matchId, user, channel: MatchService.CHANNEL.AI_ASSISTANT, strict: true });
}

async function bulkConfirmExact(sessionId, user) {
  return MatchService.bulkConfirmExact({ sessionId, user, channel: MatchService.CHANNEL.AI_ASSISTANT });
}

// Guard wrappers. `kind` names how the first argument maps to a session;
// the user always comes from runAs(), replacing whatever the caller passed.
function guarded(fn, { kind = null, permission = "VIEW", passUser = false } = {}) {
  return async (...args) => {
    const ctx = contextOrDeny();
    await requireReconPermission(ctx.user, permission);
    if (kind) {
      const session = await assertRecordAccess(kind, args[0], ctx.user);
      ctx.companyId = session.companyId;
    }
    if (passUser) args[fn.length - 1] = ctx.user;
    return fn(...args);
  };
}

module.exports = {
  runAs,
  listBankAccounts: guarded(listBankAccounts),
  // creates only when needed - CREATE is required inside, at that point
  findOrCreateSession: guarded(findOrCreateSession, { passUser: true }),
  getSession: guarded(getSession, { kind: "session" }),
  getSessionSummary: guarded(getSessionSummary, { kind: "session" }),
  getOutstandingItems: guarded(getOutstandingItems, { kind: "session" }),
  listAdjustments: guarded(listAdjustments, { kind: "session" }),
  getLowConfidenceLines: guarded(getLowConfidenceLines, { kind: "session" }),
  getMatchCandidates: guarded(getMatchCandidates, { kind: "line", passUser: true }),
  getReconciliationQueue: guarded(getReconciliationQueue, { kind: "session", passUser: true }),
  runMatchingForSession: guarded(runMatchingForSession, { kind: "session", permission: "CREATE", passUser: true }),
  updateSessionTolerance: guarded(updateSessionTolerance, { kind: "session", permission: "CREATE", passUser: true }),
  confirmMatch: guarded(confirmMatch, { kind: "match", permission: "CREATE", passUser: true }),
  bulkConfirmExact: guarded(bulkConfirmExact, { kind: "session", permission: "CREATE", passUser: true }),
};
