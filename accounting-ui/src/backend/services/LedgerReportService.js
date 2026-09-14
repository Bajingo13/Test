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

// Reports Books of Accounts (Phase L.1 Journal Book, Phase L.2 Income Book,
// ...). A Book of Accounts is simply the canonical union filtered to one or
// more source_type values and presented chronologically (by voucher, then
// by line), instead of grouped/windowed by account_code the way General
// Ledger / Subsidiary Ledger are. No new recognition SQL - Posted-only and
// company isolation are inherited unchanged from buildTransactionUnionSql.
// Every line is preserved (a voucher with N lines produces N rows here),
// never collapsed to one net amount, so the caller can show full
// debit/credit detail and sum its own totals from the actual rows.
//
// `sourceTypes` is ALWAYS server-chosen configuration - each Book's own
// backend route passes a hardcoded literal array (["JV"], ["INV"], ...),
// never anything derived from req.query/req.body - so this can never become
// a client-controlled SQL-injection surface; the IN (...) list is still
// fully parameterized regardless.
//
// tx.source_type is additive (Phase L.7): it was already computed inside
// buildTransactionUnionSql for every branch and used internally by the WHERE
// clause below, just never surfaced in the SELECT list. Six Books (Journal/
// Income/Cash Receipt/Cash Disbursement/Accounts Payable/Petty Cash) each
// have exactly one sourceTypes[] entry, so every row they get back already
// has one single, implied, unambiguous type - their BookReport.jsx callers
// don't read this field and are completely unaffected by its presence. Only
// the seventh, dual-source Debit/Credit Memo Book (Phase L.7) needs it: its
// two source types ("DEBIT MEMO"/"CREDIT MEMO") share one free-typed,
// user-entered voucher_no column with no enforced DM-/CM- prefix (see
// voucherNumberService.js - "manual numbering is preserved, voucher_no
// stays user-typed free text"), so two rows with the same reference number
// could otherwise be indistinguishable as to which Memo produced them.
async function getBookRows({ sourceTypes, from, to, companyId }) {
  if (!Array.isArray(sourceTypes) || sourceTypes.length === 0) {
    throw new Error("getBookRows: sourceTypes[] is required");
  }
  const unionSql = buildTransactionUnionSql("BETWEEN ? AND ?");
  const unionParams = Array(9).fill([from, to, companyId]).flat();
  const placeholders = sourceTypes.map(() => "?").join(",");

  const [rows] = await pool.execute(
    `
    SELECT
      tx.id AS line_id,
      tx.transaction_id,
      tx.transaction_date,
      tx.reference_no,
      tx.source_type,
      tx.account_code,
      COALESCE(ca.title, tx.account_title) AS account_title,
      tx.particulars,
      tx.debit,
      tx.credit
    FROM (${unionSql}) tx
    LEFT JOIN chart_of_accounts ca
      ON TRIM(CAST(ca.code AS CHAR)) = TRIM(CAST(tx.account_code AS CHAR))
    WHERE tx.source_type IN (${placeholders})
    ORDER BY tx.transaction_date, tx.sort_order, tx.transaction_id, tx.id
    `,
    [...unionParams, ...sourceTypes]
  );

  return rows;
}

// Journal Book (Phase L.1) - source_type = 'JV' only. Kept as its own named
// function (not inlined at the route) so the call site reads the same as
// before the Phase L.2 getBookRows extraction; behavior is unchanged - for
// a single-element sourceTypes array, `IN (?)` is equivalent to `= ?`.
function getJournalBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["JV"], from, to, companyId });
}

// Income Book (Phase L.2) - source_type = 'INV' only.
function getIncomeBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["INV"], from, to, companyId });
}

// Cash Receipt Book (Phase L.3) - source_type = 'OR' only.
function getCashReceiptBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["OR"], from, to, companyId });
}

