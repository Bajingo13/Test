const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const FxAccountService = require("../services/fxAccountService");

// Checkpoint 4I: permanent HTTP-level regression coverage for company
// isolation. Every assertion below goes through the real Express app via
// Supertest (no bypassing authorization) - real bcrypt-hashed users, real
// POST /api/login, real JWTs, real route/permission middleware. Company A
// and Company B fixtures are built once in beforeAll and reused across
// every describe block below to stay within the login rate limiter's
// window (20 attempts/15min) - only 3 logins happen for the whole file.

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA, tokenB, tokenSuper;
let arA, apA, gainA, lossA, ugainA, ulossA;
let arB, apB, gainB, lossB, ugainB, ulossB;
let custAId, custBId, suppAId, suppBId;
let invAId, invBId, apvAId, apvBId, orAId, cvAId, jvAId, jvBId, poAId, poBId;
let bbArAId, bbArBId, bbHeaderAId, bbHeaderBId;
let glBbAId;
let usdAId, usdBId, phpAId, phpBId;
let adminUserAId, adminUserBId, superUserId;
let templateAId;

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
  if (companyId) {
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  }
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

  companyAId = await makeCompany("TEST4I Company A");
  companyBId = await makeCompany("TEST4I Company B");
  adminUserAId = await makeLoginUser("test4i_admin_a", "Test4iPass!A1", 2, companyAId);
  adminUserBId = await makeLoginUser("test4i_admin_b", "Test4iPass!B1", 2, companyBId);
  superUserId = await makeLoginUser("test4i_super", "Test4iPass!S1", 1, null); // SUPER_ADMIN, no company membership row needed

  const phpA = await CurrencyService.createCurrency({ id: adminUserAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  phpAId = phpA.id;
  const usdA = await CurrencyService.createCurrency({ id: adminUserAId, roleCode: "ADMIN" }, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyAId,
  });
  usdAId = usdA.id;
  const phpB = await CurrencyService.createCurrency({ id: adminUserBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
  phpBId = phpB.id;
  const usdB = await CurrencyService.createCurrency({ id: adminUserBId, roleCode: "ADMIN" }, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyBId,
  });
  usdBId = usdB.id;

  arA = await makeAccount("TEST4IAR-A", "Accounts Receivable A (4I)", "ASSET");
  apA = await makeAccount("TEST4IAP-A", "Accounts Payable A (4I)", "LIABILITY");
  gainA = await makeAccount("TEST4IRGAIN-A", "Realized FX Gain A (4I)", "INCOME");
  lossA = await makeAccount("TEST4IRLOSS-A", "Realized FX Loss A (4I)", "EXPENSE");
  ugainA = await makeAccount("TEST4IUGAIN-A", "Unrealized FX Gain A (4I)", "INCOME");
  ulossA = await makeAccount("TEST4IULOSS-A", "Unrealized FX Loss A (4I)", "EXPENSE");

  arB = await makeAccount("TEST4IAR-B", "Accounts Receivable B (4I)", "ASSET");
  apB = await makeAccount("TEST4IAP-B", "Accounts Payable B (4I)", "LIABILITY");
  gainB = await makeAccount("TEST4IRGAIN-B", "Realized FX Gain B (4I)", "INCOME");
  lossB = await makeAccount("TEST4IRLOSS-B", "Realized FX Loss B (4I)", "EXPENSE");
  ugainB = await makeAccount("TEST4IUGAIN-B", "Unrealized FX Gain B (4I)", "INCOME");
  ulossB = await makeAccount("TEST4IULOSS-B", "Unrealized FX Loss B (4I)", "EXPENSE");

  await FxAccountService.upsertFxAccounts({ id: adminUserAId, roleCode: "ADMIN" }, companyAId, {
    gainAccountId: gainA, lossAccountId: lossA, unrealizedGainAccountId: ugainA, unrealizedLossAccountId: ulossA,
  });
  await FxAccountService.upsertFxAccounts({ id: adminUserBId, roleCode: "ADMIN" }, companyBId, {
    gainAccountId: gainB, lossAccountId: lossB, unrealizedGainAccountId: ugainB, unrealizedLossAccountId: ulossB,
  });

  custAId = await makeParty("TEST4I-CUSTA", "CUSTOMER", "4I Company A Customer", companyAId);
  custBId = await makeParty("TEST4I-CUSTB", "CUSTOMER", "4I Company B Customer", companyBId);
  suppAId = await makeParty("TEST4I-SUPPA", "SUPPLIER", "4I Company A Supplier", companyAId);
  suppBId = await makeParty("TEST4I-SUPPB", "SUPPLIER", "4I Company B Supplier", companyBId);

  // Invoice A/B - Company A's has a valid closing rate available, Company
  // B's deliberately never gets one (reproduces the exact FX contamination
  // regression via HTTP in the FX Revaluation describe block below).
  await CurrencyService.recordRate({ id: adminUserAId, roleCode: "ADMIN" }, usdAId, { rateMode: "MANUAL", rate: 56.0, effectiveDate: "2026-08-01" });
  const [invA] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, 'TEST4I-INV-A1', ?, '4I Company A Customer', '2026-08-01', 56000, 0, 0, 56000, 'Unpaid', 'Posted', ?)`,
    [companyAId, custAId, usdAId]
  );
  invAId = invA.insertId;
  await pool.execute(
    `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4IAR-A', 'Accounts Receivable A (4I)', 'x', 56000, 0, 1000, 0)`,
    [invAId, arA]
  );
  await pool.execute(
    `INSERT INTO transaction_currency_snapshots (company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code, exchange_rate, rate_date, rate_source, rate_locked, foreign_total, base_total)
     VALUES (?, 'INV', ?, ?, 'USD', ?, 'PHP', 56.0, '2026-08-01', 'MANUAL', 1, 1000, 56000)`,
    [companyAId, invAId, usdAId, phpAId]
  );
  await CurrencyService.recordRate({ id: adminUserAId, roleCode: "ADMIN" }, usdAId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-08-31" });

  const [invB] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, 'TEST4I-INV-B1', ?, '4I Company B Customer', '2026-08-01', 116000, 0, 0, 116000, 'Unpaid', 'Posted', ?)`,
    [companyBId, custBId, usdBId]
  );
  invBId = invB.insertId;
  await pool.execute(
    `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4IAR-B', 'Accounts Receivable B (4I)', 'x', 116000, 0, 2000, 0)`,
    [invBId, arB]
  );
  await pool.execute(
    `INSERT INTO transaction_currency_snapshots (company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code, exchange_rate, rate_date, rate_source, rate_locked, foreign_total, base_total)
     VALUES (?, 'INV', ?, ?, 'USD', ?, 'PHP', 58.0, '2026-08-01', 'MANUAL', 1, 2000, 116000)`,
    [companyBId, invBId, usdBId, phpBId]
  );
  // No closing rate ever recorded for usdB.

  const [apvA] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'TEST4I-APV-A1', ?, '4I Company A Supplier', '2026-08-01', 0, 5000, 0, 5000, 'Unpaid', 'Posted')`,
    [companyAId, suppAId]
  );
  apvAId = apvA.insertId;
  await pool.execute(
    `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAP-A', 'AP', 'x', 0, 5000)`,
    [apvAId, apA]
  );
  const [apvB] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'TEST4I-APV-B1', ?, '4I Company B Supplier', '2026-08-01', 0, 6000, 0, 6000, 'Unpaid', 'Posted')`,
    [companyBId, suppBId]
  );
  apvBId = apvB.insertId;
  await pool.execute(
    `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAP-B', 'AP', 'x', 0, 6000)`,
    [apvBId, apB]
  );

  const [orA] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-OR-A1', ?, '4I Company A Customer', '2026-08-05', 0, 0, 'Draft')`,
    [companyAId, custAId]
  );
  orAId = orA.insertId;

  const [cvA] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-CV-A1', ?, '4I Company A Supplier', '2026-08-05', 0, 0, 'Draft')`,
    [companyAId, suppAId]
  );
  cvAId = cvA.insertId;

  // Checkpoint 6B: Posted, not Draft - reports now only recognize Posted
  // transactions, and test 28 below specifically asserts this JV appears in
  // Account Analysis, which would no longer be true for a Draft.
  const [jvA] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-JV-A1', '2026-08-10', 'x', 300, 300, 'Posted')`,
    [companyAId]
  );
  jvAId = jvA.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAR-A', 'AR', 'x', 300, 0)`, [jvAId, arA]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAP-A', 'AP', 'x', 0, 300)`, [jvAId, apA]);

  const [jvB] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-JV-B1', '2026-08-10', 'x', 400, 400, 'Draft')`,
    [companyBId]
  );
  jvBId = jvB.insertId;
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAR-B', 'AR', 'x', 400, 0)`, [jvBId, arB]);
  await pool.execute(`INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST4IAP-B', 'AP', 'x', 0, 400)`, [jvBId, apB]);

  const [poA] = await pool.execute(
    `INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-PO-A1', ?, '4I Company A Supplier', '2026-08-10', 0, 700, 'Open')`,
    [companyAId, suppAId]
  );
  poAId = poA.insertId;
  const [poB] = await pool.execute(
    `INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, 'TEST4I-PO-B1', ?, '4I Company B Supplier', '2026-08-10', 0, 800, 'Open')`,
    [companyBId, suppBId]
  );
  poBId = poB.insertId;

  const [bbHeaderA] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, 'AR', '2026-01-01', 'PHP', 'PHILIPPINE PESO', 'TEST4I', 'Posted')`,
    [companyAId]
  );
  bbHeaderAId = bbHeaderA.insertId;
  const [bbLineA] = await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, account_id, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, '4I Company A Customer', 'TEST4IAR-A', 'AR', ?, 'TEST4I-BB-A1', '2026-01-31', 900, 0, 900, 0, 'Unpaid')`,
    [bbHeaderAId, custAId, arA]
  );
  bbArAId = bbLineA.insertId;

  const [bbHeaderB] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, 'AR', '2026-01-01', 'PHP', 'PHILIPPINE PESO', 'TEST4I', 'Posted')`,
    [companyBId]
  );
  bbHeaderBId = bbHeaderB.insertId;
  const [bbLineB] = await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, account_id, reference_no, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, '4I Company B Customer', 'TEST4IAR-B', 'AR', ?, 'TEST4I-BB-B1', '2026-01-31', 1100, 0, 1100, 0, 'Unpaid')`,
    [bbHeaderBId, custBId, arB]
  );
  bbArBId = bbLineB.insertId;

  const [glBbA] = await pool.execute(
    `INSERT INTO gl_beginning_balance_headers (company_id, filter_code, balance_date, currency_code, currency_name, title, status)
     VALUES (?, 'NON', '2026-01-01', 'PHP', 'PHILIPPINE PESO', 'TEST4I GL BB', 'Posted')`,
    [companyAId]
  );
  glBbAId = glBbA.insertId;

  tokenA = await loginAs("test4i_admin_a", "Test4iPass!A1");
  tokenB = await loginAs("test4i_admin_b", "Test4iPass!B1");
  tokenSuper = await loginAs("test4i_super", "Test4iPass!S1");
});

