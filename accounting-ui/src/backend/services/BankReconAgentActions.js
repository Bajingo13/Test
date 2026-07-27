// Actions both AI providers (Anthropic and the deterministic mock) call
// into. This is the entire "AI can touch the system" surface - see the
// Tier 1 / Tier 2 split below. Nothing here decides a match or computes a
// score; that logic lives in BankMatchingService/ConfidenceScoringService
// and is identical to what the manual UI uses (BankReconController).
// Requirement: the matching engine itself never depends on AI - these
// functions are plain, provider-agnostic backend code that a deterministic
// parser can call exactly as well as an LLM tool-call can.
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const {
  BANK_RECON_SESSION_SELECT,
  loadBookTransactions,
  computeSessionSummary,
} = require("./BankMatchingService");
const { scoreCandidate, classifyAdjustmentSuggestion } = require("./ConfidenceScoringService");
const { resolveDateRange } = require("./PromptParser");

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

  const [existing] = await pool.execute(
    `${BANK_RECON_SESSION_SELECT} WHERE s.bank_account_id = ? AND s.period_start = ? AND s.period_end = ?`,
    [input.bankAccountId, periodStart, periodEnd]
  );

  if (existing.length > 0) {
    return { created: false, session: existing[0] };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_sessions(
        bank_account_id, period_start, period_end,
        statement_beginning_balance, statement_ending_balance,
        date_tolerance_days, amount_variance_type, amount_variance_value,
        status, notes, created_by
      ) VALUES (?,?,?,0,0,?,?,?, 'IN_PROGRESS', ?, ?)`,
      [
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
     WHERE sl.session_id = ? AND m.status = 'PENDING' AND m.confidence_score < ?
     ORDER BY m.confidence_score ASC`,
    [sessionId, thresholdPercent]
  );
  return rows;
}

async function runMatchingForSession(sessionId, user) {
  const conn = await pool.getConnection();

  try {
    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [
      sessionId,
    ]);
    if (sessionRows.length === 0) throw new HttpError(404, "Reconciliation session not found");

    const session = sessionRows[0];
    if (session.status === "FINALIZED") {
      throw new HttpError(400, "Cannot run matching on a finalized session");
    }

    const [stmtLines] = await conn.execute(
      `SELECT id, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description,
              reference_no AS referenceNo, check_no AS checkNo, debit, credit
       FROM bank_recon_statement_lines
       WHERE session_id = ? AND match_status IN ('UNMATCHED', 'SUGGESTED')`,
      [sessionId]
    );

    if (stmtLines.length === 0) {
      return { processed: 0, suggested: 0 };
    }

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'`,
      [sessionId]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    await conn.beginTransaction();

    let suggestedCount = 0;

    for (const line of stmtLines) {
      await conn.execute(
        "DELETE FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING'",
        [line.id]
      );

      const wantDirection = Number(line.debit) > 0 ? "OUT" : "IN";

      const candidates = bookTxns
        .filter((t) => t.direction === wantDirection)
        .filter((t) => !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`))
        .map((t) => scoreCandidate(line, t, session))
        .filter((c) => c && c.totalScore >= 30)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 3);

      for (const c of candidates) {
        await conn.execute(
          `INSERT INTO bank_recon_matches(
            session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
            match_type, confidence_score, score_breakdown, status, amount, created_by
          ) VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
          [
            sessionId,
            line.id,
            c.sourceType,
            c.sourceId,
            c.lineId,
            c.matchType,
            c.totalScore,
            JSON.stringify(c.breakdown),
            c.amount,
            user?.id || null,
          ]
        );
      }

      const newStatus = candidates.length > 0 ? "SUGGESTED" : "UNMATCHED";
      await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [
        newStatus,
        line.id,
      ]);
      if (newStatus === "SUGGESTED") suggestedCount++;

      if (newStatus === "UNMATCHED") {
        const [existingAdj] = await conn.execute(
          "SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ?",
          [line.id]
        );
        if (existingAdj.length === 0) {
          const { adjustmentType, amount } = classifyAdjustmentSuggestion(line);
          await conn.execute(
            `INSERT INTO bank_recon_adjustments(
              session_id, statement_line_id, adjustment_type, amount, description, status
            ) VALUES (?,?,?,?,?, 'PENDING')`,
            [sessionId, line.id, adjustmentType, amount, line.description || ""]
          );
        }
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(sessionId),
      action: "MATCH",
      description: `[AI Agent] Matching engine run on session #${sessionId}: ${stmtLines.length} line(s) processed, ${suggestedCount} with suggestions`,
      afterData: { processed: stmtLines.length, suggested: suggestedCount },
      user,
    });

    await conn.commit();

    return { processed: stmtLines.length, suggested: suggestedCount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
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

async function confirmMatch(matchId, user) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT m.*, s.status AS sessionStatus
       FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
      [matchId]
    );
    if (rows.length === 0) throw new HttpError(404, "Match not found");
    const match = rows[0];
    if (match.sessionStatus === "FINALIZED") throw new HttpError(400, "Cannot modify a finalized session");
    if (match.status !== "PENDING") throw new HttpError(400, `Match is already ${match.status}`);

    const userId = user?.id || null;
    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW() WHERE id = ?",
      [userId, matchId]
    );
    await conn.execute(
      `UPDATE bank_recon_matches SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
       WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
      [userId, match.statement_line_id, matchId]
    );
    await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [
      match.statement_line_id,
    ]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(matchId),
      action: "MATCH",
      description: `[AI Agent] Confirmed ${match.match_type} match: statement line #${match.statement_line_id} <-> ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "CONFIRMED" },
      user,
    });

    await conn.commit();
    return { matchId, status: "CONFIRMED" };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function bulkConfirmExact(sessionId, user) {
  const conn = await pool.getConnection();
  try {
    const [sessionRows] = await conn.execute("SELECT status FROM bank_recon_sessions WHERE id = ?", [
      sessionId,
    ]);
    if (sessionRows.length === 0) throw new HttpError(404, "Reconciliation session not found");
    if (sessionRows[0].status === "FINALIZED") throw new HttpError(400, "Cannot modify a finalized session");

    const [exactMatches] = await conn.execute(
      "SELECT id, statement_line_id AS statementLineId FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING' AND match_type = 'EXACT'",
      [sessionId]
    );

    const userId = user?.id || null;
    await conn.beginTransaction();

    for (const m of exactMatches) {
      await conn.execute(
        "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW() WHERE id = ?",
        [userId, m.id]
      );
      await conn.execute(
        `UPDATE bank_recon_matches SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
         WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
        [userId, m.statementLineId, m.id]
      );
      await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [
        m.statementLineId,
      ]);
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(sessionId),
      action: "MATCH",
      description: `[AI Agent] Bulk-confirmed ${exactMatches.length} exact match(es) in session #${sessionId}`,
      afterData: { confirmedCount: exactMatches.length },
      user,
    });

    await conn.commit();
    return { confirmedCount: exactMatches.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  listBankAccounts,
  findOrCreateSession,
  getSession,
  getSessionSummary,
  getOutstandingItems,
  listAdjustments,
  getLowConfidenceLines,
  runMatchingForSession,
  updateSessionTolerance,
  confirmMatch,
  bulkConfirmExact,
};
