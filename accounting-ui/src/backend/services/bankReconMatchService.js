const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const PermissionService = require("./permissionService");
const { assertRecordAccess } = require("./bankReconAccessService");
const { BANK_RECON_SESSION_SELECT, loadBookTransactions } = require("./BankMatchingService");
const {
  scoreCandidate,
  classifyAdjustmentSuggestion,
  bookKey,
  classifyLineCandidates,
  markCrossLineAmbiguity,
  isStrictExactRow,
  MATCH_LEVEL,
} = require("./ConfidenceScoringService");
const {
  lockStatementLine,
  lockEligibleBookItem,
  assertMatchAmount,
  statementAmount,
  asConflict,
} = require("./bankReconMatchGuard");

// The one authoritative Bank Reconciliation matching service (R8.1).
//
// Everything that suggests or decides a match lives here and is called by
// BOTH the workspace REST controller and the AI assistant's agent actions:
//   runMatching       - scores statement lines against book items (suggestions)
//   listCandidates    - the PENDING suggestions of one statement line, with
//                       their evidence level and a plain explanation
//   confirmMatch      - turns one suggestion into a CONFIRMED match
//   bulkConfirmExact  - confirms every single strict EXACT suggestion
//   createManualMatch - matches a statement line to a book item by hand
//
// Suggestion and confirmation are separate on purpose: runMatching only
// ever writes PENDING rows; only the confirm functions write CONFIRMED, and
// every confirmation goes through the same locked eligibility check
// (bankReconMatchGuard: Posted, company, bank account, direction,
// already-reconciled, server-derived amount).
//
// Every function authorizes the caller itself (Bank Reconciliation
// permission + the record's session company), whoever calls it - a route
// with its own middleware, or the AI. The company always comes from the
// record's session, never from the caller.
//
// `channel` is "WORKSPACE" or "AI_ASSISTANT". The audit event is the same
// either way - same module, entity, action, description and the real
// signed-in user - with `channel: "AI_ASSISTANT"` added to afterData when
// the request came through the assistant.
//
// `strict` (bulk confirmation, and every confirmation requested through the
// assistant): only a statement line's single EXACT suggestion backed by a
// check or document number with an identical amount. AMBIGUOUS and
// amount/date suggestions always need the accountant's own choice in the
// workspace.

const CHANNEL = { WORKSPACE: "WORKSPACE", AI_ASSISTANT: "AI_ASSISTANT" };

function channelData(channel) {
  return channel === CHANNEL.AI_ASSISTANT ? { channel } : {};
}

async function authorize(user, kind, recordId, action) {
  if (!user?.id) throw new HttpError(403, "Bank reconciliation actions require a signed-in user");
  const allowed = await PermissionService.can(user.id, "REPORTS.BANK_RECONCILIATION", action);
  if (!allowed) {
    throw new HttpError(403, action === "VIEW"
      ? "You do not have permission to view bank reconciliations."
      : "You do not have permission to change bank reconciliations.");
  }
  return assertRecordAccess(kind, recordId, user);
}

// Every confirming transaction runs under READ COMMITTED (each read after a
// lock wait sees what the other request committed) and takes its locks in
// one fixed order - session, statement line, book document.
async function beginReadCommitted(conn) {
  await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await conn.beginTransaction();
}

async function lockSession(conn, sessionId) {
  await conn.execute("SELECT id FROM bank_recon_sessions WHERE id = ? FOR UPDATE", [sessionId]);
  const [rows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [sessionId]);
  if (!rows[0]) throw new HttpError(404, "Reconciliation session not found");
  if (rows[0].status === "FINALIZED") throw new HttpError(400, "Cannot modify a finalized session");
  return rows[0];
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await beginReadCommitted(conn);
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw asConflict(err);
  } finally {
    conn.release();
  }
}

// ---- Suggestions ----

