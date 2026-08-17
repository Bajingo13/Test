const pool = require("../db");
const { HttpError } = require("../lib/httpError");
const BBCurrency = require("./beginningBalanceCurrencyService");
const TransactionCurrencyService = require("./transactionCurrencyService");
const AccountingPeriodService = require("./accountingPeriodService");

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

async function listGLBeginningBalances(companyId) {
  const [headers] = await pool.execute(
    `SELECT id, filter_code AS filterCode, DATE_FORMAT(balance_date, '%Y-%m-%d') AS balanceDate,
      currency_code AS currencyCode, currency_name AS currencyName, title, status,
      created_at AS createdAt
     FROM gl_beginning_balance_headers
     WHERE company_id = ?
     ORDER BY balance_date DESC, id DESC`,
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

// Finds an existing Draft/open header for the exact balance date, or
// creates one. Used by import commit to group same-date rows under one
// header (per design decision) instead of one header per line.
async function findOrCreateHeader(conn, { balanceDate, filterCode, currencyCode, currencyName, title, companyId }) {
  const [existing] = await conn.execute(
    `SELECT id FROM gl_beginning_balance_headers WHERE balance_date = ? AND company_id = ? LIMIT 1`,
    [balanceDate, companyId]
  );

  if (existing.length > 0) return existing[0].id;

  const [result] = await conn.execute(
    `INSERT INTO gl_beginning_balance_headers (company_id, filter_code, balance_date, currency_code, currency_name, title, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId,
      filterCode || "NON",
      balanceDate,
      currencyCode || "PHP",
      currencyName || "PHILIPPINE PESO",
      title || null,
      "Posted",
    ]
  );

  return result.insertId;
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

    await conn.commit();
    return { headerId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  listGLBeginningBalances,
  findOrCreateHeader,
  insertLine,
  createGLBeginningBalance,
};
