const crypto = require("crypto");
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { HttpError } = require("../lib/httpError");
const PermissionService = require("./permissionService");
const { assertRecordAccess } = require("./bankReconAccessService");
const { BANK_RECON_SESSION_SELECT, loadCandidatePool, statementSetWhere, isInStatementSet } = require("./BankMatchingService");
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
const { depositPool, findDepositCombinations, classifyCombinations, GROUP_LEVEL } = require("./depositCombinationService");

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
//
// R8.4-B one-to-many deposits: a deposit no single document matches may be
// proposed as a COMBINATION of ORs that adds up exactly (see
// depositCombinationService). Its rows share one match_group and are only
// ever confirmed / unmatched together, by the accountant, never in strict
// mode (assistant or bulk).

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

    // R8.3: the session's slice of the bank account's statement history
    // (its period, plus earlier rows still unresolved).
    const set = statementSetWhere(session);
    const [stmtLines] = await conn.execute(
      `SELECT sl.id, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, sl.description,
              sl.reference_no AS referenceNo, sl.check_no AS checkNo, sl.debit, sl.credit
       FROM bank_recon_statement_lines sl
       WHERE ${set.sql} AND sl.match_status IN ('UNMATCHED', 'SUGGESTED')
       ORDER BY sl.txn_date, sl.id`,
      set.params
    );
    if (stmtLines.length === 0) {
      return { processed: 0, suggested: 0, message: "No unmatched statement lines to process" };
    }

    // Window documents plus older never-cleared ones (carry-forward).
    const bookTxns = await loadCandidatePool(conn, session);

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
    const groupsByLine = proposeDepositGroups(stmtLines, candidatesByLine, depositPool(bookTxns, confirmedKeys), session);

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
      const groups = groupsByLine.get(line.id) || [];
      for (const [i, g] of groups.entries()) {
        const groupId = crypto.randomUUID();
        const breakdown = {
          ...g.breakdown,
          matchLevel: g.level,
          ...(g.ambiguous ? { ambiguous: g.ambiguous } : {}),
          group: { option: i + 1, options: groups.length, size: g.members.length, totalCents: g.totalCents, namedCount: g.namedCount },
        };
        for (const m of g.members) {
          await conn.execute(
            `INSERT INTO bank_recon_matches(
              session_id, statement_line_id, book_source_type, book_source_id, book_line_id, match_group,
              match_type, confidence_score, score_breakdown, status, amount, created_by
            ) VALUES (?,?,?,?,?,?,?,?,?,'PENDING',?,?)`,
            [session.id, line.id, m.sourceType, m.sourceId, m.lineId, groupId, g.matchType, g.score, JSON.stringify(breakdown), m.amount, user.id]
          );
        }
      }

      const newStatus = candidates.length > 0 || groups.length > 0 ? "SUGGESTED" : "UNMATCHED";
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

