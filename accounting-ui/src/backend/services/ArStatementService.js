const pool = require("../db");
const { postedOnlySql } = require("./reportRecognitionService");

// AR Statement of Accounts - a customer-level (party-scoped) statement,
// distinct from LedgerReportService.js's account-level (account_code-scoped)
// engine. The closest existing precedent is the Subsidiary Ledger route
// (GET /api/reports/subsidiary-ledger, server.js) - its AR branch unions
// invoice_headers/or_headers/arap_beginning_balance_lines/memo_headers for
// one partyId over a date range, with a SUM(debit-credit) OVER (...)
// running-balance window function. That route is NOT modified here (it is
// a working, unrelated, already-shipped report) - this file follows the
// exact same 4-source union pattern, same postedOnlySql()/sort_order
// convention, header-level totals (not line-level sums, same as Subsidiary
// Ledger), and the same Debit Memo=increases AR / Credit Memo=decreases AR
// convention. The one genuine addition beyond Subsidiary Ledger: a true
// pre-period Beginning Balance, computed the same "before this date" way
// LedgerReportService.getBeginningBalances/Cash Flow Statement/Daily Cash
// Position already compute an opening balance, just party-scoped instead
// of account-scoped (no such party-scoped opening-balance query exists
// elsewhere in this codebase to reuse).
//
// Payment allocation (transaction_applications) is deliberately NOT
// consumed - same as Subsidiary Ledger. An OR's own total_debit is used as
// a flat customer payment on its transaction_date regardless of which
// invoice(s) it was later applied to; this report cannot distinguish an
// "allocated" from an "unallocated" payment, matching the existing
// Subsidiary Ledger precedent exactly.

const AR_UNION_SQL = `
  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    'INV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
    COALESCE(total_debit, 0) AS debit, 0 AS credit, 1 AS sort_order
  FROM invoice_headers
  WHERE customer_id = ? AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql()}

  UNION ALL

  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    'OR' AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    NULL AS due_date,
    0 AS debit, COALESCE(total_debit, 0) AS credit, 2 AS sort_order
  FROM or_headers
  WHERE customer_id = ? AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql()}

  UNION ALL

  SELECT
    l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
    'AR BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
    COALESCE(l.party_name, '') AS particulars,
    DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
    COALESCE(l.debit, 0) AS debit, 0 AS credit, 0 AS sort_order
  FROM arap_beginning_balance_lines l
  JOIN arap_beginning_balance_headers h ON h.id = l.header_id
  WHERE h.balance_type = 'AR' AND l.party_id = ? AND h.balance_date {DATE_FILTER} AND h.company_id = ? AND ${postedOnlySql("h")}

  UNION ALL

  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    CONCAT(memo_type, ' MEMO') AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    NULL AS due_date,
    CASE WHEN memo_type = 'DEBIT' THEN COALESCE(total_debit, 0) ELSE 0 END AS debit,
    CASE WHEN memo_type = 'CREDIT' THEN COALESCE(total_credit, 0) ELSE 0 END AS credit,
    3 AS sort_order
  FROM memo_headers
  WHERE party_id = ? AND party_type = 'CUSTOMER' AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql()}
`;

function paramsFor(partyId, companyId, dateParams) {
  // 4 branches, each needing (partyId, ...dateParams, companyId).
  return [
    partyId, ...dateParams, companyId,
    partyId, ...dateParams, companyId,
    partyId, ...dateParams, companyId,
    partyId, ...dateParams, companyId,
  ];
}

// Sum of debit-credit across the same 4 AR sources, for everything dated
// strictly before `before` - the party-scoped analog of
// LedgerReportService.getBeginningBalances.
async function getArBeginningBalance({ partyId, before, companyId }) {
  const unionSql = AR_UNION_SQL.replace(/\{DATE_FILTER\}/g, "< ?");
  const [rows] = await pool.execute(
    `SELECT SUM(tx.debit - tx.credit) AS balance FROM (${unionSql}) tx`,
    paramsFor(partyId, companyId, [before])
  );
  return Number(rows[0]?.balance) || 0;
}

// Detail rows for the period, with a running balance seeded by
// `beginningBalance` so the displayed running_balance is a true
// carried-forward figure, not a window starting at 0.
async function getArStatementRows({ partyId, from, to, companyId, beginningBalance }) {
  const unionSql = AR_UNION_SQL.replace(/\{DATE_FILTER\}/g, "BETWEEN ? AND ?");
  const [rows] = await pool.execute(
    `
    SELECT
      transaction_date, source_type, reference_no, transaction_id, particulars, due_date, debit, credit,
      SUM(debit - credit) OVER (ORDER BY transaction_date, sort_order, id) AS window_balance
    FROM (${unionSql}) tx
    ORDER BY transaction_date, sort_order, id
    `,
    paramsFor(partyId, companyId, [from, to])
  );

  return rows.map((r) => ({
    transactionDate: r.transaction_date,
    sourceType: r.source_type,
    referenceNo: r.reference_no,
    dueDate: r.due_date,
    particulars: r.particulars,
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    runningBalance: beginningBalance + (Number(r.window_balance) || 0),
  }));
}

async function getArStatementOfAccounts({ partyId, from, to, companyId }) {
  const beginningBalance = await getArBeginningBalance({ partyId, before: from, companyId });
  const rows = await getArStatementRows({ partyId, from, to, companyId, beginningBalance });
  const endingBalance = rows.length ? rows[rows.length - 1].runningBalance : beginningBalance;

  return { beginningBalance, rows, endingBalance };
}

module.exports = { getArStatementOfAccounts };
