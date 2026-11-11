// AP Aging recognizes a payable exactly when the ledger does: Posted APVs
// (not reversed) and Posted AP beginning balances. Draft, Cancelled and Void
// APVs, reversed APVs and Draft beginning balances are not payables; payment
// applications reduce what remains. With real ledger postings this proves,
// for one company and as-of date:
//
//   AP Aging total = Trial Balance AP account (the Balance Sheet's source)
//                  = Dashboard Payables
//
// It also covers /api/apv/unpaid - the Check Voucher payment-selection list
// - which uses the same eligibility rule. Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "apagr-";
const ACC = "APAGR-";
const PASSWORD = "ApAgrPass!1";
const AS_OF = "2097-04-30";

let companyId;
let otherCompanyId;
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
      "INSERT INTO user_permissions (user_id, permission_id, granted, reason) SELECT ?, id, ?, 'ap aging test' FROM permissions WHERE module_key = ? AND action = ?",
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

async function postApv(voucherNo, date, due, amount, status) {
  const res = await request(app).post("/api/apv").set(auth("acct")).send({
    voucherNo, supplierId, supplierName: "AP Recognition Supplier", transactionDate: date, dueDate: due,
    totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: acc.EXP.id, accountCode: acc.EXP.code, accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  if (res.status !== 200) throw new Error(`apv ${voucherNo}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function jv(voucherNo, date, dr, cr, amount, extra = {}) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, ?, ?, 'ap aging test', ?, ?, 'Posted', ?, ?)`,
    [companyId, voucherNo, date, amount, amount, extra.sourceModule || null, extra.sourceReferenceId || null]
  );
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, 0)", [h.insertId, acc[dr].id, acc[dr].code, amount]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, ?)", [h.insertId, acc[cr].id, acc[cr].code, amount]);
  return h.insertId;
}

// A Posted payment (CV) of `amount` against an APV: the CV lines move the
// ledger (Dr AP / Cr Bank) and the application row reduces the APV balance,
// as paymentApplicationService does.
async function pay(apvId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    "INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status, payment_method) VALUES (?, ?, ?, 'AP Recognition Supplier', ?, ?, ?, 'Posted', 'Check')",
    [companyId, voucherNo, supplierId, date, amount, amount]
  );
  await pool.execute("INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'AP', 'x', ?, 0)", [h.insertId, acc.AP.id, acc.AP.code, amount]);
  await pool.execute("INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'Bank', 'x', 0, ?)", [h.insertId, acc.BANK.id, acc.BANK.code, amount]);
  await pool.execute(
    "INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date) VALUES ('APV', ?, 'CV', ?, ?, ?)",
    [apvId, h.insertId, amount, date]
  );
  await pool.execute(
    `UPDATE apv_headers SET paid_amount = paid_amount + ?, balance_amount = total_credit - (paid_amount),
            payment_status = IF(total_credit - paid_amount <= 0, 'Paid', 'Partially Paid') WHERE id = ?`,
    [amount, apvId]
  );
}

