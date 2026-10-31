const { round2, shiftDate } = require("./ConfidenceScoringService");

const BANK_RECON_SESSION_SELECT = `
  SELECT
    s.id,
    s.company_id AS companyId,
    co.name AS companyName,
    s.bank_account_id AS bankAccountId,
    bc.bank_code AS bankCode,
    bc.bank_name AS bankName,
    bc.account_no AS bankAccountNo,
    bc.account_name AS bankAccountName,
    bc.coa_account_id AS bankCoaAccountId,
    DATE_FORMAT(s.period_start, '%Y-%m-%d') AS periodStart,
    DATE_FORMAT(s.period_end, '%Y-%m-%d') AS periodEnd,
    s.statement_beginning_balance AS statementBeginningBalance,
    s.opening_balance_source AS openingBalanceSource,
    s.opening_balance_source_session_id AS openingBalanceSourceSessionId,
    DATE_FORMAT(src.period_start, '%Y-%m-%d') AS openingSourcePeriodStart,
    DATE_FORMAT(src.period_end, '%Y-%m-%d') AS openingSourcePeriodEnd,
    src.statement_ending_balance AS openingSourceEndingBalance,
    src.status AS openingSourceStatus,
    s.statement_ending_balance AS statementEndingBalance,
    s.date_tolerance_days AS dateToleranceDays,
    s.amount_variance_type AS amountVarianceType,
    s.amount_variance_value AS amountVarianceValue,
    s.status,
    s.notes,
    s.created_by AS createdBy,
    s.created_at AS createdAt,
    s.finalized_by AS finalizedBy,
    s.finalized_at AS finalizedAt
  FROM bank_recon_sessions s
  JOIN bank_codes bc ON bc.id = s.bank_account_id
  LEFT JOIN companies co ON co.id = s.company_id
  LEFT JOIN bank_recon_sessions src ON src.id = s.opening_balance_source_session_id
`;

// bank_codes and chart_of_accounts are global, so one bank account / cash GL
// account can carry posted activity from several companies. Every book-side
// query therefore adds the session's own company; a NULL company (legacy,
// Super-Admin-only session) keeps the previous unfiltered behaviour.
function companyClause(alias, companyId) {
  return companyId ? { sql: ` AND ${alias}company_id = ?`, params: [Number(companyId)] } : { sql: "", params: [] };
}

// ---- Bank movement (R7-2) ----
// A CV/OR header carries the GROSS voucher amount (total_debit). The cash
// that actually crossed the bank is smaller whenever tax was withheld
// (CV: Dr AP 1,000 / Cr Bank 980 / Cr EWT payable 20; OR: Dr Bank 980 /
// Dr CWT 20 / Cr AR 1,000). Reconciliation must compare the statement to
// that bank movement, never to the gross amount - and must not recompute
// any tax itself. So the movement is read straight from the voucher's own
// posted journal lines on the session bank account's GL account
// (bank_codes.coa_account_id):
//   CV: SUM(credit - debit) of its cv_lines on that account (money OUT)
//   OR: SUM(debit - credit) of its or_lines on that account (money IN)
// Only when the voucher has no line on that GL account at all (bank code
// without a GL link, or a voucher booked to another cash account) does it
// fall back to the stored header values: gross - tax_withheld_amount.
// The accounting document is never changed; amountSource says which rule
// produced the figure.
// R9 keeps this rule for every payment method, Cash included: how Cash
// vouchers booked to cash on hand are treated is deliberately unchanged
// until the historical population is reviewed (r9PaymentFieldAudit.sql,
// query 7).
const AMOUNT_SOURCE = { BANK_LINE: "BANK_LINE", GROSS_LESS_WITHHOLDING: "GROSS_LESS_WITHHOLDING" };

function bankMovement(row) {
  const grossAmount = round2(Number(row.grossAmount) || 0);
  const withholdingAmount = round2(Number(row.withholdingAmount) || 0);
  const fromBankLine = Number(row.bankLineCount) > 0;
  const bankMovementAmount = fromBankLine
    ? round2(Number(row.bankLineNet) || 0)
    : round2(grossAmount - withholdingAmount);
  return {
    grossAmount,
    withholdingAmount,
    bankMovementAmount,
    amountSource: fromBankLine ? AMOUNT_SOURCE.BANK_LINE : AMOUNT_SOURCE.GROSS_LESS_WITHHOLDING,
  };
}

