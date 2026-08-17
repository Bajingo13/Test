const pool = require("../db");
const { logAudit } = require("../lib/audit");
const TrialBalanceDifferenceService = require("./trialBalanceDifferenceService");
const ValidationService = require("./trialBalanceValidationService");
const CurrencyService = require("./currencyService");

// The 3 header/line modules Trial Balance actually unions (see
// trialBalanceDifferenceService.js) that carry their own total_debit/
// total_credit header columns - arap_beginning_balance_headers doesn't, so
// it's investigated separately (findBeginningBalanceIssues) rather than
// through this generic list.
const HEADER_LINE_MODULES = [
  { key: "JV", headerTable: "jv_headers", linesTable: "jv_lines", fk: "jv_id", dateCol: "transaction_date", voucherCol: "voucher_no" },
  { key: "APV", headerTable: "apv_headers", linesTable: "apv_lines", fk: "apv_id", dateCol: "transaction_date", voucherCol: "voucher_no" },
  { key: "CV", headerTable: "cv_headers", linesTable: "cv_lines", fk: "cv_id", dateCol: "transaction_date", voucherCol: "voucher_no" },
];

// All 4 modules Trial Balance unions carry account_id + account_code on
// their line tables - used by findInvalidAccounts and the "both zero" /
// "both filled" / "negative amount" checks in findOtherSuspicious.
const ALL_LINE_MODULES = [
  ...HEADER_LINE_MODULES,
  { key: "AR/AP BEGINNING", headerTable: "arap_beginning_balance_headers", linesTable: "arap_beginning_balance_lines", fk: "header_id", dateCol: "balance_date", voucherCol: null },
];

function dateFilter(alias, dateCol, from, to) {
  if (!from || !to) return { sql: "", params: [] };
  return { sql: `WHERE ${alias}.${dateCol} BETWEEN ? AND ?`, params: [from, to] };
}

function toleranceDecimal(tolerance) {
  return ValidationService.centsToDecimalString(Math.abs(ValidationService.toCents(tolerance ?? "0")) || 0);
}

function baseFinding(overrides) {
  return {
    category: null,
    severity: "MEDIUM",
    source_module: null,
    source_table: null,
    transaction_id: null,
    transaction_number: null,
    transaction_date: null,
    reference_no: null,
    account_code: null,
    account_title: null,
    debit: null,
    credit: null,
    line_difference: null,
    status: null,
    reason: null,
    recommended_action: "Open for Review",
    ...overrides,
  };
}

// ---- Category 1: Unbalanced Transactions (causes #1, #6) ----
async function findUnbalancedTransactions({ from, to, tolerance }) {
  const findings = [];
  const tol = toleranceDecimal(tolerance);

  for (const mod of HEADER_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);
    const [rows] = await pool.execute(
      `
      SELECT h.id AS transaction_id, h.${mod.voucherCol} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, h.reference_no, h.status,
        COALESCE(SUM(l.debit), 0) AS line_debit, COALESCE(SUM(l.credit), 0) AS line_credit
      FROM ${mod.headerTable} h
      JOIN ${mod.linesTable} l ON l.${mod.fk} = h.id
      ${dateSql}
      GROUP BY h.id, h.${mod.voucherCol}, h.${mod.dateCol}, h.reference_no, h.status
      HAVING ABS(COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)) > ?
      `,
      [...dateParams, tol]
    );

    for (const r of rows) {
      const diff = Number(r.line_debit) - Number(r.line_credit);
      const oneSided = Number(r.line_debit) === 0 || Number(r.line_credit) === 0;
      findings.push(
        baseFinding({
          category: "UNBALANCED_TRANSACTIONS",
          severity: "HIGH",
          source_module: mod.key,
          source_table: mod.headerTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          transaction_date: r.transaction_date,
          reference_no: r.reference_no,
          debit: r.line_debit,
          credit: r.line_credit,
          line_difference: diff.toFixed(2),
          status: r.status,
          reason: oneSided
            ? `This ${mod.key} transaction has lines on only one side (total debit ${r.line_debit}, total credit ${r.line_credit}) - it was never offset by an entry on the other side.`
            : `This ${mod.key} transaction's lines do not balance: total debit ${r.line_debit} vs total credit ${r.line_credit}, a difference of ${Math.abs(diff).toFixed(2)}.`,
          recommended_action: "Open for Review",
        })
      );
    }
  }

  return findings;
}

