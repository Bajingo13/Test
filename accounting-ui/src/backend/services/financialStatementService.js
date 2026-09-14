const pool = require("../db");
const LedgerReportService = require("./LedgerReportService");

// Reports Batch 1: Income Statement, Balance Sheet, and Account Analysis
// previously each hand-rolled their own UNION of "recognized transaction
// sources" directly in server.js - a shorter, independently-maintained list
// (APV/CV/GL-Beginning/AR-AP-Beginning/Petty-Cash/Memo for Income
// Statement/Balance Sheet; APV/CV/AR-AP-Beginning/JV/Petty-Cash/Memo for
// Account Analysis) that silently omitted Invoice, OR, and/or JV. Trial
// Balance and General Ledger already used the complete set. This service
// builds all three reports on LedgerReportService.buildTransactionUnionSql -
// the SAME canonical 9-branch union GL/Cash Flow Statement already use - so
// a future new source only has to be added once, in one place, to reach
// every report at the same time.
//
// No accounting posting logic, VAT/EWT generation, or transaction_tax_entries
// handling lives here or is touched by this file - it only reads existing
// Posted lines (via LedgerReportService's postedOnlySql-gated union) for
// reporting.

// Income Statement rows: one row per Revenue/Expense account, `amount` =
// SUM(credit - debit) over the period - positive for revenue earned,
// negative for expense incurred (expense accounts are debit-normal), same
// convention the pre-existing query used. chart_of_accounts/coa_groups/
// account_group_codes are intentionally NOT company-filtered - shared
// catalog across companies, same as every other report in this file.
async function getIncomeStatementRows({ companyId, from, to }) {
  const unionSql = LedgerReportService.buildTransactionUnionSql("BETWEEN ? AND ?");
  const unionParams = Array(9).fill([from, to, companyId]).flat();

  const [rows] = await pool.execute(
    `
    SELECT
      ag.group_description AS group_name,
      ca.code AS account_code,
      ca.title AS account_title,
      ca.account_class,
      COALESCE(SUM(tx.credit - tx.debit), 0) AS amount
    FROM chart_of_accounts ca
    JOIN coa_groups cg ON cg.coa_id = ca.id
    JOIN account_group_codes ag ON ag.group_code = cg.group_code
    LEFT JOIN (${unionSql}) tx ON TRIM(tx.account_code) = TRIM(ca.code)
    WHERE UPPER(ag.group_description) IN ('REVENUE', 'EXPENSES', 'EXPENSE')
       OR UPPER(ca.account_class) IN ('INCOME', 'EXPENSE')
    GROUP BY
      ag.group_description,
      ca.code,
      ca.title,
      ca.account_class
    ORDER BY
      CASE
        WHEN UPPER(ag.group_description) = 'REVENUE' THEN 1
        WHEN UPPER(ca.account_class) = 'INCOME' THEN 1
        WHEN UPPER(ag.group_description) IN ('EXPENSES', 'EXPENSE') THEN 2
        WHEN UPPER(ca.account_class) = 'EXPENSE' THEN 2
        ELSE 9
      END,
      ca.code ASC
    `,
    unionParams
  );

  return rows;
}

// No fiscal-year configuration exists anywhere in this codebase (checked:
// no "fiscal" reference in src/backend). Documented policy for "Current
// Year Earnings": calendar-year-to-date - January 1st of the as-of date's
// year through the as-of date itself. If fiscal-year configuration is ever
// added, this is the one place that needs to change.
function resolveCurrentEarningsRange(to) {
  const year = String(to || "").slice(0, 4) || String(new Date().getFullYear());
  return { from: `${year}-01-01`, to };
}

