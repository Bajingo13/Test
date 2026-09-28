const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Confirmed-gap fix: POST /api/quotations/:id/convert-to-invoice creates a
// real invoice_headers row (transaction_date = CURDATE() at insert time)
// but, before this fix, never called AccountingPeriodService.assertPeriodOpen(...)
// - the same gate the normal POST /api/invoices route already goes
// through. This suite proves the fix in isolation:
//   - AccountingPeriodService.js itself is untouched (reused as-is)
//   - the normal invoice CREATE route is untouched
//   - no other transaction module is touched
// Since the conversion route always dates the new invoice CURDATE(), the
// fixture periods below are for the CURRENT real year/month (computed at
// test time), not a fixed historical month like the rest of the period-
// lock suite - that is the one thing this route's date behavior forces.

jest.setTimeout(180000);

let openCo, closedCo;
let userId, token;
let salesAccId;
let custOpen, custClosed;
const periodIds = [];

const now = new Date();
const CUR_YEAR = now.getFullYear();
const CUR_MONTH = now.getMonth() + 1;

function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

async function mkCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}

async function mkPeriod(companyId, status) {
  const { startDate, endDate } = monthBounds(CUR_YEAR, CUR_MONTH);
  const [r] = await pool.execute(
    `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, CUR_YEAR, CUR_MONTH, startDate, endDate, status]
  );
  periodIds.push(r.insertId);
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  openCo = await mkCompany("QCPL Open Co");
  closedCo = await mkCompany("QCPL Closed Co");

  const hash = await bcrypt.hash("QcplPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('qcpl_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, openCo]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, closedCo]);
  token = (await request(app).post("/api/login").send({ username: "qcpl_admin", password: "QcplPass!1" })).body.token;

  // convert-to-invoice needs a %receivable% and a %sales%/%revenue% account (global COA)
  await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('QCPL-AR', CURDATE(), 'QCPL Accounts Receivable', 'ASSET')");
  const [sl] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('QCPL-SALES', CURDATE(), 'QCPL Sales Revenue', 'INCOME')");
  salesAccId = sl.insertId;

  const [c1] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'QCPL-C1', 'CUSTOMER', 'QCPL Cust Open', 'ACTIVE')", [openCo]);
  custOpen = c1.insertId;
  const [c2] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'QCPL-C2', 'CUSTOMER', 'QCPL Cust Closed', 'ACTIVE')", [closedCo]);
  custClosed = c2.insertId;

  await mkPeriod(openCo, "OPEN");
  await mkPeriod(closedCo, "CLOSED");
});

afterAll(async () => {
  for (const co of [openCo, closedCo]) {
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM quotation_lines l JOIN quotation_headers h ON h.id = l.quotation_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [co]);
  }
  if (periodIds.length) {
    await pool.query(`DELETE FROM accounting_period_history WHERE period_id IN (${periodIds.map(() => "?").join(",")})`, periodIds);
    await pool.query(`DELETE FROM accounting_periods WHERE id IN (${periodIds.map(() => "?").join(",")})`, periodIds);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [openCo, closedCo]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'QCPL-%'");
  await pool.end();
});

function qBody(companyId, customerId, { amount = 1000 } = {}) {
  return {
    companyId,
    customerId,
    customerName: companyId === openCo ? "QCPL Cust Open" : "QCPL Cust Closed",
    quotationDate: "2026-11-20",
    status: "Draft",
    totalAmount: amount,
    lines: [
      { lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: amount, taxRate: 0, amount, accountId: salesAccId, accountCode: "QCPL-SALES", accountTitle: "QCPL Sales Revenue" },
    ],
  };
}
const createQ = (companyId, custId, opts) =>
  request(app).post("/api/quotations").set("Authorization", `Bearer ${token}`).send(qBody(companyId, custId, opts));
const convert = (id, companyId) =>
  request(app).post(`/api/quotations/${id}/convert-to-invoice`).set("Authorization", `Bearer ${token}`).send({ companyId });

describe("Quotation -> Invoice conversion respects Accounting Period Locking", () => {
  test("A. succeeds when the target (current) accounting period is OPEN", async () => {
    const q = await createQ(openCo, custOpen, { amount: 1500 });
    expect(q.status).toBe(200);
    const conv = await convert(q.body.id, openCo);
    expect(conv.status).toBe(200);
    expect(conv.body.invoiceId).toBeDefined();

    const [[inv]] = await pool.query("SELECT company_id, status, total_debit FROM invoice_headers WHERE id = ?", [conv.body.invoiceId]);
    expect(inv.company_id).toBe(openCo);
    expect(inv.status).toBe("Draft");
    expect(Number(inv.total_debit)).toBe(1500);
    const [[lineCount]] = await pool.query("SELECT COUNT(*) c FROM invoice_lines WHERE invoice_id = ?", [conv.body.invoiceId]);
    expect(lineCount.c).toBeGreaterThan(0);
  });

  let closedQ;
  test("B. rejected with ACCOUNTING_PERIOD_CLOSED when the target (current) accounting period is CLOSED", async () => {
    closedQ = await createQ(closedCo, custClosed, { amount: 2000 });
    expect(closedQ.status).toBe(200);
    const conv = await convert(closedQ.body.id, closedCo);
    expect(conv.status).toBe(409);
    expect(conv.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("C. the rejection does not create an invoice_header", async () => {
    const [rows] = await pool.query("SELECT id FROM invoice_headers WHERE source_quotation_id = ?", [closedQ.body.id]);
    expect(rows).toHaveLength(0);
  });

  test("D. the rejection does not create invoice_lines", async () => {
    const [rows] = await pool.query(
      `SELECT l.id FROM invoice_lines l
       JOIN invoice_headers h ON h.id = l.invoice_id
       WHERE h.source_quotation_id = ?`,
      [closedQ.body.id]
    );
    expect(rows).toHaveLength(0);
  });

  test("E. the quotation itself remains unchanged (still Draft, not Converted, no converted_invoice_id)", async () => {
    const [[q]] = await pool.query("SELECT status, converted_invoice_id FROM quotation_headers WHERE id = ?", [closedQ.body.id]);
    expect(q.status).toBe("Draft");
    expect(q.converted_invoice_id).toBeNull();
  });

  test("F. the transaction was rolled back cleanly - the same quotation converts successfully once its period reopens", async () => {
    await pool.query("UPDATE accounting_periods SET status = 'OPEN' WHERE company_id = ? AND year = ? AND period_month = ?", [closedCo, CUR_YEAR, CUR_MONTH]);
    const conv = await convert(closedQ.body.id, closedCo);
    expect(conv.status).toBe(200);
    const [[q]] = await pool.query("SELECT status FROM quotation_headers WHERE id = ?", [closedQ.body.id]);
    expect(q.status).toBe("Converted");
    // restore CLOSED so this file's period fixtures stay as documented for anyone re-reading it
    await pool.query("UPDATE accounting_periods SET status = 'CLOSED' WHERE company_id = ? AND year = ? AND period_month = ?", [closedCo, CUR_YEAR, CUR_MONTH]);
  });

  test("G. existing normal conversion behavior is unchanged - customer, totals, voucher numbering, status, source link", async () => {
    const q = await createQ(openCo, custOpen, { amount: 3300 });
    const conv = await convert(q.body.id, openCo);
    expect(conv.status).toBe(200);
    const [[inv]] = await pool.query(
      "SELECT company_id, voucher_no, customer_id, customer_name, total_debit, total_credit, status, source_quotation_id FROM invoice_headers WHERE id = ?",
      [conv.body.invoiceId]
    );
    expect(inv.voucher_no).toBe(`INV-${q.body.quotationNo}`);
    expect(inv.customer_id).toBe(custOpen);
    expect(inv.customer_name).toBe("QCPL Cust Open");
    expect(Number(inv.total_debit)).toBe(3300);
    expect(Number(inv.total_credit)).toBe(3300);
    expect(inv.status).toBe("Draft");
    expect(inv.source_quotation_id).toBe(q.body.id);
  });

  test("H. company isolation remains intact - a user cannot convert a quotation under a company it doesn't belong to, regardless of period status", async () => {
    const q = await createQ(openCo, custOpen, { amount: 500 });
    const crossAttempt = await request(app)
      .post(`/api/quotations/${q.body.id}/convert-to-invoice`)
      .set("Authorization", `Bearer ${token}`)
      .send({ companyId: closedCo });
    expect(crossAttempt.status).toBe(404);
  });
});
