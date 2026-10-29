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

// One query per voucher type. `id` narrows it to a single document (the
// confirmation guard); otherwise it is the date-window load.
async function queryVoucherMovements(conn, type, { bankAccountId, bankCoaAccountId, companyId, fromDate, toDate, id = null }) {
  const isCv = type === "CV";
  const header = isCv ? "cv_headers" : "or_headers";
  const lineTable = isCv ? "cv_lines" : "or_lines";
  const lineFk = isCv ? "cv_id" : "or_id";
  const net = isCv ? "l.credit - l.debit" : "l.debit - l.credit";
  const party = isCv ? "h.payee_name AS partyName" : "h.customer_name AS partyName";
  const receipt = isCv ? "'' AS receiptNo" : "h.receipt_no AS receiptNo";
  const coa = bankCoaAccountId ? Number(bankCoaAccountId) : null;
  const where = id !== null
    ? "h.id = ?"
    : "h.bank_account_id = ? AND h.status = 'Posted' AND h.transaction_date BETWEEN ? AND ?";
  const whereParams = id !== null ? [id] : [bankAccountId, fromDate, toDate];
  const co = companyClause("h.", companyId);
  const [rows] = await conn.execute(
    `SELECT h.id, h.voucher_no AS voucherNo, ${party},
            DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS txnDate,
            h.reference_no AS referenceNo, ${receipt}, h.check_no AS checkNo, h.description,
            h.status, h.bank_account_id AS bankAccountId, h.company_id AS companyId,
            h.total_debit AS grossAmount, h.tax_withheld_amount AS withholdingAmount,
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

async function loadBookTransactions(
  conn,
  bankAccountId,
  bankCoaAccountId,
  periodStart,
  periodEnd,
  toleranceDays,
  companyId = null
) {
  const widenDays = (Number(toleranceDays) || 0) * 2;
  const fromDate = shiftDate(periodStart, -widenDays);
  const toDate = shiftDate(periodEnd, widenDays);
  const scope = { bankAccountId, bankCoaAccountId, companyId, fromDate, toDate };

  const cvRows = await queryVoucherMovements(conn, "CV", scope);
  const orRows = await queryVoucherMovements(conn, "OR", scope);

  // Excludes JVs that themselves came from posting a bank-recon adjustment -
  // those already exist specifically to resolve one statement line and must
  // never be re-offered as an independent unmatched/outstanding book item.
  const jvRows = bankCoaAccountId
    ? (
        await conn.execute(
          `${JV_LINE_SELECT}
           FROM jv_lines jl
           JOIN jv_headers jh ON jh.id = jl.jv_id
           WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?
             AND (jh.source_module IS NULL OR jh.source_module != 'BANK_RECON')${companyClause("jh.", companyId).sql}`,
          [bankCoaAccountId, fromDate, toDate, ...companyClause("jh.", companyId).params]
        )
      )[0]
    : [];

  return [
    ...cvRows.map((r) => toBookTxn("CV", r)),
    ...orRows.map((r) => toBookTxn("OR", r)),
    ...jvRows.map(jvBookTxn),
  ].filter(Boolean);
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

// ---- Reconciliation summary (Phase 9) ----
// Adjusted Bank = Statement Ending Balance + Deposits in Transit - Outstanding Checks.
// Book Balance is derived from the session's own statement-beginning-balance
// (assumed already reconciled as of period start, per standard practice)
// plus posted CV/OR/JV activity on this bank account within the period -
// approved adjustments already hit the ledger once posted as a JV in
// Phase 8, so there is no separate "+ interest - charges" term here the
// way a textbook formula has it: that would double-count once posted.
async function computeSessionSummary(conn, session) {
  const bookTxns = await loadBookTransactions(
    conn,
    session.bankAccountId,
    session.bankCoaAccountId,
    session.periodStart,
    session.periodEnd,
    session.dateToleranceDays,
    session.companyId
  );

  const [confirmedRows] = await conn.execute(
    `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
     FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'`,
    [session.id]
  );
  const confirmedKeys = new Set(
    confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
  );

  const unmatched = bookTxns.filter(
    (t) =>
      !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`) &&
      t.date <= session.periodEnd
  );
  const outstandingChecks = unmatched.filter((t) => t.direction === "OUT");
  const depositsInTransit = unmatched.filter((t) => t.direction === "IN");
  const outstandingChecksTotal = outstandingChecks.reduce((sum, t) => sum + t.amount, 0);
  const depositsInTransitTotal = depositsInTransit.reduce((sum, t) => sum + t.amount, 0);

  // R7-2: the book side moves by what actually crossed the bank (see
  // bankMovement above), not by the gross CV/OR voucher totals. Same
  // per-document figure the matcher uses, over exactly the period.
  const periodTxns = await loadBookTransactions(
    conn,
    session.bankAccountId,
    session.bankCoaAccountId,
    session.periodStart,
    session.periodEnd,
    0,
    session.companyId
  );
  const voucherNet = periodTxns
    .filter((t) => t.sourceType === "CV" || t.sourceType === "OR")
    .reduce((sum, t) => sum + (t.direction === "IN" ? t.amount : -t.amount), 0);

  let jvNet = 0;
  if (session.bankCoaAccountId) {
    const [jvSum] = await conn.execute(
      `SELECT COALESCE(SUM(jl.debit), 0) AS debitTotal, COALESCE(SUM(jl.credit), 0) AS creditTotal
       FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id
       WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?${companyClause("jh.", session.companyId).sql}`,
      [session.bankCoaAccountId, session.periodStart, session.periodEnd, ...companyClause("jh.", session.companyId).params]
    );
    jvNet = Number(jvSum[0].debitTotal) - Number(jvSum[0].creditTotal);
  }

  const bookBalance =
    Number(session.statementBeginningBalance) + voucherNet + jvNet;

  const adjustedBank =
    Number(session.statementEndingBalance) + depositsInTransitTotal - outstandingChecksTotal;
  const difference = round2(adjustedBank - bookBalance);

  const [pendingAdjRows] = await conn.execute(
    "SELECT COUNT(*) AS cnt FROM bank_recon_adjustments WHERE session_id = ? AND status IN ('PENDING', 'APPROVED')",
    [session.id]
  );
  const [unresolvedLinesRows] = await conn.execute(
    "SELECT COUNT(*) AS cnt FROM bank_recon_statement_lines WHERE session_id = ? AND match_status IN ('UNMATCHED', 'SUGGESTED')",
    [session.id]
  );

  const pendingAdjustmentsCount = pendingAdjRows[0].cnt;
  const unresolvedStatementLinesCount = unresolvedLinesRows[0].cnt;

  return {
    statementBeginningBalance: Number(session.statementBeginningBalance),
    statementEndingBalance: Number(session.statementEndingBalance),
    bookBalance: round2(bookBalance),
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
  loadBookItem,
  computeSessionSummary,
};
