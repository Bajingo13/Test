const { HttpError } = require("../lib/httpError");
const { loadBookItem } = require("./BankMatchingService");
const { round2, bookKey } = require("./ConfidenceScoringService");

// Server-side gate for every way a statement line becomes MATCHED to a book
// document (R7-3 / R7-6): confirming an engine suggestion, bulk-confirming
// EXACT suggestions, and a manual match. The frontend disabling a button is
// never relied on.
//
// Runs inside the caller's transaction and takes row locks in a fixed order
// - statement line, then the book document's header row - so two requests
// racing for the same document serialize on that header row; the second
// one then sees the first one's CONFIRMED match (locking read) and gets 409.
//
// "Already reconciled" means a CONFIRMED match for the same document in any
// session of the same company and bank account - not only this session. A
// cheque cleared in July cannot be confirmed again in August. (Showing it
// as cleared in later sessions - carry-forward - is a later phase.)

const DOCUMENT_TABLES = { CV: "cv_headers", OR: "or_headers", JV: "jv_headers" };

function statementAmount(line) {
  return Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit);
}

function statementDirection(line) {
  return Number(line.debit) > 0 ? "OUT" : "IN";
}

// The amount difference a match may carry - the session's own variance,
// the same edge the matching engine scores against.
function varianceEdge(session, stmtAmount) {
  return session.amountVarianceType === "PERCENT"
    ? stmtAmount * (Number(session.amountVarianceValue) / 100)
    : Number(session.amountVarianceValue);
}

// Locks the statement line and checks it can still take a match.
async function lockStatementLine(conn, statementLineId) {
  const [rows] = await conn.execute(
    `SELECT sl.id, sl.session_id AS sessionId, sl.match_status AS matchStatus,
            DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate, sl.debit, sl.credit
     FROM bank_recon_statement_lines sl
     WHERE sl.id = ? FOR UPDATE`,
    [statementLineId]
  );
  const line = rows[0];
  if (!line) throw new HttpError(404, "Statement line not found");
  if (line.matchStatus === "MATCHED") {
    throw new HttpError(409, "This statement line is already matched. Unmatch it first.", "STATEMENT_LINE_ALREADY_MATCHED");
  }
  return line;
}

// Locks + re-reads the book document and verifies it may be matched to this
// statement line in this session. Returns the server-side book item (its
// amount is the bank movement, never a client value).
async function lockEligibleBookItem(conn, session, line, { sourceType, sourceId, lineId = null }) {
  const table = DOCUMENT_TABLES[sourceType];
  const id = Number(sourceId);
  if (!table || !Number.isInteger(id) || id <= 0) throw new HttpError(404, "Book document not found");

  const [locked] = await conn.execute(`SELECT id, company_id FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
  const doc = locked[0];
  // Another company's document answers exactly like a missing one.
  if (!doc || (session.companyId && Number(doc.company_id) !== Number(session.companyId))) {
    throw new HttpError(404, "Book document not found");
  }

  const item = await loadBookItem(conn, session, { sourceType, sourceId: id, lineId });
  if (!item) throw new HttpError(404, "Book document not found");
  const { header, txn } = item;

  if (String(header.status || "").toUpperCase() !== "POSTED") {
    throw new HttpError(409, `${sourceType} ${header.voucherNo || id} is not Posted, so it cannot be reconciled.`, "BOOK_DOCUMENT_NOT_POSTED");
  }
  if (sourceType === "JV") {
    if (!lineId || !header.lineId) throw new HttpError(400, "Select the journal voucher line that moved through the bank.");
    if (Number(header.accountId) !== Number(session.bankCoaAccountId)) {
      throw new HttpError(409, "That journal voucher line is not on this bank account.", "BOOK_DOCUMENT_OTHER_BANK");
    }
    if (header.sourceModule === "BANK_RECON") {
      throw new HttpError(409, "A journal voucher posted from a reconciliation adjustment cannot be matched again.", "BOOK_DOCUMENT_NOT_ELIGIBLE");
    }
  } else if (Number(header.bankAccountId) !== Number(session.bankAccountId)) {
    throw new HttpError(409, `${sourceType} ${header.voucherNo || id} was not paid through this bank account.`, "BOOK_DOCUMENT_OTHER_BANK");
  }
  if (!txn) {
    throw new HttpError(409, `${sourceType} ${header.voucherNo || id} did not move any money through this bank account.`, "BOOK_DOCUMENT_NO_BANK_MOVEMENT");
  }
  if (txn.direction !== statementDirection(line)) {
    throw new HttpError(
      400,
      txn.direction === "OUT"
        ? "This statement line is money in, but the selected document is money out."
        : "This statement line is money out, but the selected document is money in.",
      "MATCH_DIRECTION_MISMATCH"
    );
  }

  const [existing] = await conn.execute(
    `SELECT m.id, m.session_id AS sessionId, m.statement_line_id AS statementLineId
     FROM bank_recon_matches m
     JOIN bank_recon_sessions s ON s.id = m.session_id
     WHERE m.book_source_type = ? AND m.book_source_id = ? AND m.book_line_id <=> ?
       AND m.status = 'CONFIRMED'
       AND s.bank_account_id = ? AND s.company_id <=> ?
     LIMIT 1
     FOR UPDATE`,
    [sourceType, id, sourceType === "JV" ? Number(lineId) : null, session.bankAccountId, session.companyId ?? null]
  );
  if (existing[0]) {
    const where = Number(existing[0].sessionId) === Number(session.id)
      ? `statement line #${existing[0].statementLineId} in this session`
      : `a statement line in reconciliation session #${existing[0].sessionId}`;
    throw new HttpError(
      409,
      `${sourceType} ${header.voucherNo || id} is already reconciled (matched to ${where}).`,
      "BOOK_DOCUMENT_ALREADY_MATCHED"
    );
  }

  return txn;
}

// Amount rule for a match: the statement amount and the document's bank
// movement must agree within the session's variance. A client-supplied
// amount is only checked, never stored.
function assertMatchAmount(session, line, txn, clientAmount) {
  const stmtAmount = round2(statementAmount(line));
  if (clientAmount !== undefined && clientAmount !== null && clientAmount !== "") {
    const n = Number(clientAmount);
    if (!Number.isFinite(n) || Math.abs(round2(n) - txn.amount) > 0.005) {
      throw new HttpError(
        400,
        `The match amount must be the document's bank amount (${txn.amount.toFixed(2)}).`,
        "MATCH_AMOUNT_INVALID"
      );
    }
  }
  const diff = round2(Math.abs(stmtAmount - txn.amount));
  const edge = round2(varianceEdge(session, stmtAmount));
  if (diff > edge) {
    throw new HttpError(
      400,
      `The statement amount (${stmtAmount.toFixed(2)}) and the document's bank amount (${txn.amount.toFixed(2)}) differ by ${diff.toFixed(2)}, more than this session's allowed variance (${edge.toFixed(2)}). Record the difference as an adjustment instead.`,
      "MATCH_AMOUNT_MISMATCH"
    );
  }
  return txn.amount;
}

// A lock wait that MySQL resolves as a deadlock is a conflicting concurrent
// reconciliation change, not a server fault.
function asConflict(err) {
  if (err && (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT")) {
    return new HttpError(409, "Another reconciliation change was in progress. Refresh and try again.", "RECON_CONCURRENT_CHANGE");
  }
  return err;
}

module.exports = {
  lockStatementLine,
  lockEligibleBookItem,
  assertMatchAmount,
  statementAmount,
  statementDirection,
  asConflict,
  bookKey,
};
