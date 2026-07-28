const pool = require("../db");

// Every transaction-line table that carries an account_code, unioned into one
// ledger stream. Same table set trial-balance/income-statement already union
// for totals-only (server.js) - this assembles it once with full detail
// (date, source, reference, particulars) so it can back both a General
// Ledger (all accounts) and a Cash Flow Statement (accounts filtered to the
// bank_codes list) from one query engine.
//
// dateFilterSql is interpolated identically into every branch - either
// "BETWEEN ? AND ?" (2 params/branch) for a period, or "< ?" (1 param/branch)
// for "everything before this report's start date" (used for opening
// balances). gl_beginning_balance_lines uses othrdebit/othrcredit instead of
// debit/credit, and has no particulars/reference_no column, so those are
// synthesized from the header's title/filter_code.
function buildTransactionUnionSql(dateFilterSql) {
  return `
    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'APV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 1 AS sort_order
    FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id
    WHERE h.transaction_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'CV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 2 AS sort_order
    FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id
    WHERE h.transaction_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'JV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 3 AS sort_order
    FROM jv_lines l JOIN jv_headers h ON h.id = l.jv_id
    WHERE h.transaction_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'INV' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 4 AS sort_order
    FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id
    WHERE h.transaction_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
      'OR' AS source_type, h.voucher_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.particulars, h.description, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 5 AS sort_order
    FROM or_lines l JOIN or_headers h ON h.id = l.or_id
    WHERE h.transaction_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
      h.balance_type AS source_type, l.reference_no AS reference_no, l.account_code, l.account_title,
      COALESCE(l.party_name, '') AS particulars,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit, 0 AS sort_order
    FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    WHERE h.balance_date ${dateFilterSql}

    UNION ALL

    SELECT l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
      'GL BEGINNING' AS source_type, h.filter_code AS reference_no, l.account_code, l.account_title,
      COALESCE(h.title, '') AS particulars,
      COALESCE(l.othrdebit, 0) AS debit, COALESCE(l.othrcredit, 0) AS credit, 0 AS sort_order
    FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id
    WHERE h.balance_date ${dateFilterSql}
  `;
}

function accountCodeFilterSql(accountCodes) {
  if (!accountCodes || accountCodes.length === 0) return "";
  return `AND tx.account_code IN (${accountCodes.map(() => "?").join(",")})`;
}

// Detail rows for a period, one running balance per account_code.
async function getLedgerRows({ from, to, accountCodes }) {
  const unionSql = buildTransactionUnionSql("BETWEEN ? AND ?");
  const unionParams = Array(7).fill([from, to]).flat();
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
async function getBeginningBalances({ before, accountCodes }) {
  const unionSql = buildTransactionUnionSql("< ?");
  const unionParams = Array(7).fill([before]).flat();
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

module.exports = { getLedgerRows, getBeginningBalances };
