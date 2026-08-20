const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Checkpoint 6B: permanent HTTP-level regression coverage proving Draft
// transactions no longer affect any financial report while Posted
// transactions still do, and that this recognition-status predicate never
// trades away the company-isolation predicate from Checkpoint 6A (both
// must hold simultaneously - see Section 17 of the checkpoint spec).
//
// One JV pair (Draft 111 / Posted 222) is dedicated to proving the combined
// company+status property. A representative module per report is used for
// the rest: JV for GL/Trial Balance/Account Analysis, APV+CV+Petty Cash for
// Income Statement/Balance Sheet/Cash Flow, Invoice for Subsidiary Ledger.
// All Company A fixtures share transaction_date 2026-08-01 so date-ranged
// queries return a closed, fully-known population.

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA;
let arA, apA, cashA, revA, expA, arB, revB;
let custAId, suppAId, custBId;
let adminUserAId, adminUserBId;

let jvDraftAId, jvPostedAId, jvPostedBId;
let apvDraftAId, apvPostedAId;
let cvDraftAId, cvPostedAId;
let pcvDraftAId, pcvPostedAId;
let invDraftAId, invPostedAId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeLoginUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = result.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("DVP6B Company A");
  companyBId = await makeCompany("DVP6B Company B");
  adminUserAId = await makeLoginUser("dvp6b_admin_a", "Dvp6bPass!A1", 2, companyAId);
  adminUserBId = await makeLoginUser("dvp6b_admin_b", "Dvp6bPass!B1", 2, companyBId);

  arA = await makeAccount("DVP6BAR-A", "AR (6B)", "ASSET");
  apA = await makeAccount("DVP6BAP-A", "AP (6B)", "LIABILITY");
  cashA = await makeAccount("DVP6BCASH-A", "Cash (6B)", "ASSET");
  revA = await makeAccount("DVP6BREV-A", "Revenue (6B)", "INCOME");
  expA = await makeAccount("DVP6BEXP-A", "Expense (6B)", "EXPENSE");
  arB = await makeAccount("DVP6BAR-B", "AR (6B)", "ASSET");
  revB = await makeAccount("DVP6BREV-B", "Revenue (6B)", "INCOME");

  await pool.execute(`INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES
    ('DVP6B-ASSET-GRP', 'ASSETS', 'ASSET', 'ACTIVE'),
    ('DVP6B-LIAB-GRP', 'LIABILITIES', 'LIABILITY', 'ACTIVE'),
    ('DVP6B-REV-GRP', 'REVENUE', 'INCOME', 'ACTIVE'),
    ('DVP6B-EXP-GRP', 'EXPENSES', 'EXPENSE', 'ACTIVE')`);
  for (const coaId of [arA, cashA]) await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'DVP6B-ASSET-GRP', 'ASSETS')`, [coaId]);
  await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'DVP6B-LIAB-GRP', 'LIABILITIES')`, [apA]);
  await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'DVP6B-REV-GRP', 'REVENUE')`, [revA]);
  await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'DVP6B-EXP-GRP', 'EXPENSES')`, [expA]);

  await pool.execute(`INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_code, status) VALUES ('DVP6B-BANK', 'DVP6B Bank', 'DVP6B-0001', 'DVP6B Cash', 'DVP6BCASH-A', 'ACTIVE')`);

  custAId = await makeParty("DVP6B-CUSTA", "CUSTOMER", "6B Company A Customer", companyAId);
  suppAId = await makeParty("DVP6B-SUPPA", "SUPPLIER", "6B Company A Supplier", companyAId);
  custBId = await makeParty("DVP6B-CUSTB", "CUSTOMER", "6B Company B Customer", companyBId);

  // ---- JV: Draft 111 / Posted 222 (Company A) - the combined status+company proof ----
  const [jvDraftA] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-JV-A-DRAFT', '2026-08-01', 'x', 111, 111, 'Draft')`,
    [companyAId]
  );
  jvDraftAId = jvDraftA.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAR-A', 'AR', 'x', 111, 0)`, [jvDraftAId, arA]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BREV-A', 'REV', 'x', 0, 111)`, [jvDraftAId, revA]);

  const [jvPostedA] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-JV-A-POSTED', '2026-08-01', 'x', 222, 222, 'Posted')`,
    [companyAId]
  );
  jvPostedAId = jvPostedA.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAR-A', 'AR', 'x', 222, 0)`, [jvPostedAId, arA]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BREV-A', 'REV', 'x', 0, 222)`, [jvPostedAId, revA]);

  // Company B Posted JV (2222) - proves Company A never sees it even though
  // it is Posted (the company predicate, not the status predicate, is what
  // must exclude it).
  const [jvPostedB] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-JV-B-POSTED', '2026-08-01', 'x', 2222, 2222, 'Posted')`,
    [companyBId]
  );
  jvPostedBId = jvPostedB.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAR-B', 'AR', 'x', 2222, 0)`, [jvPostedBId, arB]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BREV-B', 'REV', 'x', 0, 2222)`, [jvPostedBId, revB]);

  // ---- APV: Draft 333 / Posted 444 (feeds Income Statement's EXP-A / Balance Sheet's AP-A) ----
  const [apvDraftA] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'DVP6B-APV-A-DRAFT', ?, '6B Company A Supplier', '2026-08-01', 333, 333, 0, 333, 'Unpaid', 'Draft')`,
    [companyAId, suppAId]
  );
  apvDraftAId = apvDraftA.insertId;
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BEXP-A', 'EXP', 'x', 333, 0)`, [apvDraftAId, expA]);
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAP-A', 'AP', 'x', 0, 333)`, [apvDraftAId, apA]);

  const [apvPostedA] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'DVP6B-APV-A-POSTED', ?, '6B Company A Supplier', '2026-08-01', 444, 444, 0, 444, 'Unpaid', 'Posted')`,
    [companyAId, suppAId]
  );
  apvPostedAId = apvPostedA.insertId;
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BEXP-A', 'EXP', 'x', 444, 0)`, [apvPostedAId, expA]);
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAP-A', 'AP', 'x', 0, 444)`, [apvPostedAId, apA]);

  // ---- CV: Draft 555 / Posted 666 (feeds Balance Sheet's AP-A / Cash Flow's CASH-A) ----
  const [cvDraftA] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-CV-A-DRAFT', ?, '6B Company A Supplier', '2026-08-01', 555, 555, 'Draft')`,
    [companyAId, suppAId]
  );
  cvDraftAId = cvDraftA.insertId;
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAP-A', 'AP', 'x', 555, 0)`, [cvDraftAId, apA]);
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BCASH-A', 'CASH', 'x', 0, 555)`, [cvDraftAId, cashA]);

  const [cvPostedA] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-CV-A-POSTED', ?, '6B Company A Supplier', '2026-08-01', 666, 666, 'Posted')`,
    [companyAId, suppAId]
  );
  cvPostedAId = cvPostedA.insertId;
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAP-A', 'AP', 'x', 666, 0)`, [cvPostedAId, apA]);
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BCASH-A', 'CASH', 'x', 0, 666)`, [cvPostedAId, cashA]);

  // ---- Petty Cash: Draft 777 / Posted 888 (Checkpoint 6 module, feeds EXP-A / CASH-A) ----
  const [pcvDraftA] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-PCV-A-DRAFT', ?, '6B Company A Supplier', '2026-08-01', 777, 777, 'Draft')`,
    [companyAId, suppAId]
  );
  pcvDraftAId = pcvDraftA.insertId;
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BEXP-A', 'EXP', 'x', 777, 0)`, [pcvDraftAId, expA]);
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BCASH-A', 'CASH', 'x', 0, 777)`, [pcvDraftAId, cashA]);

  const [pcvPostedA] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'DVP6B-PCV-A-POSTED', ?, '6B Company A Supplier', '2026-08-01', 888, 888, 'Posted')`,
    [companyAId, suppAId]
  );
  pcvPostedAId = pcvPostedA.insertId;
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BEXP-A', 'EXP', 'x', 888, 0)`, [pcvPostedAId, expA]);
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BCASH-A', 'CASH', 'x', 0, 888)`, [pcvPostedAId, cashA]);

  // ---- Invoice: Draft 999 / Posted 1010 (feeds Subsidiary Ledger's AR party ledger) ----
  const [invDraftA] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'DVP6B-INV-A-DRAFT', ?, '6B Company A Customer', '2026-08-01', 999, 999, 0, 999, 'Unpaid', 'Draft')`,
    [companyAId, custAId]
  );
  invDraftAId = invDraftA.insertId;
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAR-A', 'AR', 'x', 999, 0)`, [invDraftAId, arA]);
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BREV-A', 'REV', 'x', 0, 999)`, [invDraftAId, revA]);

  const [invPostedA] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'DVP6B-INV-A-POSTED', ?, '6B Company A Customer', '2026-08-01', 1010, 1010, 0, 1010, 'Unpaid', 'Posted')`,
    [companyAId, custAId]
  );
  invPostedAId = invPostedA.insertId;
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BAR-A', 'AR', 'x', 1010, 0)`, [invPostedAId, arA]);
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'DVP6BREV-A', 'REV', 'x', 0, 1010)`, [invPostedAId, revA]);

  tokenA = await loginAs("dvp6b_admin_a", "Dvp6bPass!A1");
});

afterAll(async () => {
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?,?)", [invDraftAId, invPostedAId]);
  await pool.query("DELETE FROM invoice_headers WHERE id IN (?,?)", [invDraftAId, invPostedAId]);
  await pool.query("DELETE FROM petty_cash_lines WHERE petty_cash_id IN (?,?)", [pcvDraftAId, pcvPostedAId]);
  await pool.query("DELETE FROM petty_cash_headers WHERE id IN (?,?)", [pcvDraftAId, pcvPostedAId]);
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (?,?)", [cvDraftAId, cvPostedAId]);
  await pool.query("DELETE FROM cv_headers WHERE id IN (?,?)", [cvDraftAId, cvPostedAId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?,?)", [apvDraftAId, apvPostedAId]);
  await pool.query("DELETE FROM apv_headers WHERE id IN (?,?)", [apvDraftAId, apvPostedAId]);
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?,?,?)", [jvDraftAId, jvPostedAId, jvPostedBId]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?,?,?)", [jvDraftAId, jvPostedAId, jvPostedBId]);
  await pool.query("DELETE FROM bank_codes WHERE bank_code = 'DVP6B-BANK'");
  await pool.query("DELETE FROM general_libraries WHERE id IN (?,?,?)", [custAId, suppAId, custBId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'DVP6B%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'DVP6B%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?,?)", [adminUserAId, adminUserBId]);
  await pool.query("DELETE FROM users WHERE id IN (?,?)", [adminUserAId, adminUserBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

const range = { from: "2026-08-01", to: "2026-08-01" };

describe("General Ledger: Draft excluded, Posted included exactly once", () => {
  test("1. AR-A shows only the two Posted rows (JV 222, Invoice 1010), never the Draft rows (JV 111, Invoice 999)", async () => {
    const res = await request(app)
      .get("/api/reports/general-ledger")
      .query({ ...range, accountCode: "DVP6BAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    const debits = res.body.map((r) => Number(r.debit)).sort((a, b) => a - b);
    expect(debits).toEqual([222, 1010]);
  });
});

describe("Trial Balance: Draft excluded, Posted included (Section 4/16)", () => {
  test("2. AR-A net balance reflects only Posted contributions (222 + 1010 = 1232 debit)", async () => {
    const res = await request(app).get("/api/reports/trial-balance").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const arRow = res.body.find((r) => r.account_code === "DVP6BAR-A");
    expect(Number(arRow.debit)).toBeCloseTo(1232, 2);
    expect(Number(arRow.credit)).toBeCloseTo(0, 2);
  });

  test("3. Unbalance Checker status totals reflect the same Posted-only population", async () => {
    const tb = await request(app).get("/api/reports/trial-balance").query(range).set("Authorization", `Bearer ${tokenA}`);
    const totalDebit = tb.body.reduce((s, r) => s + Number(r.debit), 0);
    const status = await request(app).get("/api/reports/trial-balance-checker/status").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(status.status).toBe(200);
    expect(Number(status.body.totalDebit)).toBeCloseTo(totalDebit, 2);
  });
});

describe("Account Analysis: Draft excluded, Posted included", () => {
  // Account Analysis's source union has never included Invoice/OR (only
  // APV/CV/ARAP-BB/JV/Petty Cash/Memo) - a pre-existing, EXCLUDED BY DESIGN
  // gap unrelated to Draft/Posted recognition and out of this checkpoint's
  // scope (Section 5 only asks to exclude Drafts from whatever sources are
  // already included, not to expand coverage). So only the Posted JV (222)
  // is expected here, not the Posted Invoice (1010).
  test("4. AR-A shows the Posted JV row (222), never the Draft JV row (111)", async () => {
    const res = await request(app)
      .get("/api/reports/account-analysis")
      .query({ ...range, accountCode: "DVP6BAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(Number(res.body[0].debit)).toBe(222);
  });
});

describe("Income Statement: Draft excluded (Section 6, no source-coverage expansion)", () => {
  test("5. EXP-A reflects only Posted APV (444) + Posted Petty Cash (888) = -1332, never the Draft 333/777", async () => {
    const res = await request(app).get("/api/reports/income-statement").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const expRow = res.body.find((r) => r.account_code === "DVP6BEXP-A");
    expect(Number(expRow.amount)).toBeCloseTo(-1332, 2);
  });
});

describe("Balance Sheet: Draft excluded (Section 7, no source-coverage expansion)", () => {
  test("6. AP-A reflects only Posted APV (444cr) and Posted CV (666dr) = -222, never the Draft 333/555", async () => {
    const res = await request(app).get("/api/reports/balance-sheet").query({ to: "2026-08-01" }).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const apRow = res.body.find((r) => r.account_code === "DVP6BAP-A");
    expect(Number(apRow.amount)).toBeCloseTo(-222, 2);
  });
});

describe("Cash Flow Statement: Draft cash/bank transactions excluded (Section 8)", () => {
  test("7. CASH-A ending balance reflects only Posted CV (666) + Posted Petty Cash (888) = -1554, never the Draft 555/777", async () => {
    const res = await request(app).get("/api/reports/cash-flow-statement").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const acct = res.body.accounts.find((a) => a.accountCode === "DVP6BCASH-A");
    expect(acct).toBeDefined();
    expect(acct.endingBalance).toBeCloseTo(-1554, 2);
  });
});

describe("Subsidiary Ledger: Draft source documents excluded, company isolation preserved (Section 9)", () => {
  test("8. Company A customer's AR ledger shows only the Posted Invoice (1010), not the Draft (999)", async () => {
    const res = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .query({ type: "AR", partyId: custAId, from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(Number(res.body[0].debit)).toBe(1010);
  });
});

describe("Combined company + status recognition (Section 17)", () => {
  test("9. Company A sees its own Posted (222), never its own Draft (111), never Company B's Posted (2222)", async () => {
    const res = await request(app)
      .get("/api/reports/general-ledger")
      .query({ ...range, accountCode: "DVP6BAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const debits = res.body.map((r) => Number(r.debit));
    expect(debits).toContain(222);
    expect(debits).not.toContain(111);
    expect(JSON.stringify(res.body)).not.toMatch(/2222/);

    // Belt-and-suspenders: the same 3-way check against Trial Balance too.
    const tb = await request(app).get("/api/reports/trial-balance").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(JSON.stringify(tb.body)).not.toMatch(/\b111\b|\b2222\b/);
  });
});

describe("No double counting when a Draft is posted (Section 18)", () => {
  test("10. Flipping the Draft JV (111) to Posted makes it appear exactly once, not zero and not twice", async () => {
    const before = await request(app)
      .get("/api/reports/general-ledger")
      .query({ ...range, accountCode: "DVP6BAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(before.body.filter((r) => Number(r.debit) === 111).length).toBe(0);

    await pool.execute("UPDATE jv_headers SET status = 'Posted' WHERE id = ?", [jvDraftAId]);

    const after = await request(app)
      .get("/api/reports/general-ledger")
      .query({ ...range, accountCode: "DVP6BAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    const matches = after.body.filter((r) => Number(r.debit) === 111);
    expect(matches.length).toBe(1);

    // Revert so the rest of the suite's expected totals remain stable.
    await pool.execute("UPDATE jv_headers SET status = 'Draft' WHERE id = ?", [jvDraftAId]);
  });
});