async function runMatching({ sessionId, user, channel = CHANNEL.WORKSPACE }) {
  const access = await authorize(user, "session", sessionId, "CREATE");
  const conn = await pool.getConnection();

  try {
    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [access.id]);
    if (sessionRows.length === 0) throw new HttpError(404, "Reconciliation session not found");
    const session = sessionRows[0];
    if (session.status === "FINALIZED") throw new HttpError(400, "Cannot run matching on a finalized session");

    const [stmtLines] = await conn.execute(
      `SELECT id, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description,
              reference_no AS referenceNo, check_no AS checkNo, debit, credit
       FROM bank_recon_statement_lines
       WHERE session_id = ? AND match_status IN ('UNMATCHED', 'SUGGESTED')`,
      [session.id]
    );
    if (stmtLines.length === 0) {
      return { processed: 0, suggested: 0, message: "No unmatched statement lines to process" };
    }

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays,
      session.companyId
    );

    // A document already CONFIRMED in any session of this company and bank
    // account is reconciled - never offered as a candidate again.
    const [confirmedRows] = await conn.execute(
      `SELECT m.book_source_type AS sourceType, m.book_source_id AS sourceId, m.book_line_id AS lineId
       FROM bank_recon_matches m
       JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.status = 'CONFIRMED' AND s.bank_account_id = ? AND s.company_id <=> ?`,
      [session.bankAccountId, session.companyId ?? null]
    );
    const confirmedKeys = new Set(confirmedRows.map(bookKey));

    // Score every line first, then decide EXACT vs AMBIGUOUS with the whole
    // statement in view (one document EXACT for two lines is ambiguous for both).
    const candidatesByLine = new Map();
    for (const line of stmtLines) {
      const wantDirection = Number(line.debit) > 0 ? "OUT" : "IN";
      const scored = bookTxns
        .filter((t) => t.direction === wantDirection)
        .filter((t) => !confirmedKeys.has(bookKey(t)))
        .map((t) => scoreCandidate(line, t, session))
        .filter((c) => c && c.totalScore >= 30);
      candidatesByLine.set(line.id, classifyLineCandidates(scored, 3));
    }
    markCrossLineAmbiguity(candidatesByLine);

    await conn.beginTransaction();

    let suggestedCount = 0;
    for (const line of stmtLines) {
      await conn.execute("DELETE FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING'", [line.id]);

      const candidates = candidatesByLine.get(line.id);
      for (const c of candidates) {
        await conn.execute(
          `INSERT INTO bank_recon_matches(
            session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
            match_type, confidence_score, score_breakdown, status, amount, created_by
          ) VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
          [session.id, line.id, c.sourceType, c.sourceId, c.lineId, c.matchType, c.totalScore, JSON.stringify(c.breakdown), c.amount, user.id]
        );
      }

      const newStatus = candidates.length > 0 ? "SUGGESTED" : "UNMATCHED";
      await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [newStatus, line.id]);
      if (newStatus === "SUGGESTED") suggestedCount++;

      // A line with no viable book match either explains itself (bank
      // charge/interest) or needs a human decision (OTHER) - either way it
      // becomes a PENDING adjustment suggestion, created once per line.
      if (newStatus === "UNMATCHED") {
        const [anyAdj] = await conn.execute("SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ?", [line.id]);
        if (anyAdj.length === 0) {
          const { adjustmentType, amount } = classifyAdjustmentSuggestion(line);
          await conn.execute(
            `INSERT INTO bank_recon_adjustments(
              session_id, statement_line_id, adjustment_type, amount, description, status
            ) VALUES (?,?,?,?,?, 'PENDING')`,
            [session.id, line.id, adjustmentType, amount, line.description || ""]
          );
        }
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(session.id),
      action: "MATCH",
      description: `Matching engine run on session #${session.id}: ${stmtLines.length} line(s) processed, ${suggestedCount} with suggestions`,
      afterData: { processed: stmtLines.length, suggested: suggestedCount, ...channelData(channel) },
      user,
      companyId: access.companyId,
    });

    await conn.commit();
    return {
      processed: stmtLines.length,
      suggested: suggestedCount,
      message: `Processed ${stmtLines.length} statement line(s), ${suggestedCount} with suggested matches`,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function parseBreakdown(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Plain-language reason for a suggestion, from the engine's own evidence -
// what the workspace shows and what the assistant repeats. Never computed
// by the assistant itself.
function explainCandidate(matchType, breakdown) {
  const level = breakdown?.matchLevel;
  const base = {
    [MATCH_LEVEL.CHECK_NO]: "The check number and the amount match exactly.",
    [MATCH_LEVEL.REFERENCE]: "The document / reference number and the amount match exactly.",
    [MATCH_LEVEL.AMOUNT_DATE]: "Same amount and a date within tolerance, but no check or document number confirms it.",
    [MATCH_LEVEL.FUZZY]: "A partial match on amount, date or description.",
  }[level] || "Scored before the current evidence rules - run matching again.";
  if (matchType === "AMBIGUOUS") {
    return `${base} Ambiguous: ${breakdown?.ambiguous || "more than one pairing fits"} - the accountant must choose in the workspace.`;
  }
  if (matchType === "EXACT") return `${base} Strong evidence - can be confirmed.`;
  return `${base} Review before confirming.`;
}

async function listCandidates({ statementLineId, user }) {
  const access = await authorize(user, "line", statementLineId, "VIEW");
  const companyId = access.companyId ?? null;

  const [lineRows] = await pool.execute(
    `SELECT id, session_id AS sessionId, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description,
            reference_no AS referenceNo, check_no AS checkNo, debit, credit, match_status AS matchStatus
     FROM bank_recon_statement_lines WHERE id = ?`,
    [statementLineId]
  );
  const statementLine = lineRows[0];

  const [rows] = await pool.execute(
    `SELECT m.id, m.book_source_type AS bookSourceType, m.book_source_id AS bookSourceId,
            m.book_line_id AS bookLineId, m.match_type AS matchType, m.confidence_score AS confidenceScore,
            m.score_breakdown AS scoreBreakdown, m.status, m.amount
     FROM bank_recon_matches m
     WHERE m.statement_line_id = ? AND m.status = 'PENDING'
     ORDER BY m.confidence_score DESC`,
    [statementLineId]
  );

  const DETAIL = {
    CV: `SELECT voucher_no AS voucherNo, payee_name AS payeeName, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                reference_no AS referenceNo, check_no AS checkNo, description
         FROM cv_headers WHERE id = ? AND (? IS NULL OR company_id = ?)`,
    OR: `SELECT voucher_no AS voucherNo, customer_name AS customerName, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                reference_no AS referenceNo, receipt_no AS receiptNo, check_no AS checkNo, description
         FROM or_headers WHERE id = ? AND (? IS NULL OR company_id = ?)`,
    JV: `SELECT jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor, DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
                jh.reference_no AS referenceNo, jh.description
         FROM jv_headers jh WHERE jh.id = ? AND (? IS NULL OR jh.company_id = ?)`,
  };

  const candidates = [];
  for (const row of rows) {
    let detail = null;
    if (DETAIL[row.bookSourceType]) {
      const [d] = await pool.execute(DETAIL[row.bookSourceType], [row.bookSourceId, companyId, companyId]);
      detail = d[0] || null;
    }
    const breakdown = parseBreakdown(row.scoreBreakdown);
    candidates.push({
      ...row,
      detail,
      matchLevel: breakdown?.matchLevel || null,
      ambiguousReason: breakdown?.ambiguous || null,
      explanation: explainCandidate(row.matchType, breakdown),
      strictExact: isStrictExactRow(row.matchType, breakdown),
    });
  }

  return { statementLine, candidates };
}

// ---- Confirmation ----

async function markConfirmed(conn, { matchId, statementLineId, amount, userId }) {
  await conn.execute(
    "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW(), amount = ? WHERE id = ?",
    [userId, amount, matchId]
  );
  await conn.execute(
    `UPDATE bank_recon_matches
     SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
     WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
    [userId, statementLineId, matchId]
  );
  await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [statementLineId]);
}

// The strict rule shared by bulk confirmation and every assistant-requested
// confirmation: the line's single strict EXACT suggestion, identical amount.
async function assertStrictExact(conn, match, line, txn) {
  if (!isStrictExactRow(match.match_type, match.score_breakdown)) {
    const kind = match.match_type === "AMBIGUOUS"
      ? "is AMBIGUOUS (more than one pairing fits)"
      : "is not backed by a check or document number";
    throw new HttpError(
      409,
      `This suggestion ${kind}, so it cannot be confirmed automatically. The accountant must review and confirm it in the workspace.`,
      "MATCH_NOT_STRICT_EXACT"
    );
  }
  const [others] = await conn.execute(
    "SELECT id, match_type AS matchType, score_breakdown AS scoreBreakdown FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?",
    [line.id, match.id]
  );
  if (others.some((o) => isStrictExactRow(o.matchType, o.scoreBreakdown))) {
    throw new HttpError(409, "More than one exact candidate for this statement line - choose one in the workspace.", "MATCH_NOT_STRICT_EXACT");
  }
  if (Math.round(statementAmount(line) * 100) !== Math.round(txn.amount * 100)) {
    throw new HttpError(409, "The amounts are no longer identical - review this match in the workspace.", "MATCH_NOT_STRICT_EXACT");
  }
}

// One locked confirmation of a PENDING suggestion inside the caller's
// transaction (session already locked). Returns the confirmed amount.
async function confirmLocked(conn, session, matchId, { user, strict }) {
  const [[match]] = await conn.execute("SELECT * FROM bank_recon_matches WHERE id = ? FOR UPDATE", [matchId]);
  if (!match || Number(match.session_id) !== Number(session.id)) throw new HttpError(404, "Match not found");
  if (match.status !== "PENDING") {
    throw new HttpError(409, `Match is already ${match.status}`, "MATCH_NOT_PENDING");
  }
  const line = await lockStatementLine(conn, match.statement_line_id);
  const txn = await lockEligibleBookItem(conn, session, line, {
    sourceType: match.book_source_type,
    sourceId: match.book_source_id,
    lineId: match.book_line_id,
  });
  if (strict) await assertStrictExact(conn, match, line, txn);
  await markConfirmed(conn, { matchId: match.id, statementLineId: line.id, amount: txn.amount, userId: user.id });
  return { match, amount: txn.amount };
}

async function confirmMatch({ matchId, user, channel = CHANNEL.WORKSPACE, strict = false }) {
  const access = await authorize(user, "match", matchId, "CREATE");
  return withTransaction(async (conn) => {
    const session = await lockSession(conn, access.id);
    const { match, amount } = await confirmLocked(conn, session, matchId, { user, strict });
    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(matchId),
      action: "MATCH",
      description: `Confirmed ${match.match_type} match: statement line #${match.statement_line_id} <-> ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "CONFIRMED", amount, ...channelData(channel) },
      user,
      companyId: access.companyId,
    });
    return { matchId: Number(matchId), status: "CONFIRMED", amount };
  });
}

