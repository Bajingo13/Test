const pool = require("../db");
const { postedOnlySql } = require("./reportRecognitionService");
const ControlAmount = require("./controlAmountService");

// AP Statement of Accounts (TC-REPORT-015) - the supplier-side mirror of
// ArStatementService.js, using the same structure (party-scoped 4-source
// union, true pre-period Beginning Balance, running balance seeded by it)
// and the same sources / amounts the AP Subsidiary Ledger branch already
// uses (server.js GET /api/reports/subsidiary-ledger, type=AP):
//
//   APV            credit  = the AP CONTROL amount (P0 TC1-062: Gross - EWT)
//   CV             debit   = what the CV settled on the AP control account
//   AP BEGINNING   credit  = arap_beginning_balance_lines.credit
//   Supplier memo  P0 TC1-092b control-line amount: DM decreases AP (debit),
//                  CM increases AP (credit)
//
// Balance convention: a payable is positive - running balance = credit - debit
// (the AP Subsidiary Ledger's SUM(credit - debit)). Posted-only recognition
// via postedOnlySql(), exactly like every other report: Draft / Cancelled /
// Void documents never appear. ArStatementService.js is not modified.

// Multi-Branch Phase C-2A: built per call (not once at load) so postedOnlySql()
// can apply the report request's branch scope.
const apUnionSql = () => `
  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    'APV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
    0 AS debit, ${ControlAmount.baseOriginalExpr("APV", "apv_headers", "ca")} AS credit, 1 AS sort_order
  FROM apv_headers
  LEFT JOIN ${ControlAmount.aggregateSql("APV")} ca ON ca.doc_id = apv_headers.id
  WHERE supplier_id = ? AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql("apv_headers")}

  UNION ALL

  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    'CV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    NULL AS due_date,
    ${ControlAmount.paymentSettledExpr("CV", "cv_headers.total_credit", "ca")} AS debit, 0 AS credit, 2 AS sort_order
  FROM cv_headers
  LEFT JOIN ${ControlAmount.aggregateSql("CV")} ca ON ca.doc_id = cv_headers.id
  WHERE payee_id = ? AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql("cv_headers")}

  UNION ALL

  SELECT
    l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
    'AP BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
    COALESCE(l.party_name, '') AS particulars,
    DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
    0 AS debit, COALESCE(l.credit, 0) AS credit, 0 AS sort_order
  FROM arap_beginning_balance_lines l
  JOIN arap_beginning_balance_headers h ON h.id = l.header_id
  WHERE h.balance_type = 'AP' AND l.party_id = ? AND h.balance_date {DATE_FILTER} AND h.company_id = ? AND ${postedOnlySql("h")}

  UNION ALL

  SELECT
    id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
    CONCAT(memo_type, ' MEMO') AS source_type, voucher_no AS reference_no, id AS transaction_id,
    COALESCE(description, '') AS particulars,
    NULL AS due_date,
    GREATEST(-${ControlAmount.memoSignedBaseExpr("AP", "memo_headers", "ma")}, 0) AS debit,
    GREATEST(${ControlAmount.memoSignedBaseExpr("AP", "memo_headers", "ma")}, 0) AS credit,
    3 AS sort_order
  FROM memo_headers
  LEFT JOIN ${ControlAmount.memoAggregateSql("AP")} ma ON ma.doc_id = memo_headers.id
  WHERE party_id = ? AND party_type = 'SUPPLIER' AND transaction_date {DATE_FILTER} AND company_id = ? AND ${postedOnlySql("memo_headers")}
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

// Sum of credit - debit across the 4 AP sources for everything dated
// strictly before `before`.
async function getApBeginningBalance({ partyId, before, companyId }) {
  const unionSql = apUnionSql().replace(/\{DATE_FILTER\}/g, "< ?");
  const [rows] = await pool.execute(
    `SELECT SUM(tx.credit - tx.debit) AS balance FROM (${unionSql}) tx`,
    paramsFor(partyId, companyId, [before])
  );
  return Number(rows[0]?.balance) || 0;
}

async function getApStatementRows({ partyId, from, to, companyId, beginningBalance }) {
  const unionSql = apUnionSql().replace(/\{DATE_FILTER\}/g, "BETWEEN ? AND ?");
  const [rows] = await pool.execute(
    `
    SELECT
      transaction_date, source_type, reference_no, transaction_id, particulars, due_date, debit, credit,
      SUM(credit - debit) OVER (ORDER BY transaction_date, sort_order, id) AS window_balance
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
    runningBalance: Math.round((beginningBalance + (Number(r.window_balance) || 0)) * 100) / 100,
  }));
}

async function getApStatementOfAccounts({ partyId, from, to, companyId }) {
  const beginningBalance = await getApBeginningBalance({ partyId, before: from, companyId });
  const rows = await getApStatementRows({ partyId, from, to, companyId, beginningBalance });
  const endingBalance = rows.length ? rows[rows.length - 1].runningBalance : beginningBalance;

  return { beginningBalance, rows, endingBalance };
}

module.exports = { getApStatementOfAccounts, get AP_UNION_SQL() { return apUnionSql(); } };