// ---- Category 2: Header/Line Total Mismatches (cause #2) ----
async function findHeaderLineMismatches({ from, to, tolerance }) {
  const findings = [];
  const tol = toleranceDecimal(tolerance);

  for (const mod of HEADER_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);
    const [rows] = await pool.execute(
      `
      SELECT h.id AS transaction_id, h.${mod.voucherCol} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, h.reference_no, h.status,
        h.total_debit, h.total_credit,
        COALESCE(SUM(l.debit), 0) AS line_debit, COALESCE(SUM(l.credit), 0) AS line_credit
      FROM ${mod.headerTable} h
      LEFT JOIN ${mod.linesTable} l ON l.${mod.fk} = h.id
      ${dateSql}
      GROUP BY h.id, h.${mod.voucherCol}, h.${mod.dateCol}, h.reference_no, h.status, h.total_debit, h.total_credit
      HAVING ABS(h.total_debit - COALESCE(SUM(l.debit), 0)) > ? OR ABS(h.total_credit - COALESCE(SUM(l.credit), 0)) > ?
      `,
      [...dateParams, tol, tol]
    );

    for (const r of rows) {
      findings.push(
        baseFinding({
          category: "HEADER_LINE_MISMATCH",
          severity: "CRITICAL",
          source_module: mod.key,
          source_table: mod.headerTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          transaction_date: r.transaction_date,
          reference_no: r.reference_no,
          debit: r.line_debit,
          credit: r.line_credit,
          line_difference: (Number(r.total_debit) - Number(r.line_debit)).toFixed(2),
          status: r.status,
          reason: `Stored header total (debit ${r.total_debit}, credit ${r.total_credit}) does not match the sum of this transaction's lines (debit ${r.line_debit}, credit ${r.line_credit}). The header total may be stale, or lines were edited without updating it.`,
          recommended_action: "Open for Review",
        })
      );
    }
  }

  return findings;
}

// ---- Category 3: Invalid or Missing Accounts (causes #7, #8) ----
async function findInvalidAccounts({ from, to }) {
  const findings = [];

  for (const mod of ALL_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);
    const voucherSelect = mod.voucherCol ? `h.${mod.voucherCol}` : "NULL";

    const [rows] = await pool.execute(
      `
      SELECT l.id AS line_id, h.id AS transaction_id, ${voucherSelect} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, l.account_id, l.account_code, l.account_title,
        l.debit, l.credit,
        byid.code AS resolved_code_by_id, bycode.id AS resolved_id_by_code
      FROM ${mod.linesTable} l
      JOIN ${mod.headerTable} h ON h.id = l.${mod.fk}
      LEFT JOIN chart_of_accounts byid ON byid.id = l.account_id
      LEFT JOIN chart_of_accounts bycode ON TRIM(CAST(bycode.code AS CHAR)) = TRIM(CAST(l.account_code AS CHAR))
      ${dateSql}
      ${dateSql ? "AND" : "WHERE"} (l.account_id IS NOT NULL OR (l.account_code IS NOT NULL AND l.account_code != ''))
      `,
      dateParams
    );

    for (const r of rows) {
      if (r.account_id && !r.resolved_code_by_id) {
        findings.push(
          baseFinding({
            category: "INVALID_ACCOUNTS",
            severity: "CRITICAL",
            source_module: mod.key,
            source_table: mod.linesTable,
            transaction_id: r.transaction_id,
            transaction_number: r.transaction_number,
            transaction_date: r.transaction_date,
            account_code: r.account_code,
            account_title: r.account_title,
            debit: r.debit,
            credit: r.credit,
            reason: `Line references account_id ${r.account_id}, which does not exist in the Chart of Accounts (the account was likely deleted after this line was posted).`,
            recommended_action: "Open for Review",
          })
        );
        continue;
      }

      if (r.account_code && !r.resolved_id_by_code) {
        findings.push(
          baseFinding({
            category: "INVALID_ACCOUNTS",
            severity: "HIGH",
            source_module: mod.key,
            source_table: mod.linesTable,
            transaction_id: r.transaction_id,
            transaction_number: r.transaction_number,
            transaction_date: r.transaction_date,
            account_code: r.account_code,
            account_title: r.account_title,
            debit: r.debit,
            credit: r.credit,
            reason: `Account Code "${r.account_code}" stored on this line does not exist in the Chart of Accounts.`,
            recommended_action: "Open for Review",
          })
        );
        continue;
      }

      if (r.account_id && r.account_code && r.resolved_code_by_id && String(r.resolved_code_by_id).trim() !== String(r.account_code).trim()) {
        findings.push(
          baseFinding({
            category: "INVALID_ACCOUNTS",
            severity: "HIGH",
            source_module: mod.key,
            source_table: mod.linesTable,
            transaction_id: r.transaction_id,
            transaction_number: r.transaction_number,
            transaction_date: r.transaction_date,
            account_code: r.account_code,
            account_title: r.account_title,
            debit: r.debit,
            credit: r.credit,
            reason: `Line's account_id resolves to Account Code "${r.resolved_code_by_id}" in the Chart of Accounts, but the line's own stored account_code is "${r.account_code}" - these are inconsistent, which usually means a manual database edit bypassed normal validation.`,
            recommended_action: "Open for Review",
          })
        );
      }
    }
  }

  return findings;
}