// ---- Book-side "cleared" state (R8.3 carry-forward foundation) ----
// A book document (JV: its bank line) is CLEARED once a CONFIRMED match
// for it exists in a reconciliation session of the same company + bank
// account. "Cleared as of X" counts only sessions whose period ended before
// X, so a January check that is still unmatched in January stays
// outstanding into February until a session actually confirms it - never
// because of its date.
function notClearedClause(type, idExpr, lineExpr, scope) {
  if (!scope.excludeCleared) return { sql: "", params: [] };
  return {
    sql: ` AND NOT EXISTS (
            SELECT 1 FROM bank_recon_matches cm JOIN bank_recon_sessions cs ON cs.id = cm.session_id
            WHERE cm.book_source_type = '${type}' AND cm.book_source_id = ${idExpr} AND cm.book_line_id <=> ${lineExpr}
              AND cm.status = 'CONFIRMED' AND cs.bank_account_id = ? AND cs.company_id <=> ?${scope.clearedBefore ? " AND cs.period_end < ?" : ""})`,
    params: [scope.bankAccountId, scope.companyId ?? null, ...(scope.clearedBefore ? [scope.clearedBefore] : [])],
  };
}

function dateRange(column, scope) {
  const parts = [];
  const params = [];
  if (scope.fromDate) {
    parts.push(` AND ${column} >= ?`);
    params.push(scope.fromDate);
  }
  if (scope.toDate) {
    parts.push(` AND ${column} <= ?`);
    params.push(scope.toDate);
  }
  return { sql: parts.join(""), params };
}

// One query per voucher type. `id` narrows it to a single document (the
// confirmation guard); otherwise posted documents on the bank account in
// the scope's date range (either bound optional), optionally not cleared.
async function queryVoucherMovements(conn, type, scope) {
  const { bankCoaAccountId, companyId, id = null } = scope;
  const isCv = type === "CV";
  const header = isCv ? "cv_headers" : "or_headers";
  const lineTable = isCv ? "cv_lines" : "or_lines";
  const lineFk = isCv ? "cv_id" : "or_id";
  const net = isCv ? "l.credit - l.debit" : "l.debit - l.credit";
  const party = isCv ? "h.payee_name AS partyName" : "h.customer_name AS partyName";
  const receipt = isCv ? "'' AS receiptNo" : "h.receipt_no AS receiptNo";
  const coa = bankCoaAccountId ? Number(bankCoaAccountId) : null;
  let where;
  let whereParams;
  if (id !== null) {
    where = "h.id = ?";
    whereParams = [id];
  } else {
    const range = dateRange("h.transaction_date", scope);
    const cleared = notClearedClause(type, "h.id", "NULL", scope);
    where = `h.bank_account_id = ? AND h.status = 'Posted'${range.sql}${cleared.sql}`;
    whereParams = [scope.bankAccountId, ...range.params, ...cleared.params];
  }
  const co = companyClause("h.", companyId);
  const [rows] = await conn.execute(
    `SELECT h.id, h.voucher_no AS voucherNo, ${party},
            DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS txnDate,
            h.reference_no AS referenceNo, ${receipt}, h.check_no AS checkNo, h.description,
            h.payment_method AS paymentMethod, DATE_FORMAT(h.check_date, '%Y-%m-%d') AS checkDate,
            h.payment_reference AS paymentReference, DATE_FORMAT(h.payment_date, '%Y-%m-%d') AS paymentDate,
            h.status, h.bank_account_id AS bankAccountId, h.company_id AS companyId,
            h.total_debit AS grossAmount, h.tax_withheld_amount AS withholdingAmount,
            h.currency_id AS currencyId,
            (SELECT cur.is_base_currency FROM currencies cur WHERE cur.id = h.currency_id) AS currencyIsBase,
            (SELECT COUNT(*) FROM ${lineTable} l WHERE l.${lineFk} = h.id AND l.account_id = ?) AS bankLineCount,
            (SELECT COALESCE(SUM(${net}), 0) FROM ${lineTable} l WHERE l.${lineFk} = h.id AND l.account_id = ?) AS bankLineNet
     FROM ${header} h
     WHERE ${where}${co.sql}`,
    [coa, coa, ...whereParams, ...co.params]
  );
  return rows;
}