async function beginningBalance(status, amount, ref) {
  const [h] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, 'AP', '2097-01-01', 'PHP', 'PHILIPPINE PESO', 'ap aging test', ?)`,
    [companyId, status]
  );
  await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, 'AP Recognition Supplier', ?, 'AP', ?, '2097-02-15', 0, ?, ?, 0, 'Unpaid')`,
    [h.insertId, supplierId, acc.AP.code, ref, amount, amount]
  );
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
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'AP Recognition Supplier', '123-456-789-000', 'ACTIVE')",
    [companyId, `${P}sup`]
  );
  supplierId = g.insertId;
  await mkAccount("AP", "AP Recognition Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("EXP", "AP Recognition Expense", "EXPENSE");
  await mkAccount("BANK", "AP Recognition Bank", "ASSET");

  await makeUser("acct", "ACCOUNTANT", [companyId], [["REPORTS.AP", "VIEW", 1], ["REPORTS.FINANCIAL", "VIEW", 1]]);
  await makeUser("acctOther", "ACCOUNTANT", [otherCompanyId], [["REPORTS.AP", "VIEW", 1]]);

  ids.posted = await postApv(`${P}POSTED`, "2097-03-01", "2097-03-31", 1000, "Posted");
  ids.posted2 = await postApv(`${P}POSTED2`, "2097-03-05", "2097-05-31", 500, "Posted");
  ids.paid = await postApv(`${P}PAID`, "2097-03-06", "2097-03-31", 250, "Posted");
  ids.draft = await postApv(`${P}DRAFT`, "2097-03-10", "2097-03-31", 300, "Draft");
  ids.cancelled = await postApv(`${P}CANCELLED`, "2097-03-11", "2097-03-31", 200, "Draft");
  ids.voided = await postApv(`${P}VOID`, "2097-03-12", "2097-03-31", 700, "Posted");
  ids.reversed = await postApv(`${P}REVERSED`, "2097-03-13", "2097-03-31", 800, "Posted");

  let res = await request(app).post(`/api/apv/${ids.cancelled}/cancel`).set(auth("acct")).send({ reason: "test cancel" });
  if (res.status !== 200) throw new Error(`cancel: ${res.status} ${JSON.stringify(res.body)}`);
  res = await request(app).post(`/api/apv/${ids.voided}/void`).set(auth("acct")).send({ reason: "test void" });
  if (res.status !== 200) throw new Error(`void: ${res.status} ${JSON.stringify(res.body)}`);
  // A closed-period reversal keeps the original Posted and links a Posted
  // reversing JV (Phase 7K.1); the JV reverses the ledger effect.
  await jv(`${P}REV-JV`, "2097-04-01", "AP", "EXP", 800, { sourceModule: "APV_REVERSAL", sourceReferenceId: ids.reversed });

  await pay(ids.posted, `${P}CV-1`, "2097-03-20", 400); // partial: 1000 -> 600
  await pay(ids.paid, `${P}CV-2`, "2097-03-21", 250); // fully paid
  await beginningBalance("Posted", 150, `${P}BB-POSTED`);
  await beginningBalance("Draft", 90, `${P}BB-DRAFT`);
});