// ---- Category 4: Orphaned Records (causes #5, #14, #19) ----
async function findOrphanedRecords({ from, to }) {
  const findings = [];

  for (const mod of HEADER_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);
    const [rows] = await pool.execute(
      `
      SELECT h.id AS transaction_id, h.${mod.voucherCol} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, h.reference_no, h.status,
        h.total_debit, h.total_credit
      FROM ${mod.headerTable} h
      LEFT JOIN ${mod.linesTable} l ON l.${mod.fk} = h.id
      ${dateSql}
      ${dateSql ? "AND" : "WHERE"} l.id IS NULL
      `,
      dateParams
    );

    for (const r of rows) {
      const hasStoredTotals = Number(r.total_debit) !== 0 || Number(r.total_credit) !== 0;
      findings.push(
        baseFinding({
          category: "ORPHANED_RECORDS",
          severity: hasStoredTotals ? "CRITICAL" : "MEDIUM",
          source_module: mod.key,
          source_table: mod.headerTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          transaction_date: r.transaction_date,
          reference_no: r.reference_no,
          debit: r.total_debit,
          credit: r.total_credit,
          status: r.status,
          reason: hasStoredTotals
            ? `This ${mod.key} header has stored totals (debit ${r.total_debit}, credit ${r.total_credit}) but zero lines - this looks like a save that was interrupted partway through.`
            : `This ${mod.key} header has no lines at all.`,
          recommended_action: "Open for Review",
        })
      );
    }
  }

  return findings;
}

// ---- Category 5: Duplicate Postings (cause #9) ----
// voucher_no is enforced UNIQUE at the DB level on all 3 header tables
// (confirmed via SHOW INDEX), so two headers can never share a voucher_no -
// "duplicate posting" here means the same transaction re-keyed twice under
// two different voucher numbers, not a voucher-number collision. Matched on
// date + reference_no + totals, which is what an accidental double-entry
// actually looks like given this schema's constraints.
async function findDuplicatePostings({ from, to }) {
  const findings = [];

  for (const mod of HEADER_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);

    const [rows] = await pool.execute(
      `
      SELECT h.id AS transaction_id, h.${mod.voucherCol} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, h.reference_no, h.status,
        h.total_debit, h.total_credit
      FROM ${mod.headerTable} h
      ${dateSql}
      ${dateSql ? "AND" : "WHERE"} h.reference_no IS NOT NULL AND h.reference_no != ''
        AND (h.total_debit != 0 OR h.total_credit != 0)
        AND EXISTS (
          SELECT 1 FROM ${mod.headerTable} h2
          WHERE h2.id != h.id
            AND h2.${mod.dateCol} = h.${mod.dateCol}
            AND h2.reference_no = h.reference_no
            AND h2.total_debit = h.total_debit AND h2.total_credit = h.total_credit
        )
      `,
      dateParams
    );

    for (const r of rows) {
      findings.push(
        baseFinding({
          category: "DUPLICATE_POSTINGS",
          severity: "HIGH",
          source_module: mod.key,
          source_table: mod.headerTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          transaction_date: r.transaction_date,
          reference_no: r.reference_no,
          debit: r.total_debit,
          credit: r.total_credit,
          status: r.status,
          reason: `Another ${mod.key} header (different voucher number) exists with the same date, Reference No "${r.reference_no}", and totals - this looks like the same transaction entered twice under two different voucher numbers.`,
          recommended_action: "Open for Review",
        })
      );
    }
  }

  return findings;
}