function toBookTxn(type, row) {
  const m = bankMovement(row);
  // A voucher whose bank line nets the other way (rare - e.g. a CV that
  // ends up depositing) is shown in the direction the money really moved;
  // one that nets to zero never touched the bank and is not a book item.
  const naturalDirection = type === "CV" ? "OUT" : "IN";
  if (m.bankMovementAmount === 0) return null;
  const direction = m.bankMovementAmount > 0 ? naturalDirection : naturalDirection === "OUT" ? "IN" : "OUT";
  return {
    sourceType: type,
    sourceId: row.id,
    lineId: null,
    amount: Math.abs(m.bankMovementAmount),
    grossAmount: m.grossAmount,
    withholdingAmount: m.withholdingAmount,
    bankMovementAmount: Math.abs(m.bankMovementAmount),
    amountSource: m.amountSource,
    direction,
    date: row.txnDate,
    referenceNo: row.referenceNo,
    checkNo: row.checkNo,
    receiptNo: row.receiptNo || "",
    payeeOrCustomer: row.partyName,
    description: row.description,
    voucherNo: row.voucherNo,
    // R9 payment details (Check: check number + check date; Bank Transfer:
    // transfer reference + date)
    paymentMethod: row.paymentMethod || null,
    checkDate: row.checkDate || null,
    paymentReference: row.paymentReference || "",
    paymentDate: row.paymentDate || null,
    currencyId: row.currencyId ?? null,
    // R8.4-B: a document in a currency other than the company's base
    // currency is never combined into a multi-OR deposit match.
    foreignCurrency: row.currencyId != null && Number(row.currencyIsBase) !== 1,
  };
}

function jvBookTxn(jl) {
  const debit = Number(jl.debit);
  const credit = Number(jl.credit);
  if (debit <= 0 && credit <= 0) return null;
  const amount = debit > 0 ? debit : credit;
  return {
    sourceType: "JV",
    sourceId: jl.jvId,
    lineId: jl.lineId,
    amount,
    grossAmount: amount,
    withholdingAmount: 0,
    bankMovementAmount: amount,
    amountSource: AMOUNT_SOURCE.BANK_LINE,
    direction: debit > 0 ? "IN" : "OUT",
    date: jl.txnDate,
    referenceNo: jl.referenceNo,
    checkNo: "",
    receiptNo: "",
    payeeOrCustomer: jl.preparedFor,
    description: jl.description,
    voucherNo: jl.voucherNo,
  };
}

const JV_LINE_SELECT = `SELECT jl.id AS lineId, jh.id AS jvId, jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor,
         DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
         jh.reference_no AS referenceNo, jh.description, jl.debit, jl.credit`;

// Posted CV / OR / JV bank movements for a session's bank account and
// company. scope: { fromDate?, toDate?, excludeCleared?, clearedBefore? }.
async function loadBookItems(conn, session, range = {}) {
  const scope = {
    bankAccountId: session.bankAccountId,
    bankCoaAccountId: session.bankCoaAccountId,
    companyId: session.companyId,
    ...range,
  };
  const cvRows = await queryVoucherMovements(conn, "CV", scope);
  const orRows = await queryVoucherMovements(conn, "OR", scope);

  // Excludes JVs that themselves came from posting a bank-recon adjustment -
  // those already exist specifically to resolve one statement line and must
  // never be re-offered as an independent unmatched/outstanding book item.
  let jvRows = [];
  if (session.bankCoaAccountId) {
    const dates = dateRange("jh.transaction_date", scope);
    const cleared = notClearedClause("JV", "jh.id", "jl.id", scope);
    const co = companyClause("jh.", session.companyId);
    [jvRows] = await conn.execute(
      `${JV_LINE_SELECT}
       FROM jv_lines jl
       JOIN jv_headers jh ON jh.id = jl.jv_id
       WHERE jl.account_id = ? AND jh.status = 'Posted'${dates.sql}
         AND (jh.source_module IS NULL OR jh.source_module != 'BANK_RECON')${cleared.sql}${co.sql}`,
      [session.bankCoaAccountId, ...dates.params, ...cleared.params, ...co.params]
    );
  }

  return [
    ...cvRows.map((r) => toBookTxn("CV", r)),
    ...orRows.map((r) => toBookTxn("OR", r)),
    ...jvRows.map(jvBookTxn),
  ].filter(Boolean);
}