// Cash Disbursement Book (Phase L.4) - source_type = 'CV' only. CV's
// lifecycle (Draft/Posted/Void/Cancelled/Reversed) needs no special-casing
// here: postedOnlySql already excludes anything not Posted, and a CV
// "reversal" creates a separate Posted reversing JV (see POST
// /api/cv/:id/reverse) rather than a second CV row - the original CV stays
// Posted, unchanged, and shows here exactly once; its reversing entry shows
// once in Journal Book (source_type = 'JV'), not here.
function getCashDisbursementBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["CV"], from, to, companyId });
}

// Accounts Payable Book (Phase L.5) - source_type = 'APV' only. Same
// lifecycle shape as CV: postedOnlySql excludes Void/Cancelled, and an APV
// "reversal" creates a separate Posted reversing JV (see POST
// /api/apv/:id/reverse) rather than a second APV row - the original APV
// stays Posted, unchanged, exactly once. CV settlement of an APV updates
// only apv_headers.payment_status/balance_amount (never apv_lines.debit/
// credit, which is all this union reads), so settlement has zero effect on
// what this Book shows - it is an accounting book, not an outstanding-
// payables/AP-aging report.
function getAccountsPayableBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["APV"], from, to, companyId });
}

// Petty Cash Book (Phase L.6) - source_type = 'PETTY CASH' only (note the
// space - confirmed by reading buildTransactionUnionSql directly, not
// assumed). Petty Cash's lifecycle is simpler than CV/APV: server.js has no
// /void, /cancel, or /reverse route for petty-cash at all - only Draft
// (freely PUT-editable/DELETE-able) and Posted (both blocked with 409
// TRANSACTION_ALREADY_POSTED once Posted; see PUT/DELETE /api/petty-cash/:id
// - Phase 7A.1 immutability). There is no reversal mechanism (no separate
// reversing PCV or JV is ever generated for Petty Cash), so unlike CV/APV
// there is nothing here to exclude beyond the standard postedOnlySql filter,
// which already keeps this Book to Posted PCVs exactly as recognized by the
// canonical union.
function getPettyCashBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["PETTY CASH"], from, to, companyId });
}

// Debit/Credit Memo Book (Phase L.7) - a single combined Book over TWO
// source types, confirmed by reading buildTransactionUnionSql directly:
// the memo branch computes source_type as CONCAT(h.memo_type, ' MEMO')
// from memo_headers.memo_type (ENUM('DEBIT','CREDIT')), producing exactly
// 'DEBIT MEMO' and 'CREDIT MEMO' - not two separate physical tables, one
// shared memo_headers/memo_lines pair discriminated by memo_type (same
// design memoized in voucherNumberService.js's DM/CM module config and
// server.js's registerMemoRoutes("DEBIT", ...)/("CREDIT", ...)). Both
// share the exact same lifecycle (Draft -> Posted, both enforced by
// postedOnlySql; no /void, /cancel, or /reverse route exists for either -
// same shape as Petty Cash) and the same permission module
// (TRANSACTIONS.DEBIT_CREDIT_MEMO), so one combined Book with two literal
// sourceTypes is correct and sufficient - no separate recognition query,
// no two frontend Books.
function getDebitCreditMemoBookRows({ from, to, companyId }) {
  return getBookRows({ sourceTypes: ["DEBIT MEMO", "CREDIT MEMO"], from, to, companyId });
}

// buildTransactionUnionSql is exported (Reports Batch 1) so
// financialStatementService.js can build Income Statement / Balance Sheet /
// Account Analysis on the exact same canonical source set, instead of each
// maintaining its own independent, driftable UNION.
module.exports = {
  getLedgerRows,
  getBeginningBalances,
  getBookRows,
  getJournalBookRows,
  getIncomeBookRows,
  getCashReceiptBookRows,
  getCashDisbursementBookRows,
  getAccountsPayableBookRows,
  getPettyCashBookRows,
  getDebitCreditMemoBookRows,
  buildTransactionUnionSql,
};