// ---- Category 6: Beginning Balance Issues (causes #11, #12) ----
async function findBeginningBalanceIssues({ from, to, tolerance }) {
  const findings = [];
  const tol = toleranceDecimal(tolerance);

  const { sql: glDateSql, params: glDateParams } = dateFilter("h", "balance_date", from, to);
  const [glRows] = await pool.execute(
    `
    SELECT h.id AS transaction_id, h.filter_code AS transaction_number,
      DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date, h.status,
      COALESCE(SUM(l.othrdebit), 0) AS line_debit, COALESCE(SUM(l.othrcredit), 0) AS line_credit
    FROM gl_beginning_balance_headers h
    JOIN gl_beginning_balance_lines l ON l.header_id = h.id
    ${glDateSql}
    GROUP BY h.id, h.filter_code, h.balance_date, h.status
    HAVING ABS(COALESCE(SUM(l.othrdebit), 0) - COALESCE(SUM(l.othrcredit), 0)) > ?
    `,
    [...glDateParams, tol]
  );

  for (const r of glRows) {
    findings.push(
      baseFinding({
        category: "BEGINNING_BALANCE_ISSUES",
        severity: "HIGH",
        source_module: "GL BEGINNING",
        source_table: "gl_beginning_balance_headers",
        transaction_id: r.transaction_id,
        transaction_number: r.transaction_number,
        transaction_date: r.transaction_date,
        debit: r.line_debit,
        credit: r.line_credit,
        line_difference: (Number(r.line_debit) - Number(r.line_credit)).toFixed(2),
        status: r.status,
        reason: `This GL Beginning Balance batch's debit (${r.line_debit}) and credit (${r.line_credit}) totals do not match.`,
        recommended_action: "Open for Review",
      })
    );
  }

  // AR/AP Beginning Balance has no offsetting entry anywhere in this system
  // by design (confirmed during planning) - every AR line is a debit with
  // no matching credit, and vice versa for AP, so the system-wide net of
  // (AR debits - AP credits) for the period is a very plausible structural
  // contributor to the overall Trial Balance difference.
  const { sql: arapDateSql, params: arapDateParams } = dateFilter("h", "balance_date", from, to);
  const [arapTotals] = await pool.execute(
    `
    SELECT h.balance_type,
      COALESCE(SUM(l.debit), 0) AS total_debit, COALESCE(SUM(l.credit), 0) AS total_credit
    FROM arap_beginning_balance_lines l
    JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    ${arapDateSql}
    GROUP BY h.balance_type
    `,
    arapDateParams
  );

  let arDebit = 0;
  let apCredit = 0;
  for (const r of arapTotals) {
    if (r.balance_type === "AR") arDebit = Number(r.total_debit);
    if (r.balance_type === "AP") apCredit = Number(r.total_credit);
  }
  const netImbalance = arDebit - apCredit;

  if (Math.abs(netImbalance) > Number(tol)) {
    findings.push(
      baseFinding({
        category: "BEGINNING_BALANCE_ISSUES",
        severity: "MEDIUM",
        source_module: "AR/AP BEGINNING",
        source_table: "arap_beginning_balance_lines",
        debit: arDebit.toFixed(2),
        credit: apCredit.toFixed(2),
        line_difference: netImbalance.toFixed(2),
        reason: `AR Beginning Balance debits (${arDebit.toFixed(2)}) and AP Beginning Balance credits (${apCredit.toFixed(2)}) for this period have no offsetting entry anywhere in the system (this module has no such mechanism today) - their net difference of ${netImbalance.toFixed(2)} is a likely structural contributor to the overall Trial Balance difference, not a data-entry error in any single transaction.`,
        recommended_action: "Create Adjustment Draft",
      })
    );
  }

  return findings;
}

// ---- Category 7: Date and Period Issues (cause #17) ----
async function findDatePeriodIssues() {
  const findings = [];

  for (const mod of HEADER_LINE_MODULES) {
    const [rows] = await pool.execute(
      `SELECT id AS transaction_id, ${mod.voucherCol} AS transaction_number, reference_no, status, total_debit, total_credit
       FROM ${mod.headerTable} WHERE ${mod.dateCol} IS NULL`
    );

    for (const r of rows) {
      findings.push(
        baseFinding({
          category: "DATE_PERIOD_ISSUES",
          severity: "LOW",
          source_module: mod.key,
          source_table: mod.headerTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          reference_no: r.reference_no,
          debit: r.total_debit,
          credit: r.total_credit,
          status: r.status,
          reason: `This ${mod.key} header has no transaction date. It silently falls outside any date-filtered Trial Balance run (including this one, if a date range was selected), which can make a period's totals look asymmetric versus reports that don't filter by date.`,
          recommended_action: "Open for Review",
        })
      );
    }
  }

  return findings;
}