afterAll(async () => {
  // FK-safe order: children before parents, per the same convention this
  // whole session has used - now doubly enforced by the Phase E RESTRICT
  // constraints (a stray order mistake here would fail loudly, not
  // silently corrupt).
  await pool.query("DELETE FROM recurring_transaction_occurrences WHERE schedule_id IN (SELECT id FROM recurring_transaction_schedules WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id IN (?,?)))", [companyAId, companyBId]);
  await pool.query("DELETE FROM recurring_transaction_schedules WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id IN (?,?))", [companyAId, companyBId]);
  await pool.query("DELETE FROM recurring_transaction_template_lines WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id IN (?,?))", [companyAId, companyBId]);
  await pool.query("DELETE FROM recurring_transaction_templates WHERE company_id IN (?,?)", [companyAId, companyBId]);

  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE source_reference_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id IN (?,?)))", [companyAId, companyBId]);
  await pool.query("DELETE FROM fx_revaluation_items WHERE session_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id IN (?,?))", [companyAId, companyBId]);
  const [fxSessions] = await pool.query("SELECT id, jv_id, reversal_jv_id FROM fx_revaluation_sessions WHERE company_id IN (?,?)", [companyAId, companyBId]);
  const fxJvIds = fxSessions.flatMap((s) => [s.jv_id, s.reversal_jv_id]).filter(Boolean);
  await pool.query("DELETE FROM fx_revaluation_sessions WHERE company_id IN (?,?)", [companyAId, companyBId]);
  if (fxJvIds.length) await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [fxJvIds]);
  if (fxJvIds.length) await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [fxJvIds]);
  await pool.query("DELETE FROM company_fx_accounts WHERE company_id IN (?,?)", [companyAId, companyBId]);

  await pool.query("DELETE FROM transaction_applications WHERE (source_type='INV' AND source_id IN (?,?)) OR (source_type='APV' AND source_id IN (?,?)) OR (source_type IN ('AR_BEGINNING','AP_BEGINNING') AND source_id IN (?,?))", [invAId, invBId, apvAId, apvBId, bbArAId, bbArBId]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE (transaction_type='INV' AND transaction_id IN (?,?))", [invAId, invBId]);

  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?,?)", [invAId, invBId]);
  await pool.query("DELETE FROM invoice_headers WHERE id IN (?,?)", [invAId, invBId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?,?)", [apvAId, apvBId]);
  await pool.query("DELETE FROM apv_headers WHERE id IN (?,?)", [apvAId, apvBId]);
  await pool.query("DELETE FROM or_lines WHERE or_id IN (?)", [orAId]);
  await pool.query("DELETE FROM or_headers WHERE id IN (?)", [orAId]);
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (?)", [cvAId]);
  await pool.query("DELETE FROM cv_headers WHERE id IN (?)", [cvAId]);
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?,?)", [jvAId, jvBId]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?,?)", [jvAId, jvBId]);
  await pool.query("DELETE FROM purchase_order_lines WHERE po_id IN (?,?)", [poAId, poBId]);
  await pool.query("DELETE FROM purchase_order_headers WHERE id IN (?,?)", [poAId, poBId]);
  await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id IN (?,?)", [bbArAId, bbArBId]);
  await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id IN (?,?)", [bbHeaderAId, bbHeaderBId]);
  await pool.query("DELETE FROM gl_beginning_balance_headers WHERE id IN (?)", [glBbAId]);

  await pool.query("DELETE FROM general_libraries WHERE id IN (?,?,?,?)", [custAId, custBId, suppAId, suppBId]);
  // Catch-all: any snapshot row still referencing these companies' currencies
  // (as either currency_id or base_currency_id) must go before the
  // currencies themselves, or the Phase E FK (fk_snapshot_base_currency)
  // rejects the delete.
  await pool.query(
    "DELETE FROM transaction_currency_snapshots WHERE base_currency_id IN (SELECT id FROM currencies WHERE company_id IN (?,?)) OR currency_id IN (SELECT id FROM currencies WHERE company_id IN (?,?))",
    [companyAId, companyBId, companyAId, companyBId]
  );
  await pool.query("DELETE FROM currency_rates WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM currencies WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST4I%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?,?)", [adminUserAId, adminUserBId]);
  await pool.query("DELETE FROM users WHERE id IN (?,?,?)", [adminUserAId, adminUserBId, superUserId]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);

  await pool.end();
});

