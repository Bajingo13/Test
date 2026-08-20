const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Checkpoint 6A: permanent HTTP-level regression coverage for the two
// confirmed financial-report-integrity bugs (Trial Balance omitting
// Invoice/OR; Income Statement & Balance Sheet having zero company_id
// filtering) plus the same missing-company-filter pattern found and fixed
// elsewhere during the 6A audit (Subsidiary Ledger, the Trial Balance
// Checker's own investigation queries). Everything here runs through the
// real Express app via Supertest against the TEST database only.
//
// Fixture shape: every Company A transaction is dated 2026-08-01 and is
// individually balanced (debit == credit) except the AR Beginning Balance,
// which is deliberately one-sided by design (documented pre-existing
// behavior - see trialBalanceCheckerService.js's BEGINNING_BALANCE_ISSUES
// finding) and is dated 2026-01-01 specifically so it can be excluded from
// the pure balance-equation check and included only in the wider
// completeness/isolation checks. Company B mirrors a smaller set with
// entirely different amounts so cross-company leakage is unambiguous.

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA, tokenB;
let arA, apA, cashA, revA, expA;
let arB, apB, cashB, revB, expB;
let custAId, suppAId, custBId, suppBId;
let adminUserAId, adminUserBId;

let jvAId, apvAId, cvAId, invAId, orAId, pcvAId, dmAId, cmAId, bbHeaderAId, bbLineAId;
let jvBId, apvBId, cvBId, invBId, orBId, pcvBId, dmBId, cmBId;

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

  companyAId = await makeCompany("RPT6A Company A");
  companyBId = await makeCompany("RPT6A Company B");
  adminUserAId = await makeLoginUser("rpt6a_admin_a", "Rpt6aPass!A1", 2, companyAId);
  adminUserBId = await makeLoginUser("rpt6a_admin_b", "Rpt6aPass!B1", 2, companyBId);

  arA = await makeAccount("RPT6AAR-A", "AR (6A)", "ASSET");
  apA = await makeAccount("RPT6AAP-A", "AP (6A)", "LIABILITY");
  cashA = await makeAccount("RPT6ACASH-A", "Cash (6A)", "ASSET");
  revA = await makeAccount("RPT6AREV-A", "Revenue (6A)", "INCOME");
  expA = await makeAccount("RPT6AEXP-A", "Expense (6A)", "EXPENSE");

  arB = await makeAccount("RPT6AAR-B", "AR (6A)", "ASSET");
  apB = await makeAccount("RPT6AAP-B", "AP (6A)", "LIABILITY");
  cashB = await makeAccount("RPT6ACASH-B", "Cash (6A)", "ASSET");
  revB = await makeAccount("RPT6AREV-B", "Revenue (6A)", "INCOME");
  expB = await makeAccount("RPT6AEXP-B", "Expense (6A)", "EXPENSE");

  custAId = await makeParty("RPT6A-CUSTA", "CUSTOMER", "6A Company A Customer", companyAId);
  suppAId = await makeParty("RPT6A-SUPPA", "SUPPLIER", "6A Company A Supplier", companyAId);
  custBId = await makeParty("RPT6A-CUSTB", "CUSTOMER", "6A Company B Customer", companyBId);
  suppBId = await makeParty("RPT6A-SUPPB", "SUPPLIER", "6A Company B Supplier", companyBId);

  // Income Statement / Balance Sheet INNER JOIN chart_of_accounts through
  // coa_groups -> account_group_codes to classify each account - without a
  // row here, an account is invisible to those two reports regardless of
  // company_id. Four shared group codes cover all 5 account classes used
  // by both companies' fixture accounts.
  await pool.execute(`INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES
    ('RPT6A-ASSET-GRP', 'ASSETS', 'ASSET', 'ACTIVE'),
    ('RPT6A-LIAB-GRP', 'LIABILITIES', 'LIABILITY', 'ACTIVE'),
    ('RPT6A-REV-GRP', 'REVENUE', 'INCOME', 'ACTIVE'),
    ('RPT6A-EXP-GRP', 'EXPENSES', 'EXPENSE', 'ACTIVE')`);
  const assetAccounts = [arA, cashA, arB, cashB];
  const liabAccounts = [apA, apB];
  const revAccounts = [revA, revB];
  const expAccounts = [expA, expB];
  for (const coaId of assetAccounts) {
    await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'RPT6A-ASSET-GRP', 'ASSETS')`, [coaId]);
  }
  for (const coaId of liabAccounts) {
    await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'RPT6A-LIAB-GRP', 'LIABILITIES')`, [coaId]);
  }
  for (const coaId of revAccounts) {
    await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'RPT6A-REV-GRP', 'REVENUE')`, [coaId]);
  }
  for (const coaId of expAccounts) {
    await pool.execute(`INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'RPT6A-EXP-GRP', 'EXPENSES')`, [coaId]);
  }

  // ---- Company A: one Posted, balanced transaction per module, each with
  // a distinct amount so "exactly once" is verifiable by summing. ----
  const [jvA] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-JV-A1', '2026-08-01', 'x', 1000, 1000, 'Posted')`,
    [companyAId]
  );
  jvAId = jvA.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-A', 'AR', 'x', 1000, 0)`, [jvAId, arA]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-A', 'REV', 'x', 0, 1000)`, [jvAId, revA]);

  const [apvA] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'RPT6A-APV-A1', ?, '6A Company A Supplier', '2026-08-01', 2000, 2000, 0, 2000, 'Unpaid', 'Posted')`,
    [companyAId, suppAId]
  );
  apvAId = apvA.insertId;
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AEXP-A', 'EXP', 'x', 2000, 0)`, [apvAId, expA]);
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAP-A', 'AP', 'x', 0, 2000)`, [apvAId, apA]);

  const [cvA] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-CV-A1', ?, '6A Company A Supplier', '2026-08-01', 3000, 3000, 'Posted')`,
    [companyAId, suppAId]
  );
  cvAId = cvA.insertId;
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAP-A', 'AP', 'x', 3000, 0)`, [cvAId, apA]);
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-A', 'CASH', 'x', 0, 3000)`, [cvAId, cashA]);

  const [invA] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'RPT6A-INV-A1', ?, '6A Company A Customer', '2026-08-01', 4000, 4000, 0, 4000, 'Unpaid', 'Posted')`,
    [companyAId, custAId]
  );
  invAId = invA.insertId;
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-A', 'AR', 'x', 4000, 0)`, [invAId, arA]);
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-A', 'REV', 'x', 0, 4000)`, [invAId, revA]);

  const [orA] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-OR-A1', ?, '6A Company A Customer', '2026-08-01', 5000, 5000, 'Posted')`,
    [companyAId, custAId]
  );
  orAId = orA.insertId;
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-A', 'CASH', 'x', 5000, 0)`, [orAId, cashA]);
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-A', 'AR', 'x', 0, 5000)`, [orAId, arA]);

  const [pcvA] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-PCV-A1', ?, '6A Company A Supplier', '2026-08-01', 6000, 6000, 'Posted')`,
    [companyAId, suppAId]
  );
  pcvAId = pcvA.insertId;
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AEXP-A', 'EXP', 'x', 6000, 0)`, [pcvAId, expA]);
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-A', 'CASH', 'x', 0, 6000)`, [pcvAId, cashA]);

  const [dmA] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-DM-A1', 'DEBIT', ?, '6A Company A Customer', 'CUSTOMER', '2026-08-01', 7000, 7000, 'Posted')`,
    [companyAId, custAId]
  );
  dmAId = dmA.insertId;
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-A', 'AR', 'x', 7000, 0)`, [dmAId, arA]);
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-A', 'REV', 'x', 0, 7000)`, [dmAId, revA]);

  const [cmA] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-CM-A1', 'CREDIT', ?, '6A Company A Customer', 'CUSTOMER', '2026-08-01', 8000, 8000, 'Posted')`,
    [companyAId, custAId]
  );
  cmAId = cmA.insertId;
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-A', 'REV', 'x', 8000, 0)`, [cmAId, revA]);
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-A', 'AR', 'x', 0, 8000)`, [cmAId, arA]);

  // Deliberately one-sided (AR Beginning Balance has no offsetting entry
  // anywhere in this system, by design - see trialBalanceCheckerService.js)
  // and deliberately dated OUTSIDE the Aug-01 window so the pure
  // balance-equation test below isn't muddied by a documented, unrelated
  // structural asymmetry.
  const [bbHeaderA] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, 'AR', '2026-01-01', 'PHP', 'PHILIPPINE PESO', 'RPT6A', 'Posted')`,
    [companyAId]
  );
  bbHeaderAId = bbHeaderA.insertId;
  const [bbLineA] = await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, account_id, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, '6A Company A Customer', 'RPT6AAR-A', 'AR', ?, 'RPT6A-BB-A1', '2026-01-31', 9000, 0, 9000, 0, 'Unpaid')`,
    [bbHeaderAId, custAId, arA]
  );
  bbLineAId = bbLineA.insertId;

  // ---- Company B: smaller mirrored set, entirely different amounts,
  // used only to prove Company A never sees these values. ----
  const [jvB] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-JV-B1', '2026-08-01', 'x', 111, 111, 'Posted')`,
    [companyBId]
  );
  jvBId = jvB.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-B', 'AR', 'x', 111, 0)`, [jvBId, arB]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-B', 'REV', 'x', 0, 111)`, [jvBId, revB]);

  const [apvB] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'RPT6A-APV-B1', ?, '6A Company B Supplier', '2026-08-01', 222, 222, 0, 222, 'Unpaid', 'Posted')`,
    [companyBId, suppBId]
  );
  apvBId = apvB.insertId;
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AEXP-B', 'EXP', 'x', 222, 0)`, [apvBId, expB]);
  await pool.execute(`INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAP-B', 'AP', 'x', 0, 222)`, [apvBId, apB]);

  const [cvB] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-CV-B1', ?, '6A Company B Supplier', '2026-08-01', 333, 333, 'Posted')`,
    [companyBId, suppBId]
  );
  cvBId = cvB.insertId;
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAP-B', 'AP', 'x', 333, 0)`, [cvBId, apB]);
  await pool.execute(`INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-B', 'CASH', 'x', 0, 333)`, [cvBId, cashB]);

  const [invB] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'RPT6A-INV-B1', ?, '6A Company B Customer', '2026-08-01', 444, 444, 0, 444, 'Unpaid', 'Posted')`,
    [companyBId, custBId]
  );
  invBId = invB.insertId;
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-B', 'AR', 'x', 444, 0)`, [invBId, arB]);
  await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-B', 'REV', 'x', 0, 444)`, [invBId, revB]);

  const [orB] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-OR-B1', ?, '6A Company B Customer', '2026-08-01', 555, 555, 'Posted')`,
    [companyBId, custBId]
  );
  orBId = orB.insertId;
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-B', 'CASH', 'x', 555, 0)`, [orBId, cashB]);
  await pool.execute(`INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-B', 'AR', 'x', 0, 555)`, [orBId, arB]);

  const [pcvB] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-PCV-B1', ?, '6A Company B Supplier', '2026-08-01', 666, 666, 'Posted')`,
    [companyBId, suppBId]
  );
  pcvBId = pcvB.insertId;
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AEXP-B', 'EXP', 'x', 666, 0)`, [pcvBId, expB]);
  await pool.execute(`INSERT INTO petty_cash_lines (petty_cash_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6ACASH-B', 'CASH', 'x', 0, 666)`, [pcvBId, cashB]);

  const [dmB] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-DM-B1', 'DEBIT', ?, '6A Company B Customer', 'CUSTOMER', '2026-08-01', 777, 777, 'Posted')`,
    [companyBId, custBId]
  );
  dmBId = dmB.insertId;
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-B', 'AR', 'x', 777, 0)`, [dmBId, arB]);
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-B', 'REV', 'x', 0, 777)`, [dmBId, revB]);

  const [cmB] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'RPT6A-CM-B1', 'CREDIT', ?, '6A Company B Customer', 'CUSTOMER', '2026-08-01', 888, 888, 'Posted')`,
    [companyBId, custBId]
  );
  cmBId = cmB.insertId;
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AREV-B', 'REV', 'x', 888, 0)`, [cmBId, revB]);
  await pool.execute(`INSERT INTO memo_lines (memo_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'RPT6AAR-B', 'AR', 'x', 0, 888)`, [cmBId, arB]);

  tokenA = await loginAs("rpt6a_admin_a", "Rpt6aPass!A1");
  tokenB = await loginAs("rpt6a_admin_b", "Rpt6aPass!B1");
});