// ---- Category 8: Rounding Differences (cause #18) ----
async function findRoundingDifferences({ from, to }) {
  const findings = [];

  const { sql: glDateSql, params: glDateParams } = dateFilter("h", "balance_date", from, to);
  const [glRows] = await pool.execute(
    `
    SELECT l.id AS line_id, h.id AS transaction_id, h.filter_code AS transaction_number,
      DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date, l.account_code, l.account_title,
      l.othrdebit AS debit, l.othrcredit AS credit
    FROM gl_beginning_balance_lines l
    JOIN gl_beginning_balance_headers h ON h.id = l.header_id
    ${glDateSql}
    ${glDateSql ? "AND" : "WHERE"} (MOD(ROUND(ABS(l.othrdebit) * 10000), 100) != 0 OR MOD(ROUND(ABS(l.othrcredit) * 10000), 100) != 0)
    `,
    glDateParams
  );

  for (const r of glRows) {
    findings.push(
      baseFinding({
        category: "ROUNDING_DIFFERENCES",
        severity: "ROUNDING_ONLY",
        source_module: "GL BEGINNING",
        source_table: "gl_beginning_balance_lines",
        transaction_id: r.transaction_id,
        transaction_number: r.transaction_number,
        transaction_date: r.transaction_date,
        account_code: r.account_code,
        account_title: r.account_title,
        debit: r.debit,
        credit: r.credit,
        reason: `This line is stored at 4-decimal precision (debit ${r.debit}, credit ${r.credit}) while transactional modules use 2 decimals - the sub-centavo remainder can show up as a tiny rounding difference when compared against those totals.`,
        recommended_action: "Mark as Investigated",
      })
    );
  }

  const { sql: arapDateSql, params: arapDateParams } = dateFilter("h", "balance_date", from, to);
  const [arapRows] = await pool.execute(
    `
    SELECT l.id AS line_id, h.id AS transaction_id, l.reference_no AS transaction_number,
      DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date, l.account_code, l.account_title,
      l.debit, l.credit
    FROM arap_beginning_balance_lines l
    JOIN arap_beginning_balance_headers h ON h.id = l.header_id
    ${arapDateSql}
    ${arapDateSql ? "AND" : "WHERE"} (MOD(ROUND(ABS(l.debit) * 10000), 100) != 0 OR MOD(ROUND(ABS(l.credit) * 10000), 100) != 0)
    `,
    arapDateParams
  );

  for (const r of arapRows) {
    findings.push(
      baseFinding({
        category: "ROUNDING_DIFFERENCES",
        severity: "ROUNDING_ONLY",
        source_module: "AR/AP BEGINNING",
        source_table: "arap_beginning_balance_lines",
        transaction_id: r.transaction_id,
        transaction_number: r.transaction_number,
        transaction_date: r.transaction_date,
        account_code: r.account_code,
        account_title: r.account_title,
        debit: r.debit,
        credit: r.credit,
        reason: `This line is stored at 4-decimal precision (debit ${r.debit}, credit ${r.credit}) while transactional modules use 2 decimals - the sub-centavo remainder can show up as a tiny rounding difference when compared against those totals.`,
        recommended_action: "Mark as Investigated",
      })
    );
  }

  return findings;
}

