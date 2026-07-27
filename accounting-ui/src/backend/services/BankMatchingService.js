const { round2, shiftDate } = require("./ConfidenceScoringService");

const BANK_RECON_SESSION_SELECT = `
  SELECT
    s.id,
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
`;

async function loadBookTransactions(
  conn,
  bankAccountId,
  bankCoaAccountId,
  periodStart,
  periodEnd,
  toleranceDays
) {
  const widenDays = (Number(toleranceDays) || 0) * 2;
  const fromDate = shiftDate(periodStart, -widenDays);
  const toDate = shiftDate(periodEnd, widenDays);

  const [cvRows] = await conn.execute(
    `SELECT id, voucher_no AS voucherNo, payee_name AS payeeName,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
            reference_no AS referenceNo, check_no AS checkNo, total_debit AS totalDebit, description
     FROM cv_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [bankAccountId, fromDate, toDate]
  );

  const [orRows] = await conn.execute(
    `SELECT id, voucher_no AS voucherNo, customer_name AS customerName,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
            reference_no AS referenceNo, receipt_no AS receiptNo, check_no AS checkNo,
            total_debit AS totalDebit, description
     FROM or_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [bankAccountId, fromDate, toDate]
  );

  // Excludes JVs that themselves came from posting a bank-recon adjustment -
  // those already exist specifically to resolve one statement line and must
  // never be re-offered as an independent unmatched/outstanding book item.
  const jvRows = bankCoaAccountId
    ? (
        await conn.execute(
          `SELECT jl.id AS lineId, jh.id AS jvId, jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor,
                  DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
                  jh.reference_no AS referenceNo, jh.description, jl.debit, jl.credit
           FROM jv_lines jl
           JOIN jv_headers jh ON jh.id = jl.jv_id
           WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?
             AND (jh.source_module IS NULL OR jh.source_module != 'BANK_RECON')`,
          [bankCoaAccountId, fromDate, toDate]
        )
      )[0]
    : [];

  const txns = [];

  for (const cv of cvRows) {
    txns.push({
      sourceType: "CV",
      sourceId: cv.id,
      lineId: null,
      amount: Number(cv.totalDebit),
      direction: "OUT",
      date: cv.txnDate,
      referenceNo: cv.referenceNo,
      checkNo: cv.checkNo,
      receiptNo: "",
      payeeOrCustomer: cv.payeeName,
      description: cv.description,
      voucherNo: cv.voucherNo,
    });
  }

  for (const or of orRows) {
    txns.push({
      sourceType: "OR",
      sourceId: or.id,
      lineId: null,
      amount: Number(or.totalDebit),
      direction: "IN",
      date: or.txnDate,
      referenceNo: or.referenceNo,
      checkNo: or.checkNo,
      receiptNo: or.receiptNo,
      payeeOrCustomer: or.customerName,
      description: or.description,
      voucherNo: or.voucherNo,
    });
  }

  for (const jl of jvRows) {
    const debit = Number(jl.debit);
    const credit = Number(jl.credit);
    if (debit <= 0 && credit <= 0) continue;

    txns.push({
      sourceType: "JV",
      sourceId: jl.jvId,
      lineId: jl.lineId,
      amount: debit > 0 ? debit : credit,
      direction: debit > 0 ? "IN" : "OUT",
      date: jl.txnDate,
      referenceNo: jl.referenceNo,
      checkNo: "",
      receiptNo: "",
      payeeOrCustomer: jl.preparedFor,
      description: jl.description,
      voucherNo: jl.voucherNo,
    });
  }

  return txns;
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
    session.dateToleranceDays
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

  const [cvSum] = await conn.execute(
    `SELECT COALESCE(SUM(total_debit), 0) AS total FROM cv_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [session.bankAccountId, session.periodStart, session.periodEnd]
  );
  const [orSum] = await conn.execute(
    `SELECT COALESCE(SUM(total_debit), 0) AS total FROM or_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [session.bankAccountId, session.periodStart, session.periodEnd]
  );

  let jvNet = 0;
  if (session.bankCoaAccountId) {
    const [jvSum] = await conn.execute(
      `SELECT COALESCE(SUM(jl.debit), 0) AS debitTotal, COALESCE(SUM(jl.credit), 0) AS creditTotal
       FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id
       WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?`,
      [session.bankCoaAccountId, session.periodStart, session.periodEnd]
    );
    jvNet = Number(jvSum[0].debitTotal) - Number(jvSum[0].creditTotal);
  }

  const bookBalance =
    Number(session.statementBeginningBalance) - Number(cvSum[0].total) + Number(orSum[0].total) + jvNet;

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

module.exports = { BANK_RECON_SESSION_SELECT, loadBookTransactions, computeSessionSummary };
