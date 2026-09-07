const pool = require("../db");
const { postedOnlySql } = require("./reportRecognitionService");

// Every transaction-line table that carries an account_code, unioned into one
// ledger stream. Same table set trial-balance/income-statement already union
// for totals-only (server.js) - this assembles it once with full detail
// (date, source, reference, particulars) so it can back both a General
// Ledger (all accounts) and a Cash Flow Statement (accounts filtered to the
// bank_codes list) from one query engine.
//
// Reports Batch 1: this is now also THE canonical recognized-transaction-
// source set for Income Statement, Balance Sheet, and Account Analysis
// (financialStatementService.js) - previously each of those hand-rolled its
// own, shorter UNION (missing Invoice/OR/JV), which is exactly how they
// silently fell behind Trial Balance/General Ledger. Adding a source here
// now automatically reaches every report built on top of it.
//
// dateFilterSql is interpolated identically into every branch - either
// "BETWEEN ? AND ?" (2 params/branch) for a period, "<= ?" (1 param/branch)
// for an as-of date (Balance Sheet), or "< ?" (1 param/branch) for
// "everything before this report's start date" (opening balances).
// gl_beginning_balance_lines uses othrdebit/othrcredit instead of
// debit/credit, and has no particulars/reference_no column, so those are
// synthesized from the header's title/filter_code.
//
// transaction_id is the source HEADER's id (for drill-down, e.g. Account
// Analysis linking back to the originating voucher) - NULL for the two
// beginning-balance branches, which have no voucher to drill into. This is
// an additive column: getLedgerRows/getBeginningBalances below select
// explicit column lists and never reference it, so existing General
// Ledger/Cash Flow Statement behavior is unchanged.
function buildTransactionUnionSql(dateFilterSql) {
  return `
    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'APV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 1 AS sort_order,
      h.id AS transaction_id
    FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'CV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 2 AS sort_order,
      h.id AS transaction_id
    FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'JV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 3 AS sort_order,
      h.id AS transaction_id
    FROM jv_lines l JOIN jv_headers h ON h.id = l.jv_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'INV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 4 AS sort_order,
      h.id AS transaction_id
    FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'OR' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 5 AS sort_order,
      h.id AS transaction_id
    FROM or_lines l JOIN or_headers h ON h.id = l.or_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
      h.balance_type AS source_type, l.reference_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.party_name, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 0 AS sort_order,
      NULL AS transaction_id
    FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    WHERE h.balance_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
      'GL BEGINNING' AS source_type, h.filter_code AS reference_no, l.account_code, l.account_title,
      COALESCE(h.title, '') AS particulars,
      COALESCE(l.othrdebit, 0) AS debit, COALESCE(l.othrcredit, 0) AS credit, 0 AS sort_order,
      NULL AS transaction_id
    FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id
    WHERE h.balance_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'PETTY CASH' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 6 AS sort_order,
      h.id AS transaction_id
    FROM petty_cash_lines l JOIN petty_cash_headers h ON h.id = l.petty_cash_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      CONCAT(h.memo_type, ' MEMO') AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 7 AS sort_order,
      h.id AS transaction_id
    FROM memo_lines l JOIN memo_headers h ON h.id = l.memo_id
    WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ? AND ${postedOnlySql("h")}
  `;
}

function accountCodeFilterSql(accountCodes) {
  if (!accountCodes || accountCodes.length === 0) return "";
  return `AND tx.account_code IN (${accountCodes.map(() => "?").join(",")})`;
}

// Detail rows for a period, one running balance per account_code.
async function getLedgerRows({ from, to, accountCodes, companyId }) {
  const unionSql = buildTransactionUnionSql("BETWEEN ? AND ?");
  const unionParams = Array(9).fill([from, to, companyId]).flat();
  const filterSql = accountCodeFilterSql(accountCodes);

  const [rows] = await pool.execute(
    `
    SELECT
      tx.account_code,
      COALESCE(ca.title, tx.account_title) AS account_title,
      ca.account_class,
      tx.transaction_date,
      tx.source_type,
      tx.reference_no,
      tx.particulars,
      tx.debit,
      tx.credit,
      SUM(tx.debit - tx.credit) OVER (
        PARTITION BY tx.account_code
        ORDER BY tx.transaction_date, tx.sort_order, tx.id
      ) AS running_balance
    FROM (${unionSql}) tx
    LEFT JOIN chart_of_accounts ca
      ON TRIM(CAST(ca.code AS CHAR)) = TRIM(CAST(tx.account_code AS CHAR))
    WHERE tx.account_code IS NOT NULL AND tx.account_code != ''
      ${filterSql}
    ORDER BY tx.account_code, tx.transaction_date, tx.sort_order, tx.id
    `,
    [...unionParams, ...(accountCodes || [])]
  );

  return rows;
}

// Opening balance per account_code for everything dated before `before`.
async function getBeginningBalances({ before, accountCodes, companyId }) {
  const unionSql = buildTransactionUnionSql("< ?");
  const unionParams = Array(9).fill([before, companyId]).flat();
  const filterSql = accountCodeFilterSql(accountCodes);

  const [rows] = await pool.execute(
    `
    SELECT tx.account_code, SUM(tx.debit - tx.credit) AS balance
    FROM (${unionSql}) tx
    WHERE tx.account_code IS NOT NULL AND tx.account_code != ''
      ${filterSql}
    GROUP BY tx.account_code
    `,
    [...unionParams, ...(accountCodes || [])]
  );

  const balances = {};
  for (const row of rows) {
    balances[row.account_code] = Number(row.balance) || 0;
  }
  return balances;
}

// buildTransactionUnionSql is exported (Reports Batch 1) so
// financialStatementService.js can build Income Statement / Balance Sheet /
// Account Analysis on the exact same canonical source set, instead of each
// maintaining its own independent, driftable UNION.
module.exports = { getLedgerRows, getBeginningBalances, buildTransactionUnionSql };