// ---- Category 9: Other Suspicious Records (causes #3, #4, #10, #13, #15, #20) ----
async function findOtherSuspicious({ from, to }) {
  const findings = [];
  const KNOWN_STATUSES = {
    JV: ["Draft", "Posted"],
    APV: ["DRAFT", "Draft", "Posted"],
    CV: ["Draft", "Posted"],
  };

  for (const mod of HEADER_LINE_MODULES) {
    const { sql: dateSql, params: dateParams } = dateFilter("h", mod.dateCol, from, to);

    // Both debit and credit filled, or both zero, on a single line.
    const [lineRows] = await pool.execute(
      `
      SELECT l.id AS line_id, h.id AS transaction_id, h.${mod.voucherCol} AS transaction_number,
        DATE_FORMAT(h.${mod.dateCol}, '%Y-%m-%d') AS transaction_date, l.account_code, l.account_title, l.debit, l.credit
      FROM ${mod.linesTable} l
      JOIN ${mod.headerTable} h ON h.id = l.${mod.fk}
      ${dateSql}
      ${dateSql ? "AND" : "WHERE"} (
        (COALESCE(l.debit, 0) > 0 AND COALESCE(l.credit, 0) > 0)
        OR (COALESCE(l.debit, 0) = 0 AND COALESCE(l.credit, 0) = 0)
        OR l.debit < 0 OR l.credit < 0
      )
      `,
      dateParams
    );

    for (const r of lineRows) {
      const bothFilled = Number(r.debit) > 0 && Number(r.credit) > 0;
      const negative = Number(r.debit) < 0 || Number(r.credit) < 0;
      findings.push(
        baseFinding({
          category: "OTHER_SUSPICIOUS",
          severity: negative ? "HIGH" : bothFilled ? "MEDIUM" : "LOW",
          source_module: mod.key,
          source_table: mod.linesTable,
          transaction_id: r.transaction_id,
          transaction_number: r.transaction_number,
          transaction_date: r.transaction_date,
          account_code: r.account_code,
          account_title: r.account_title,
          debit: r.debit,
          credit: r.credit,
          reason: negative
            ? `This line has a negative amount (debit ${r.debit}, credit ${r.credit}), which the app's own forms never produce - likely a manual database edit.`
            : bothFilled
            ? `This line has both a Debit (${r.debit}) and a Credit (${r.credit}) amount - only one side should be filled per line.`
            : `This line has zero for both Debit and Credit - an empty line that shouldn't have been saved.`,
          recommended_action: "Open for Review",
        })
      );
    }

    // Anomalous status strings.
    const known = KNOWN_STATUSES[mod.key] || [];
    if (known.length) {
      const { sql: statusDateSql, params: statusDateParams } = dateFilter("h", mod.dateCol, from, to);
      const placeholders = known.map(() => "?").join(",");
      const [statusRows] = await pool.execute(
        `
        SELECT id AS transaction_id, ${mod.voucherCol} AS transaction_number,
          DATE_FORMAT(${mod.dateCol}, '%Y-%m-%d') AS transaction_date, reference_no, status, total_debit, total_credit
        FROM ${mod.headerTable} h
        ${statusDateSql}
        ${statusDateSql ? "AND" : "WHERE"} (status IS NULL OR status NOT IN (${placeholders}))
        `,
        [...statusDateParams, ...known]
      );

      for (const r of statusRows) {
        const isVoidLike = /VOID|CANCEL|DELETE/i.test(r.status || "");
        findings.push(
          baseFinding({
            category: "OTHER_SUSPICIOUS",
            severity: isVoidLike ? "HIGH" : "LOW",
            source_module: mod.key,
            source_table: mod.headerTable,
            transaction_id: r.transaction_id,
            transaction_number: r.transaction_number,
            transaction_date: r.transaction_date,
            reference_no: r.reference_no,
            debit: r.total_debit,
            credit: r.total_credit,
            status: r.status,
            reason: isVoidLike
              ? `This ${mod.key} header has a void/cancelled-looking status ("${r.status}") but is still included in the Trial Balance total, which has no status filter today.`
              : `This ${mod.key} header has an unrecognized status value ("${r.status || "(empty)"}") outside the normal Draft/Posted set.`,
            recommended_action: "Open for Review",
          })
        );
      }
    }
  }

  // Static, informational findings - not detected by a query, but
  // explicitly requested transparency about causes that don't apply given
  // this app's current architecture.
  findings.push(
    baseFinding({
      category: "OTHER_SUSPICIOUS",
      severity: "LOW",
      source_module: "SYSTEM",
      reason: `Company/Branch scoping is not applicable: this application has no multi-company or branch data model today, so "wrong company/branch" cannot be checked.`,
      recommended_action: "Mark as Investigated",
    }),
    baseFinding({
      category: "OTHER_SUSPICIOUS",
      severity: "LOW",
      source_module: "SYSTEM",
      reason: `Trial Balance's totals (and this check) include General Journal, AP Voucher, Check Voucher, and AR/AP Beginning Balance only - Invoice, Official Receipt, and GL Beginning Balance records are excluded, same as this report has always worked. If you're comparing against General Ledger, that report includes those extra sources.`,
      recommended_action: "Mark as Investigated",
    }),
    baseFinding({
      category: "OTHER_SUSPICIOUS",
      severity: "LOW",
      source_module: "SYSTEM",
      reason: `Debit Memo / Credit Memo transactions have no dedicated table in this system - submitting one currently saves it into the AP Voucher tables, indistinguishable from a real APV. Any DM/CM activity is already covered by the APV checks above, but can't be identified as DM/CM specifically.`,
      recommended_action: "Mark as Investigated",
    })
  );

  return findings;
}

async function runAllDetectors(params) {
  const [
    unbalanced,
    headerLineMismatch,
    invalidAccounts,
    orphaned,
    duplicates,
    beginningBalance,
    datePeriod,
    rounding,
    otherSuspicious,
  ] = await Promise.all([
    findUnbalancedTransactions(params),
    findHeaderLineMismatches(params),
    findInvalidAccounts(params),
    findOrphanedRecords(params),
    findDuplicatePostings(params),
    findBeginningBalanceIssues(params),
    findDatePeriodIssues(params),
    findRoundingDifferences(params),
    findOtherSuspicious(params),
  ]);

  return [
    ...unbalanced,
    ...headerLineMismatch,
    ...invalidAccounts,
    ...orphaned,
    ...duplicates,
    ...beginningBalance,
    ...datePeriod,
    ...rounding,
    ...otherSuspicious,
  ];
}

// Debounce: return an existing still-RUNNING run for this user/params
// started in the last 60s instead of starting a second one.
async function findRecentRunningRun({ userId, from, to, tolerance }) {
  const [rows] = await pool.execute(
    `SELECT id FROM trial_balance_checker_runs
     WHERE run_by <=> ? AND from_date <=> ? AND to_date <=> ? AND tolerance = ?
       AND run_state = 'RUNNING' AND created_at > (NOW() - INTERVAL 60 SECOND)
     ORDER BY id DESC LIMIT 1`,
    [userId || null, from || null, to || null, tolerance]
  );
  return rows[0]?.id || null;
}

