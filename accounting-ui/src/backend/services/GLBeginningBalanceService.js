const pool = require("../db");

// GL Beginning Balance persistence - previously nonexistent (the manual
// entry page only console.logged; gl_beginning_balance_headers/lines were
// write-never, read-only via report joins). Used by both the manual-entry
// save endpoint and the import commit path, so there is exactly one place
// that inserts a GL beginning balance header+lines.

async function listGLBeginningBalances() {
  const [headers] = await pool.execute(
    `SELECT id, filter_code AS filterCode, DATE_FORMAT(balance_date, '%Y-%m-%d') AS balanceDate,
      currency_code AS currencyCode, currency_name AS currencyName, title, status,
      created_at AS createdAt
     FROM gl_beginning_balance_headers
     ORDER BY balance_date DESC, id DESC`
  );

  if (headers.length === 0) return [];

  // pool.execute()'s prepared-statement protocol doesn't expand a single
  // array parameter into IN (?, ?, ...) the way pool.query() does - build
  // the placeholder string manually instead.
  const placeholders = headers.map(() => "?").join(",");
  const [lines] = await pool.execute(
    `SELECT id, header_id AS headerId, account_id AS accountId, account_code AS accountCode,
      account_title AS accountTitle, project_code AS projectCode, dept_code AS deptCode,
      othrdebit AS debit, othrcredit AS credit, reference_no AS referenceNo, remarks
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
async function findOrCreateHeader(conn, { balanceDate, filterCode, currencyCode, currencyName, title }) {
  const [existing] = await conn.execute(
    `SELECT id FROM gl_beginning_balance_headers WHERE balance_date = ? LIMIT 1`,
    [balanceDate]
  );

  if (existing.length > 0) return existing[0].id;

  const [result] = await conn.execute(
    `INSERT INTO gl_beginning_balance_headers (filter_code, balance_date, currency_code, currency_name, title, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
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

async function insertLine(conn, headerId, line) {
  await conn.execute(
    `INSERT INTO gl_beginning_balance_lines
      (header_id, account_id, account_code, account_title, project_code, dept_code,
       othrdebit, othrcredit, reference_no, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      headerId,
      line.accountId || null,
      line.accountCode,
      line.accountTitle,
      line.projectCode || null,
      line.deptCode || null,
      Number(line.debit) || 0,
      Number(line.credit) || 0,
      line.referenceNo || null,
      line.remarks || null,
    ]
  );
}

// Manual-entry save: the existing page already batches its whole rows
// array into one submission, so this naturally becomes one header (per
// balanceDate) + N lines - no behavior change from what the page already
// intended, it just now actually persists.
async function createGLBeginningBalance({ header, rows }) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const headerId = await findOrCreateHeader(conn, {
      balanceDate: header.date,
      filterCode: header.filterCode,
      currencyCode: header.currency,
      currencyName: header.currencyName,
      title: header.title,
    });

    for (const row of rows) {
      await insertLine(conn, headerId, {
        accountId: row.accountId,
        accountCode: row.code,
        accountTitle: row.title,
        projectCode: row.project,
        deptCode: row.dept,
        debit: row.otherDebit || row.debit,
        credit: row.otherCredit || row.credit,
        referenceNo: row.referenceNo,
        remarks: row.remarks,
      });
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