// One-to-many proposals for deposit lines that no single document matches
// to the centavo (a one-to-one exact amount always wins). An OR that fits
// the combinations of two different deposits makes both ambiguous.
function proposeDepositGroups(stmtLines, candidatesByLine, orPool, session) {
  const groupsByLine = new Map();
  for (const line of stmtLines) {
    if (!(Number(line.credit) > 0)) continue;
    const target = Math.round(Number(line.credit) * 100);
    const singles = candidatesByLine.get(line.id) || [];
    if (singles.some((c) => Math.round(Number(c.amount) * 100) === target)) continue;
    const groups = classifyCombinations(findDepositCombinations(line, orPool, session));
    if (groups.length) groupsByLine.set(line.id, groups);
  }
  const linesByMember = new Map();
  for (const [lineId, groups] of groupsByLine) {
    for (const g of groups) {
      for (const m of g.members) {
        const k = bookKey(m);
        linesByMember.set(k, new Set([...(linesByMember.get(k) || []), lineId]));
      }
    }
  }
  for (const [lineId, groups] of groupsByLine) {
    groupsByLine.set(lineId, groups.map((g) => (g.matchType !== "AMBIGUOUS" && g.members.some((m) => linesByMember.get(bookKey(m)).size > 1)
      ? { ...g, matchType: "AMBIGUOUS", ambiguous: "a receipt in this combination also fits another deposit" }
      : g)));
  }
  return groupsByLine;
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

const peso = (v) => `₱${Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Plain-language reason for a suggestion, from the engine's own evidence -
// what the workspace shows and what the assistant repeats. Never computed
// by the assistant itself. `ctx` (statement line + candidate) lets it name
// the actual check / document and amounts.
function explainCandidate(matchType, breakdown, ctx = null) {
  const level = breakdown?.matchLevel;
  let base = {
    [MATCH_LEVEL.CHECK_NO]: "The check number and the amount match exactly.",
    [MATCH_LEVEL.REFERENCE]: "The document / reference number and the amount match exactly.",
    [MATCH_LEVEL.AMOUNT_DATE]: "Same amount and a date within tolerance, but no check or document number confirms it.",
    [MATCH_LEVEL.FUZZY]: "A partial match on amount, date or description.",
  }[level] || "Scored before the current evidence rules - run matching again.";
  if (ctx?.line && ctx?.candidate) {
    const { line, candidate } = ctx;
    const stmtAmount = Number(line.debit) > 0 ? line.debit : line.credit;
    const doc = `${candidate.bookSourceType} ${candidate.detail?.voucherNo || `#${candidate.bookSourceId}`}`;
    if (level === MATCH_LEVEL.CHECK_NO) {
      base = `Bank statement check ${line.checkNo || line.referenceNo} for ${peso(stmtAmount)} matches ${doc} for ${peso(candidate.amount)}: the check number and amount match exactly, and the ${candidate.bookSourceType} is posted to this company and bank account.`;
    } else if (level === MATCH_LEVEL.REFERENCE) {
      base = `Bank statement reference ${line.referenceNo || line.checkNo} for ${peso(stmtAmount)} matches ${doc} for ${peso(candidate.amount)}: the document / reference number and amount match exactly, and the ${candidate.bookSourceType} is posted to this company and bank account.`;
    } else if (level === MATCH_LEVEL.AMOUNT_DATE) {
      base = `${doc} has the same amount (${peso(candidate.amount)}) and a date within tolerance, but no check or document number confirms it.`;
    }
  }
  if (matchType === "AMBIGUOUS") {
    return `${base} Ambiguous: ${breakdown?.ambiguous || "more than one pairing fits"} - the accountant must choose in the workspace.`;
  }
  if (matchType === "EXACT") return `${base} Strong evidence - can be confirmed.`;
  return `${base} Review before confirming.`;
}

const listNames = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// Plain-language reason for a one-to-many proposal - the engine's own
// evidence, repeated verbatim by the workspace and the assistant.
function explainGroup(matchType, breakdown, line, members) {
  const deposit = Number(line?.credit) || 0;
  const total = members.reduce((s, m) => s + Number(m.amount), 0);
  const names = members.map((m) => m.voucherNo || `${m.bookSourceType} #${m.bookSourceId}`);
  let text = `Bank deposit ${peso(deposit)} has a deterministic candidate consisting of ${listNames(names)} totaling ${peso(total)}.`;
  text += breakdown?.matchLevel === GROUP_LEVEL.GROUP_REFERENCE
    ? " The bank statement names every one of these receipts."
    : " Only the amounts add up - nothing on the bank statement names these receipts.";
  if (matchType === "AMBIGUOUS") {
    return `${text} Ambiguous: ${breakdown?.ambiguous || "multiple possible combinations found"} - the accountant must choose in the workspace.`;
  }
  return `${text} Review and confirm the proposed match.`;
}