async function runCheck({ from, to, tolerance, user, companyId }) {
  const tol = tolerance ?? "0";
  const userId = user?.id || null;

  const existingRunId = await findRecentRunningRun({ userId, from, to, tolerance: tol });
  if (existingRunId) {
    return getRun(existingRunId);
  }

  const totals = await TrialBalanceDifferenceService.getTrialBalanceTotals({ from, to, companyId });
  const balance = ValidationService.evaluateBalance({ difference: totals.difference, tolerance: tol });

  const [runResult] = await pool.execute(
    `INSERT INTO trial_balance_checker_runs
      (run_by, run_by_username, from_date, to_date, tolerance, total_debit, total_credit, difference, balance_status, run_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING')`,
    [userId, user?.username || null, from || null, to || null, tol, totals.totalDebit, totals.totalCredit, totals.difference, balance.status]
  );
  const runId = runResult.insertId;

  try {
    const findings = await runAllDetectors({ from, to, tolerance: tol });

    for (const f of findings) {
      await pool.execute(
        `INSERT INTO trial_balance_checker_findings
          (run_id, category, severity, source_module, source_table, transaction_id, transaction_number,
           transaction_date, reference_no, account_code, account_title, debit, credit, line_difference,
           status, reason, recommended_action)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          runId,
          f.category,
          f.severity,
          f.source_module,
          f.source_table,
          f.transaction_id,
          f.transaction_number,
          f.transaction_date,
          f.reference_no,
          f.account_code,
          f.account_title,
          f.debit,
          f.credit,
          f.line_difference,
          f.status,
          f.reason,
          f.recommended_action,
        ]
      );
    }

    await pool.execute(
      `UPDATE trial_balance_checker_runs SET run_state = 'COMPLETED', finding_count = ?, completed_at = NOW() WHERE id = ?`,
      [findings.length, runId]
    );

    await logAudit(pool, {
      module: "TRIAL_BALANCE_CHECKER",
      entityType: "CHECKER_RUN",
      entityId: runId,
      action: "RUN",
      description: `Trial Balance Checker run for ${from || "(all)"} to ${to || "(all)"}: ${balance.status}, difference ${balance.differenceFormatted}, ${findings.length} finding(s)`,
      afterData: { from, to, tolerance: tol, status: balance.status, findingCount: findings.length },
      user,
    });
  } catch (err) {
    await pool.execute(`UPDATE trial_balance_checker_runs SET run_state = 'FAILED' WHERE id = ?`, [runId]);
    throw err;
  }

  return getRun(runId);
}

async function getRun(runId) {
  const [runRows] = await pool.execute(
    `SELECT *, DATE_FORMAT(from_date, '%Y-%m-%d') AS from_date_fmt, DATE_FORMAT(to_date, '%Y-%m-%d') AS to_date_fmt
     FROM trial_balance_checker_runs WHERE id = ?`,
    [runId]
  );
  const run = runRows[0];
  if (!run) {
    throw Object.assign(new Error("Checker run not found"), { statusCode: 404 });
  }

  const [findings] = await pool.execute(
    `SELECT id, run_id, category, severity, source_module, source_table, transaction_id, transaction_number,
       DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, reference_no, account_code, account_title,
       debit, credit, line_difference, status, reason, recommended_action, investigated, investigated_by,
       investigated_note, investigated_at, adjustment_jv_id, created_at
     FROM trial_balance_checker_findings
     WHERE run_id = ?
     ORDER BY FIELD(severity,'CRITICAL','HIGH','MEDIUM','LOW','ROUNDING_ONLY'), id ASC`,
    [runId]
  );

  return {
    runId: run.id,
    summary: {
      fromDate: run.from_date_fmt || null,
      toDate: run.to_date_fmt || null,
      totalDebit: run.total_debit,
      totalCredit: run.total_credit,
      difference: run.difference,
      tolerance: run.tolerance,
      status: run.balance_status,
      runState: run.run_state,
      createdAt: run.created_at,
    },
    findings,
  };
}

async function getFinding(findingId) {
  const [rows] = await pool.execute(
    `SELECT id, run_id, category, severity, source_module, source_table, transaction_id, transaction_number,
       DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date, reference_no, account_code, account_title,
       debit, credit, line_difference, status, reason, recommended_action, investigated, investigated_by,
       investigated_note, investigated_at, adjustment_jv_id, created_at
     FROM trial_balance_checker_findings WHERE id = ?`,
    [findingId]
  );
  const finding = rows[0];
  if (!finding) {
    throw Object.assign(new Error("Finding not found"), { statusCode: 404 });
  }
  return finding;
}

async function markInvestigated(findingId, { note, user }) {
  const finding = await getFinding(findingId);

  await pool.execute(
    `UPDATE trial_balance_checker_findings
     SET investigated = 1, investigated_by = ?, investigated_note = ?, investigated_at = NOW()
     WHERE id = ?`,
    [user?.id || null, note || null, findingId]
  );

  await logAudit(pool, {
    module: "TRIAL_BALANCE_CHECKER",
    entityType: "CHECKER_FINDING",
    entityId: findingId,
    action: "MARK_INVESTIGATED",
    description: `Finding #${findingId} (${finding.category}) marked as investigated${note ? `: ${note}` : ""}`,
    beforeData: { investigated: !!finding.investigated },
    afterData: { investigated: true, note },
    user,
  });

  return getFinding(findingId);
}

// The only action in this service that writes to an existing table -
// always creates a Draft-status JV (never Posted), mirroring the exact
// insert shape POST /api/jv already uses. Nothing is auto-posted; a human
// must open the JV module and post it explicitly.
async function createAdjustmentDraft(findingId, { debitAccountCode, creditAccountCode, amount, explanation, user }) {
  const finding = await getFinding(findingId);

  if (!debitAccountCode || !creditAccountCode) {
    throw Object.assign(new Error("Both a debit and a credit account code are required."), { statusCode: 400 });
  }
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) {
    throw Object.assign(new Error("Amount must be a positive number."), { statusCode: 400 });
  }

  const [accounts] = await pool.execute(
    "SELECT id, code, title FROM chart_of_accounts WHERE code IN (?, ?)",
    [debitAccountCode, creditAccountCode]
  );
  const byCode = new Map(accounts.map((a) => [String(a.code).trim(), a]));
  const debitAccount = byCode.get(String(debitAccountCode).trim());
  const creditAccount = byCode.get(String(creditAccountCode).trim());

  if (!debitAccount || !creditAccount) {
    throw Object.assign(new Error("One or both account codes do not exist in the Chart of Accounts."), { statusCode: 400 });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const voucherNo = `TBADJ-${finding.id}-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(user, null);

    const [headerResult] = await conn.execute(
      `INSERT INTO jv_headers
        (company_id, voucher_no, transaction_date, reference_no, prepared_for, description, remarks, total_debit, total_credit, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
      [
        companyId,
        voucherNo,
        today,
        finding.transaction_number || "",
        "Trial Balance Checker",
        `Suggested adjustment for Checker finding #${finding.id} (${finding.category})`,
        explanation || finding.reason || "",
        amountNum,
        amountNum,
        user?.id || null,
      ]
    );
    const jvId = headerResult.insertId;

    await conn.execute(
      `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?,?,?,?,?,?,0)`,
      [jvId, debitAccount.id, debitAccount.code, debitAccount.title, explanation || "", amountNum]
    );
    await conn.execute(
      `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?,?,?,?,?,0,?)`,
      [jvId, creditAccount.id, creditAccount.code, creditAccount.title, explanation || "", amountNum]
    );

    await conn.execute("UPDATE trial_balance_checker_findings SET adjustment_jv_id = ? WHERE id = ?", [jvId, finding.id]);

    await logAudit(conn, {
      module: "TRIAL_BALANCE_CHECKER",
      entityType: "CHECKER_FINDING",
      entityId: finding.id,
      action: "CREATE_ADJUSTMENT_DRAFT",
      description: `Draft JV ${voucherNo} created from finding #${finding.id} (${finding.category}) - status Draft, not posted`,
      afterData: { jvId, voucherNo, debitAccountCode, creditAccountCode, amount: amountNum, explanation },
      user,
    });

    await conn.commit();
    return { jvId, voucherNo };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function findingsToCsv(findings) {
  const columns = [
    "id", "category", "severity", "source_module", "transaction_id", "transaction_number",
    "transaction_date", "reference_no", "account_code", "account_title", "debit", "credit",
    "line_difference", "status", "reason", "recommended_action", "investigated", "investigated_note",
  ];
  const header = [
    "ID", "Category", "Severity", "Source Module", "Transaction ID", "Transaction Number",
    "Transaction Date", "Reference No", "Account Code", "Account Title", "Debit", "Credit",
    "Difference", "Status", "Reason", "Recommended Action", "Investigated", "Investigated Note",
  ];
  const lines = [header, ...findings.map((f) => columns.map((c) => f[c]))];
  return lines.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

module.exports = {
  runCheck,
  getRun,
  getFinding,
  markInvestigated,
  createAdjustmentDraft,
  findingsToCsv,
};
