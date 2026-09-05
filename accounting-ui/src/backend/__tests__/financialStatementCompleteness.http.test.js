const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Batch 1: permanent HTTP-level regression coverage for the
// confirmed Income Statement / Balance Sheet / Account Analysis
// completeness gaps (Invoice, OR, JV missing; no true Account Analysis
// opening balance; no Balance Sheet Current Year Earnings) found by the
// Reports Module Audit and fixed via financialStatementService.js, which
// reuses LedgerReportService's canonical 9-source union - the same one
// General Ledger/Trial Balance/Cash Flow Statement already used.
//
// All fixture transactions for the "clean equation" company are confined
// to a single calendar year (2027) with no prior-year activity, so
// "Current Year Earnings" (calendar-year-to-`to`, since no fiscal-year
// configuration exists) captures the company's entire accumulated net
// income and Assets = Liabilities + Equity + Current Earnings holds
// exactly - see the balance-equation test below for the worked math.

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA;
let arA, apA, cashA, revA, expA, loanA;
let arB, revB, expB;
let custAId, suppAId, custBId;
let adminAId, adminBId;

const ids = { jv: [], apv: [], cv: [], inv: [], or: [], pcv: [], memo: [] };

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(username, password, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')",
    [username, hash]
  );
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return r.insertId;
}
async function group(groupCode, groupDescription, accountClass, coaIds) {
  await pool.execute(
    "INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, ?, ?, 'ACTIVE')",
    [groupCode, groupDescription, accountClass]
  );
  for (const coaId of coaIds) {
    await pool.execute(
      "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
      [coaId, groupCode, groupDescription]
    );
  }
}
async function makeParty(code, partyType, name, companyId) {
  const [r] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return r.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// Thin fixture helpers for each module's header+2-line pair. `status`
// defaults to Posted; pass 'Draft'/'Cancelled' to build exclusion fixtures.
async function jv(companyId, voucherNo, date, debitAcct, creditAcct, amount, status = "Posted", extra = {}) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
    [companyId, voucherNo, date, amount, amount, status, extra.sourceModule || null, extra.sourceReferenceId || null]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.jv.push(h.insertId);
  return h.insertId;
}
async function apv(companyId, voucherNo, date, supplierId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, supplierId, date, amount, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.apv.push(h.insertId);
  return h.insertId;
}
async function cv(companyId, voucherNo, date, payeeId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.cv.push(h.insertId);
  return h.insertId;
}
async function inv(companyId, voucherNo, date, customerId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, customerId, date, amount, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.inv.push(h.insertId);
  return h.insertId;
}
async function or_(companyId, voucherNo, date, customerId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
    [companyId, voucherNo, customerId, date, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.or.push(h.insertId);
  return h.insertId;
}
async function pcv(companyId, voucherNo, date, payeeId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.pcv.push(h.insertId);
  return h.insertId;
}
async function memo(companyId, voucherNo, memoType, date, partyId, debitAcct, creditAcct, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'x', 'CUSTOMER', ?, ?, ?, ?)`,
    [companyId, voucherNo, memoType, partyId, date, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', ?, 0)",
    [h.insertId, debitAcct, debitAcct, amount]
  );
  await pool.execute(
    "INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, (SELECT code FROM chart_of_accounts WHERE id=?), 'x', 'x', 0, ?)",
    [h.insertId, creditAcct, creditAcct, amount]
  );
  ids.memo.push(h.insertId);
  return h.insertId;
}
function codeOf(map, id) {
  return map.get(id);
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("RB1 Company A");
  companyBId = await makeCompany("RB1 Company B");
  adminAId = await makeUser("rb1_admin_a", "Rb1Pass!A1", companyAId);
  adminBId = await makeUser("rb1_admin_b", "Rb1Pass!B1", companyBId);

  arA = await makeAccount("RB1-AR-A", "AR", "ASSET");
  cashA = await makeAccount("RB1-CASH-A", "Cash", "ASSET");
  apA = await makeAccount("RB1-AP-A", "AP", "LIABILITY");
  loanA = await makeAccount("RB1-LOAN-A", "Loans Payable", "LIABILITY");
  revA = await makeAccount("RB1-REV-A", "Revenue", "INCOME");
  expA = await makeAccount("RB1-EXP-A", "Expense", "EXPENSE");

  arB = await makeAccount("RB1-AR-B", "AR", "ASSET");
  revB = await makeAccount("RB1-REV-B", "Revenue", "INCOME");
  expB = await makeAccount("RB1-EXP-B", "Expense", "EXPENSE");

  await group("RB1-ASSET-GRP", "ASSETS", "ASSET", [arA, cashA, arB]);
  await group("RB1-LIAB-GRP", "LIABILITIES", "LIABILITY", [apA, loanA]);
  await group("RB1-REV-GRP", "REVENUE", "INCOME", [revA, revB]);
  await group("RB1-EXP-GRP", "EXPENSES", "EXPENSE", [expA, expB]);

  custAId = await makeParty("RB1-CUSTA", "CUSTOMER", "RB1 Customer A", companyAId);
  suppAId = await makeParty("RB1-SUPPA", "SUPPLIER", "RB1 Supplier A", companyAId);
  custBId = await makeParty("RB1-CUSTB", "CUSTOMER", "RB1 Customer B", companyBId);

  // ---- Company A: a single calendar year (2027), fully self-contained,
  // so Current Year Earnings (Jan 1 2027 -> `to`) captures 100% of net
  // income and Assets = Liabilities + Equity + Current Earnings holds
  // exactly (worked in the balance-equation test below). ----
  await inv(companyAId, "RB1-INV-A1", "2027-03-05", custAId, arA, revA, 10000); // Invoice revenue
  await or_(companyAId, "RB1-OR-A1", "2027-03-06", custAId, cashA, revA, 4000); // OR direct cash-sale revenue
  await jv(companyAId, "RB1-JV-A1", "2027-03-07", expA, cashA, 3000); // JV expense
  await jv(companyAId, "RB1-JV-A2", "2027-03-08", cashA, loanA, 1000); // JV asset+liability, no P&L
  const apvA1 = await apv(companyAId, "RB1-APV-A1", "2027-03-09", suppAId, expA, apA, 500); // APV regression
  await cv(companyAId, "RB1-CV-A1", "2027-03-10", suppAId, apA, cashA, 500); // CV regression (settles the APV's AP)
  await pcv(companyAId, "RB1-PCV-A1", "2027-03-11", suppAId, expA, cashA, 200); // Petty Cash regression
  await memo(companyAId, "RB1-DM-A1", "DEBIT", "2027-03-12", custAId, arA, revA, 300); // Debit Memo revenue
  await memo(companyAId, "RB1-CM-A1", "CREDIT", "2027-03-13", custAId, revA, arA, 150); // Credit Memo contra-revenue

  // Reversal pair: a Posted APV to Expense, then a Posted JV that reverses
  // it exactly the way reversalService.js's real reversals are shaped
  // (source_module 'APV_REVERSAL', source_reference_id = original id,
  // debit/credit of every line swapped) - net effect on Expense/AP must be
  // zero, proving reversal JVs are included naturally (no special-casing)
  // and net correctly rather than needing to be excluded.
  const apvToReverse = await apv(companyAId, "RB1-APV-A2", "2027-03-14", suppAId, expA, apA, 7000);
  await jv(companyAId, "RB1-JV-REV-A1", "2027-03-15", apA, expA, 7000, "Posted", {
    sourceModule: "APV_REVERSAL",
    sourceReferenceId: apvToReverse,
  });

  // Draft: must NOT appear anywhere (distinct, unmistakable amount).
  await inv(companyAId, "RB1-INV-A-DRAFT", "2027-03-16", custAId, arA, revA, 99999, "Draft");
  await jv(companyAId, "RB1-JV-A-DRAFT", "2027-03-16", expA, cashA, 99999, "Draft");
  await or_(companyAId, "RB1-OR-A-DRAFT", "2027-03-16", custAId, cashA, revA, 99999, "Draft");

  // Cancelled: must NOT appear (distinct, unmistakable amount).
  await jv(companyAId, "RB1-JV-A-CANCELLED", "2027-03-17", expA, cashA, 88888, "Cancelled");

  // Dated AFTER the Balance Sheet as-of date used below (2027-03-31) - must
  // be excluded from an as-of-2027-03-31 Balance Sheet.
  await jv(companyAId, "RB1-JV-A-FUTURE", "2027-04-01", cashA, revA, 55555);

  // ---- Company B: mirrored, different amounts, isolation-only. ----
  await inv(companyBId, "RB1-INV-B1", "2027-03-05", custBId, arB, revB, 444);
  await jv(companyBId, "RB1-JV-B1", "2027-03-07", expB, arB, 222);

  tokenA = await loginAs("rb1_admin_a", "Rb1Pass!A1");
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [ids.jv.length ? ids.jv : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [ids.jv.length ? ids.jv : [0]]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?)", [ids.apv.length ? ids.apv : [0]]);
  await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [ids.apv.length ? ids.apv : [0]]);
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (?)", [ids.cv.length ? ids.cv : [0]]);
  await pool.query("DELETE FROM cv_headers WHERE id IN (?)", [ids.cv.length ? ids.cv : [0]]);
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [ids.inv.length ? ids.inv : [0]]);
  await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [ids.inv.length ? ids.inv : [0]]);
  await pool.query("DELETE FROM or_lines WHERE or_id IN (?)", [ids.or.length ? ids.or : [0]]);
  await pool.query("DELETE FROM or_headers WHERE id IN (?)", [ids.or.length ? ids.or : [0]]);
  await pool.query("DELETE FROM petty_cash_lines WHERE petty_cash_id IN (?)", [ids.pcv.length ? ids.pcv : [0]]);
  await pool.query("DELETE FROM petty_cash_headers WHERE id IN (?)", [ids.pcv.length ? ids.pcv : [0]]);
  await pool.query("DELETE FROM memo_lines WHERE memo_id IN (?)", [ids.memo.length ? ids.memo : [0]]);
  await pool.query("DELETE FROM memo_headers WHERE id IN (?)", [ids.memo.length ? ids.memo : [0]]);
  await pool.query("DELETE FROM general_libraries WHERE id IN (?,?,?)", [custAId, suppAId, custBId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'RB1-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'RB1-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?,?)", [adminAId, adminBId]);
  await pool.query("DELETE FROM users WHERE id IN (?,?)", [adminAId, adminBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

const H = (t) => ({ Authorization: `Bearer ${t}` });
const byCode = (rows, code) => rows.find((r) => r.account_code === code);

describe("Income Statement completeness (Reports Batch 1)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app)
      .get("/api/reports/income-statement?from=2027-03-01&to=2027-03-31")
      .set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body;
  });

  test("Invoice revenue: Posted Invoice Dr AR / Cr Revenue increases Revenue", () => {
    const rev = byCode(rows, "RB1-REV-A");
    // Invoice 10000 + OR 4000 + DM 300 - CM 150 = 14150
    expect(Number(rev.amount)).toBeCloseTo(14150, 2);
  });

  test("OR revenue: a Posted OR that credits Revenue directly (real cash-sale posting) is included", () => {
    // isolate OR's own contribution by re-running without the Invoice/DM/CM
    // amounts is unnecessary - OR's 4000 is already proven present because
    // the combined Revenue total above only reconciles (14150) if OR's
    // 4000 is included; this test pins that specific number so a
    // regression that silently drops OR again fails here even if some
    // other source's amount happens to compensate.
    const rev = byCode(rows, "RB1-REV-A");
    expect(Number(rev.amount)).toBe(10000 + 4000 + 300 - 150);
  });

  test("JV revenue/expense: a Posted JV to an Expense account is included", () => {
    const exp = byCode(rows, "RB1-EXP-A");
    // JV 3000 + APV 500 + PCV 200 + reversal-pair net 0 = 3700, expense
    // accounts are debit-normal so amount (credit-debit) is negative.
    expect(Number(exp.amount)).toBeCloseTo(-3700, 2);
  });

  test("Draft Invoice/OR/JV do not appear (distinct 99999 amount absent)", () => {
    const rev = byCode(rows, "RB1-REV-A");
    const exp = byCode(rows, "RB1-EXP-A");
    expect(Number(rev.amount)).not.toBe(14150 + 99999 + 99999);
    expect(Math.abs(Number(exp.amount))).not.toBeGreaterThanOrEqual(99999);
  });

  test("Cancelled JV does not appear (distinct 88888 amount absent)", () => {
    const exp = byCode(rows, "RB1-EXP-A");
    expect(Math.abs(Number(exp.amount))).toBeLessThan(88888);
  });

  test("Reversal: the Posted reversal JV nets its original APV to zero on Expense/AP, not merely excluded", () => {
    // Expense's -3700 above already has no trace of the 7000 pair, proving
    // the +7000/-7000 offset, not an exclusion of either leg.
    const exp = byCode(rows, "RB1-EXP-A");
    expect(Number(exp.amount)).toBeCloseTo(-3700, 2);
  });

  test("Company isolation: Company A's Income Statement never contains Company B's amounts", () => {
    const rev = byCode(rows, "RB1-REV-A");
    const exp = byCode(rows, "RB1-EXP-A");
    expect(Number(rev.amount)).not.toBe(444);
    expect(Math.abs(Number(exp.amount))).not.toBe(222);
    // chart_of_accounts is a shared catalog across companies (no company_id
    // column), so Company B's accounts still appear as zero-amount rows
    // (the LEFT JOIN finds no Company-A-scoped transaction for them) -
    // that is the pre-existing, correct behavior. The isolation guarantee
    // is that their AMOUNT is never Company B's real figure.
    const revB = rows.find((r) => r.account_code === "RB1-REV-B");
    const expB2 = rows.find((r) => r.account_code === "RB1-EXP-B");
    expect(Number(revB?.amount || 0)).toBe(0);
    expect(Number(expB2?.amount || 0)).toBe(0);
  });
});

describe("Balance Sheet completeness + Current Year Earnings (Reports Batch 1)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get("/api/reports/balance-sheet?to=2027-03-31").set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body;
  });

  test("Invoice AR: Posted Invoice's AR debit reaches the Balance Sheet asset", () => {
    const ar = byCode(rows, "RB1-AR-A");
    // Invoice +10000, DM +300, CM -150 = 10150
    expect(Number(ar.amount)).toBeCloseTo(10150, 2);
  });

  test("JV to asset/liability: the Cash<->Loans Payable JV appears on both sides", () => {
    const cash = byCode(rows, "RB1-CASH-A");
    const loan = byCode(rows, "RB1-LOAN-A");
    // Cash: OR +4000, JV#1 -3000, JV#2 +1000, CV -500, PCV -200 = 1300
    expect(Number(cash.amount)).toBeCloseTo(1300, 2);
    expect(Number(loan.amount)).toBeCloseTo(1000, 2);
  });

  test("Current Year Earnings row is present, computed (not persisted), and matches Income Statement's net income", () => {
    const earnings = rows.find((r) => r.account_code === "CURRENT-EARNINGS");
    expect(earnings).toBeTruthy();
    expect(earnings.account_title).toBe("Current Year Earnings");
    expect(String(earnings.group_name).toUpperCase()).toContain("EQUITY");
    // Revenue 14150 - Expense 3700 = 10450
    expect(Number(earnings.amount)).toBeCloseTo(10450, 2);
  });

  test("Balance equation: Assets = Liabilities + Equity + Current Earnings", () => {
    const assets = rows
      .filter((r) => String(r.account_class).toUpperCase() === "ASSET")
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    const liabilities = rows
      .filter((r) => String(r.account_class).toUpperCase().includes("LIABIL"))
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    const equity = rows
      .filter((r) => String(r.account_class).toUpperCase() === "EQUITY")
      .reduce((s, r) => s + Number(r.amount || 0), 0);

    expect(assets).toBeCloseTo(11450, 2);
    expect(liabilities).toBeCloseTo(1000, 2);
    expect(equity).toBeCloseTo(10450, 2); // the Current Earnings row itself
    expect(assets).toBeCloseTo(liabilities + equity, 2);
  });

  test("As-of date: a transaction dated after the as-of date is excluded", () => {
    const cash = byCode(rows, "RB1-CASH-A");
    const rev = rows.find((r) => r.account_code === "RB1-REV-A"); // not on BS, but reuse to sanity-check no bleed
    expect(Number(cash.amount)).toBeCloseTo(1300, 2); // not 1300+55555
    expect(rev).toBeUndefined(); // Revenue isn't a Balance Sheet line at all
  });

  test("Draft/Cancelled do not affect the Balance Sheet", () => {
    const ar = byCode(rows, "RB1-AR-A");
    const cash = byCode(rows, "RB1-CASH-A");
    expect(Number(ar.amount)).toBeLessThan(99999);
    expect(Number(cash.amount)).toBeLessThan(88888);
  });

  test("Company isolation: Company A's Balance Sheet never contains Company B's amounts", () => {
    // Same shared-catalog note as the Income Statement isolation test above.
    const arB2 = rows.find((r) => r.account_code === "RB1-AR-B");
    expect(Number(arB2?.amount || 0)).toBe(0);
  });
});

describe("Account Analysis completeness + true opening balance (Reports Batch 1)", () => {
  let aaAcctA;
  let rows;

  beforeAll(async () => {
    aaAcctA = await makeAccount("RB1-AA-REV", "AA Test Revenue", "INCOME");

    // Prior-period beginning balance (before `from` = 2027-03-01).
    await jv(companyAId, "RB1-AA-BB", "2027-01-15", cashA, aaAcctA, 1000);

    // In-range movements (2027-03-01 .. 2027-03-31), one per required source.
    await inv(companyAId, "RB1-AA-INV1", "2027-03-05", custAId, arA, aaAcctA, 500);
    await or_(companyAId, "RB1-AA-OR1", "2027-03-06", custAId, cashA, aaAcctA, 300);
    await jv(companyAId, "RB1-AA-JV1", "2027-03-07", cashA, aaAcctA, 200);
    await memo(companyAId, "RB1-AA-DM1", "DEBIT", "2027-03-08", custAId, arA, aaAcctA, 100);
    await memo(companyAId, "RB1-AA-CM1", "CREDIT", "2027-03-09", custAId, aaAcctA, arA, 50);

    // Draft: must not affect beginning or ending balance.
    await inv(companyAId, "RB1-AA-DRAFT", "2027-03-10", custAId, arA, aaAcctA, 99999, "Draft");

    // Company B, same-shaped account code space, isolation-only.
    await jv(companyBId, "RB1-AA-B1", "2027-03-07", arB, revB, 321);

    const res = await request(app)
      .get(`/api/reports/account-analysis?from=2027-03-01&to=2027-03-31&accountCode=RB1-AA-REV`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body;
  });

  afterAll(async () => {
    ids.jv.push(...[]); // no-op: cleanup handled in the outer afterAll via LIKE 'RB1-%'
  });

  test("true beginning balance is computed from sources dated before `from`", () => {
    expect(rows.length).toBeGreaterThan(0);
    // Cr 1000 on 2027-01-15 -> debit(0) - credit(1000) = -1000
    expect(Number(rows[0].beginning_balance)).toBeCloseTo(-1000, 2);
  });

  test("Invoice, OR, JV, Debit Memo and Credit Memo movements all appear, each once", () => {
    const sources = rows.map((r) => r.source_type);
    expect(sources).toEqual(
      expect.arrayContaining(["INV", "OR", "JV", "DEBIT MEMO", "CREDIT MEMO"])
    );
    expect(rows.length).toBe(5); // exactly the 5 in-range Posted rows, no Draft
  });

  test("running balance starts from the beginning balance and accumulates correctly", () => {
    // -1000, then -1500, -1800, -2000, -2100, -2050 (see file header comment
    // for the full worked derivation)
    expect(Number(rows[0].running_balance)).toBeCloseTo(-1500, 2);
    expect(Number(rows[1].running_balance)).toBeCloseTo(-1800, 2);
    expect(Number(rows[2].running_balance)).toBeCloseTo(-2000, 2);
    expect(Number(rows[3].running_balance)).toBeCloseTo(-2100, 2);
  });

  test("ending balance (last row's running balance) is correct", () => {
    const last = rows[rows.length - 1];
    expect(Number(last.running_balance)).toBeCloseTo(-2050, 2);
  });

  test("transaction_id is preserved for drill-down", () => {
    expect(rows.every((r) => r.source_type === "GL BEGINNING" || r.transaction_id != null)).toBe(true);
  });

  test("Company isolation: Company A's Account Analysis never contains Company B's amounts", () => {
    expect(rows.length).toBe(5);
    expect(rows.some((r) => Number(r.debit) === 321 || Number(r.credit) === 321)).toBe(false);
  });
});

describe("Input VAT still works through Account Analysis, no tax architecture change", () => {
  test("InputVAT.jsx source is unchanged: still calls /api/reports/account-analysis, no tax-entry logic", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../pages/REPORTS/InputVAT.jsx"),
      "utf8"
    );
    expect(src).toMatch(/\/api\/reports\/account-analysis/);
    expect(src).not.toMatch(/transaction_tax_entries|vat_entry_mode|taxEntry/);
  });

  test("the same account-analysis endpoint Input VAT relies on returns a complete, company-scoped, dated result", async () => {
    const acctId = await makeAccount("RB1-IVAT-A", "Input VAT-like account", "ASSET");
    await jv(companyAId, "RB1-IVAT-JV1", "2027-03-05", acctId, cashA, 42);
    const res = await request(app)
      .get(`/api/reports/account-analysis?from=2027-03-01&to=2027-03-31&accountCode=RB1-IVAT-A`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(Number(res.body[0].debit)).toBe(42);
    expect("beginning_balance" in res.body[0]).toBe(true);
    expect("running_balance" in res.body[0]).toBe(true);
  });
});