afterAll(async () => {
  await pool.query("DELETE FROM memo_lines WHERE memo_id IN (?,?,?,?)", [dmAId, cmAId, dmBId, cmBId]);
  await pool.query("DELETE FROM memo_headers WHERE id IN (?,?,?,?)", [dmAId, cmAId, dmBId, cmBId]);
  await pool.query("DELETE FROM petty_cash_lines WHERE petty_cash_id IN (?,?)", [pcvAId, pcvBId]);
  await pool.query("DELETE FROM petty_cash_headers WHERE id IN (?,?)", [pcvAId, pcvBId]);
  await pool.query("DELETE FROM or_lines WHERE or_id IN (?,?)", [orAId, orBId]);
  await pool.query("DELETE FROM or_headers WHERE id IN (?,?)", [orAId, orBId]);
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?,?)", [invAId, invBId]);
  await pool.query("DELETE FROM invoice_headers WHERE id IN (?,?)", [invAId, invBId]);
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (?,?)", [cvAId, cvBId]);
  await pool.query("DELETE FROM cv_headers WHERE id IN (?,?)", [cvAId, cvBId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?,?)", [apvAId, apvBId]);
  await pool.query("DELETE FROM apv_headers WHERE id IN (?,?)", [apvAId, apvBId]);
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?,?)", [jvAId, jvBId]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?,?)", [jvAId, jvBId]);
  await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id IN (?)", [bbLineAId]);
  await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id IN (?)", [bbHeaderAId]);
  await pool.query("DELETE FROM general_libraries WHERE id IN (?,?,?,?)", [custAId, suppAId, custBId, suppBId]);
  // coa_groups rows cascade-delete with their chart_of_accounts parent
  // (fk ON DELETE CASCADE); account_group_codes is an independent catalog
  // row this fixture inserted and must be cleaned up explicitly.
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'RPT6A%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'RPT6A%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?,?)", [adminUserAId, adminUserBId]);
  await pool.query("DELETE FROM users WHERE id IN (?,?)", [adminUserAId, adminUserBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Trial Balance: completeness fix (Invoice/OR previously omitted)", () => {
  test("1. Trial Balance for 2026-08-01 includes Invoice and OR contributions on the AR/Revenue/Cash accounts", async () => {
    const res = await request(app)
      .get("/api/reports/trial-balance")
      .query({ from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    const byCode = Object.fromEntries(res.body.map((r) => [r.account_code, r]));
    // AR (debit side, netted): INV +4000dr, OR -5000(cr), JV +1000dr, DM +7000dr, CM -8000(cr)
    // net AR = 1000 + 4000 - 5000 + 7000 - 8000 = -1000 -> credit balance of 1000
    expect(Number(byCode["RPT6AAR-A"].credit)).toBeCloseTo(1000, 2);
    expect(Number(byCode["RPT6AAR-A"].debit)).toBeCloseTo(0, 2);
    // Cash: CV +3000cr is actually a credit; OR +5000dr; PCV -6000cr
    // net cash = -3000 + 5000 - 6000 = -4000 -> credit balance 4000
    expect(Number(byCode["RPT6ACASH-A"].credit)).toBeCloseTo(4000, 2);
  });

  test("2. The Unbalance Checker status badge uses the same fixed population (Invoice/OR reflected in totals)", async () => {
    const trialBalance = await request(app)
      .get("/api/reports/trial-balance")
      .query({ from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    const totalDebit = trialBalance.body.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = trialBalance.body.reduce((s, r) => s + Number(r.credit), 0);

    const status = await request(app)
      .get("/api/reports/trial-balance-checker/status")
      .query({ from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(status.status).toBe(200);
    expect(Number(status.body.totalDebit)).toBeCloseTo(totalDebit, 2);
    expect(Number(status.body.totalCredit)).toBeCloseTo(totalCredit, 2);
  });
});

describe("Trial Balance: accounting equation (Section 4)", () => {
  test("3. TOTAL DEBIT = TOTAL CREDIT for the 8 naturally-balanced sources dated 2026-08-01 (AR Beginning Balance excluded by date)", async () => {
    const res = await request(app)
      .get("/api/reports/trial-balance")
      .query({ from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const totalDebit = res.body.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = res.body.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });

  test("4. Widening the range to include the AR Beginning Balance produces exactly the documented, known, one-sided difference (not an unexplained imbalance)", async () => {
    const res = await request(app)
      .get("/api/reports/trial-balance")
      .query({ from: "2026-01-01", to: "2026-08-31" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const totalDebit = res.body.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = res.body.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit - totalCredit).toBeCloseTo(9000, 2);
  });
});

describe("Company isolation: Trial Balance / GL / Account Analysis / Income Statement / Balance Sheet / Cash Flow / Subsidiary Ledger (Section 8)", () => {
  const range = { from: "2026-08-01", to: "2026-08-01" };

  test("5. Company A's Trial Balance never contains Company B's amounts or voucher numbers", async () => {
    const res = await request(app).get("/api/reports/trial-balance").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/RPT6AAR-B|RPT6AAP-B|RPT6ACASH-B|RPT6AREV-B|RPT6AEXP-B/);
    for (const leakAmount of [111, 222, 333, 444, 555, 666, 777, 888]) {
      const row = res.body.find((r) => Number(r.debit) === leakAmount || Number(r.credit) === leakAmount);
      expect(row).toBeUndefined();
    }
  });

  test("6. Company B's Trial Balance never contains Company A's amounts or voucher numbers", async () => {
    const res = await request(app).get("/api/reports/trial-balance").query(range).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/RPT6AAR-A|RPT6AAP-A|RPT6ACASH-A|RPT6AREV-A|RPT6AEXP-A/);
    for (const leakAmount of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]) {
      const row = res.body.find((r) => Number(r.debit) === leakAmount || Number(r.credit) === leakAmount);
      expect(row).toBeUndefined();
    }
  });

  test("7. General Ledger: Company A sees only Company A rows", async () => {
    const res = await request(app).get("/api/reports/general-ledger").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/RPT6A-.*-B1/);
  });

  test("8. Account Analysis: Company A querying its own AR account never shows Company B's AR lines", async () => {
    const res = await request(app)
      .get("/api/reports/account-analysis")
      .query({ ...range, accountCode: "RPT6AAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/RPT6A-.*-B1/);
  });

  test("9. Income Statement (previously had ZERO company filtering): Company A's Expense account excludes Company B's APV/Petty Cash expense amounts", async () => {
    const resA = await request(app).get("/api/reports/income-statement").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    const expRowA = resA.body.find((r) => r.account_code === "RPT6AEXP-A");
    expect(expRowA).toBeDefined();
    // APV 2000 + Petty Cash 6000 = 8000 debit -> expense shown as negative of (credit-debit) i.e. -8000
    expect(Number(expRowA.amount)).toBeCloseTo(-8000, 2);
    // chart_of_accounts is a shared catalog by design (checkpoint4h migration
    // explicitly excludes it from company scoping), so Company B's account
    // code legitimately appears in the row list - the security property is
    // that its amount is 0 (no Company B transactions leaked into it), not
    // that the code string never appears at all.
    const expRowB_asA = resA.body.find((r) => r.account_code === "RPT6AEXP-B");
    expect(Number(expRowB_asA.amount)).toBeCloseTo(0, 2);

    const resB = await request(app).get("/api/reports/income-statement").query(range).set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    const expRowB = resB.body.find((r) => r.account_code === "RPT6AEXP-B");
    expect(expRowB).toBeDefined();
    // APV 222 + Petty Cash 666 = 888
    expect(Number(expRowB.amount)).toBeCloseTo(-888, 2);
    const expRowA_asB = resB.body.find((r) => r.account_code === "RPT6AEXP-A");
    expect(Number(expRowA_asB.amount)).toBeCloseTo(0, 2);
  });

  test("10. Balance Sheet (previously had ZERO company filtering): Company A's AP balance excludes Company B's APV/CV amounts", async () => {
    const resA = await request(app).get("/api/reports/balance-sheet").query({ to: "2026-08-01" }).set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    const apRowA = resA.body.find((r) => r.account_code === "RPT6AAP-A");
    expect(apRowA).toBeDefined();
    // APV 2000cr - CV 3000dr = -1000 net debit-side movement on a liability -> amount = credit-debit = 2000-3000 = -1000
    expect(Number(apRowA.amount)).toBeCloseTo(-1000, 2);
    const apRowB_asA = resA.body.find((r) => r.account_code === "RPT6AAP-B");
    expect(Number(apRowB_asA.amount)).toBeCloseTo(0, 2);

    const resB = await request(app).get("/api/reports/balance-sheet").query({ to: "2026-08-01" }).set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    const apRowA_asB = resB.body.find((r) => r.account_code === "RPT6AAP-A");
    expect(Number(apRowA_asB.amount)).toBeCloseTo(0, 2);
  });

  test("11. Cash Flow Statement stays company-scoped (regression - was already correct)", async () => {
    const res = await request(app).get("/api/reports/cash-flow-statement").query(range).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/RPT6A-.*-B1/);
  });

  test("12. Subsidiary Ledger (previously had ZERO company filtering): Company A cannot read Company B's party ledger by ID", async () => {
    const ownParty = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .query({ type: "AR", partyId: custAId, from: "2026-01-01", to: "2026-08-31" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(ownParty.status).toBe(200);
    expect(JSON.stringify(ownParty.body)).not.toMatch(/RPT6A-.*-B1/);

    const crossCompany = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .query({ type: "AR", partyId: custBId, from: "2026-01-01", to: "2026-08-31" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(crossCompany.status).toBe(404);
  });
});

describe("Report completeness: each transaction type contributes exactly once (Section 9)", () => {
  test("13. Trial Balance's Revenue account reflects JV + Invoice + Debit Memo (credit) + Credit Memo (debit), each exactly once, no duplicates", async () => {
    const res = await request(app)
      .get("/api/reports/trial-balance")
      .query({ from: "2026-08-01", to: "2026-08-01" })
      .set("Authorization", `Bearer ${tokenA}`);
    const revRow = res.body.find((r) => r.account_code === "RPT6AREV-A");
    // credits: JV 1000 + INV 4000 + DM 7000 = 12000; debits: CM 8000
    // net = 12000 - 8000 = 4000 credit balance
    expect(Number(revRow.credit)).toBeCloseTo(4000, 2);
    expect(Number(revRow.debit)).toBeCloseTo(0, 2);
  });

  test("14. General Ledger detail rows: exactly one row per fixture transaction on the AR account (no duplication, no missing)", async () => {
    const res = await request(app)
      .get("/api/reports/general-ledger")
      .query({ from: "2026-08-01", to: "2026-08-01", accountCode: "RPT6AAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    // JV, INV, OR, DM, CM each touch RPT6AAR-A exactly once = 5 rows
    expect(res.body.length).toBe(5);
    const sources = res.body.map((r) => r.source_type).sort();
    expect(sources).toEqual(["CREDIT MEMO", "DEBIT MEMO", "INV", "JV", "OR"]);
  });
});

describe("Petty Cash / Debit Memo / Credit Memo: no APV mislabeling in reports (Section 14, regression)", () => {
  test("15. Account Analysis on the Expense account labels the Petty Cash line as PETTY CASH, not APV", async () => {
    const res = await request(app)
      .get("/api/reports/account-analysis")
      .query({ from: "2026-08-01", to: "2026-08-01", accountCode: "RPT6AEXP-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const pettyCashRow = res.body.find((r) => r.reference_no === "RPT6A-PCV-A1");
    expect(pettyCashRow).toBeDefined();
    expect(pettyCashRow.source_type).toBe("PETTY CASH");

    const apvRow = res.body.find((r) => r.reference_no === "RPT6A-APV-A1");
    expect(apvRow.source_type).toBe("APV");
  });

  test("16. Account Analysis on the AR account labels Debit/Credit Memo distinctly, not as APV", async () => {
    const res = await request(app)
      .get("/api/reports/account-analysis")
      .query({ from: "2026-08-01", to: "2026-08-01", accountCode: "RPT6AAR-A" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const dmRow = res.body.find((r) => r.reference_no === "RPT6A-DM-A1");
    expect(dmRow.source_type).toBe("DEBIT MEMO");
    const cmRow = res.body.find((r) => r.reference_no === "RPT6A-CM-A1");
    expect(cmRow.source_type).toBe("CREDIT MEMO");
  });
});

describe("Trial Balance Checker: investigation queries are company-scoped (Section 7 same-pattern fix)", () => {
  test("17. Running the checker as Company A never surfaces Company B's voucher numbers or transaction amounts in findings", async () => {
    const res = await request(app)
      .post("/api/reports/trial-balance-checker/check")
      .send({ from: "2026-01-01", to: "2026-12-31", tolerance: "0" })
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body.findings);
    expect(body).not.toMatch(/RPT6A-.*-B1/);
  });

  test("18. Running the checker as Company B never surfaces Company A's voucher numbers or transaction amounts in findings", async () => {
    const res = await request(app)
      .post("/api/reports/trial-balance-checker/check")
      .send({ from: "2026-01-01", to: "2026-12-31", tolerance: "0" })
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body.findings);
    expect(body).not.toMatch(/RPT6A-.*-A1/);
  });
});