const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const { BANK_RECON_SESSION_SELECT, statementSetWhere } = require("./BankMatchingService");
const { resolveCompanyForNewSession } = require("./bankReconAccessService");
const { round2 } = require("./ConfidenceScoringService");
const MatchService = require("./bankReconMatchService");
const QueueService = require("./bankReconQueueService");

// Bank statement history (R8.4-C): a read-only review / investigation view
// of the imported statement rows of ONE company + bank account.
//
// Nothing here suggests, scores, confirms or changes anything. Statuses come
// from the stored reconciliation state (match_status, CONFIRMED matches) and,
// for unresolved rows, from the reconciliation queue of the bank account's
// latest session - the same deterministic result the workspace and the AI
// assistant see. Explanations come from bankReconMatchService. Confirming,
// unmatching and ignoring stay in the workspace's existing routes.
//
// Display status (one per row):
//   MATCHED       match_status MATCHED (a CONFIRMED match)
//   IGNORED       match_status IGNORED
//   EXCEPTION     unresolved and listed as an exception by the queue
//   NEEDS_REVIEW  unresolved with suggested matches (or "manual review
//                 required" in the queue)
//   UNMATCHED     unresolved, nothing proposed
// Flags (independent): carriedForward, possibleDuplicate, highConfidence.
//
// carriedForward: the row is worked on in a LATER session of the same
// company + bank account than the one it was imported through - still
// unresolved while a later session exists, or confirmed by a later session.
// possibleDuplicate: a pre-R8.2 row with no fingerprint (the same rule the
// queue uses); the database fingerprint stays authoritative.

const STATUS = ["MATCHED", "UNMATCHED", "NEEDS_REVIEW", "EXCEPTION", "CARRIED_FORWARD", "IGNORED", "POSSIBLE_DUPLICATE"];
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

const CARRIED_SQL = `EXISTS (
  SELECT 1 FROM bank_recon_sessions cs
  WHERE cs.company_id = sl.company_id AND cs.bank_account_id = sl.bank_account_id
    AND cs.id <> sl.session_id AND cs.period_start > sl.txn_date
    AND (sl.match_status IN ('UNMATCHED', 'SUGGESTED')
         OR EXISTS (SELECT 1 FROM bank_recon_matches ccm
                    WHERE ccm.statement_line_id = sl.id AND ccm.session_id = cs.id AND ccm.status = 'CONFIRMED')))`;
const DUPLICATE_SQL = "(sl.company_id IS NOT NULL AND sl.row_fingerprint IS NULL)";

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const present = (v) => v !== undefined && v !== null && v !== "";

function toPositiveId(value, label) {
  if (!present(value)) return null;
  const s = String(value);
  if (!/^[1-9][0-9]{0,9}$/.test(s)) throw new HttpError(400, `Invalid ${label}.`, "INVALID_ID");
  return Number(s);
}