// Net income for a period = the sum of every Income Statement row's amount
// (revenue rows positive, expense rows already negative under the
// credit-minus-debit convention above) - this IS the P&L bottom line, not a
// separate computation prone to drifting from the statement it summarizes.
async function getCurrentYearEarnings({ companyId, to }) {
  const { from, to: asOf } = resolveCurrentEarningsRange(to);
  const rows = await getIncomeStatementRows({ companyId, from, to: asOf });
  return rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

// Balance Sheet rows: one row per Asset/Liability/Equity account as of a
// single date, PLUS a computed (never persisted) "Current Year Earnings"
// equity row so Assets = Liabilities + Equity can hold without requiring
// the user to manually close every Revenue/Expense account into Retained
// Earnings via a JV first. This is presentation-only: nothing is written to
// the ledger, no JV is created, no account balance is mutated.
async function getBalanceSheetRows({ companyId, to }) {
  const unionSql = LedgerReportService.buildTransactionUnionSql("<= ?");
  const unionParams = Array(9).fill([to, companyId]).flat();

  const [rows] = await pool.execute(
    `
    SELECT
      ag.group_description AS group_name,
      ca.code AS account_code,
      ca.title AS account_title,
      ca.account_class,
      CASE
        WHEN UPPER(ca.account_class) = 'ASSET'
          THEN COALESCE(SUM(tx.debit - tx.credit), 0)
        ELSE COALESCE(SUM(tx.credit - tx.debit), 0)
      END AS amount
    FROM chart_of_accounts ca
    JOIN coa_groups cg ON cg.coa_id = ca.id
    JOIN account_group_codes ag ON ag.group_code = cg.group_code
    LEFT JOIN (${unionSql}) tx ON TRIM(tx.account_code) = TRIM(ca.code)
    WHERE UPPER(ag.group_description) IN ('ASSETS', 'ASSET', 'LIABILITIES', 'LIABILITY', 'EQUITY', 'CAPITAL')
       OR UPPER(ca.account_class) IN ('ASSET', 'LIABILITY', 'LIABILITIES', 'EQUITY', 'CAPITAL')
    GROUP BY
      ag.group_description,
      ca.code,
      ca.title,
      ca.account_class
    ORDER BY
      CASE
        WHEN UPPER(ag.group_description) IN ('ASSETS', 'ASSET') THEN 1
        WHEN UPPER(ag.group_description) IN ('LIABILITIES', 'LIABILITY') THEN 2
        WHEN UPPER(ag.group_description) IN ('EQUITY', 'CAPITAL') THEN 3
        ELSE 9
      END,
      ca.code ASC
    `,
    unionParams
  );

  const currentEarnings = await getCurrentYearEarnings({ companyId, to });

  return [
    ...rows,
    {
      group_name: "EQUITY",
      account_code: "CURRENT-EARNINGS",
      account_title: "Current Year Earnings",
      account_class: "EQUITY",
      amount: currentEarnings,
    },
  ];
}

// Account Analysis: full detail for ONE account over a date range, with a
// true beginning balance (every recognized source dated before `from`,
// via LedgerReportService.getBeginningBalances - the same opening-balance
// engine General Ledger already uses) and a running balance that starts
// from that beginning balance rather than from zero. transaction_id (the
// source header's id - see buildTransactionUnionSql) is preserved so the
// existing UI's click-through-to-source-voucher behavior keeps working.
async function getAccountAnalysisRows({ companyId, accountCode, from, to }) {
  const beginningBalances = await LedgerReportService.getBeginningBalances({
    before: from,
    accountCodes: [accountCode],
    companyId,
  });
  const beginningBalance = Number(beginningBalances[accountCode] || 0);

  const unionSql = LedgerReportService.buildTransactionUnionSql("BETWEEN ? AND ?");
  const unionParams = Array(9).fill([from, to, companyId]).flat();

  const [rows] = await pool.execute(
    `
    SELECT
      tx.transaction_date,
      tx.source_type,
      tx.reference_no,
      tx.transaction_id,
      tx.account_code,
      tx.account_title,
      tx.particulars,
      tx.debit,
      tx.credit,
      SUM(tx.debit - tx.credit) OVER (
        ORDER BY tx.transaction_date, tx.sort_order, tx.id
      ) AS in_range_running_balance
    FROM (${unionSql}) tx
    WHERE tx.account_code = ?
    ORDER BY tx.transaction_date, tx.sort_order, tx.id
    `,
    [...unionParams, accountCode]
  );

  return rows.map((row) => ({
    transaction_date: row.transaction_date,
    source_type: row.source_type,
    reference_no: row.reference_no,
    transaction_id: row.transaction_id,
    account_code: row.account_code,
    account_title: row.account_title,
    particulars: row.particulars,
    debit: row.debit,
    credit: row.credit,
    beginning_balance: beginningBalance,
    running_balance: beginningBalance + Number(row.in_range_running_balance || 0),
  }));
}

module.exports = {
  getIncomeStatementRows,
  getBalanceSheetRows,
  getCurrentYearEarnings,
  getAccountAnalysisRows,
  resolveCurrentEarningsRange,
};
