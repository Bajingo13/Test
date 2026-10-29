const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const {
  BANK_RECON_SESSION_SELECT,
  bankMovement,
  statementSetWhere,
  computeSessionSummary,
  loadCandidatePool,
} = require("./BankMatchingService");
const { normalizeIdentifier, isStrictExactRow, bookKey, round2, daysBetween, MATCH_LEVEL } = require("./ConfidenceScoringService");
const { depositPool, findDepositCombinations, namesReceipt, statementText } = require("./depositCombinationService");
const MatchService = require("./bankReconMatchService");

// Reconciliation queue (R8.3): "show me what needs my attention" for one
// session, built only from the deterministic engine's own results - the
// PENDING suggestions written by runMatching, the outstanding book items of
// the session summary, and the same eligibility rules the confirmation
// guard enforces. Read-only: it never suggests, scores or confirms anything
// itself, and the workspace and the AI assistant receive the same queue.
//
//   highConfidence - one strict EXACT suggestion (check number first, then
//                    document / reference number); confirm with one click
//   needsReview    - suggestions without deterministic evidence, or several
//   unmatchedBank  - statement rows with no candidate at all
//   unmatchedBook  - posted OR / CV / JV bank movements not yet cleared,
//                    including ones carried from earlier periods
//   exceptions     - a statement check / reference number that names a real
//                    document that cannot be matched (wrong amount, wrong
//                    direction, other bank account, not posted, already
//                    reconciled, outside the date window), and rows that are
//                    possible duplicates from before R8.2
//
// R8.4-B: a deposit proposed as a combination of ORs is ONE candidate (its
// member ORs, total, deposit and difference). It is high confidence only as
// the single strong (EXACT) combination; several combinations, amount-only
// sums, weak dates and large combinations are needs-review; a deposit whose
// search hit a limit is "manual review required". Two more exceptions:
// a deposit that names ORs whose amounts do not add up to it
// (GROUP_AMOUNT_MISMATCH), and a book item outstanding longer than
// OLD_ITEM_DAYS (OLD_OUTSTANDING_ITEM - a stale or dropped check, possibly
// older than the imported statement history).

const MIN_ID = 3;
const EXCEPTION = {
  NOT_POSTED: "NOT_POSTED",
  OTHER_BANK_ACCOUNT: "OTHER_BANK_ACCOUNT",
  ALREADY_RECONCILED: "ALREADY_RECONCILED",
  WRONG_DIRECTION: "WRONG_DIRECTION",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  OUTSIDE_DATE_WINDOW: "OUTSIDE_DATE_WINDOW",
  POSSIBLE_DUPLICATE_IMPORT: "POSSIBLE_DUPLICATE_IMPORT",
  GROUP_AMOUNT_MISMATCH: "GROUP_AMOUNT_MISMATCH",
  OLD_OUTSTANDING_ITEM: "OLD_OUTSTANDING_ITEM",
};
// Philippine checks become stale six months after their date.
const OLD_ITEM_DAYS = 180;
const LEVEL_ORDER = { [MATCH_LEVEL.CHECK_NO]: 0, [MATCH_LEVEL.REFERENCE]: 1 };