// The date-window load (period widened by twice the date tolerance).
async function loadBookTransactions(conn, bankAccountId, bankCoaAccountId, periodStart, periodEnd, toleranceDays, companyId = null) {
  const widenDays = (Number(toleranceDays) || 0) * 2;
  return loadBookItems(conn, { bankAccountId, bankCoaAccountId, companyId }, {
    fromDate: shiftDate(periodStart, -widenDays),
    toDate: shiftDate(periodEnd, widenDays),
  });
}

// Book items a session may match: everything in its widened date window,
// plus every OLDER document that has never been cleared (carry-forward - a
// check written in January can clear in February).
async function loadCandidatePool(conn, session) {
  const widenDays = (Number(session.dateToleranceDays) || 0) * 2;
  const windowStart = shiftDate(session.periodStart, -widenDays);
  const inWindow = await loadBookItems(conn, session, { fromDate: windowStart, toDate: shiftDate(session.periodEnd, widenDays) });
  const older = await loadBookItems(conn, session, { toDate: shiftDate(windowStart, -1), excludeCleared: true });
  return [...older, ...inWindow];
}

// ---- Statement history (R8.3) ----
// Imported statement rows are the bank account's history (company + bank
// account + batch), not a session's private copy. A session works on:
//   * every row of its company + bank account dated inside its period, and
//   * every EARLIER row still unresolved (UNMATCHED / SUGGESTED) - carry-
//     forward - plus earlier rows this session itself confirmed.
// A legacy session with no company only sees its own rows.
function statementSetWhere(session, alias = "sl") {
  const owner = session.companyId
    ? `${alias}.company_id = ?`
    : `(${alias}.company_id IS NULL AND ${alias}.session_id = ?)`;
  return {
    sql: `${owner} AND ${alias}.bank_account_id = ?
      AND (${alias}.txn_date BETWEEN ? AND ?
           OR (${alias}.txn_date < ? AND (${alias}.match_status IN ('UNMATCHED', 'SUGGESTED')
               OR EXISTS (SELECT 1 FROM bank_recon_matches sm WHERE sm.statement_line_id = ${alias}.id AND sm.session_id = ? AND sm.status = 'CONFIRMED'))))`,
    params: [session.companyId ?? session.id, session.bankAccountId, session.periodStart, session.periodEnd, session.periodStart, session.id],
  };
}

async function isInStatementSet(conn, session, statementLineId) {
  const set = statementSetWhere(session);
  const [rows] = await conn.execute(`SELECT sl.id FROM bank_recon_statement_lines sl WHERE sl.id = ? AND ${set.sql}`, [statementLineId, ...set.params]);
  return rows.length > 0;
}

// One book document as reconciliation sees it, regardless of status / bank
// account / date (the confirmation guard checks those itself and needs the
// raw values to say WHY a document is not eligible). Returns
// { header, txn } or null when the document does not exist in the company.
async function loadBookItem(conn, session, { sourceType, sourceId, lineId = null }) {
  const scope = {
    bankAccountId: session.bankAccountId,
    bankCoaAccountId: session.bankCoaAccountId,
    companyId: session.companyId,
    id: Number(sourceId),
  };
  if (sourceType === "CV" || sourceType === "OR") {
    const [row] = await queryVoucherMovements(conn, sourceType, scope);
    if (!row) return null;
    return { header: row, txn: toBookTxn(sourceType, row) };
  }
  if (sourceType === "JV") {
    const co = companyClause("jh.", session.companyId);
    const [rows] = await conn.execute(
      `${JV_LINE_SELECT}, jl.account_id AS accountId, jh.status, jh.source_module AS sourceModule, jh.company_id AS companyId
       FROM jv_headers jh
       LEFT JOIN jv_lines jl ON jl.jv_id = jh.id AND jl.id = ?
       WHERE jh.id = ?${co.sql}`,
      [lineId === null || lineId === undefined ? null : Number(lineId), Number(sourceId), ...co.params]
    );
    const row = rows[0];
    if (!row) return null;
    return { header: row, txn: row.lineId ? jvBookTxn(row) : null };
  }
  return null;
}