// Collapses the PENDING rows of one statement line into candidates: single
// documents stay as they are; rows sharing a match_group become ONE
// candidate listing its member ORs, their total and the difference.
// Rows carry: id, matchGroup, bookSourceType, bookSourceId, amount,
// matchType, confidenceScore, scoreBreakdown, voucherNo, txnDate, partyName.
function collapseGroupRows(rows, line) {
  const out = [];
  const groups = new Map();
  for (const r of rows) {
    if (!r.matchGroup) {
      out.push(r);
      continue;
    }
    if (!groups.has(r.matchGroup)) {
      const g = { matchGroup: r.matchGroup, rows: [] };
      groups.set(r.matchGroup, g);
      out.push(g);
    }
    groups.get(r.matchGroup).rows.push(r);
  }
  return out.map((c) => {
    if (!c.rows) return c;
    const first = c.rows[0];
    const breakdown = parseBreakdown(first.scoreBreakdown);
    const members = [...c.rows]
      .sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate)) || a.bookSourceId - b.bookSourceId)
      .map((r) => ({
        matchId: r.id,
        bookSourceType: r.bookSourceType,
        bookSourceId: r.bookSourceId,
        voucherNo: r.voucherNo,
        txnDate: r.txnDate,
        partyName: r.partyName,
        amount: Number(r.amount),
      }));
    const totalCents = members.reduce((s, m) => s + Math.round(m.amount * 100), 0);
    const depositCents = Math.round((Number(line?.credit) || 0) * 100);
    return {
      group: true,
      id: Math.min(...c.rows.map((r) => r.id)),
      matchGroup: c.matchGroup,
      matchIds: c.rows.map((r) => r.id).sort((a, b) => a - b),
      bookSourceType: "OR",
      matchType: first.matchType,
      confidenceScore: Number(first.confidenceScore),
      matchLevel: breakdown?.matchLevel || null,
      ambiguousReason: breakdown?.ambiguous || null,
      option: breakdown?.group?.option || null,
      options: breakdown?.group?.options || null,
      members,
      total: totalCents / 100,
      depositAmount: depositCents / 100,
      difference: (depositCents - totalCents) / 100,
      amount: totalCents / 100,
      strictExact: false,
      explanation: explainGroup(first.matchType, breakdown, line, members),
    };
  });
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
            m.book_line_id AS bookLineId, m.match_group AS matchGroup, m.match_type AS matchType, m.confidence_score AS confidenceScore,
            m.score_breakdown AS scoreBreakdown, m.status, m.amount,
            o.voucher_no AS voucherNo, o.customer_name AS partyName, DATE_FORMAT(o.transaction_date, '%Y-%m-%d') AS txnDate
     FROM bank_recon_matches m
     LEFT JOIN or_headers o ON m.match_group IS NOT NULL AND m.book_source_type = 'OR' AND o.id = m.book_source_id
     WHERE m.statement_line_id = ? AND m.status = 'PENDING'
     ORDER BY m.confidence_score DESC, m.id`,
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
  for (const row of collapseGroupRows(rows, statementLine)) {
    if (row.group) {
      candidates.push(row);
      continue;
    }
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
      explanation: explainCandidate(row.matchType, breakdown, { line: statementLine, candidate: { ...row, detail } }),
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

// R8.4-B: confirms a one-to-many proposal - every row of the group or none.
// Re-checks everything under lock: every row still PENDING and unchanged
// (and, when the client says which rows it reviewed, exactly those), every
// OR still posted, on this company + bank account, money in, base currency
// and not reconciled anywhere, and the ORs' bank movements still adding up
// to the deposit to the centavo. Any change is a 409; the caller's
// transaction rolls back, so nothing is ever partially confirmed.
async function confirmGroupLocked(conn, session, match, { user, strict, expectedMatchIds = null }) {
  if (strict) {
    throw new HttpError(
      409,
      "A deposit matched to several official receipts is never confirmed automatically. The accountant must review and confirm it in the workspace.",
      "MATCH_NOT_STRICT_EXACT"
    );
  }
  const [rows] = await conn.execute(
    "SELECT * FROM bank_recon_matches WHERE match_group = ? ORDER BY id FOR UPDATE",
    [match.match_group]
  );
  const stale = (message) => new HttpError(409, message, "GROUP_PROPOSAL_CHANGED");
  if (rows.some((r) => r.status !== "PENDING")) throw stale("This combination is no longer pending - refresh the reconciliation queue.");
  if (rows.some((r) => Number(r.session_id) !== Number(session.id) || Number(r.statement_line_id) !== Number(match.statement_line_id))) {
    throw stale("This combination changed - refresh the reconciliation queue.");
  }
  if (expectedMatchIds) {
    const want = [...new Set(expectedMatchIds.map(Number))].sort((a, b) => a - b).join(",");
    if (want !== rows.map((r) => Number(r.id)).join(",")) {
      throw stale("The proposed receipts changed since you reviewed them - refresh the reconciliation queue.");
    }
  }
  const line = await lockStatementLine(conn, match.statement_line_id);
  if (!(Number(line.credit) > 0)) throw stale("This statement line is no longer a deposit.");

  const ordered = [...rows].sort((a, b) => a.book_source_type.localeCompare(b.book_source_type) || a.book_source_id - b.book_source_id);
  const confirmed = [];
  let totalCents = 0;
  for (const r of ordered) {
    if (r.book_source_type !== "OR") throw stale("Only official receipts can be combined into one deposit.");
    const txn = await lockEligibleBookItem(conn, session, line, { sourceType: "OR", sourceId: r.book_source_id, lineId: null });
    if (txn.foreignCurrency) {
      throw new HttpError(409, `OR ${txn.voucherNo || r.book_source_id} is not in the company's base currency.`, "GROUP_CURRENCY_MISMATCH");
    }
    if (Math.round(txn.amount * 100) !== Math.round(Number(r.amount) * 100)) {
      throw stale(`OR ${txn.voucherNo || r.book_source_id} now moves ${peso(txn.amount)} through the bank, not ${peso(r.amount)} - refresh the reconciliation queue.`);
    }
    totalCents += Math.round(txn.amount * 100);
    confirmed.push({ id: r.id, sourceId: r.book_source_id, voucherNo: txn.voucherNo, amount: txn.amount });
  }
  if (totalCents !== Math.round(statementAmount(line) * 100)) {
    throw new HttpError(
      409,
      `The receipts total ${peso(totalCents / 100)}, but the deposit is ${peso(statementAmount(line))} - the combination no longer reconciles.`,
      "GROUP_AMOUNT_CHANGED"
    );
  }

  for (const c of confirmed) {
    await conn.execute(
      "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW(), amount = ? WHERE id = ?",
      [user.id, c.amount, c.id]
    );
  }
  await conn.execute(
    `UPDATE bank_recon_matches
     SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
     WHERE statement_line_id = ? AND status = 'PENDING' AND NOT (match_group <=> ?)`,
    [user.id, line.id, match.match_group]
  );
  await conn.execute("UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?", [line.id]);
  return { match, amount: totalCents / 100, members: confirmed };
}