const peso = (v) => `₱${Number(v || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lineAmount = (l) => (Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit));
const lineDirection = (l) => (Number(l.debit) > 0 ? "OUT" : "IN");
const strongIds = (...values) => values.map((v) => normalizeIdentifier(v || "")).filter((v) => v.length >= MIN_ID);
const parse = (b) => {
  if (!b || typeof b !== "string") return b || null;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

function presentLine(l) {
  return {
    id: l.id,
    txnDate: l.txnDate,
    description: l.description,
    referenceNo: l.referenceNo,
    checkNo: l.checkNo,
    direction: lineDirection(l),
    amount: round2(lineAmount(l)),
    matchStatus: l.matchStatus,
    carriedForward: l.carried === 1 || l.carried === true,
  };
}

// Documents of the company whose check / document number equals one of the
// statement identifiers, with their bank movement on their own bank account.
async function documentsByIdentifier(conn, companyId, keys) {
  if (!keys.size) return [];
  const stripped = [...new Set([...keys].map((k) => k.replace(/^0+/, "")))];
  const out = [];
  for (const type of ["CV", "OR"]) {
    const isCv = type === "CV";
    const h = isCv ? "cv_headers" : "or_headers";
    const lt = isCv ? "cv_lines" : "or_lines";
    const fk = isCv ? "cv_id" : "or_id";
    const net = isCv ? "l.credit - l.debit" : "l.debit - l.credit";
    const cols = isCv ? ["check_no", "voucher_no", "reference_no"] : ["check_no", "voucher_no", "reference_no", "receipt_no"];
    const where = cols.map((c) => `TRIM(LEADING '0' FROM LOWER(TRIM(h.${c}))) IN (?)`).join(" OR ");
    const [rows] = await conn.query(
      `SELECT h.id, h.voucher_no AS voucherNo, h.check_no AS checkNo, h.reference_no AS referenceNo,
              ${isCv ? "''" : "h.receipt_no"} AS receiptNo, h.status, h.bank_account_id AS bankAccountId,
              DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS txnDate,
              h.total_debit AS grossAmount, h.tax_withheld_amount AS withholdingAmount,
              (SELECT COUNT(*) FROM ${lt} l WHERE l.${fk} = h.id AND l.account_id = bc.coa_account_id) AS bankLineCount,
              (SELECT COALESCE(SUM(${net}), 0) FROM ${lt} l WHERE l.${fk} = h.id AND l.account_id = bc.coa_account_id) AS bankLineNet
       FROM ${h} h LEFT JOIN bank_codes bc ON bc.id = h.bank_account_id
       WHERE h.company_id = ? AND (${where})`,
      [companyId, ...cols.map(() => stripped)]
    );
    for (const r of rows) {
      const m = bankMovement(r);
      const natural = isCv ? "OUT" : "IN";
      out.push({
        type,
        id: r.id,
        voucherNo: r.voucherNo,
        status: r.status,
        bankAccountId: r.bankAccountId,
        txnDate: r.txnDate,
        checkIds: strongIds(r.checkNo),
        documentIds: strongIds(r.voucherNo, r.receiptNo, r.referenceNo),
        amount: Math.abs(m.bankMovementAmount),
        direction: m.bankMovementAmount >= 0 ? natural : natural === "OUT" ? "IN" : "OUT",
      });
    }
  }
  return out;
}

async function buildQueue({ sessionId, user }) {
  const access = await MatchService.authorize(user, "session", sessionId, "VIEW");
  const conn = await pool.getConnection();
  try {
    const [[session]] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [access.id]);
    if (!session) throw new HttpError(404, "Reconciliation session not found");

    const set = statementSetWhere(session);
    const [lines] = await conn.execute(
      `SELECT sl.id, DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, sl.description, sl.reference_no AS referenceNo,
              sl.check_no AS checkNo, sl.debit, sl.credit, sl.match_status AS matchStatus, sl.row_fingerprint AS fingerprint,
              sl.company_id AS companyId, (sl.txn_date < ?) AS carried
       FROM bank_recon_statement_lines sl WHERE ${set.sql} ORDER BY sl.txn_date, sl.id`,
      [session.periodStart, ...set.params]
    );
    const unresolved = lines.filter((l) => l.matchStatus === "UNMATCHED" || l.matchStatus === "SUGGESTED");

    const pendingByLine = new Map();
    if (unresolved.length) {
      const [pending] = await conn.query(
        `SELECT m.id, m.statement_line_id AS lineId, m.book_source_type AS bookSourceType, m.book_source_id AS bookSourceId,
                m.match_type AS matchType, m.confidence_score AS confidenceScore, m.score_breakdown AS scoreBreakdown, m.amount,
                m.match_group AS matchGroup, o.customer_name AS partyName, DATE_FORMAT(o.transaction_date, '%Y-%m-%d') AS txnDate,
                COALESCE(cv.voucher_no, o.voucher_no, j.voucher_no) AS voucherNo
         FROM bank_recon_matches m
         LEFT JOIN cv_headers cv ON m.book_source_type = 'CV' AND cv.id = m.book_source_id
         LEFT JOIN or_headers o ON m.book_source_type = 'OR' AND o.id = m.book_source_id
         LEFT JOIN jv_headers j ON m.book_source_type = 'JV' AND j.id = m.book_source_id
         WHERE m.statement_line_id IN (?) AND m.status = 'PENDING'
         ORDER BY m.confidence_score DESC, m.id`,
        [unresolved.map((l) => l.id)]
      );
      for (const p of pending) pendingByLine.set(p.lineId, [...(pendingByLine.get(p.lineId) || []), p]);
    }

    const present = (p, line) => {
      const breakdown = parse(p.scoreBreakdown);
      return {
        matchId: p.id,
        bookSourceType: p.bookSourceType,
        bookSourceId: p.bookSourceId,
        voucherNo: p.voucherNo,
        amount: round2(Number(p.amount)),
        matchType: p.matchType,
        matchLevel: breakdown?.matchLevel || null,
        confidenceScore: Number(p.confidenceScore),
        strictExact: isStrictExactRow(p.matchType, breakdown),
        explanation: MatchService.explainCandidate(p.matchType, breakdown, {
          line,
          candidate: { ...p, detail: { voucherNo: p.voucherNo } },
        }),
      };
    };

    // Same pool and limits the engine used (R8.4-B), for the deposit
    // checks below.
    const [confirmedRows] = await conn.execute(
      `SELECT m.book_source_type AS sourceType, m.book_source_id AS sourceId, m.book_line_id AS lineId
       FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.status = 'CONFIRMED' AND s.bank_account_id = ? AND s.company_id <=> ?`,
      [session.bankAccountId, session.companyId ?? null]
    );
    const confirmed = new Set(confirmedRows.map(bookKey));
    const hasDeposits = unresolved.some((l) => lineDirection(l) === "IN");
    const orPool = hasDeposits ? depositPool(await loadCandidatePool(conn, session), confirmed) : [];

    const highConfidence = [];
    const needsReview = [];
    const unmatchedBank = [];
    for (const l of unresolved) {
      const cands = MatchService.collapseGroupRows(pendingByLine.get(l.id) || [], l)
        .map((p) => (p.group ? { ...p, matchId: p.id } : present(p, l)));
      const strict = cands.filter((c) => c.strictExact);
      const groups = cands.filter((c) => c.group);
      if (strict.length === 1) {
        highConfidence.push({ line: presentLine(l), candidate: strict[0] });
      } else if (cands.length === 1 && groups.length === 1 && groups[0].matchType === "EXACT") {
        highConfidence.push({ line: presentLine(l), candidate: groups[0] });
      } else if (cands.length) {
        let reason;
        if (groups.length > 1 || groups.some((g) => g.matchType === "AMBIGUOUS")) {
          reason = groups.some((g) => /limit/.test(g.ambiguousReason || ""))
            ? "Manual review required - the search limit was reached, so other combinations may exist. Options found so far are shown."
            : "Multiple possible combinations found - choose the right one.";
        } else if (groups.length) {
          reason = "One combination of official receipts adds up to this deposit, but the evidence is weak (amount only, distant dates, partial references or a large combination) - review before confirming.";
        } else if (cands.some((c) => c.matchType === "AMBIGUOUS")) {
          reason = "Several documents fit - choose the right one.";
        } else {
          reason = "Likely match without a check or document number - review before confirming.";
        }
        needsReview.push({ line: presentLine(l), reason, candidates: cands.slice(0, 3) });
      } else {
        const r = lineDirection(l) === "IN" ? findDepositCombinations(l, orPool, session) : null;
        if (r && (r.limitReached || r.poolTruncated)) {
          needsReview.push({
            line: presentLine(l),
            manualReview: true,
            reason: "Manual review required - too many official receipts could make up this deposit for an automatic proposal (search limit reached). Match it manually.",
            candidates: [],
          });
        } else {
          unmatchedBank.push({ line: presentLine(l) });
        }
      }
    }
    highConfidence.sort((a, b) => (LEVEL_ORDER[a.candidate.matchLevel] ?? 9) - (LEVEL_ORDER[b.candidate.matchLevel] ?? 9)
      || a.line.txnDate.localeCompare(b.line.txnDate));

    // ---- exceptions ----
    const exceptions = [];
    const reviewable = unresolved.filter((l) => !highConfidence.some((h) => h.line.id === l.id));
    const keys = new Set(reviewable.flatMap((l) => strongIds(l.checkNo, l.referenceNo)));
    const docs = session.companyId ? await documentsByIdentifier(conn, session.companyId, keys) : [];
    const edge = (amount) => round2(session.amountVarianceType === "PERCENT"
      ? amount * (Number(session.amountVarianceValue) / 100)
      : Number(session.amountVarianceValue));
    for (const l of reviewable) {
      const ids = strongIds(l.checkNo, l.referenceNo);
      if (!ids.length) continue;
      const pendingDocs = new Set((pendingByLine.get(l.id) || []).map((p) => `${p.bookSourceType}:${p.bookSourceId}`));
      for (const d of docs) {
        const viaCheck = d.checkIds.some((k) => ids.includes(k));
        const viaDocument = d.documentIds.some((k) => ids.includes(k));
        if (!viaCheck && !viaDocument) continue;
        const amt = lineAmount(l);
        let reason = null;
        if (String(d.status || "").toUpperCase() !== "POSTED") reason = EXCEPTION.NOT_POSTED;
        else if (Number(d.bankAccountId) !== Number(session.bankAccountId)) reason = EXCEPTION.OTHER_BANK_ACCOUNT;
        else if (confirmed.has(bookKey({ sourceType: d.type, sourceId: d.id, lineId: null }))) reason = EXCEPTION.ALREADY_RECONCILED;
        else if (d.direction !== lineDirection(l)) reason = EXCEPTION.WRONG_DIRECTION;
        else if (Math.abs(round2(amt - d.amount)) > edge(amt)) reason = EXCEPTION.AMOUNT_MISMATCH;
        else if (!pendingDocs.has(`${d.type}:${d.id}`)) reason = EXCEPTION.OUTSIDE_DATE_WINDOW;
        if (!reason) continue;
        const what = `${viaCheck ? "check" : "reference"} ${viaCheck ? l.checkNo || l.referenceNo : l.referenceNo || l.checkNo}`;
        const doc = `${d.type} ${d.voucherNo || `#${d.id}`}`;
        const message = {
          NOT_POSTED: `Statement ${what} names ${doc}, which is ${d.status || "not posted"} - post it before it can be reconciled.`,
          OTHER_BANK_ACCOUNT: `Statement ${what} names ${doc}, which was recorded on a different bank account.`,
          ALREADY_RECONCILED: `Statement ${what} names ${doc}, which is already reconciled - this may be a duplicate bank line.`,
          WRONG_DIRECTION: `Statement ${what} is money ${lineDirection(l) === "OUT" ? "out" : "in"}, but ${doc} is money ${d.direction === "OUT" ? "out" : "in"}.`,
          AMOUNT_MISMATCH: `Statement ${what} is ${peso(amt)}, but ${doc} moved ${peso(d.amount)} through the bank (difference ${peso(Math.abs(amt - d.amount))}).`,
          OUTSIDE_DATE_WINDOW: `Statement ${what} (${l.txnDate}) names ${doc} (${d.txnDate}), dated outside this session's date tolerance - widen the tolerance or match it manually.`,
        }[reason];
        exceptions.push({ type: reason, line: presentLine(l), document: { type: d.type, id: d.id, voucherNo: d.voucherNo, status: d.status, amount: d.amount, txnDate: d.txnDate }, message });
      }
    }
    // A deposit that names official receipts which do not add up to it.
    const unmatchedIds = new Set(unmatchedBank.map((u) => u.line.id));
    for (const l of reviewable) {
      if (lineDirection(l) !== "IN" || !unmatchedIds.has(l.id) || exceptions.some((e) => e.line.id === l.id)) continue;
      const text = statementText(l);
      const named = orPool.filter((t) => namesReceipt(text, t));
      if (!named.length) continue;
      const total = round2(named.reduce((s, t) => s + t.amount, 0));
      const amt = lineAmount(l);
      if (Math.round(total * 100) === Math.round(amt * 100)) continue;
      const names = named.map((t) => `OR ${t.voucherNo || `#${t.sourceId}`}`).join(", ");
      exceptions.push({
        type: EXCEPTION.GROUP_AMOUNT_MISMATCH,
        line: presentLine(l),
        document: null,
        documents: named.map((t) => ({ type: "OR", id: t.sourceId, voucherNo: t.voucherNo, amount: t.amount, txnDate: t.date })),
        message: `Deposit ${peso(amt)} names ${names} (total ${peso(total)}), but the amounts do not reconcile (difference ${peso(Math.abs(amt - total))}).`,
      });
    }

    for (const l of lines) {
      if (l.companyId && !l.fingerprint) {
        exceptions.push({
          type: EXCEPTION.POSSIBLE_DUPLICATE_IMPORT,
          line: presentLine(l),
          document: null,
          message: "This bank row was imported more than once before duplicate protection existed - check it is not counted twice.",
        });
      }
    }

    const summary = await computeSessionSummary(conn, session);
    const unmatchedBook = [...summary.outstandingChecks, ...summary.depositsInTransit]
      .map((t) => ({ ...t, carriedForward: t.date < session.periodStart }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Long-outstanding book items (stale / dropped checks, deposits never
    // credited) - they stay outstanding and matchable; this only asks the
    // accountant to look at them.
    const old = unmatchedBook.filter((t) => daysBetween(t.date, session.periodEnd) > OLD_ITEM_DAYS && t.date < session.periodEnd);
    if (old.length) {
      const [[hist]] = await conn.execute(
        `SELECT DATE_FORMAT(MIN(txn_date), '%Y-%m-%d') AS firstDate FROM bank_recon_statement_lines
         WHERE bank_account_id = ? AND company_id <=> ?`,
        [session.bankAccountId, session.companyId ?? null]
      );
      for (const t of old) {
        const days = daysBetween(t.date, session.periodEnd);
        const doc = `${t.sourceType} ${t.voucherNo || `#${t.sourceId}`}${t.checkNo ? ` (check ${t.checkNo})` : ""}`;
        const beforeHistory = hist?.firstDate && t.date < hist.firstDate
          ? ` It is dated before the first imported bank statement row (${hist.firstDate}), so the bank history cannot show whether it already cleared.`
          : "";
        const action = t.direction === "OUT"
          ? "Confirm whether the check is still valid - a stale or dropped check may need to be cancelled or re-issued."
          : "Confirm whether this deposit was ever credited by the bank.";
        exceptions.push({
          type: EXCEPTION.OLD_OUTSTANDING_ITEM,
          line: null,
          document: { type: t.sourceType, id: t.sourceId, voucherNo: t.voucherNo, checkNo: t.checkNo || null, amount: t.amount, txnDate: t.date, beforeStatementHistory: Boolean(beforeHistory) },
          message: `${doc} for ${peso(t.amount)} dated ${t.date} has been outstanding for ${days} days (over ${OLD_ITEM_DAYS}).${beforeHistory} ${action}`,
        });
      }
    }

    return {
      session: { id: session.id, companyId: session.companyId, bankAccountId: session.bankAccountId, periodStart: session.periodStart, periodEnd: session.periodEnd },
      counts: {
        statementRows: lines.length,
        highConfidence: highConfidence.length,
        needsReview: needsReview.length,
        unmatchedBank: unmatchedBank.length,
        unmatchedBook: unmatchedBook.length,
        exceptions: exceptions.length,
        carriedForwardBank: lines.filter((l) => l.carried === 1 && (l.matchStatus === "UNMATCHED" || l.matchStatus === "SUGGESTED")).length,
        carriedForwardBook: unmatchedBook.filter((t) => t.carriedForward).length,
      },
      highConfidence,
      needsReview,
      unmatchedBank,
      unmatchedBook,
      exceptions,
    };
  } finally {
    conn.release();
  }
}

module.exports = { buildQueue, EXCEPTION, OLD_ITEM_DAYS };