// ---- Reconciliation summary (Phase 9, carry-forward in R8.3) ----
// Adjusted Bank = Statement Ending Balance + Deposits in Transit - Outstanding Checks,
// where outstanding means "not cleared by a session whose period ended on
// or before this period's end" - so items carried from earlier months stay
// listed until a session confirms them.
// Book Balance = Statement Beginning Balance
//              + book items already outstanding at the start of the period
//                (in transit at the opening: deposits +, checks -)
//              + posted CV/OR/JV activity on this bank account in the period.
// (The beginning statement balance plus the items in transit at the start is
// the book balance at the start.) Approved adjustments already hit the
// ledger once posted as a JV, so there is no separate charges/interest term.
async function computeSessionSummary(conn, session) {
  const start = session.periodStart;
  const end = session.periodEnd;

  const carried = await loadBookItems(conn, session, { toDate: shiftDate(start, -1), excludeCleared: true, clearedBefore: start });
  const outstanding = await loadBookItems(conn, session, { toDate: end, excludeCleared: true, clearedBefore: shiftDate(end, 1) });
  const outstandingChecks = outstanding.filter((t) => t.direction === "OUT");
  const depositsInTransit = outstanding.filter((t) => t.direction === "IN");
  const outstandingChecksTotal = outstandingChecks.reduce((sum, t) => sum + t.amount, 0);
  const depositsInTransitTotal = depositsInTransit.reduce((sum, t) => sum + t.amount, 0);
  const net = (items) => items.reduce((sum, t) => sum + (t.direction === "IN" ? t.amount : -t.amount), 0);

  // R7-2: the book side moves by what actually crossed the bank (see
  // bankMovement above), not by the gross CV/OR voucher totals.
  const periodTxns = await loadBookItems(conn, session, { fromDate: start, toDate: end });
  const voucherNet = net(periodTxns.filter((t) => t.sourceType === "CV" || t.sourceType === "OR"));

  let jvNet = 0;
  if (session.bankCoaAccountId) {
    const [jvSum] = await conn.execute(
      `SELECT COALESCE(SUM(jl.debit), 0) AS debitTotal, COALESCE(SUM(jl.credit), 0) AS creditTotal
       FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id
       WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?${companyClause("jh.", session.companyId).sql}`,
      [session.bankCoaAccountId, start, end, ...companyClause("jh.", session.companyId).params]
    );
    jvNet = Number(jvSum[0].debitTotal) - Number(jvSum[0].creditTotal);
  }

  const carriedNet = net(carried);
  const bookBalance = Number(session.statementBeginningBalance) + carriedNet + voucherNet + jvNet;

  const adjustedBank =
    Number(session.statementEndingBalance) + depositsInTransitTotal - outstandingChecksTotal;
  const difference = round2(adjustedBank - bookBalance);

  const [pendingAdjRows] = await conn.execute(
    "SELECT COUNT(*) AS cnt FROM bank_recon_adjustments WHERE session_id = ? AND status IN ('PENDING', 'APPROVED')",
    [session.id]
  );
  const set = statementSetWhere(session);
  const [unresolvedLinesRows] = await conn.execute(
    `SELECT COUNT(*) AS cnt FROM bank_recon_statement_lines sl WHERE ${set.sql} AND sl.match_status IN ('UNMATCHED', 'SUGGESTED')`,
    set.params
  );

  const pendingAdjustmentsCount = pendingAdjRows[0].cnt;
  const unresolvedStatementLinesCount = unresolvedLinesRows[0].cnt;

  return {
    statementBeginningBalance: Number(session.statementBeginningBalance),
    statementEndingBalance: Number(session.statementEndingBalance),
    bookBalance: round2(bookBalance),
    carriedForward: {
      count: carried.length,
      net: round2(carriedNet),
    },
    outstandingChecks,
    outstandingChecksTotal: round2(outstandingChecksTotal),
    depositsInTransit,
    depositsInTransitTotal: round2(depositsInTransitTotal),
    adjustedBank: round2(adjustedBank),
    difference,
    pendingAdjustmentsCount,
    unresolvedStatementLinesCount,
    canFinalizeCleanly:
      difference === 0 && pendingAdjustmentsCount === 0 && unresolvedStatementLinesCount === 0,
  };
}

module.exports = {
  BANK_RECON_SESSION_SELECT,
  AMOUNT_SOURCE,
  bankMovement,
  loadBookTransactions,
  loadBookItems,
  loadCandidatePool,
  loadBookItem,
  statementSetWhere,
  isInStatementSet,
  computeSessionSummary,
};