afterAll(async () => {
  try {
    const companies = [companyId, otherCompanyId].filter(Boolean);
    const apvIds = Object.values(ids);
    if (apvIds.length) await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?)", [apvIds]);
    await pool.query("DELETE ln FROM arap_beginning_balance_lines ln JOIN arap_beginning_balance_headers h ON h.id = ln.header_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM cv_lines ln JOIN cv_headers h ON h.id = ln.cv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM cv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE ln FROM jv_lines ln JOIN jv_headers h ON h.id = ln.jv_id WHERE h.company_id IN (?)", [companies]);
    await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
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

async function apAging() {
  const res = await request(app).get("/api/reports/ap-aging").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(res.status).toBe(200);
  return res.body;
}
const ledgerAp = async () => {
  const tb = await request(app).get("/api/reports/trial-balance").query({ from: "1900-01-01", to: AS_OF, companyId: String(companyId) }).set(auth("acct"));
  expect(tb.status).toBe(200);
  // The Trial Balance groups by account code AND name, so one account can
  // span several rows - add them all.
  const rows = tb.body.filter((r) => r.account_code === acc.AP.code);
  return Math.round(rows.reduce((t, r) => t + Number(r.credit) - Number(r.debit), 0) * 100) / 100;
};

describe("AP Aging recognition", () => {
  test("statuses are what the workflow produced", async () => {
    const [rows] = await pool.query("SELECT voucher_no, status FROM apv_headers WHERE company_id = ? ORDER BY id", [companyId]);
    expect(Object.fromEntries(rows.map((r) => [r.voucher_no, r.status]))).toEqual({
      [`${P}POSTED`]: "Posted", [`${P}POSTED2`]: "Posted", [`${P}PAID`]: "Posted", [`${P}DRAFT`]: "Draft",
      [`${P}CANCELLED`]: "Cancelled", [`${P}VOID`]: "Void", [`${P}REVERSED`]: "Posted",
    });
  });

  test("only Posted, non-reversed APVs with a balance and Posted AP beginning balances are payables", async () => {
    const body = await apAging();
    expect(body.rows.map((r) => r.referenceNo).sort()).toEqual([`${P}BB-POSTED`, `${P}POSTED`, `${P}POSTED2`].sort());
  });

  test.each([["Draft", "DRAFT"], ["Cancelled", "CANCELLED"], ["Void", "VOID"], ["Reversed", "REVERSED"], ["fully paid", "PAID"]])("%s APV is excluded", async (_label, suffix) => {
    const body = await apAging();
    expect(body.rows.find((r) => r.referenceNo === `${P}${suffix}`)).toBeUndefined();
  });

  test("a payment application reduces the outstanding balance (1000 - 400 = 600)", async () => {
    const body = await apAging();
    expect(body.rows.find((r) => r.referenceNo === `${P}POSTED`).baseBalance).toBe(600);
    expect(body.bucketTotals.base.total).toBe(600 + 500 + 150);
  });

  test("AP Aging total = Trial Balance AP account (the Balance Sheet's recognized AP) = Dashboard Payables", async () => {
    const aging = await apAging();
    expect(await ledgerAp()).toBe(aging.bucketTotals.base.total);
    const dash = await request(app).get("/api/dashboard/summary").query({ companyId: String(companyId), from: "2097-01-01", to: AS_OF }).set(auth("acct"));
    expect(dash.status).toBe(200);
    expect(dash.body.sections.payables.total).toBe(aging.bucketTotals.base.total);
  });

  test("posting a Draft APV makes it a payable in aging and in the ledger together", async () => {
    await pool.execute("UPDATE apv_headers SET status = 'Posted' WHERE id = ?", [ids.draft]);
    try {
      expect((await apAging()).bucketTotals.base.total).toBe(1550);
      expect(await ledgerAp()).toBe(1550);
    } finally {
      await pool.execute("UPDATE apv_headers SET status = 'Draft' WHERE id = ?", [ids.draft]);
    }
  });

  test("AP Overdue Accounts and AP Aging Summary follow the same rule", async () => {
    const overdue = await request(app).get("/api/reports/ap-overdue-accounts").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
    expect(overdue.status).toBe(200);
    expect(overdue.body.rows.map((r) => r.referenceNo).sort()).toEqual([`${P}BB-POSTED`, `${P}POSTED`].sort()); // POSTED2 not due yet
    const summary = await request(app).get("/api/reports/ap-aging-summary").query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
    expect(summary.status).toBe(200);
    expect(JSON.stringify(summary.body)).toContain("1250");
  });
});

describe("AP Aging / AP Aging Summary company authorization", () => {
  test.each(["/api/reports/ap-aging", "/api/reports/ap-aging-summary"])("%s: a company the user cannot access -> 403, no data", async (url) => {
    const res = await request(app).get(url).query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acctOther"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "You do not have access to this company" });
    expect(JSON.stringify(res.body)).not.toContain(P);
  });

  test.each(["/api/reports/ap-aging", "/api/reports/ap-aging-summary"])("%s: own company still -> 200", async (url) => {
    const res = await request(app).get(url).query({ asOf: AS_OF, companyId: String(companyId) }).set(auth("acct"));
    expect(res.status).toBe(200);
  });
});

describe("/api/apv/unpaid (Check Voucher payment selection)", () => {
  const unpaid = (who, query = {}) => request(app).get("/api/apv/unpaid").query({ companyId: String(companyId), ...query }).set(auth(who));

  test("lists only payment-eligible APVs and AP beginning balances, with the remaining balance", async () => {
    const res = await unpaid("acct");
    expect(res.status).toBe(200);
    const byNo = Object.fromEntries(res.body.map((r) => [r.voucherNo, r]));
    expect(Object.keys(byNo).sort()).toEqual([`${P}BB-POSTED`, `${P}POSTED`, `${P}POSTED2`].sort());
    expect(Number(byNo[`${P}POSTED`].balanceAmount)).toBe(600); // partially paid stays, with what remains
    expect(Number(byNo[`${P}POSTED2`].balanceAmount)).toBe(500);
    expect(byNo[`${P}BB-POSTED`].sourceType).toBe("AP_BEGINNING");
  });

  test.each(["DRAFT", "CANCELLED", "VOID", "REVERSED", "PAID", "BB-DRAFT"])("%s is not offered for payment", async (suffix) => {
    const res = await unpaid("acct");
    expect(res.body.find((r) => r.voucherNo === `${P}${suffix}`)).toBeUndefined();
  });

  test("the supplier filter still works", async () => {
    const res = await unpaid("acct", { supplierId: String(supplierId) });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    const none = await unpaid("acct", { supplierId: "2147483000" });
    expect(none.body).toEqual([]);
  });

  test("company isolation: another company's user gets nothing of this company", async () => {
    const res = await request(app).get("/api/apv/unpaid").query({ companyId: String(companyId) }).set(auth("acctOther"));
    expect(res.status).not.toBe(200);
    const own = await request(app).get("/api/apv/unpaid").set(auth("acctOther"));
    expect(own.status).toBe(200);
    expect(own.body.some((r) => String(r.voucherNo).startsWith(P))).toBe(false);
  });
});
