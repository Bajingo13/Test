const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const BBCurrency = require("./beginningBalanceCurrencyService");
const TransactionCurrencyService = require("./transactionCurrencyService");
const AccountingPeriodService = require("./accountingPeriodService");
const { logAudit } = require("../lib/audit");
// Multi-Branch Phase C-3: headers are Company + Branch + Balance Date.
const BBBranch = require("./beginningBalanceBranchService");

// GL Beginning Balance persistence - previously nonexistent (the manual
// entry page only console.logged; gl_beginning_balance_headers/lines were
// write-never, read-only via report joins). Used by both the manual-entry
// save endpoint and the import commit path, so there is exactly one place
// that inserts a GL beginning balance header+lines.
//
// Checkpoint 3D: each line may carry its own currency (section 4 - one
// header/batch can mix USD/EUR/PHP lines). othrdebit/othrcredit remain the
// AUTHORITATIVE base-currency GL values (unchanged column meaning, still
// what LedgerReportService/trial balance read); foreign_debit/foreign_credit
// hold the transaction-currency value when currency_id != base currency.

const { roundMoney } = TransactionCurrencyService;

// visibilitySql: the caller's branch-visibility predicate on alias h
// (BBBranch.visibleSql) - omitted only by internal callers.
async function listGLBeginningBalances(companyId, { visibilitySql = "1 = 1" } = {}) {
  const [headers] = await pool.execute(
    `SELECT h.id, h.filter_code AS filterCode, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS balanceDate,
      h.currency_code AS currencyCode, h.currency_name AS currencyName, h.title, h.status,
      h.created_at AS createdAt, h.branch_id AS branchId, b.name AS branchName
     FROM gl_beginning_balance_headers h
     LEFT JOIN branches b ON b.id = h.branch_id
     WHERE h.company_id = ? AND ${visibilitySql}
     ORDER BY h.balance_date DESC, h.id DESC`,
    [companyId]
  );

  if (headers.length === 0) return [];

  // pool.execute()'s prepared-statement protocol doesn't expand a single
  // array parameter into IN (?, ?, ...) the way pool.query() does - build
  // the placeholder string manually instead.
  const placeholders = headers.map(() => "?").join(",");
  const [lines] = await pool.execute(
    `SELECT id, header_id AS headerId, account_id AS accountId, account_code AS accountCode,
      account_title AS accountTitle, project_code AS projectCode, dept_code AS deptCode,
      othrdebit AS debit, othrcredit AS credit, reference_no AS referenceNo, remarks,
      currency_id AS currencyId, foreign_debit AS foreignDebit, foreign_credit AS foreignCredit
     FROM gl_beginning_balance_lines
     WHERE header_id IN (${placeholders})`,
    headers.map((h) => h.id)
  );

  const linesByHeader = new Map();
  for (const line of lines) {
    if (!linesByHeader.has(line.headerId)) linesByHeader.set(line.headerId, []);
    linesByHeader.get(line.headerId).push(line);
  }

  return headers.map((h) => ({ ...h, lines: linesByHeader.get(h.id) || [] }));
}

// Finds the existing header for the exact Company + Branch + balance date,
// or creates one (Phase C-3; previously Company + date). Used by manual save
// and import commit to group same-key rows under one header. Callers hold
// the per-company header lock (BBBranch.acquireHeaderLock).
async function findOrCreateHeader(conn, { balanceDate, filterCode, currencyCode, currencyName, title, companyId, branchId = null }) {
  return BBBranch.findOrCreateGLHeader(conn, { companyId, branchId, balanceDate, filterCode, currencyCode, currencyName, title });
}