async function bulkConfirmExact({ sessionId, user, channel = CHANNEL.WORKSPACE }) {
  const access = await authorize(user, "session", sessionId, "CREATE");
  return withTransaction(async (conn) => {
    const session = await lockSession(conn, access.id);
    const [exactRows] = await conn.execute(
      "SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING' AND match_type = 'EXACT' ORDER BY id",
      [session.id]
    );

    let confirmedCount = 0;
    const skipped = [];
    for (const { id } of exactRows) {
      try {
        await confirmLocked(conn, session, id, { user, strict: true });
        confirmedCount++;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        skipped.push({ matchId: id, reason: err.message });
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(session.id),
      action: "MATCH",
      description: `Bulk-confirmed ${confirmedCount} exact match(es) in session #${session.id}${skipped.length ? `, ${skipped.length} skipped` : ""}`,
      afterData: { confirmedCount, skippedCount: skipped.length, ...channelData(channel) },
      user,
      companyId: access.companyId,
    });

    return {
      confirmedCount,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 50),
      message: skipped.length
        ? `Confirmed ${confirmedCount} exact match(es). ${skipped.length} left for review.`
        : `Confirmed ${confirmedCount} exact match(es)`,
    };
  });
}

// The matched amount is the selected document's own bank movement, derived
// on the server. A client "amount" is only checked against it, and the
// statement amount must agree with it within the session variance.
async function createManualMatch({ statementLineId, bookSourceType, bookSourceId, bookLineId, amount, user, channel = CHANNEL.WORKSPACE }) {
  if (!statementLineId || !bookSourceType || !bookSourceId) {
    throw new HttpError(400, "statementLineId, bookSourceType, and bookSourceId are required");
  }
  if (!["CV", "OR", "JV"].includes(bookSourceType)) throw new HttpError(400, "Invalid bookSourceType");
  if (bookSourceType === "JV" && !bookLineId) {
    throw new HttpError(400, "Select the journal voucher line that moved through the bank.");
  }

  const access = await authorize(user, "line", statementLineId, "CREATE");
  return withTransaction(async (conn) => {
    const session = await lockSession(conn, access.id);
    const line = await lockStatementLine(conn, statementLineId);
    const txn = await lockEligibleBookItem(conn, session, line, {
      sourceType: bookSourceType,
      sourceId: bookSourceId,
      lineId: bookSourceType === "JV" ? bookLineId : null,
    });
    const matchAmount = assertMatchAmount(session, line, txn, amount);

    await conn.execute(
      `UPDATE bank_recon_matches
       SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
       WHERE statement_line_id = ? AND status = 'PENDING'`,
      [user.id, statementLineId]
    );
    const [result] = await conn.execute(
      `INSERT INTO bank_recon_matches(
        session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
        match_type, confidence_score, status, amount, created_by, matched_by, matched_at
      ) VALUES (?,?,?,?,?, 'MANUAL', NULL, 'CONFIRMED', ?, ?, ?, NOW())`,
      [session.id, statementLineId, bookSourceType, Number(bookSourceId), bookSourceType === "JV" ? Number(bookLineId) : null, matchAmount, user.id, user.id]
    );
    await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [statementLineId]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: result.insertId,
      action: "MATCH",
      description: `Manually matched statement line #${statementLineId} to ${bookSourceType} #${bookSourceId}`,
      afterData: { bookSourceType, bookSourceId, bookLineId, amount: matchAmount, ...channelData(channel) },
      user,
      companyId: access.companyId,
    });

    return { id: result.insertId, amount: matchAmount };
  });
}

module.exports = {
  CHANNEL,
  beginReadCommitted,
  lockSession,
  runMatching,
  listCandidates,
  explainCandidate,
  confirmMatch,
  bulkConfirmExact,
  createManualMatch,
};