function toAmount(value, label) {
  if (!present(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !/^\d+(\.\d{1,2})?$/.test(String(value).trim())) {
    throw new HttpError(400, `${label} must be a non-negative amount.`, "INVALID_AMOUNT");
  }
  return n;
}

// Company + bank account the history is for. The company comes from the
// same resolver new sessions use: an explicit, permitted company - or the
// user's only company. A Super Admin / multi-company user must choose one.
async function resolveScope(user, query) {
  const bankAccountId = toPositiveId(query.bankAccountId, "bank account");
  if (!bankAccountId) throw new HttpError(400, "Select a bank account.", "BANK_ACCOUNT_REQUIRED");
  const companyId = await resolveCompanyForNewSession(user, query.companyId);
  const [[bank]] = await pool.execute(
    "SELECT id, bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo FROM bank_codes WHERE id = ?",
    [bankAccountId]
  );
  if (!bank) throw new HttpError(404, "Bank account not found");
  const [[company]] = await pool.execute("SELECT id, name FROM companies WHERE id = ?", [companyId]);
  return { companyId, bankAccountId, bank, companyName: company?.name || null };
}

async function scopeSessions(scope) {
  const [rows] = await pool.execute(
    `SELECT id, DATE_FORMAT(period_start, '%Y-%m-%d') AS periodStart, DATE_FORMAT(period_end, '%Y-%m-%d') AS periodEnd, status
     FROM bank_recon_sessions WHERE company_id = ? AND bank_account_id = ?
     ORDER BY period_start DESC, id DESC`,
    [scope.companyId, scope.bankAccountId]
  );
  return rows;
}

// The queue of the bank account's latest session: every unresolved row of
// the shared history is in that session's statement set (R8.3), so its
// exceptions / needs-review / high-confidence lists classify them all.
async function queueClassification(user, sessions) {
  const empty = { exception: new Map(), review: new Set(), high: new Set(), sessionId: null };
  const latest = sessions[0];
  if (!latest) return empty;
  const queue = await QueueService.buildQueue({ sessionId: latest.id, user });
  const exception = new Map();
  for (const e of queue.exceptions) {
    if (!e.line || e.type === QueueService.EXCEPTION.POSSIBLE_DUPLICATE_IMPORT) continue;
    exception.set(e.line.id, [...(exception.get(e.line.id) || []), { type: e.type, message: e.message }]);
  }
  return {
    exception,
    review: new Set(queue.needsReview.map((r) => r.line.id)),
    high: new Set(queue.highConfidence.map((h) => h.line.id)),
    sessionId: latest.id,
    queue,
  };
}

function displayStatus(row, cls) {
  if (row.matchStatus === "MATCHED") return "MATCHED";
  if (row.matchStatus === "IGNORED") return "IGNORED";
  if (cls.exception.has(row.id)) return "EXCEPTION";
  if (row.matchStatus === "SUGGESTED" || cls.review.has(row.id) || cls.high.has(row.id)) return "NEEDS_REVIEW";
  return "UNMATCHED";
}

function parseFilters(query) {
  const f = {};
  if (present(query.from)) {
    if (!isDate(query.from)) throw new HttpError(400, "From must be a YYYY-MM-DD date.", "INVALID_DATE");
    f.from = query.from;
  }
  if (present(query.to)) {
    if (!isDate(query.to)) throw new HttpError(400, "To must be a YYYY-MM-DD date.", "INVALID_DATE");
    f.to = query.to;
  }
  if (f.from && f.to && f.to < f.from) throw new HttpError(400, "To cannot be before From.", "INVALID_DATE");
  const status = present(query.status) ? String(query.status).toUpperCase() : "ALL";
  if (status !== "ALL" && !STATUS.includes(status)) throw new HttpError(400, "Unknown status filter.", "INVALID_STATUS");
  f.status = status;
  const type = present(query.type) ? String(query.type).toUpperCase() : "ALL";
  if (!["ALL", "DEBIT", "CREDIT"].includes(type)) throw new HttpError(400, "Transaction type must be Debit, Credit or All.", "INVALID_TYPE");
  f.type = type;
  if (present(query.q)) {
    const q = String(query.q).trim();
    if (q.length > 100) throw new HttpError(400, "Search text is too long.", "INVALID_SEARCH");
    if (q) f.q = q;
  }
  f.amountMin = toAmount(query.amountMin, "Minimum amount");
  f.amountMax = toAmount(query.amountMax, "Maximum amount");
  if (f.amountMin !== null && f.amountMax !== null && f.amountMax < f.amountMin) {
    throw new HttpError(400, "Maximum amount cannot be below the minimum.", "INVALID_AMOUNT");
  }
  f.sessionId = toPositiveId(query.sessionId, "session");
  f.batchId = toPositiveId(query.batchId, "import batch");
  const page = present(query.page) ? toPositiveId(query.page, "page") : 1;
  const pageSize = present(query.pageSize) ? toPositiveId(query.pageSize, "page size") : PAGE_SIZE_DEFAULT;
  f.page = page;
  f.pageSize = Math.min(pageSize, PAGE_SIZE_MAX);
  return f;
}

const idList = (ids) => (ids.length ? ids : [0]);

async function listHistory({ user, query }) {
  const scope = await resolveScope(user, query);
  const f = parseFilters(query);
  const sessions = await scopeSessions(scope);

  const where = ["sl.company_id = ?", "sl.bank_account_id = ?"];
  const params = [scope.companyId, scope.bankAccountId];
  if (f.from) { where.push("sl.txn_date >= ?"); params.push(f.from); }
  if (f.to) { where.push("sl.txn_date <= ?"); params.push(f.to); }
  if (f.type === "DEBIT") where.push("sl.debit > 0");
  if (f.type === "CREDIT") where.push("sl.credit > 0");
  if (f.amountMin !== null) { where.push("GREATEST(sl.debit, sl.credit) >= ?"); params.push(f.amountMin); }
  if (f.amountMax !== null) { where.push("GREATEST(sl.debit, sl.credit) <= ?"); params.push(f.amountMax); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const stripped = f.q.toLowerCase().replace(/^0+(?=\d)/, "");
    where.push(`(sl.check_no LIKE ? OR sl.reference_no LIKE ? OR sl.bank_reference LIKE ? OR sl.description LIKE ?
                 OR sl.check_no_normalized = ? OR sl.reference_no_normalized = ?)`);
    params.push(like, like, like, like, stripped, stripped);
  }
  if (f.batchId) {
    const [[batch]] = await pool.execute(
      "SELECT id FROM bank_recon_import_batches WHERE id = ? AND company_id = ? AND bank_account_id = ?",
      [f.batchId, scope.companyId, scope.bankAccountId]
    );
    if (!batch) throw new HttpError(404, "Import batch not found");
    where.push("sl.batch_id = ?");
    params.push(f.batchId);
  }
  if (f.sessionId) {
    const session = sessions.find((s) => Number(s.id) === f.sessionId);
    if (!session) throw new HttpError(404, "Reconciliation session not found");
    const [[full]] = await pool.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [f.sessionId]);
    const set = statementSetWhere(full);
    where.push(set.sql);
    params.push(...set.params);
  }

  // The queue is only needed when it decides the filter or the page has
  // unresolved rows (built once per request).
  let cls = null;
  const classification = async () => {
    if (!cls) cls = await queueClassification(user, sessions);
    return cls;
  };
  const exceptionIds = async () => [...(await classification()).exception.keys()];
  const reviewIds = async () => {
    const c = await classification();
    return [...new Set([...c.review, ...c.high])];
  };
  switch (f.status) {
    case "MATCHED": where.push("sl.match_status = 'MATCHED'"); break;
    case "IGNORED": where.push("sl.match_status = 'IGNORED'"); break;
    case "POSSIBLE_DUPLICATE": where.push(DUPLICATE_SQL); break;
    case "CARRIED_FORWARD": where.push(CARRIED_SQL); break;
    case "EXCEPTION":
      where.push("sl.id IN (?)");
      params.push(idList(await exceptionIds()));
      break;
    case "NEEDS_REVIEW":
      where.push("(sl.match_status = 'SUGGESTED' OR (sl.match_status = 'UNMATCHED' AND sl.id IN (?))) AND sl.id NOT IN (?)");
      params.push(idList(await reviewIds()), idList(await exceptionIds()));
      break;
    case "UNMATCHED":
      where.push("sl.match_status = 'UNMATCHED' AND sl.id NOT IN (?) AND sl.id NOT IN (?)");
      params.push(idList(await reviewIds()), idList(await exceptionIds()));
      break;
    default:
  }

  const whereSql = where.join(" AND ");
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM bank_recon_statement_lines sl WHERE ${whereSql}`, params);
  const offset = (f.page - 1) * f.pageSize;
  const [rows] = await pool.query(
    `SELECT sl.id, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, DATE_FORMAT(sl.value_date, '%Y-%m-%d') AS valueDate,
            sl.description, sl.check_no AS checkNo, sl.reference_no AS referenceNo, sl.bank_reference AS bankReference,
            sl.debit, sl.credit, sl.match_status AS matchStatus, sl.session_id AS sessionId, sl.batch_id AS batchId,
            b.file_name AS batchFileName,
            DATE_FORMAT(s.period_start, '%Y-%m-%d') AS sessionPeriodStart, DATE_FORMAT(s.period_end, '%Y-%m-%d') AS sessionPeriodEnd,
            s.status AS sessionStatus,
            ${CARRIED_SQL} AS carriedForward, ${DUPLICATE_SQL} AS possibleDuplicate
     FROM bank_recon_statement_lines sl
     JOIN bank_recon_sessions s ON s.id = sl.session_id
     JOIN bank_recon_import_batches b ON b.id = sl.batch_id
     WHERE ${whereSql}
     ORDER BY sl.txn_date DESC, sl.id DESC
     LIMIT ? OFFSET ?`,
    [...params, f.pageSize, offset]
  );

  const unresolved = rows.some((r) => r.matchStatus === "UNMATCHED" || r.matchStatus === "SUGGESTED");
  const c = unresolved ? await classification() : { exception: new Map(), review: new Set(), high: new Set() };
  const matches = await confirmedMatchSummaries(rows.map((r) => r.id), scope);

  return {
    scope: { companyId: scope.companyId, companyName: scope.companyName, bankAccountId: scope.bankAccountId, ...scope.bank },
    sessions,
    filters: { ...f },
    page: f.page,
    pageSize: f.pageSize,
    total: Number(total),
    pageCount: Math.max(1, Math.ceil(Number(total) / f.pageSize)),
    rows: rows.map((r) => {
      const m = matches.get(r.id) || null;
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      return {
        id: r.id,
        txnDate: r.txnDate,
        valueDate: r.valueDate,
        description: r.description,
        checkNo: r.checkNo,
        referenceNo: r.referenceNo,
        bankReference: r.bankReference,
        debit,
        credit,
        amount: round2(debit > 0 ? debit : credit),
        direction: debit > 0 ? "OUT" : "IN",
        matchStatus: r.matchStatus,
        status: displayStatus(r, c),
        carriedForward: Boolean(Number(r.carriedForward)),
        ignored: r.matchStatus === "IGNORED",
        possibleDuplicate: Boolean(Number(r.possibleDuplicate)),
        highConfidence: c.high.has(r.id),
        session: { id: r.sessionId, periodStart: r.sessionPeriodStart, periodEnd: r.sessionPeriodEnd, status: r.sessionStatus },
        batch: { id: r.batchId, fileName: r.batchFileName },
        match: m,
      };
    }),
  };
}

// Confirmed matches of the given statement rows - only those made in a
// session of the SAME company + bank account as the row (never another
// company's or bank account's match). One query for the page.
async function confirmedMatchRows(lineIds, scope) {
  if (!lineIds.length) return [];
  const [rows] = await pool.query(
    `SELECT m.id, m.statement_line_id AS lineId, m.session_id AS sessionId, m.match_group AS matchGroup,
            m.match_type AS matchType, m.confidence_score AS confidenceScore, m.score_breakdown AS scoreBreakdown,
            m.book_source_type AS bookSourceType, m.book_source_id AS bookSourceId, m.book_line_id AS bookLineId, m.amount,
            DATE_FORMAT(m.matched_at, '%Y-%m-%d %H:%i:%s') AS matchedAt, u.username AS matchedBy,
            DATE_FORMAT(ms.period_start, '%Y-%m-%d') AS sessionPeriodStart, DATE_FORMAT(ms.period_end, '%Y-%m-%d') AS sessionPeriodEnd,
            ms.status AS sessionStatus,
            COALESCE(cv.voucher_no, o.voucher_no, j.voucher_no) AS voucherNo,
            COALESCE(cv.payee_name, o.customer_name, j.prepared_for) AS partyName,
            DATE_FORMAT(COALESCE(cv.transaction_date, o.transaction_date, j.transaction_date), '%Y-%m-%d') AS docDate,
            COALESCE(cv.check_no, o.check_no) AS docCheckNo, COALESCE(cv.reference_no, o.reference_no, j.reference_no) AS docReferenceNo
     FROM bank_recon_matches m
     JOIN bank_recon_sessions ms ON ms.id = m.session_id AND ms.company_id = ? AND ms.bank_account_id = ?
     LEFT JOIN users u ON u.id = m.matched_by
     LEFT JOIN cv_headers cv ON m.book_source_type = 'CV' AND cv.id = m.book_source_id AND cv.company_id = ms.company_id
     LEFT JOIN or_headers o ON m.book_source_type = 'OR' AND o.id = m.book_source_id AND o.company_id = ms.company_id
     LEFT JOIN jv_headers j ON m.book_source_type = 'JV' AND j.id = m.book_source_id AND j.company_id = ms.company_id
     WHERE m.statement_line_id IN (?) AND m.status = 'CONFIRMED'
     ORDER BY m.id`,
    [scope.companyId, scope.bankAccountId, lineIds]
  );
  return rows;
}

async function confirmedMatchSummaries(lineIds, scope) {
  const out = new Map();
  for (const r of await confirmedMatchRows(lineIds, scope)) {
    const cur = out.get(r.lineId) || { matchType: r.matchType, oneToMany: Boolean(r.matchGroup), documents: [], total: 0, sessionId: r.sessionId };
    cur.documents.push(`${r.bookSourceType} ${r.voucherNo || `#${r.bookSourceId}`}`);
    cur.total = round2(cur.total + Number(r.amount));
    out.set(r.lineId, cur);
  }
  return out;
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

const monthLabel = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "");

// The confirmed match of one statement row, as the engine recorded it.
function presentConfirmed(rows, line) {
  if (!rows.length) return null;
  const first = rows[0];
  const breakdown = parseBreakdown(first.scoreBreakdown);
  const docs = rows.map((r) => ({
    matchId: r.id,
    bookSourceType: r.bookSourceType,
    bookSourceId: r.bookSourceId,
    voucherNo: r.voucherNo,
    partyName: r.partyName,
    txnDate: r.docDate,
    checkNo: r.docCheckNo,
    referenceNo: r.docReferenceNo,
    amount: Number(r.amount),
  }));
  const totalCents = docs.reduce((s, d) => s + Math.round(d.amount * 100), 0);
  const lineCents = Math.round((Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit)) * 100);
  let explanation;
  if (first.matchType === "MANUAL") {
    explanation = `Matched manually by ${first.matchedBy || "an accountant"}: the accountant selected this document in the workspace.`;
  } else if (first.matchGroup) {
    explanation = MatchService.explainGroup(first.matchType, breakdown, line, docs);
  } else {
    explanation = MatchService.explainCandidate(first.matchType, breakdown, { line, candidate: { ...first, detail: { voucherNo: first.voucherNo } } });
  }
  return {
    oneToMany: Boolean(first.matchGroup),
    matchGroup: first.matchGroup || null,
    // R10: the deposit slip this deposit was reconciled through, if any.
    depositSlip: breakdown?.depositSlipId ? { id: breakdown.depositSlipId, depositNo: breakdown.depositNo, evidence: breakdown.evidence || null } : null,
    matchType: first.matchType,
    matchLevel: breakdown?.matchLevel || null,
    confidenceScore: first.confidenceScore === null ? null : Number(first.confidenceScore),
    documents: docs,
    total: totalCents / 100,
    bankAmount: lineCents / 100,
    difference: (lineCents - totalCents) / 100,
    explanation,
    confirmedBy: first.matchedBy || null,
    confirmedAt: first.matchedAt,
    session: { id: first.sessionId, periodStart: first.sessionPeriodStart, periodEnd: first.sessionPeriodEnd, status: first.sessionStatus },
  };
}

// Everything known about one statement row. Access was checked by the
// route (the row's own session company); every related record below is
// restricted to the row's company + bank account.
async function lineDetail({ lineId, user }) {
  const [[line]] = await pool.execute(
    `SELECT sl.id, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, DATE_FORMAT(sl.value_date, '%Y-%m-%d') AS valueDate,
            sl.description, sl.check_no AS checkNo, sl.reference_no AS referenceNo, sl.bank_reference AS bankReference,
            sl.debit, sl.credit, sl.running_balance AS runningBalance, sl.match_status AS matchStatus, sl.source_row AS sourceRow,
            sl.company_id AS companyId, sl.bank_account_id AS bankAccountId, sl.session_id AS sessionId, sl.batch_id AS batchId,
            ${DUPLICATE_SQL} AS possibleDuplicate, ${CARRIED_SQL} AS carriedForward,
            c.name AS companyName, bc.bank_code AS bankCode, bc.bank_name AS bankName, bc.account_no AS bankAccountNo,
            DATE_FORMAT(s.period_start, '%Y-%m-%d') AS sessionPeriodStart, DATE_FORMAT(s.period_end, '%Y-%m-%d') AS sessionPeriodEnd,
            s.status AS sessionStatus,
            b.file_name AS batchFileName, DATE_FORMAT(b.imported_at, '%Y-%m-%d %H:%i:%s') AS batchImportedAt, bu.username AS batchImportedBy
     FROM bank_recon_statement_lines sl
     JOIN bank_recon_sessions s ON s.id = sl.session_id
     JOIN bank_recon_import_batches b ON b.id = sl.batch_id
     JOIN bank_codes bc ON bc.id = sl.bank_account_id
     LEFT JOIN companies c ON c.id = sl.company_id
     LEFT JOIN users bu ON bu.id = b.imported_by
     WHERE sl.id = ?`,
    [lineId]
  );
  if (!line) throw new HttpError(404, "Statement line not found");
  if (!line.companyId) throw new HttpError(404, "Statement line not found");
  const scope = { companyId: line.companyId, bankAccountId: line.bankAccountId };
  const sessions = await scopeSessions(scope);
  const unresolved = line.matchStatus === "UNMATCHED" || line.matchStatus === "SUGGESTED";
  const cls = unresolved ? await queueClassification(user, sessions) : { exception: new Map(), review: new Set(), high: new Set(), sessionId: null };

  const debit = Number(line.debit);
  const credit = Number(line.credit);
  const confirmed = presentConfirmed(await confirmedMatchRows([line.id], scope), line);
  const carried = Boolean(Number(line.carriedForward));

  // Where the row is worked on now: the session that confirmed it, or -
  // while unresolved - the latest session (it carries every earlier
  // unresolved row), or else its own import session.
  const latest = sessions[0] || null;
  const working = confirmed
    ? confirmed.session
    : unresolved && latest
      ? latest
      : { id: line.sessionId, periodStart: line.sessionPeriodStart, periodEnd: line.sessionPeriodEnd, status: line.sessionStatus };

  let candidates = [];
  if (unresolved) {
    candidates = (await MatchService.listCandidates({ statementLineId: line.id, user })).candidates.map((cand) => ({
      ...cand,
      scoreBreakdown: undefined,
    }));
  }

  let ignored = null;
  if (line.matchStatus === "IGNORED") {
    const [[a]] = await pool.execute(
      `SELECT u.username AS user, DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.module = 'BANK_RECON' AND a.entity_type = 'STATEMENT_LINE' AND a.entity_id = ? AND a.action = 'IGNORE'
       ORDER BY a.id DESC LIMIT 1`,
      [line.id]
    );
    ignored = {
      by: a?.user || null,
      at: a?.at || null,
      reason: null,
      period: { sessionId: line.sessionId, periodStart: line.sessionPeriodStart, periodEnd: line.sessionPeriodEnd },
      unIgnoreRule: `Un-ignore it from its own reconciliation session (#${line.sessionId}, ${line.sessionPeriodStart} to ${line.sessionPeriodEnd}). An ignored row is no longer carried into later sessions.`,
    };
  }

  let duplicates = [];
  if (Number(line.possibleDuplicate)) {
    const [rows] = await pool.execute(
      `SELECT d.id, DATE_FORMAT(d.txn_date, '%Y-%m-%d') AS txnDate, d.description, d.check_no AS checkNo, d.reference_no AS referenceNo,
              d.debit, d.credit, d.match_status AS matchStatus, d.session_id AS sessionId, d.batch_id AS batchId,
              b.file_name AS batchFileName, DATE_FORMAT(b.imported_at, '%Y-%m-%d %H:%i:%s') AS importedAt,
              DATE_FORMAT(s.period_start, '%Y-%m-%d') AS sessionPeriodStart, DATE_FORMAT(s.period_end, '%Y-%m-%d') AS sessionPeriodEnd
       FROM bank_recon_statement_lines d
       JOIN bank_recon_import_batches b ON b.id = d.batch_id
       JOIN bank_recon_sessions s ON s.id = d.session_id
       WHERE d.company_id = ? AND d.bank_account_id = ? AND d.id <> ?
         AND d.txn_date = ? AND d.debit = ? AND d.credit = ?
         AND COALESCE(d.check_no, '') = COALESCE(?, '') AND COALESCE(d.reference_no, '') = COALESCE(?, '')
         AND COALESCE(d.description, '') = COALESCE(?, '')
       ORDER BY d.id LIMIT 10`,
      [line.companyId, line.bankAccountId, line.id, line.txnDate, line.debit, line.credit, line.checkNo, line.referenceNo, line.description]
    );
    duplicates = rows.map((d) => ({
      ...d,
      debit: Number(d.debit),
      credit: Number(d.credit),
      evidence: "Same date, amount, check number, reference and description",
    }));
  }

  const status = displayStatus({ id: line.id, matchStatus: line.matchStatus }, cls);
  const reasonOutstanding = !unresolved
    ? null
    : cls.exception.has(line.id)
      ? cls.exception.get(line.id).map((e) => e.message).join(" ")
      : line.matchStatus === "SUGGESTED"
        ? "Suggested matches are waiting for the accountant's confirmation."
        : "No confirmed match yet, and the matching engine found no candidate.";

  return {
    line: {
      id: line.id,
      txnDate: line.txnDate,
      valueDate: line.valueDate,
      description: line.description,
      checkNo: line.checkNo,
      referenceNo: line.referenceNo,
      bankReference: line.bankReference,
      debit,
      credit,
      amount: round2(debit > 0 ? debit : credit),
      direction: debit > 0 ? "OUT" : "IN",
      runningBalance: line.runningBalance === null ? null : Number(line.runningBalance),
      sourceRow: line.sourceRow,
    },
    company: { id: line.companyId, name: line.companyName },
    bankAccount: { id: line.bankAccountId, bankCode: line.bankCode, bankName: line.bankName, accountNo: line.bankAccountNo },
    importSession: { id: line.sessionId, periodStart: line.sessionPeriodStart, periodEnd: line.sessionPeriodEnd, status: line.sessionStatus },
    batch: { id: line.batchId, fileName: line.batchFileName, importedAt: line.batchImportedAt, importedBy: line.batchImportedBy },
    status,
    matchStatus: line.matchStatus,
    highConfidence: cls.high.has(line.id),
    exceptions: cls.exception.get(line.id) || [],
    reasonOutstanding,
    carriedForward: carried
      ? {
          from: { sessionId: line.sessionId, periodStart: line.sessionPeriodStart, periodEnd: line.sessionPeriodEnd },
          label: `Carried forward from ${monthLabel(line.sessionPeriodStart)}`,
          currentSession: working,
        }
      : null,
    workingSession: working,
    readOnly: working.status === "FINALIZED",
    confirmedMatch: confirmed,
    candidates,
    ignored,
    possibleDuplicate: Boolean(Number(line.possibleDuplicate)),
    duplicates,
  };
}