// Resolves the line's own currency/rate (section 4/5), inserts it with
// BASE debit/credit in othrdebit/othrcredit (unchanged authoritative
// meaning) plus foreign_debit/foreign_credit, and locks an opening-rate
// snapshot immediately - GL beginning balance has no draft/edit lifecycle
// (status is always 'Posted' today), so there is no later point at which
// the rate would need to stay unlocked.
async function insertLine(conn, headerId, line, { user, companyId, balanceDate }) {
  const currencyResult = await BBCurrency.resolveLineCurrency({
    user,
    companyId,
    transactionType: "GL_BEGINNING",
    transactionId: null,
    currencyPayload: line.currencyId
      ? { currencyId: line.currencyId, isManualRate: line.isManualRate, exchangeRate: line.exchangeRate, rateDate: line.rateDate, overrideReason: line.overrideReason }
      : null,
    rateDate: line.rateDate || balanceDate,
  });

  const converted = BBCurrency.convertLineAmount({
    debit: line.debit,
    credit: line.credit,
    exchangeRate: currencyResult.rateInfo.exchangeRate,
  });

  const [result] = await conn.execute(
    `INSERT INTO gl_beginning_balance_lines
      (header_id, account_id, account_code, account_title, project_code, dept_code,
       othrdebit, othrcredit, reference_no, remarks, currency_id, foreign_debit, foreign_credit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      headerId,
      line.accountId || null,
      line.accountCode,
      line.accountTitle,
      line.projectCode || null,
      line.deptCode || null,
      converted.baseDebit,
      converted.baseCredit,
      line.referenceNo || null,
      line.remarks || null,
      currencyResult.currencyId,
      converted.foreignDebit,
      converted.foreignCredit,
    ]
  );

  const lineId = result.insertId;

  await TransactionCurrencyService.saveSnapshot(conn, {
    companyId,
    transactionType: "GL_BEGINNING",
    transactionId: lineId,
    currencyId: currencyResult.currencyId,
    currencyCode: currencyResult.currencyCode,
    baseCurrencyId: currencyResult.baseCurrency.id,
    baseCurrencyCode: currencyResult.baseCurrency.currencyCode,
    rateInfo: currencyResult.rateInfo,
    foreignTotals: {
      foreignSubtotal: 0,
      foreignTax: 0,
      foreignEwt: 0,
      foreignTotal: roundMoney(converted.foreignDebit || converted.foreignCredit),
    },
    baseTotals: {
      baseSubtotal: 0,
      baseTax: 0,
      baseEwt: 0,
      baseTotal: roundMoney(converted.baseDebit || converted.baseCredit),
    },
    userId: user.id,
    lockNow: true,
  });

  return { lineId, baseDebit: converted.baseDebit, baseCredit: converted.baseCredit };
}

// Manual-entry save: the existing page already batches its whole rows
// array into one submission, so this naturally becomes one header (per
// balanceDate) + N lines - no behavior change from what the page already
// intended, it just now actually persists.
//
// Section 4: the batch must balance in BASE currency after conversion -
// never require different-currency lines to balance against each other in
// their own foreign amounts.
async function createGLBeginningBalance({ header, rows, user, companyId }) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Phase C-3: the branch is resolved server-side (never trusted from the
    // request) and every account must be shared or the branch's own.
    const branchId = await BBBranch.resolveBeginningBalanceBranch(conn, user, { companyId, requestedBranchId: header.branchId });
    await BBBranch.validateBeginningBalanceReferences(conn, { companyId, branchId, accountIds: rows.map((r) => r.accountId) });
    await BBBranch.assertAccountCodesUsable(conn, { branchId, codes: rows.filter((r) => !r.accountId).map((r) => r.code) });
    await BBBranch.acquireHeaderLock(conn, "gl", companyId);

    // Covers both the manual-entry save endpoint and the import commit
    // path (both call this one function) - Checkpoint 5 section 21.
    await AccountingPeriodService.assertPeriodOpen({
      companyId, transactionDate: header.date, operation: "CREATE", user,
    }, conn);

    const headerId = await findOrCreateHeader(conn, {
      balanceDate: header.date,
      filterCode: header.filterCode,
      currencyCode: header.currency,
      currencyName: header.currencyName,
      title: header.title,
      companyId,
      branchId,
    });

    let totalBaseDebit = 0;
    let totalBaseCredit = 0;

    for (const row of rows) {
      const { baseDebit, baseCredit } = await insertLine(
        conn,
        headerId,
        {
          accountId: row.accountId,
          accountCode: row.code,
          accountTitle: row.title,
          projectCode: row.project,
          deptCode: row.dept,
          debit: row.otherDebit || row.debit,
          credit: row.otherCredit || row.credit,
          referenceNo: row.referenceNo,
          remarks: row.remarks,
          currencyId: row.currencyId,
          isManualRate: row.isManualRate,
          exchangeRate: row.exchangeRate,
          rateDate: row.rateDate,
        },
        { user, companyId, balanceDate: header.date }
      );
      totalBaseDebit = roundMoney(totalBaseDebit + baseDebit);
      totalBaseCredit = roundMoney(totalBaseCredit + baseCredit);
    }

    if (Math.abs(totalBaseDebit - totalBaseCredit) > 0.01) {
      throw new HttpError(
        400,
        `GL beginning balance is not balanced in base currency: total debit ${totalBaseDebit} vs total credit ${totalBaseCredit}.`
      );
    }

    // headerId is the one safe, authoritative identifier this operation
    // has - a single header can be created fresh OR reused across several
    // calls for the same balanceDate (findOrCreateHeader above), so this
    // event describes "a batch was saved under this header," never
    // claiming the header itself was newly created. No per-line audit
    // events, matching the curated-summary convention used everywhere
    // else - line count/totals only, not a snapshot of every row.
    await logAudit(conn, {
      module: "GL_BEGINNING",
      entityType: "GL_BEGINNING",
      entityId: headerId,
      companyId,
      action: "CREATE",
      description: `GL Beginning Balance batch saved under header #${headerId} (${rows.length} line(s), ${header.date})`,
      afterData: {
        balanceDate: header.date,
        branchId,
        currencyCode: header.currency || "PHP",
        lineCount: rows.length,
        totalDebit: totalBaseDebit,
        totalCredit: totalBaseCredit,
      },
      user,
    });

    await conn.commit();
    return { headerId, branchId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await BBBranch.releaseHeaderLock(conn, "gl", companyId);
    conn.release();
  }
}

module.exports = {
  listGLBeginningBalances,
  findOrCreateHeader,
  insertLine,
  createGLBeginningBalance,
};
