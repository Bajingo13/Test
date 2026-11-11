// Regression tests for the three issues found by the Demo Aging UAT
// (2026-11-11):
//
//   1. Only applications made by a POSTED OR/CV reduce AR/AP Aging. A Draft
//      OR/CV (no ledger effect yet) and a Voided CV (applications removed)
//      leave the full balance outstanding - in Aging and Aging Summary.
//   2. An APV reversal (Posted APV_REVERSAL JV) only removes the APV from
//      AP Aging as of the reversal JV's own date or later; before it, the
//      APV is still outstanding.
//   3. GET /api/apv/unpaid for a company the user cannot access -> 403
//      (was 500), like AR/AP Aging and their summaries.
//
// Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "aguat-";
const ACC = "AGUAT-";
const PASSWORD = "AgUatPass!1";
const AS_OF = "2097-06-30";

let companyId;
let otherCompanyId;
let customerId;
let supplierId;
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
      "INSERT INTO user_permissions (user_id, permission_id, granted, reason) SELECT ?, id, ?, 'aging uat fixes test' FROM permissions WHERE module_key = ? AND action = ?",
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
const line = (key, debit, credit) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: key, particulars: "x", debit, credit });

async function ok(res, what) {
  if (res.status !== 200) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
async function invoice(no, amount) {
  return (await ok(await request(app).post("/api/invoices").set(auth("acct")).send({
    voucherNo: `${P}${no}`, customerId, customerName: "UAT Fix Customer", transactionDate: "2097-06-01", dueDate: "2097-06-20",
    totalDebit: amount, totalCredit: amount, status: "Posted", lines: [line("AR", amount, 0), line("REV", 0, amount)],
  }), `invoice ${no}`)).id;
}
async function apv(no, amount) {
  return (await ok(await request(app).post("/api/apv").set(auth("acct")).send({
    voucherNo: `${P}${no}`, supplierId, supplierName: "UAT Fix Supplier", transactionDate: "2097-06-01", dueDate: "2097-06-20",
    totalDebit: amount, totalCredit: amount, status: "Posted", lines: [line("EXP", amount, 0), line("AP", 0, amount)],
  }), `apv ${no}`)).id;
}
async function or(no, invoiceId, amount, status) {
  return (await ok(await request(app).post("/api/or").set(auth("acct")).send({
    voucherNo: `${P}${no}`, customerId, customerName: "UAT Fix Customer", transactionDate: "2097-06-10", paymentMethod: "Cash",
    totalDebit: amount, totalCredit: amount, status, lines: [line("CASH", amount, 0), line("AR", 0, amount)],
    invoiceApplications: [{ sourceType: "INV", sourceId: invoiceId, amount, applicationDate: "2097-06-10" }],
  }), `or ${no}`)).id;
}
async function cv(no, apvId, amount, status) {
  return (await ok(await request(app).post("/api/cv").set(auth("acct")).send({
    voucherNo: `${P}${no}`, payeeId: supplierId, payeeName: "UAT Fix Supplier", transactionDate: "2097-06-10", paymentMethod: "Cash",
    totalDebit: amount, totalCredit: amount, status, lines: [line("AP", amount, 0), line("CASH", 0, amount)],
    apvApplications: [{ sourceType: "APV", sourceId: apvId, amount, applicationDate: "2097-06-10" }],
  }), `cv ${no}`)).id;
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
  const [g1] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', 'UAT Fix Customer', 'ACTIVE')", [companyId, `${P}cust`]);
  customerId = g1.insertId;
  const [g2] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'UAT Fix Supplier', '123-456-789-000', 'ACTIVE')", [companyId, `${P}sup`]);
  supplierId = g2.insertId;
  await mkAccount("AR", "UAT Fix Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("REV", "UAT Fix Sales", "INCOME");
  await mkAccount("AP", "UAT Fix Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("EXP", "UAT Fix Expense", "EXPENSE");
  await mkAccount("CASH", "UAT Fix Cash", "ASSET");

  await makeUser("acct", "ACCOUNTANT", [companyId], [["REPORTS.AR", "VIEW", 1], ["REPORTS.AP", "VIEW", 1], ["TRANSACTIONS.CV", "VOID", 1]]);
  await makeUser("acctOther", "ACCOUNTANT", [otherCompanyId], [["REPORTS.AR", "VIEW", 1], ["REPORTS.AP", "VIEW", 1]]);

  // AR: Draft OR (must not count) vs Posted OR (counts)
  ids.invDraftPay = await invoice("INV-DRAFTPAY", 1000);
  ids.invPostedPay = await invoice("INV-POSTEDPAY", 1000);
  ids.orDraft = await or("OR-DRAFT", ids.invDraftPay, 400, "Draft");
  ids.orPosted = await or("OR-POSTED", ids.invPostedPay, 300, "Posted");

  // AP: Draft CV, Posted CV, Posted-then-Voided CV
  ids.apvDraftPay = await apv("APV-DRAFTPAY", 1000);
  ids.apvPostedPay = await apv("APV-POSTEDPAY", 1000);
  ids.apvVoidPay = await apv("APV-VOIDPAY", 1000);
  ids.cvDraft = await cv("CV-DRAFT", ids.apvDraftPay, 400, "Draft");
  ids.cvPosted = await cv("CV-POSTED", ids.apvPostedPay, 300, "Posted");
  ids.cvVoided = await cv("CV-VOIDED", ids.apvVoidPay, 200, "Posted");
  await ok(await request(app).post(`/api/cv/${ids.cvVoided}/void`).set(auth("acct")).send({ reason: "aging uat fixes test" }), "cv void");

  // AP reversal dated 2097-06-20: Posted APV_REVERSAL JV pointing at the APV
  // (the closed-period reversal model - original stays Posted).
  ids.apvReversed = await apv("APV-REVERSED", 1900);
  const [jv] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, ?, '2097-06-20', 'reversal', 1900, 1900, 'Posted', 'APV_REVERSAL', ?)`,
    [companyId, `${P}REV-JV`, ids.apvReversed]
  );
  ids.revJv = jv.insertId;
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 1900, 0)", [jv.insertId, acc.AP.id, acc.AP.code]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, 1900)", [jv.insertId, acc.EXP.id, acc.EXP.code]);
});

afterAll(async () => {
  try {
    const companies = [companyId, otherCompanyId].filter(Boolean);
    await pool.query("DELETE FROM transaction_applications WHERE (applied_type = 'OR' AND applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))) OR (applied_type = 'CV' AND applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)))", [companies, companies]);
    await pool.query("DELETE ln FROM or_lines ln JOIN or_headers h ON h.id = ln.or_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM or_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM cv_lines ln JOIN cv_headers h ON h.id = ln.cv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM cv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM jv_lines ln JOIN jv_headers h ON h.id = ln.jv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM invoice_lines ln JOIN invoice_headers h ON h.id = ln.invoice_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
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

async function report(path, asOf = AS_OF, who = "acct", company = companyId) {
  const res = await request(app).get(path).query({ asOf, companyId: String(company) }).set(auth(who));
  return res;
}
const rowOf = (body, voucher) => body.rows.find((r) => r.referenceNo === `${P}${voucher}`);

describe("Fix 1 - only Posted OR/CV applications reduce Aging", () => {
  test("AR Aging: a Draft OR leaves the invoice fully outstanding; a Posted OR reduces it", async () => {
    const res = await report("/api/reports/ar-aging");
    expect(res.status).toBe(200);
    expect(rowOf(res.body, "INV-DRAFTPAY")).toMatchObject({ baseOriginal: 1000, basePaid: 0, baseBalance: 1000 });
    expect(rowOf(res.body, "INV-POSTEDPAY")).toMatchObject({ baseOriginal: 1000, basePaid: 300, baseBalance: 700 });
    expect(res.body.bucketTotals.base.total).toBe(1700);
  });

  test("AR Aging Summary agrees: 1,700 outstanding, not 1,300", async () => {
    const res = await report("/api/reports/ar-aging-summary");
    expect(res.status).toBe(200);
    expect(res.body.parties).toHaveLength(1);
    expect(Number(res.body.parties[0].baseBalance)).toBe(1700);
    expect(res.body.parties[0].documentCount).toBe(2);
  });

  test("AP Aging: Draft CV and Voided CV leave the APV fully outstanding; a Posted CV reduces it", async () => {
    const res = await report("/api/reports/ap-aging");
    expect(res.status).toBe(200);
    expect(rowOf(res.body, "APV-DRAFTPAY")).toMatchObject({ basePaid: 0, baseBalance: 1000 });
    expect(rowOf(res.body, "APV-POSTEDPAY")).toMatchObject({ basePaid: 300, baseBalance: 700 });
    expect(rowOf(res.body, "APV-VOIDPAY")).toMatchObject({ basePaid: 0, baseBalance: 1000 });
  });

  test("AP Aging Summary agrees with the detail (reversed APV excluded as of 2097-06-30)", async () => {
    const res = await report("/api/reports/ap-aging-summary");
    expect(res.status).toBe(200);
    expect(Number(res.body.parties[0].baseBalance)).toBe(2700);
    expect(res.body.parties[0].documentCount).toBe(3);
  });

  test("the Draft OR/CV application rows still exist - the fix is recognition, not data removal", async () => {
    const [[r]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM transaction_applications WHERE (applied_type = 'OR' AND applied_id = ?) OR (applied_type = 'CV' AND applied_id = ?)",
      [ids.orDraft, ids.cvDraft]
    );
    expect(Number(r.n)).toBe(2);
  });

  test("once the Draft OR is posted, its application counts", async () => {
    const [[hdr]] = await pool.execute("SELECT status FROM or_headers WHERE id = ?", [ids.orDraft]);
    expect(hdr.status).toBe("Draft");
    await pool.execute("UPDATE or_headers SET status = 'Posted' WHERE id = ?", [ids.orDraft]);
    try {
      const res = await report("/api/reports/ar-aging");
      expect(rowOf(res.body, "INV-DRAFTPAY")).toMatchObject({ basePaid: 400, baseBalance: 600 });
    } finally {
      await pool.execute("UPDATE or_headers SET status = 'Draft' WHERE id = ?", [ids.orDraft]);
    }
  });
});

describe("Fix 2 - an APV reversal only counts from its JV date", () => {
  test("as of 2097-06-15 (before the 2097-06-20 reversal JV) the APV is still outstanding", async () => {
    const res = await report("/api/reports/ap-aging", "2097-06-15");
    expect(res.status).toBe(200);
    expect(rowOf(res.body, "APV-REVERSED")).toMatchObject({ baseBalance: 1900 });
    const sum = await report("/api/reports/ap-aging-summary", "2097-06-15");
    expect(sum.body.parties[0].documentCount).toBe(4);
  });

  test("as of the reversal date itself, the APV is excluded", async () => {
    const res = await report("/api/reports/ap-aging", "2097-06-20");
    expect(rowOf(res.body, "APV-REVERSED")).toBeUndefined();
  });

  test("as of a later date the APV stays excluded", async () => {
    const res = await report("/api/reports/ap-aging", AS_OF);
    expect(rowOf(res.body, "APV-REVERSED")).toBeUndefined();
  });

  test("a Draft reversal JV never removes the APV", async () => {
    await pool.execute("UPDATE jv_headers SET status = 'Draft' WHERE id = ?", [ids.revJv]);
    try {
      const res = await report("/api/reports/ap-aging", AS_OF);
      expect(rowOf(res.body, "APV-REVERSED")).toMatchObject({ baseBalance: 1900 });
    } finally {
      await pool.execute("UPDATE jv_headers SET status = 'Posted' WHERE id = ?", [ids.revJv]);
    }
  });
});

describe("Fix 3 - /api/apv/unpaid refuses an inaccessible company with 403", () => {
  test("another company's companyId -> 403, no rows", async () => {
    const res = await request(app).get("/api/apv/unpaid").query({ companyId: String(companyId) }).set(auth("acctOther"));
    expect(res.status).toBe(403);
    expect(Array.isArray(res.body)).toBe(false);
  });

  test("a nonexistent companyId -> 403", async () => {
    const res = await request(app).get("/api/apv/unpaid").query({ companyId: "999999999" }).set(auth("acct"));
    expect(res.status).toBe(403);
  });

  test("the user's own company still -> 200 with only payable APVs", async () => {
    const res = await request(app).get("/api/apv/unpaid").query({ companyId: String(companyId) }).set(auth("acct"));
    expect(res.status).toBe(200);
    const vouchers = res.body.map((r) => r.voucherNo).sort();
    // The reversed APV is never payable (assertApvPayable/unpaid rule is not
    // date-based and is unchanged by this fix).
    expect(vouchers).toEqual([`${P}APV-DRAFTPAY`, `${P}APV-POSTEDPAY`, `${P}APV-VOIDPAY`].sort());
  });
});
