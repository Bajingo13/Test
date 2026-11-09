// APV due date survives editing. An APV converted from a Request for
// Payment carries the RFP's requested payment date as its due date; editing
// and saving the APV used to reset it to the APV date (the shared form sent
// dueDate = transactionDate for every module except Invoice), which moved
// the APV into the wrong AP aging bucket.
//
// The payloads below are what the transaction form sends; the form-side
// wiring is guarded in src/pages/TRANSACTIONS/__tests__/apvDueDate.test.js.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { getAgingRows } = require("../services/agingReportService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "apvdue-";
const ACC = "APVDUE-";
const PASSWORD = "ApvDuePass!1";
const APV_DATE = "2097-11-05";
const RFP_DUE = "2097-11-30";

const co = {};
const acc = {};
const users = {};
const tokens = {};
let cur;
let sup;
let cust;

async function makeUser(tag, roleCode, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [`${ACC}${key}`, title, cls]
  );
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = r.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

async function apvFromRfp() {
  let res = await request(app).post("/api/rfp").set(auth("acct")).send({
    companyId: co.A,
    rfpDate: "2097-11-01",
    supplierId: sup,
    purpose: "Office rent",
    requestedPaymentDate: RFP_DUE,
    currencyId: cur,
    lines: [{ description: "Office rent", grossAmount: "1500.00", accountId: acc.RENT, vatTreatment: "EXEMPT" }],
  });
  if (res.status !== 201) throw new Error(`rfp create: ${res.status} ${JSON.stringify(res.body)}`);
  const rfpId = res.body.id;
  for (const [who, action, body] of [["acct", "submit"], ["admin", "approve"], ["admin", "convert", { apvDate: APV_DATE, apAccountId: acc.AP }]]) {
    res = await request(app).post(`/api/rfp/${rfpId}/${action}`).set(auth(who)).send(body);
    if (res.status !== 200) throw new Error(`${action}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const [[row]] = await pool.query("SELECT converted_apv_id FROM rfp_headers WHERE id = ?", [rfpId]);
  return row.converted_apv_id;
}

async function loadApv(id) {
  const res = await request(app).get(`/api/apv/${id}`).set(auth("acct"));
  expect(res.status).toBe(200);
  return res.body;
}

// The edit payload the APV form sends, built from the loaded record
// (`dueDate` is whatever the form holds; `omitDueDate` drops the key).
function editBody(apv, { dueDate = apv.dueDate, transactionDate = apv.transactionDate, description, omitDueDate = false } = {}) {
  const body = {
    voucherNo: apv.voucherNo,
    supplierId: apv.supplierId,
    supplierName: apv.supplierName,
    transactionDate,
    dueDate,
    referenceNo: apv.referenceNo,
    description: description ?? apv.description,
    remarks: apv.remarks,
    totalDebit: Number(apv.totalDebit),
    totalCredit: Number(apv.totalCredit),
    status: "Draft",
    lines: apv.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountTitle: l.accountTitle,
      particulars: l.particulars,
      debit: Number(l.debit || 0),
      credit: Number(l.credit || 0),
    })),
  };
  if (omitDueDate) delete body.dueDate;
  return body;
}

async function storedDueDate(table, id) {
  const [[row]] = await pool.query(`SELECT DATE_FORMAT(due_date, '%Y-%m-%d') d FROM ${table} WHERE id = ?`, [id]);
  return row.d;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co A`]);
  co.A = c.insertId;
  const [k] = await pool.execute(
    "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
    [co.A]
  );
  cur = k.insertId;
  const [s] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'Due Date Supplier', '123-456-789-000', 'ACTIVE')",
    [co.A, `${P}sup`]
  );
  sup = s.insertId;
  const [cu] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', 'Due Date Customer', 'ACTIVE')",
    [co.A, `${P}cust`]
  );
  cust = cu.insertId;

  await mkAccount("RENT", "Rent Expense", "EXPENSE");
  await mkAccount("AP", "Accounts Payable - Trade", "LIABILITY", ["AP CODE"]);
  await mkAccount("AR", "Accounts Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("REV", "Service Revenue", "INCOME");

  await makeUser("admin", "ADMIN", [co.A]);
  await makeUser("acct", "ACCOUNTANT", [co.A]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM rfp_lines ln JOIN rfp_headers r ON r.id = ln.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM invoice_lines ln JOIN invoice_headers h ON h.id = ln.invoice_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM jv_lines ln JOIN jv_headers h ON h.id = ln.jv_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

describe("APV converted from an RFP", () => {
  let apvId;
  beforeAll(async () => {
    apvId = await apvFromRfp();
  });

  test("conversion carries the RFP's requested payment date as the APV due date", async () => {
    const apv = await loadApv(apvId);
    expect(apv.transactionDate).toBe(APV_DATE);
    expect(apv.dueDate).toBe(RFP_DUE);
  });

  test("editing without touching the due date keeps November 30 (not the APV date)", async () => {
    const apv = await loadApv(apvId);
    const res = await request(app).put(`/api/apv/${apvId}`).set(auth("acct")).send(editBody(apv, { description: "Office rent - edited" }));
    expect(res.status).toBe(200);
    expect(await storedDueDate("apv_headers", apvId)).toBe(RFP_DUE);
    const again = await loadApv(apvId);
    expect(again.description).toBe("Office rent - edited");
    expect(again.dueDate).toBe(RFP_DUE);
  });

  test("changing the APV date alone does not move the saved due date", async () => {
    const apv = await loadApv(apvId);
    const res = await request(app).put(`/api/apv/${apvId}`).set(auth("acct")).send(editBody(apv, { transactionDate: "2097-11-06" }));
    expect(res.status).toBe(200);
    const again = await loadApv(apvId);
    expect(again.transactionDate).toBe("2097-11-06");
    expect(again.dueDate).toBe(RFP_DUE);
  });

  test("a request without a dueDate key keeps the stored due date", async () => {
    const apv = await loadApv(apvId);
    const res = await request(app).put(`/api/apv/${apvId}`).set(auth("acct")).send(editBody(apv, { omitDueDate: true }));
    expect(res.status).toBe(200);
    expect(await storedDueDate("apv_headers", apvId)).toBe(RFP_DUE);
  });

  test("AP aging uses the preserved due date", async () => {
    const rows = await getAgingRows("AP", { companyId: co.A, asOfDate: "2097-12-10" });
    const row = rows.find((r) => r.sourceType === "APV" && r.sourceId === apvId);
    expect(row.dueDate).toBe(RFP_DUE);
    expect(row.daysOutstanding).toBe(10); // Nov 30 -> Dec 10; the APV date would give 34
    expect(row.bucket).toBe("days1to30");
  });

  test("an explicit due date change is saved, and aging follows it", async () => {
    const apv = await loadApv(apvId);
    const res = await request(app).put(`/api/apv/${apvId}`).set(auth("acct")).send(editBody(apv, { dueDate: "2097-12-15" }));
    expect(res.status).toBe(200);
    expect((await loadApv(apvId)).dueDate).toBe("2097-12-15");

    const rows = await getAgingRows("AP", { companyId: co.A, asOfDate: "2097-12-10" });
    const row = rows.find((r) => r.sourceType === "APV" && r.sourceId === apvId);
    expect(row.dueDate).toBe("2097-12-15");
    expect(row.daysOutstanding).toBe(0);
    expect(row.bucket).toBe("current");
  });
});

describe("manually created APV", () => {
  const lines = (amount) => [
    { accountId: acc.RENT, accountCode: `${ACC}RENT`, accountTitle: "Rent Expense", particulars: "x", debit: amount, credit: 0 },
    { accountId: acc.AP, accountCode: `${ACC}AP`, accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
  ];
  const create = (voucherNo, dueDate) =>
    request(app).post("/api/apv").set(auth("acct")).send({
      voucherNo, supplierId: sup, supplierName: "Due Date Supplier", transactionDate: APV_DATE, dueDate,
      totalDebit: 400, totalCredit: 400, status: "Draft", lines: lines(400),
    });

  test("a new APV whose due date was left alone defaults to the APV date (unchanged rule)", async () => {
    // The form's due date follows the APV date until the user edits it.
    const res = await create(`${ACC}M1`, APV_DATE);
    expect(res.status).toBe(200);
    expect(await storedDueDate("apv_headers", res.body.id)).toBe(APV_DATE);
  });

  test("a due date entered on a new APV is stored, and survives an edit", async () => {
    const res = await create(`${ACC}M2`, "2097-12-05");
    expect(res.status).toBe(200);
    const apv = await loadApv(res.body.id);
    expect(apv.dueDate).toBe("2097-12-05");
    const put = await request(app).put(`/api/apv/${apv.id}`).set(auth("acct")).send(editBody(apv, { description: "edited" }));
    expect(put.status).toBe(200);
    expect(await storedDueDate("apv_headers", apv.id)).toBe("2097-12-05");
  });
});

describe("other vouchers on the same save path are unchanged", () => {
  test("Invoice: an explicit due date is stored and kept on edit", async () => {
    const body = {
      voucherNo: `${ACC}INV1`, customerId: cust, customerName: "Due Date Customer",
      transactionDate: APV_DATE, dueDate: "2097-12-20", totalDebit: 300, totalCredit: 300, status: "Draft",
      lines: [
        { accountId: acc.AR, accountCode: `${ACC}AR`, accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: acc.REV, accountCode: `${ACC}REV`, accountTitle: "Revenue", particulars: "x", debit: 0, credit: 300 },
      ],
    };
    const c = await request(app).post("/api/invoices").set(auth("acct")).send(body);
    expect(c.status).toBe(200);
    expect(await storedDueDate("invoice_headers", c.body.id)).toBe("2097-12-20");
    const u = await request(app).put(`/api/invoices/${c.body.id}`).set(auth("acct")).send({ ...body, description: "edited" });
    expect(u.status).toBe(200);
    expect(await storedDueDate("invoice_headers", c.body.id)).toBe("2097-12-20");
  });

  test("JV (no due date column) still saves and edits normally with the form's payload", async () => {
    const body = {
      voucherNo: `${ACC}JV1`, transactionDate: APV_DATE, dueDate: APV_DATE, totalDebit: 200, totalCredit: 200, status: "Draft",
      lines: [
        { accountId: acc.RENT, accountCode: `${ACC}RENT`, accountTitle: "Rent", particulars: "x", debit: 200, credit: 0 },
        { accountId: acc.AP, accountCode: `${ACC}AP`, accountTitle: "AP", particulars: "x", debit: 0, credit: 200 },
      ],
    };
    const c = await request(app).post("/api/jv").set(auth("acct")).send(body);
    expect(c.status).toBe(200);
    const u = await request(app).put(`/api/jv/${c.body.id}`).set(auth("acct")).send({ ...body, description: "edited" });
    expect(u.status).toBe(200);
  });
});