// Import history of one company + bank account, newest first, with the
// stored batch counters and the rows currently held from each batch.
async function listImports({ user, query }) {
  const scope = await resolveScope(user, query);
  const page = present(query.page) ? toPositiveId(query.page, "page") : 1;
  const pageSize = Math.min(present(query.pageSize) ? toPositiveId(query.pageSize, "page size") : PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const [[{ total }]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM bank_recon_import_batches WHERE company_id = ? AND bank_account_id = ?",
    [scope.companyId, scope.bankAccountId]
  );
  const [rows] = await pool.query(
    `SELECT b.id, b.file_name AS fileName, b.file_type AS fileType, DATE_FORMAT(b.imported_at, '%Y-%m-%d %H:%i:%s') AS importedAt,
            u.username AS importedBy, b.row_count AS rowCount, b.duplicate_count AS duplicateCount, b.ignored_count AS ignoredCount,
            b.parser_version AS parserVersion, b.status, b.session_id AS sessionId,
            DATE_FORMAT(s.period_start, '%Y-%m-%d') AS sessionPeriodStart, DATE_FORMAT(s.period_end, '%Y-%m-%d') AS sessionPeriodEnd,
            s.status AS sessionStatus,
            (SELECT COUNT(*) FROM bank_recon_statement_lines l WHERE l.batch_id = b.id) AS importedCount
     FROM bank_recon_import_batches b
     JOIN bank_recon_sessions s ON s.id = b.session_id
     LEFT JOIN users u ON u.id = b.imported_by
     WHERE b.company_id = ? AND b.bank_account_id = ?
     ORDER BY b.imported_at DESC, b.id DESC
     LIMIT ? OFFSET ?`,
    [scope.companyId, scope.bankAccountId, pageSize, (page - 1) * pageSize]
  );
  return {
    scope: { companyId: scope.companyId, companyName: scope.companyName, bankAccountId: scope.bankAccountId, ...scope.bank },
    page,
    pageSize,
    total: Number(total),
    pageCount: Math.max(1, Math.ceil(Number(total) / pageSize)),
    rows: rows.map((r) => ({ ...r, importedCount: Number(r.importedCount) })),
  };
}

module.exports = { listHistory, lineDetail, listImports, resolveScope, STATUS, PAGE_SIZE_MAX };
