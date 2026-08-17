const pool = require("../db");

// The exact 4-source union GET /api/reports/trial-balance has always used
// (apv, cv, arap beginning balance, jv) - extracted here so the Unbalanced
// Trial Balance Checker can never drift from what that report actually
// shows; both read this same SQL. Deliberately NOT the 7-source union
// LedgerReportService.js uses for General Ledger (invoice/OR/GL-beginning-
// balance are excluded here, same as the existing report always has) -
// trialBalanceCheckerService surfaces that gap as its own informational
// finding instead of silently changing what Trial Balance counts.
function buildTrialBalanceUnionSql(dateFilterSql) {
  const apvFilter = dateFilterSql ? `WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ?` : "WHERE h.company_id = ?";
  const cvFilter = dateFilterSql ? `WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ?` : "WHERE h.company_id = ?";
  const arapFilter = dateFilterSql ? `WHERE h.balance_date ${dateFilterSql} AND h.company_id = ?` : "WHERE h.company_id = ?";
  const jvFilter = dateFilterSql ? `WHERE h.transaction_date ${dateFilterSql} AND h.company_id = ?` : "WHERE h.company_id = ?";

  return `
    SELECT l.account_code, l.account_title AS account_name,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
    FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id
    ${apvFilter}

    UNION ALL

    SELECT l.account_code, l.account_title AS account_name,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
    FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id
    ${cvFilter}

    UNION ALL

    SELECT l.account_code, l.account_title AS account_name,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
    FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    ${arapFilter}

    UNION ALL

    SELECT l.account_code, l.account_title AS account_name,
      COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
    FROM jv_lines l JOIN jv_headers h ON h.id = l.jv_id
    ${jvFilter}
  `;
}

function buildDateParams(from, to, companyId) {
  if (!from || !to) return { dateFilterSql: "", params: Array(4).fill(companyId) };
  return { dateFilterSql: "BETWEEN ? AND ?", params: Array(4).fill([from, to, companyId]).flat() };
}

// Same per-account rows GET /api/reports/trial-balance has always returned.
async function getTrialBalanceRows({ from, to, companyId }) {
  const { dateFilterSql, params } = buildDateParams(from, to, companyId);
  const unionSql = buildTrialBalanceUnionSql(dateFilterSql);

  const [rows] = await pool.execute(
    `
    SELECT
      tb.account_code,
      tb.account_name,
      CASE
        WHEN UPPER(TRIM(c.account_class)) = 'ASSET' THEN 'A'
        WHEN UPPER(TRIM(c.account_class)) IN ('LIABILITY', 'LIABILITIES') THEN 'L'
        WHEN UPPER(TRIM(c.account_class)) = 'INCOME' THEN 'I'
        WHEN UPPER(TRIM(c.account_class)) IN ('CAPITAL', 'EQUITY') THEN 'C'
        WHEN UPPER(TRIM(c.account_class)) = 'EXPENSE' THEN 'E'
        ELSE ''
      END AS account_class,
      CASE WHEN SUM(tb.debit) - SUM(tb.credit) > 0 THEN SUM(tb.debit) - SUM(tb.credit) ELSE 0 END AS debit,
      CASE WHEN SUM(tb.credit) - SUM(tb.debit) > 0 THEN SUM(tb.credit) - SUM(tb.debit) ELSE 0 END AS credit
    FROM (${unionSql}) tb
    LEFT JOIN chart_of_accounts c ON TRIM(CAST(c.code AS CHAR)) = TRIM(CAST(tb.account_code AS CHAR))
    WHERE tb.account_code IS NOT NULL AND tb.account_code != ''
    GROUP BY tb.account_code, tb.account_name, c.account_class
    HAVING debit != 0 OR credit != 0
    ORDER BY tb.account_code ASC
    `,
    params
  );

  return rows;
}

// Totals exactly as they appear on screen: SUM of the same per-account
// NETTED debit/credit values the report table renders (not a raw
// pre-netting sum - those are not the same number). Computed entirely in
// SQL/DECIMAL so the balanced/unbalanced decision never touches a JS float.
async function getTrialBalanceTotals({ from, to, companyId }) {
  const { dateFilterSql, params } = buildDateParams(from, to, companyId);
  const unionSql = buildTrialBalanceUnionSql(dateFilterSql);

  const [rows] = await pool.execute(
    `
    SELECT
      COALESCE(SUM(acct.debit), 0) AS total_debit,
      COALESCE(SUM(acct.credit), 0) AS total_credit,
      COALESCE(SUM(acct.debit), 0) - COALESCE(SUM(acct.credit), 0) AS difference
    FROM (
      SELECT
        tb.account_code,
        CASE WHEN SUM(tb.debit) - SUM(tb.credit) > 0 THEN SUM(tb.debit) - SUM(tb.credit) ELSE 0 END AS debit,
        CASE WHEN SUM(tb.credit) - SUM(tb.debit) > 0 THEN SUM(tb.credit) - SUM(tb.debit) ELSE 0 END AS credit
      FROM (${unionSql}) tb
      WHERE tb.account_code IS NOT NULL AND tb.account_code != ''
      GROUP BY tb.account_code
      HAVING debit != 0 OR credit != 0
    ) acct
    `,
    params
  );

  const row = rows[0] || {};
  return {
    totalDebit: row.total_debit ?? "0.00",
    totalCredit: row.total_credit ?? "0.00",
    difference: row.difference ?? "0.00",
  };
}

module.exports = {
  buildTrialBalanceUnionSql,
  buildDateParams,
  getTrialBalanceRows,
  getTrialBalanceTotals,
};