describe("Invoice route isolation", () => {
  test("16. Admin A can access Invoice A, not Invoice B; cannot mutate or delete Invoice B", async () => {
    const getA = await request(app).get(`/api/invoices/${invAId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(getA.status).toBe(200);
    expect(getA.body.voucherNo).toBe("TEST4I-INV-A1");

    const getB = await request(app).get(`/api/invoices/${invBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(getB.status);
    expect(JSON.stringify(getB.body)).not.toMatch(/TEST4I-INV-B1|4I Company B Customer/);

    const putB = await request(app).put(`/api/invoices/${invBId}`).set("Authorization", `Bearer ${tokenA}`).send({ voucherNo: "HACKED", totalDebit: 1 });
    expect([403, 404]).toContain(putB.status);

    const delB = await request(app).delete(`/api/invoices/${invBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(delB.status);

    const listA = await request(app).get("/api/invoices").set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body.some((r) => r.voucherNo === "TEST4I-INV-A1")).toBe(true);
    expect(listA.body.some((r) => r.voucherNo === "TEST4I-INV-B1")).toBe(false);

    // Confirm Invoice B genuinely untouched.
    const [[stillB]] = await pool.query("SELECT voucher_no, total_debit FROM invoice_headers WHERE id = ?", [invBId]);
    expect(stillB.voucher_no).toBe("TEST4I-INV-B1");
    expect(Number(stillB.total_debit)).toBe(116000);
  });
});

describe("APV route isolation", () => {
  test("17. Admin A cannot access/mutate/delete Company B's APV", async () => {
    const getB = await request(app).get(`/api/apv/${apvBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(getB.status);
    const putB = await request(app).put(`/api/apv/${apvBId}`).set("Authorization", `Bearer ${tokenA}`).send({ voucherNo: "HACKED" });
    expect([403, 404]).toContain(putB.status);
    const delB = await request(app).delete(`/api/apv/${apvBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(delB.status);
    const getA = await request(app).get(`/api/apv/${apvAId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(getA.status).toBe(200);
  });
});

describe("OR/CV route isolation and cross-company payment application", () => {
  test("18. Admin A cannot access Company B via OR; OR cannot apply to Company B invoice", async () => {
    const getA = await request(app).get(`/api/or/${orAId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(getA.status).toBe(200);

    const applyRes = await request(app)
      .put(`/api/or/${orAId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        voucherNo: "TEST4I-OR-A1", customerId: custAId, customerName: "4I Company A Customer",
        transactionDate: "2026-08-05", totalDebit: 100, totalCredit: 100, status: "Draft",
        lines: [{ accountId: arA, accountCode: "TEST4IAR-A", accountTitle: "AR", particulars: "x", debit: 0, credit: 100 }],
        invoiceApplications: [{ sourceType: "INV", sourceId: invBId, amount: 100 }],
      });
    // Either the route rejects outright, or the service-layer cross-company
    // check throws inside the transaction - either way, no application row
    // may exist for Company B's invoice via a Company A OR afterward.
    const [[appCount]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='INV' AND source_id = ? AND applied_type='OR' AND applied_id = ?",
      [invBId, orAId]
    );
    expect(appCount.c).toBe(0);
    void applyRes;
  });

  test("19. Admin A cannot access Company B via CV; CV cannot apply to Company B APV", async () => {
    const getA = await request(app).get(`/api/cv/${cvAId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(getA.status).toBe(200);

    await request(app)
      .put(`/api/cv/${cvAId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        voucherNo: "TEST4I-CV-A1", payeeId: suppAId, payeeName: "4I Company A Supplier",
        transactionDate: "2026-08-05", totalDebit: 100, totalCredit: 100, status: "Draft",
        lines: [{ accountId: apA, accountCode: "TEST4IAP-A", accountTitle: "AP", particulars: "x", debit: 100, credit: 0 }],
        apvApplications: [{ sourceType: "APV", sourceId: apvBId, amount: 100 }],
      });
    const [[appCount]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='APV' AND source_id = ? AND applied_type='CV' AND applied_id = ?",
      [apvBId, cvAId]
    );
    expect(appCount.c).toBe(0);
  });
});

describe("JV / PO route isolation", () => {
  test("20. Admin A cannot view/edit/post/delete Company B's JV", async () => {
    const getB = await request(app).get(`/api/jv/${jvBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(getB.status);
    const putB = await request(app).put(`/api/jv/${jvBId}`).set("Authorization", `Bearer ${tokenA}`).send({ voucherNo: "HACKED", status: "Posted" });
    expect([403, 404]).toContain(putB.status);
    const delB = await request(app).delete(`/api/jv/${jvBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(delB.status);
    const [[stillB]] = await pool.query("SELECT status FROM jv_headers WHERE id = ?", [jvBId]);
    expect(stillB.status).toBe("Draft");
  });

  test("21. Admin A cannot view/edit/delete Company B's PO", async () => {
    const getB = await request(app).get(`/api/purchase-orders/${poBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(getB.status);
    const putB = await request(app).put(`/api/purchase-orders/${poBId}`).set("Authorization", `Bearer ${tokenA}`).send({ voucherNo: "HACKED" });
    expect([403, 404]).toContain(putB.status);
    const delB = await request(app).delete(`/api/purchase-orders/${poBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(delB.status);
    const [[stillB]] = await pool.query("SELECT voucher_no FROM purchase_order_headers WHERE id = ?", [poBId]);
    expect(stillB.voucher_no).toBe("TEST4I-PO-B1");
  });
});

describe("Beginning Balance isolation", () => {
  test("22. Admin A cannot view/update/delete Company B's AR Beginning Balance", async () => {
    const listA = await request(app).get("/api/arap-beginning-balances/AR").set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body.some((r) => r.id === bbArAId)).toBe(true);
    expect(listA.body.some((r) => r.id === bbArBId)).toBe(false);

    const putB = await request(app)
      .put("/api/arap-beginning-balances")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ line: { id: bbArBId, partyName: "HACKED", debit: 1, credit: 0, balanceAmount: 1 } });
    expect([403, 404]).toContain(putB.status);

    const delB = await request(app).delete(`/api/arap-beginning-balances/${bbArBId}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(delB.status);

    const [[stillB]] = await pool.query("SELECT party_name, debit FROM arap_beginning_balance_lines WHERE id = ?", [bbArBId]);
    expect(stillB.party_name).toBe("4I Company B Customer");
    expect(Number(stillB.debit)).toBe(1100);
  });

  test("GL Beginning Balance list is company-scoped", async () => {
    const listA = await request(app).get("/api/gl-beginning-balances").set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body.some((h) => h.id === glBbAId)).toBe(true);
    const listB = await request(app).get("/api/gl-beginning-balances").set("Authorization", `Bearer ${tokenB}`);
    expect(listB.body.some((h) => h.id === glBbAId)).toBe(false);
  });
});

describe("General Libraries isolation", () => {
  test("23. Admin A cannot retrieve Company B's customer/supplier via the API", async () => {
    const listA = await request(app).get("/api/genlib").set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body.some((r) => r.code === "TEST4I-CUSTA")).toBe(true);
    expect(listA.body.some((r) => r.code === "TEST4I-CUSTB")).toBe(false);
    expect(listA.body.some((r) => r.code === "TEST4I-SUPPB")).toBe(false);
  });
});

describe("AR/AP Aging HTTP isolation", () => {
  test("24. Company A AR Aging contains only Company A rows", async () => {
    const res = await request(app).get("/api/reports/ar-aging?asOf=2026-08-31").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).toMatch(/TEST4I-INV-A1/);
    expect(bodyStr).not.toMatch(/TEST4I-INV-B1|4I Company B Customer/);
  });

  test("25. Company A AP Aging contains only Company A rows", async () => {
    const res = await request(app).get("/api/reports/ap-aging?asOf=2026-08-31").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).toMatch(/TEST4I-APV-A1/);
    expect(bodyStr).not.toMatch(/TEST4I-APV-B1|4I Company B Supplier/);
  });
});

describe("Trial Balance / General Ledger HTTP isolation", () => {
  test("26. Company A Trial Balance contains only Company A accounts", async () => {
    const res = await request(app).get("/api/reports/trial-balance?from=2026-08-01&to=2026-08-31").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.account_code === "TEST4IAR-A")).toBe(true);
    expect(res.body.some((r) => r.account_code === "TEST4IAR-B")).toBe(false);
  });

  test("27. Company A General Ledger contains only Company A activity", async () => {
    const res = await request(app).get("/api/reports/general-ledger?from=2026-08-01&to=2026-08-31").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.account_code === "TEST4IAR-A")).toBe(true);
    expect(res.body.some((r) => r.account_code === "TEST4IAR-B")).toBe(false);
  });
});

describe("Account Analysis HTTP isolation", () => {
  test("28. Company A Account Analysis includes Company A's JV, not Company B's", async () => {
    const res = await request(app)
      .get(`/api/reports/account-analysis?from=2026-08-01&to=2026-08-31&accountCode=TEST4IAR-A`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.source_type === "JV" && Number(r.debit) === 300)).toBe(true);

    const resB = await request(app)
      .get(`/api/reports/account-analysis?from=2026-08-01&to=2026-08-31&accountCode=TEST4IAR-B`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resB.body.length).toBe(0);
  });
});

describe("CRITICAL: FX Revaluation HTTP isolation (regression reproduction)", () => {
  let sessionAId;

  test("29. Company A calculates CALCULATED despite Company B's rate-less exposure; Company B gets RATE_REQUIRED", async () => {
    const calcA = await request(app)
      .post("/api/fx-revaluation/calculate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ revaluationDate: "2026-08-31" });
    expect(calcA.status).toBe(200);
    expect(calcA.body.session.status).toBe("CALCULATED");
    sessionAId = calcA.body.session.id;

    const calcB = await request(app)
      .post("/api/fx-revaluation/calculate")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ revaluationDate: "2026-08-31" });
    expect(calcB.status).toBe(200);
    expect(calcB.body.session.status).toBe("RATE_REQUIRED");
  });

  test("Company B cannot view or post Company A's session", async () => {
    const getB = await request(app).get(`/api/fx-revaluation/${sessionAId}`).set("Authorization", `Bearer ${tokenB}`);
    expect(getB.status).toBe(404);
    const postB = await request(app).post(`/api/fx-revaluation/${sessionAId}/post`).set("Authorization", `Bearer ${tokenB}`).send({});
    expect(postB.status).toBe(404);
  });

  test("Company A can post its own session; generated JV.company_id = Company A", async () => {
    const postA = await request(app).post(`/api/fx-revaluation/${sessionAId}/post`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(postA.status).toBe(200);
    expect(postA.body.status).toBe("POSTED");
    const [[jvRow]] = await pool.query("SELECT company_id FROM jv_headers WHERE id = ?", [postA.body.jvId]);
    expect(jvRow.company_id).toBe(companyAId);
  });
});

describe("Recurring Transactions HTTP isolation", () => {
  test("30. A template created for Company A is invisible/inaccessible to Admin B across every action", async () => {
    const createRes = await request(app)
      .post("/api/recurring-transactions")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        moduleType: "invoice", templateName: `TEST4I Recurring ${Date.now()}`,
        partyId: custAId, partyName: "4I Company A Customer", descriptionTemplate: "x",
        currency: "PHP", currencyId: null, amountMode: "FIXED", amountConfig: {},
        dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
        lines: [
          { accountId: arA, accountCode: "TEST4IAR-A", accountTitle: "AR", particularsTemplate: "x", debit: 50, credit: 0 },
          { accountId: arA, accountCode: "TEST4IAR-A", accountTitle: "AR", particularsTemplate: "x", debit: 0, credit: 50 },
        ],
        schedule: { frequency: "MONTHLY", startDate: "2026-09-01", dateAdjustmentRule: "KEEP_ORIGINAL" },
      });
    expect(createRes.status).toBe(201);
    templateAId = createRes.body.templateId;

    const listB = await request(app).get("/api/recurring-transactions").set("Authorization", `Bearer ${tokenB}`);
    expect(listB.body.some((t) => t.id === templateAId)).toBe(false);

    const getB = await request(app).get(`/api/recurring-transactions/${templateAId}`).set("Authorization", `Bearer ${tokenB}`);
    expect(getB.status).toBe(404);
    const pauseB = await request(app).post(`/api/recurring-transactions/${templateAId}/pause`).set("Authorization", `Bearer ${tokenB}`).send({});
    expect(pauseB.status).toBe(404);
    const generateB = await request(app).post(`/api/recurring-transactions/${templateAId}/generate`).set("Authorization", `Bearer ${tokenB}`).send({});
    expect(generateB.status).toBe(404);
    const historyB = await request(app).get(`/api/recurring-transactions/${templateAId}/history`).set("Authorization", `Bearer ${tokenB}`);
    expect(historyB.status).toBe(404);
    const previewB = await request(app).get(`/api/recurring-transactions/${templateAId}/preview`).set("Authorization", `Bearer ${tokenB}`);
    expect(previewB.status).toBe(404);
  });

  test("36. Generating Company A's occurrence stamps company_id = Company A", async () => {
    const genRes = await request(app).post(`/api/recurring-transactions/${templateAId}/generate`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(genRes.status).toBe(200);
    expect(genRes.body.status).toBe("SUCCESS");
    const [[genInv]] = await pool.query("SELECT company_id FROM invoice_headers WHERE id = ?", [genRes.body.generatedId]);
    expect(genInv.company_id).toBe(companyAId);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id = ?", [genRes.body.generatedId]);
    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [genRes.body.generatedId]);
  });
});

describe("Print/export HTTP isolation", () => {
  test("31. Admin B cannot print/export Company A's invoice by direct ID", async () => {
    const res = await request(app).get(`/api/print/invoice/${invAId}`).set("Authorization", `Bearer ${tokenB}`);
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/TEST4I-INV-A1|4I Company A Customer|56000/);
  });
});

describe("Bulk posting HTTP isolation", () => {
  test("34. Admin A bulk-posting only posts Company A's own eligible drafts", async () => {
    const [[beforeB]] = await pool.query("SELECT status FROM jv_headers WHERE id = ?", [jvBId]);
    expect(beforeB.status).toBe("Draft");

    await request(app).post("/api/posting/post").set("Authorization", `Bearer ${tokenA}`).send({ scope: "all" });

    const [[afterB]] = await pool.query("SELECT status FROM jv_headers WHERE id = ?", [jvBId]);
    expect(afterB.status).toBe("Draft"); // untouched by Company A's bulk post
  });
});

describe("Company parameter tampering", () => {
  test("33. Admin A supplying companyId=B in query/body is rejected or normalized, never trusted", async () => {
    const res = await request(app)
      .get(`/api/invoices/${invBId}`)
      .query({ companyId: companyBId })
      .set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(res.status);

    const listRes = await request(app)
      .get("/api/invoices")
      .query({ companyId: companyBId })
      .set("Authorization", `Bearer ${tokenA}`);
    // Even asking for Company B explicitly, a non-super-admin must either be
    // rejected outright (403/404) or silently normalized back to their own
    // company - either way Company B's data must never appear in the body.
    if (Array.isArray(listRes.body)) {
      expect(listRes.body.some((r) => r.voucherNo === "TEST4I-INV-B1")).toBe(false);
    } else {
      expect([403, 404]).toContain(listRes.status);
    }
  });
});

describe("Super Admin explicit-company behavior", () => {
  test("32. Super Admin with explicit companyId=A sees only Company A; companyId=B sees only Company B", async () => {
    const resA = await request(app).get("/api/invoices").query({ companyId: companyAId }).set("Authorization", `Bearer ${tokenSuper}`);
    expect(resA.body.some((r) => r.voucherNo === "TEST4I-INV-A1")).toBe(true);
    expect(resA.body.some((r) => r.voucherNo === "TEST4I-INV-B1")).toBe(false);

    const resB = await request(app).get("/api/invoices").query({ companyId: companyBId }).set("Authorization", `Bearer ${tokenSuper}`);
    expect(resB.body.some((r) => r.voucherNo === "TEST4I-INV-B1")).toBe(true);
    expect(resB.body.some((r) => r.voucherNo === "TEST4I-INV-A1")).toBe(false);
  });
});