// One locked confirmation of a PENDING suggestion inside the caller's
// transaction (session already locked). Returns the confirmed amount.
async function confirmLocked(conn, session, matchId, { user, strict, expectedMatchIds = null }) {
  const [[match]] = await conn.execute("SELECT * FROM bank_recon_matches WHERE id = ? FOR UPDATE", [matchId]);
  if (!match || Number(match.session_id) !== Number(session.id)) throw new HttpError(404, "Match not found");
  if (match.status !== "PENDING") {
    throw new HttpError(409, `Match is already ${match.status}`, "MATCH_NOT_PENDING");
  }
  if (match.match_group) return confirmGroupLocked(conn, session, match, { user, strict, expectedMatchIds });
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

async function confirmMatch({ matchId, user, channel = CHANNEL.WORKSPACE, strict = false, expectedMatchIds = null }) {
  const access = await authorize(user, "match", matchId, "CREATE");
  return withTransaction(async (conn) => {
    const session = await lockSession(conn, access.id);
    const { match, amount, members } = await confirmLocked(conn, session, matchId, { user, strict, expectedMatchIds });
    if (members) {
      const names = members.map((m) => `OR ${m.voucherNo || `#${m.sourceId}`}`).join(", ");
      await logAudit(conn, {
        module: "BANK_RECON",
        entityType: "MATCH",
        entityId: Number(matchId),
        action: "MATCH",
        description: `Confirmed one-to-many match: deposit statement line #${match.statement_line_id} <-> ${names} (${peso(amount)})`,
        beforeData: { status: "PENDING", matchGroup: match.match_group },
        afterData: {
          status: "CONFIRMED",
          matchGroup: match.match_group,
          amount,
          members: members.map((m) => ({ matchId: m.id, bookSourceType: "OR", bookSourceId: m.sourceId, voucherNo: m.voucherNo, amount: m.amount })),
          ...channelData(channel),
        },
        user,
        companyId: access.companyId,
      });
      return { matchId: Number(matchId), status: "CONFIRMED", amount, matchGroup: match.match_group, memberCount: members.length };
    }
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
      "SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING' AND match_type = 'EXACT' AND match_group IS NULL ORDER BY id",
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
// R8.3: `sessionId` is the session the accountant is working in (a carried
// row from January is matched in February's session); without it, the
// session the row was imported through. Either way the row must belong to
// that session's statement set (same company + bank account, not dated
// after the period).
async function createManualMatch({ statementLineId, bookSourceType, bookSourceId, bookLineId, amount, sessionId = null, user, channel = CHANNEL.WORKSPACE }) {
  if (!statementLineId || !bookSourceType || !bookSourceId) {
    throw new HttpError(400, "statementLineId, bookSourceType, and bookSourceId are required");
  }
  if (!["CV", "OR", "JV"].includes(bookSourceType)) throw new HttpError(400, "Invalid bookSourceType");
  if (bookSourceType === "JV" && !bookLineId) {
    throw new HttpError(400, "Select the journal voucher line that moved through the bank.");
  }

  const lineAccess = await authorize(user, "line", statementLineId, "CREATE");
  const access = sessionId ? await authorize(user, "session", sessionId, "CREATE") : lineAccess;
  return withTransaction(async (conn) => {
    const session = await lockSession(conn, access.id);
    if (!(await isInStatementSet(conn, session, statementLineId))) {
      throw new HttpError(404, "Statement line not found");
    }
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
  authorize,
  beginReadCommitted,
  lockSession,
  runMatching,
  listCandidates,
  explainCandidate,
  explainGroup,
  collapseGroupRows,
  confirmMatch,
  bulkConfirmExact,
  createManualMatch,
};
