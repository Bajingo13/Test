// AR Aging recognizes a receivable exactly when the ledger does: Posted
// invoices and Posted AR beginning balances only (reportRecognitionService
// postedOnlySql). Draft and Void invoices and Draft beginning balances are
// not receivables. With real ledger postings this proves, for one company
// and as-of date:
//
//   AR Aging total = Trial Balance AR account (the Balance Sheet's source)
//                  = Dashboard Receivables
//
// Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "aragr-";
const ACC = "ARAGR-";
const PASSWORD = "ArAgrPass!1";
const AS_OF = "2097-03-31";

let companyId;
let otherCompanyId;
let customerId;
const acc = {};
const users = {};
const tokens = {};
const ids = {};

async function makeUser(tag, roleCode, companyIds, overrides = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [moduleKey, action, granted] of overrides) {
    await pool.execute(
      "INSERT INTO user_permissions (user_id, permission_id, granted, reason) SELECT ?, id, ?, 'ar aging test' FROM permissions WHERE module_key = ? AND action = ?",
      [u.insertId, granted, moduleKey, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${ACC}${key}` };
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function postInvoice(voucherNo, date, due, amount, status) {
  const res = await request(app).post("/api/invoices").set(auth("acct")).send({
    voucherNo, customerId, customerName: "AR Recognition Customer", transactionDate: date, dueDate: due,
    totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: acc.AR.id, accountCode: acc.AR.code, accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: acc.REV.id, accountCode: acc.REV.code, accountTitle: "Revenue", particulars: "x", debit: 0, credit: amount },
    ],
  });
  if (res.status !== 200) throw new Error(`invoice ${voucherNo}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function beginningBalance(status, amount, ref) {
  const [h] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, 'AR', '2097-01-01', 'PHP', 'PHILIPPINE PESO', 'ar aging test', ?)`,
    [companyId, status]
  );
  await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, 'AR Recognition Customer', ?, 'AR', ?, '2097-01-15', ?, 0, ?, 0, 'Unpaid')`,
    [h.insertId, customerId, acc.AR.code, ref, amount, amount]
  );
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co`]);
  companyId = c.insertId;
  const [c2] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Other Co`]);
  otherCompanyId = c2.insertId;
  for (const id of [companyId, otherCompanyId]) {
    await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
      [id]
    );
  }
  const [g] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', 'AR Recognition Customer', 'ACTIVE')",
    [companyId, `${P}cust`]
  );
  customerId = g.insertId;
  await mkAccount("AR", "AR Recognition Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("REV", "AR Recognition Sales", "INCOME");

  await makeUser("acct", "ACCOUNTANT", [companyId], [["REPORTS.AR", "VIEW", 1], ["REPORTS.FINANCIAL", "VIEW", 1]]);
  await makeUser("acctOther", "ACCOUNTANT", [otherCompanyId], [["REPORTS.AR", "VIEW", 1]]);

  ids.posted = await postInvoice(`${P}POSTED`, "2097-02-01", "2097-02-28", 1000, "Posted");
  ids.draft = await postInvoice(`${P}DRAFT`, "2097-02-05", "2097-02-28", 500, "Draft");
  ids.voided = await postInvoice(`${P}VOID`, "2097-02-10", "2097-02-28", 300, "Posted");
  // No invoice void endpoint exists; a Void invoice is one whose header
  // status is Void - the ledger stops recognizing it, and so must aging.
  await pool.execute("UPDATE invoice_headers SET status = 'Void' WHERE id = ?", [ids.voided]);
  ids.bbPosted = await beginningBalance("Posted", 150, `${P}BB-POSTED`);
  ids.bbDraft = await beginningBalance("Draft", 200, `${P}BB-DRAFT`);
});

afterAll(async () => {
  try {
    const companies = [companyId, otherCompanyId].filter(Boolean);
    await pool.query("DELETE ln FROM arap_beginning_balance_lines ln JOIN arap_beginning_balance_headers h ON h.id = ln.header_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM invoice_lines ln JOIN invoice_headers h ON h.id = ln.invoice_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    const userIds = Object.values(users);
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

async function arAging() {
  const res = await request(app).get("/api/reports/ar-aging").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(res.status).toBe(200);
  return res.body;
}

test("only Posted invoices and Posted AR beginning balances are receivables", async () => {
  const body = await arAging();
  const refs = body.rows.map((r) => r.referenceNo).sort();
  expect(refs).toEqual([`${P}BB-POSTED`, `${P}POSTED`].sort());
  expect(body.bucketTotals.base.total).toBe(1150);
});

test("AR Aging total = Trial Balance AR account (the Balance Sheet's source) = Dashboard Receivables", async () => {
  const aging = await arAging();
  const tb = await request(app).get("/api/reports/trial-balance").query({ from: "1900-01-01", to: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(tb.status).toBe(200);
  const arRows = tb.body.filter((r) => r.account_code === acc.AR.code); // code + name rows
  expect(arRows.reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0)).toBe(aging.bucketTotals.base.total);

  const dash = await request(app).get("/api/dashboard/summary").query({ companyId: String(companyId), from: "2097-01-01", to: AS_OF }).set(auth("acct"));
  expect(dash.status).toBe(200);
  expect(dash.body.sections.receivables.total).toBe(aging.bucketTotals.base.total);
});

test("posting a Draft invoice makes it a receivable in aging and in the ledger together", async () => {
  await pool.execute("UPDATE invoice_headers SET status = 'Posted' WHERE id = ?", [ids.draft]);
  try {
    const aging = await arAging();
    expect(aging.bucketTotals.base.total).toBe(1650);
    const tb = await request(app).get("/api/reports/trial-balance").query({ from: "1900-01-01", to: AS_OF, companyId: String(companyId) }).set(auth("acct"));
    const arRows = tb.body.filter((r) => r.account_code === acc.AR.code);
    expect(arRows.reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0)).toBe(1650);
  } finally {
    await pool.execute("UPDATE invoice_headers SET status = 'Draft' WHERE id = ?", [ids.draft]);
  }
});

test("AR Overdue Accounts and AR Aging Summary follow the same rule", async () => {
  const overdue = await request(app).get("/api/reports/ar-overdue-accounts").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(overdue.status).toBe(200);
  expect(overdue.body.rows.map((r) => r.referenceNo).sort()).toEqual([`${P}BB-POSTED`, `${P}POSTED`].sort());
  const summary = await request(app).get("/api/reports/ar-aging-summary").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(summary.status).toBe(200);
  expect(JSON.stringify(summary.body)).toContain("1150");
});

test("company isolation: another company's user cannot read these receivables", async () => {
  const res = await request(app).get("/api/reports/ar-aging").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acctOther"));
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: "You do not have access to this company" });
  expect(res.body.rows).toBeUndefined();
  expect(res.body.bucketTotals).toBeUndefined();
  const own = await request(app).get("/api/reports/ar-aging").query({ asOf: AS_OF }).set(auth("acctOther"));
  expect(own.status).toBe(200);
  expect(own.body.rows).toEqual([]);
});

test("company isolation: AR Aging Summary for a company the user cannot access -> 403, no data", async () => {
  const res = await request(app).get("/api/reports/ar-aging-summary").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acctOther"));
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: "You do not have access to this company" });
  expect(res.body.parties).toBeUndefined();
  const own = await request(app).get("/api/reports/ar-aging-summary").query({ asOf: AS_OF }).set(auth("acctOther"));
  expect(own.status).toBe(200);
  expect(own.body.parties).toEqual([]);
});
