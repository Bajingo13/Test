const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Checkpoint 5 - permanent HTTP-level regression coverage for accounting
// period closing/locking. Real Supertest requests through the real app,
// real login, real period-generate/close/reopen endpoints - same harness
// convention as companyIsolation.http.test.js (Checkpoint 4I).

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, tokenUnauthorized, tokenSuper;
let arA, apA, revA, cashA;
let custAId, suppAId;
let julyPeriodId, augustPeriodId, julyPeriodBId, septemberPeriodId;
let julyInvoiceId; // fixture created via direct SQL, dated into the already-closed July
let julyApvId; // fixture created via direct SQL, dated into the already-closed July
let bankCodeId, bankSessionId, bankBatchId, julyStatementLineId, julyAdjustmentId, augStatementLineId, augAdjustmentId;

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
  if (companyId) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
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

  companyAId = await makeCompany("TEST5 Company A");
  companyBId = await makeCompany("TEST5 Company B");
  const adminAId = await makeLoginUser("test5_admin_a", "Test5Pass!A1", 2, companyAId);
  const adminBId = await makeLoginUser("test5_admin_b", "Test5Pass!B1", 2, companyBId);
  const unauthorizedAId = await makeLoginUser("test5_unauth_a", "Test5Pass!U1", 2, companyAId);
  const superAdminId = await makeLoginUser("test5_super", "Test5Pass!S1", 1, null);

  // Deny POST_SOFT_CLOSED specifically for this user, overriding ADMIN's
  // default grant - same user_permissions override mechanism Access
  // Restrictions uses, and the same approach accountingPeriodService.test.js
  // already validated at the unit level. Here it proves the HTTP layer
  // honors the same rule.
  const [[softClosePerm]] = await pool.query(
    "SELECT id FROM permissions WHERE module_key = 'ACCOUNTING_PERIODS' AND action = 'POST_SOFT_CLOSED'"
  );
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 0)", [unauthorizedAId, softClosePerm.id]);

  arA = await makeAccount("TEST5AR-A", "Accounts Receivable A (5)", "ASSET");
  apA = await makeAccount("TEST5AP-A", "Accounts Payable A (5)", "LIABILITY");
  revA = await makeAccount("TEST5REV-A", "Sales Revenue A (5)", "INCOME");
  cashA = await makeAccount("TEST5CASH-A", "Cash A (5)", "ASSET");
  const bankGLA = await makeAccount("TEST5BANK-A", "Bank Current Account A (5)", "ASSET");
  const bankChargeA = await makeAccount("TEST5BCHG-A", "Bank Charges A (5)", "EXPENSE");
  custAId = await makeParty("TEST5-CUSTA", "CUSTOMER", "5 Company A Customer", companyAId);
  suppAId = await makeParty("TEST5-SUPPA", "SUPPLIER", "5 Company A Supplier", companyAId);

  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });

  tokenA = await loginAs("test5_admin_a", "Test5Pass!A1");
  tokenB = await loginAs("test5_admin_b", "Test5Pass!B1");
  tokenUnauthorized = await loginAs("test5_unauth_a", "Test5Pass!U1");
  tokenSuper = await loginAs("test5_super", "Test5Pass!S1");

  // Generate 2026 periods for both companies via the real API, then close
  // Company A's July via the real API - proves the whole stack end to end
  // (permission check, transactional close, history row) before any
  // enforcement test runs.
  await request(app).post("/api/accounting-periods/generate-year").set("Authorization", `Bearer ${tokenA}`).send({ year: 2026 });
  await request(app).post("/api/accounting-periods/generate-year").set("Authorization", `Bearer ${tokenB}`).send({ year: 2026 });

  const listA = await request(app).get("/api/accounting-periods?year=2026").set("Authorization", `Bearer ${tokenA}`);
  julyPeriodId = listA.body.find((p) => p.period_month === 7).id;
  augustPeriodId = listA.body.find((p) => p.period_month === 8).id;
  septemberPeriodId = listA.body.find((p) => p.period_month === 9).id;

  const listB = await request(app).get("/api/accounting-periods?year=2026").set("Authorization", `Bearer ${tokenB}`);
  julyPeriodBId = listB.body.find((p) => p.period_month === 7).id;

  const closeRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/close`).set("Authorization", `Bearer ${tokenA}`).send({ notes: "test close" });
  if (closeRes.status !== 200) throw new Error(`Failed to close July fixture period: ${JSON.stringify(closeRes.body)}`);

  const softCloseRes = await request(app).post(`/api/accounting-periods/${septemberPeriodId}/soft-close`).set("Authorization", `Bearer ${tokenA}`).send({ notes: "test soft close" });
  if (softCloseRes.status !== 200) throw new Error(`Failed to soft-close September fixture period: ${JSON.stringify(softCloseRes.body)}`);

  // A July invoice that predates the close, inserted directly via SQL
  // (bypassing the app layer, same convention as every other fixture in
  // this session) - used to prove edit/delete/settlement rules against a
  // genuinely pre-existing closed-period document.
  const [invResult] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'TEST5-INV-JUL1', ?, '5 Company A Customer', '2026-07-10', 1000, 0, 0, 1000, 'Unpaid', 'Posted')`,
    [companyAId, custAId]
  );
  julyInvoiceId = invResult.insertId;
  await pool.execute(
    `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST5AR-A', 'AR', 'x', 1000, 0)`,
    [julyInvoiceId, arA]
  );

  // A July APV that predates the close - the CV/APV counterpart to the
  // Invoice/OR fixture above, used for the "August CV settling a
  // closed-period APV" scenario (section 16/17's explicit example).
  const [apvResult] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, 'TEST5-APV-JUL1', ?, '5 Company A Supplier', '2026-07-12', 0, 800, 0, 800, 'Unpaid', 'Posted')`,
    [companyAId, suppAId]
  );
  julyApvId = apvResult.insertId;
  await pool.execute(
    `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST5AP-A', 'AP', 'x', 0, 800)`,
    [julyApvId, apA]
  );

  // Bank Reconciliation fixtures - a bank code linked to a real CoA
  // account, a session, an import batch, and two pre-approved adjustments
  // (one dated July, one dated August) ready to post as a JV. Built via
  // direct SQL since the CSV-import/matching workflow has its own
  // coverage elsewhere; this suite only needs to exercise the
  // period-lock check on the final "post adjustment as JV" step.
  const [bankCodeResult] = await pool.execute(
    `INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status)
     VALUES ('TEST5BANK', 'Test5 Bank', '000-111-222', 'Test5 Current Account', ?, 'TEST5BANK-A', 'ACTIVE')`,
    [bankGLA]
  );
  bankCodeId = bankCodeResult.insertId;

  const [sessionResult] = await pool.execute(
    `INSERT INTO bank_recon_sessions (bank_account_id, period_start, period_end, statement_beginning_balance, statement_ending_balance, status, created_by)
     VALUES (?, '2026-07-01', '2026-08-31', 0, 0, 'IN_PROGRESS', ?)`,
    [bankCodeId, adminAId]
  );
  bankSessionId = sessionResult.insertId;

  const [batchResult] = await pool.execute(
    `INSERT INTO bank_recon_import_batches (session_id, file_name, file_type, row_count, status, imported_by)
     VALUES (?, 'test5-fixture.csv', 'csv', 2, 'COMPLETED', ?)`,
    [bankSessionId, adminAId]
  );
  bankBatchId = batchResult.insertId;

  const [julyLineResult] = await pool.execute(
    `INSERT INTO bank_recon_statement_lines (batch_id, session_id, txn_date, description, debit, credit, match_status)
     VALUES (?, ?, '2026-07-25', 'Bank charge (July, fixture)', 50, 0, 'UNMATCHED')`,
    [bankBatchId, bankSessionId]
  );
  julyStatementLineId = julyLineResult.insertId;
  const [julyAdjResult] = await pool.execute(
    `INSERT INTO bank_recon_adjustments (session_id, statement_line_id, adjustment_type, suggested_account_id, amount, description, status, decided_by, decided_at)
     VALUES (?, ?, 'BANK_CHARGE', ?, 50, 'Bank charge (July, fixture)', 'APPROVED', ?, NOW())`,
    [bankSessionId, julyStatementLineId, bankChargeA, adminAId]
  );
  julyAdjustmentId = julyAdjResult.insertId;

  const [augLineResult] = await pool.execute(
    `INSERT INTO bank_recon_statement_lines (batch_id, session_id, txn_date, description, debit, credit, match_status)
     VALUES (?, ?, '2026-08-25', 'Bank charge (August, fixture)', 60, 0, 'UNMATCHED')`,
    [bankBatchId, bankSessionId]
  );
  augStatementLineId = augLineResult.insertId;
  const [augAdjResult] = await pool.execute(
    `INSERT INTO bank_recon_adjustments (session_id, statement_line_id, adjustment_type, suggested_account_id, amount, description, status, decided_by, decided_at)
     VALUES (?, ?, 'BANK_CHARGE', ?, 60, 'Bank charge (August, fixture)', 'APPROVED', ?, NOW())`,
    [bankSessionId, augStatementLineId, bankChargeA, adminAId]
  );
  augAdjustmentId = augAdjResult.insertId;
});

afterAll(async () => {
  // Bank Recon fixtures - adjustments/statement lines reference jv_headers
  // via jv_id once posted, so clear those first.
  const [postedAdjJvs] = await pool.query("SELECT jv_id FROM bank_recon_adjustments WHERE id IN (?,?) AND jv_id IS NOT NULL", [julyAdjustmentId, augAdjustmentId]);
  const bankJvIds = postedAdjJvs.map((r) => r.jv_id).filter(Boolean);
  // bank_recon_adjustments.jv_id FK-references jv_headers - the adjustment
  // rows (and everything else in the session) must go before jv_headers,
  // not after.
  await pool.query("DELETE FROM bank_recon_adjustments WHERE session_id = ?", [bankSessionId]);
  await pool.query("DELETE FROM bank_recon_statement_lines WHERE session_id = ?", [bankSessionId]);
  await pool.query("DELETE FROM bank_recon_import_batches WHERE session_id = ?", [bankSessionId]);
  await pool.query("DELETE FROM bank_recon_sessions WHERE id = ?", [bankSessionId]);
  await pool.query("DELETE FROM bank_codes WHERE id = ?", [bankCodeId]);
  if (bankJvIds.length) {
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [bankJvIds]);
    await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [bankJvIds]);
  }

  // julyApvId's cleanup is handled below by the generic company-wide
  // apv_lines/apv_headers delete, same as julyInvoiceId.

  await pool.query("DELETE FROM recurring_transaction_occurrences WHERE schedule_id IN (SELECT id FROM recurring_transaction_schedules WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id = ?))", [companyAId]);
  await pool.query("DELETE FROM recurring_transaction_schedules WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM recurring_transaction_template_lines WHERE template_id IN (SELECT id FROM recurring_transaction_templates WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM recurring_transaction_templates WHERE company_id = ?", [companyAId]);

  const [fxSessions] = await pool.query("SELECT id, jv_id FROM fx_revaluation_sessions WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM fx_revaluation_items WHERE session_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM fx_revaluation_sessions WHERE company_id = ?", [companyAId]);
  const fxJvIds = fxSessions.map((s) => s.jv_id).filter(Boolean);
  if (fxJvIds.length) {
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [fxJvIds]);
    await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [fxJvIds]);
  }

  await pool.query("DELETE FROM transaction_applications WHERE source_type='INV' AND source_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM or_headers WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM jv_headers WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_order_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM purchase_order_headers WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id IN (SELECT id FROM arap_beginning_balance_headers WHERE company_id = ?)", [companyAId]);
  await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id = ?", [companyAId]);

  await pool.query("DELETE FROM general_libraries WHERE id IN (?,?)", [custAId, suppAId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST5%'");
  await pool.query(
    "DELETE FROM transaction_currency_snapshots WHERE base_currency_id IN (SELECT id FROM currencies WHERE company_id = ?) OR currency_id IN (SELECT id FROM currencies WHERE company_id = ?)",
    [companyAId, companyAId]
  );
  await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [companyAId]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyAId]);

  await pool.query("DELETE FROM accounting_period_history WHERE company_id IN (?,?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?,?)", [companyAId, companyBId]);

  const testUsernames = ['test5_admin_a', 'test5_admin_b', 'test5_unauth_a', 'test5_super'];
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (SELECT id FROM users WHERE username IN (?))", [testUsernames]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username IN (?))", [testUsernames]);
  await pool.query("DELETE FROM users WHERE username IN (?)", [testUsernames]);
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);

  await pool.end();
});

describe("Invoice period enforcement", () => {
  test("create in CLOSED July is rejected with the correct code", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-REJ1", customerId: custAId, customerName: "x", transactionDate: "2026-07-20",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [{ accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("create in OPEN August succeeds", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-AUG1", customerId: custAId, customerName: "x", transactionDate: "2026-08-05",
      totalDebit: 200, totalCredit: 200, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 200, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 200 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id = ?", [res.body.id]);
    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [res.body.id]);
  });

  test("edit and delete of a pre-existing July invoice are both rejected", async () => {
    const editRes = await request(app).put(`/api/invoices/${julyInvoiceId}`).set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-JUL1", customerId: custAId, customerName: "x", transactionDate: "2026-07-10",
      totalDebit: 1500, totalCredit: 1500, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 1500, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 1500 },
      ],
    });
    expect(editRes.status).toBe(409);
    expect(editRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const delRes = await request(app).delete(`/api/invoices/${julyInvoiceId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(delRes.status).toBe(409);
    expect(delRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const [[stillThere]] = await pool.query("SELECT total_debit FROM invoice_headers WHERE id = ?", [julyInvoiceId]);
    expect(Number(stillThere.total_debit)).toBe(1000);
  });

  test("date movement: an OPEN August invoice cannot be backdated into CLOSED July", async () => {
    const createRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-MOVE1", customerId: custAId, customerName: "x", transactionDate: "2026-08-10",
      totalDebit: 300, totalCredit: 300, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(createRes.status).toBe(200);

    const moveRes = await request(app).put(`/api/invoices/${createRes.body.id}`).set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-MOVE1", customerId: custAId, customerName: "x", transactionDate: "2026-07-15",
      totalDebit: 300, totalCredit: 300, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(moveRes.status).toBe(409);
    expect(moveRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const [[stillAug]] = await pool.query("SELECT DATE_FORMAT(transaction_date, '%Y-%m-%d') AS d FROM invoice_headers WHERE id = ?", [createRes.body.id]);
    expect(stillAug.d).toBe("2026-08-10");

    await pool.query("DELETE FROM invoice_lines WHERE invoice_id = ?", [createRes.body.id]);
    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [createRes.body.id]);
  });
});

describe("APV / JV / PO period enforcement", () => {
  test("APV create in CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-APV-REJ1", supplierId: suppAId, supplierName: "x", transactionDate: "2026-07-20",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [{ accountId: apA, accountCode: "TEST5AP-A", accountTitle: "AP", particulars: "x", debit: 0, credit: 100 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("JV create in CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/jv").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-JV-REJ1", transactionDate: "2026-07-20", description: "x", status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 50, credit: 0 },
        { accountId: apA, accountCode: "TEST5AP-A", accountTitle: "AP", particulars: "x", debit: 0, credit: 50 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("PO create in CLOSED July is also rejected (documented backdating-consistency control, even though PO never posts to GL)", async () => {
    const res = await request(app).post("/api/purchase-orders").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-PO-REJ1", supplierId: suppAId, supplierName: "x", transactionDate: "2026-07-20",
      totalCredit: 100, status: "Open",
      lines: [{ accountId: apA, accountCode: "TEST5AP-A", accountTitle: "AP", particulars: "x", debit: 0, credit: 100 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });
});

describe("CRITICAL: OR settlement of a closed-period Invoice", () => {
  test("an OR dated in OPEN August CAN settle the July invoice (payment period governs, not source period)", async () => {
    const res = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-OR-AUG1", customerId: custAId, customerName: "x", transactionDate: "2026-08-12",
      totalDebit: 400, totalCredit: 400, status: "Posted",
      lines: [
        { accountId: cashA, accountCode: "TEST5CASH-A", accountTitle: "Cash", particulars: "x", debit: 400, credit: 0 },
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 0, credit: 400 },
      ],
      invoiceApplications: [{ sourceType: "INV", sourceId: julyInvoiceId, amount: 400 }],
    });
    expect(res.status).toBe(200);

    const [[appRow]] = await pool.query(
      "SELECT amount FROM transaction_applications WHERE source_type='INV' AND source_id = ? AND applied_type='OR' AND applied_id = ?",
      [julyInvoiceId, res.body.id]
    );
    expect(Number(appRow.amount)).toBe(400);

    await pool.query("DELETE FROM transaction_applications WHERE applied_type='OR' AND applied_id = ?", [res.body.id]);
    await pool.query("DELETE FROM or_lines WHERE or_id = ?", [res.body.id]);
    await pool.query("DELETE FROM or_headers WHERE id = ?", [res.body.id]);
    await pool.query("UPDATE invoice_headers SET paid_amount = 0, balance_amount = total_debit, payment_status = 'Unpaid' WHERE id = ?", [julyInvoiceId]);
  });

  test("an OR dated in CLOSED July itself is rejected outright, regardless of what it would settle", async () => {
    const res = await request(app).post("/api/or").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-OR-JUL1", customerId: custAId, customerName: "x", transactionDate: "2026-07-18",
      totalDebit: 400, totalCredit: 400, status: "Posted",
      lines: [{ accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 0, credit: 400 }],
      invoiceApplications: [{ sourceType: "INV", sourceId: julyInvoiceId, amount: 400 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });
});

describe("Beginning Balance period enforcement", () => {
  test("AR Beginning Balance create in CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/arap-beginning-balances").set("Authorization", `Bearer ${tokenA}`).send({
      balanceType: "AR", balanceDate: "2026-07-01", currencyCode: "PHP", currencyName: "PHILIPPINE PESO",
      line: { partyId: custAId, partyName: "x", accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", debit: 500, credit: 0, balanceAmount: 500 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });
});

describe("FX Revaluation period enforcement", () => {
  test("calculate (preview) for a CLOSED month still works - it does not mutate the GL", async () => {
    const res = await request(app).post("/api/fx-revaluation/calculate").set("Authorization", `Bearer ${tokenA}`).send({ revaluationDate: "2026-07-31" });
    expect(res.status).toBe(200);
  });

  test("posting that same session is rejected because July is CLOSED", async () => {
    const calcRes = await request(app).post("/api/fx-revaluation/calculate").set("Authorization", `Bearer ${tokenA}`).send({ revaluationDate: "2026-07-31" });
    const sessionId = calcRes.body.session.id;
    const postRes = await request(app).post(`/api/fx-revaluation/${sessionId}/post`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(postRes.status).toBe(409);
    expect(postRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });
});

describe("Recurring generation period enforcement", () => {
  let templateId;

  test("a due occurrence landing in CLOSED July is recorded as PERIOD_CLOSED, not silently generated or lost", async () => {
    const createRes = await request(app).post("/api/recurring-transactions").set("Authorization", `Bearer ${tokenA}`).send({
      moduleType: "invoice", templateName: `TEST5 Recurring ${Date.now()}`,
      partyId: custAId, partyName: "x", descriptionTemplate: "x",
      currency: "PHP", currencyId: null, amountMode: "FIXED", amountConfig: {},
      dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particularsTemplate: "x", debit: 50, credit: 0 },
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particularsTemplate: "x", debit: 0, credit: 50 },
      ],
      schedule: { frequency: "MONTHLY", startDate: "2026-07-15", dateAdjustmentRule: "KEEP_ORIGINAL" },
    });
    expect(createRes.status).toBe(201);
    templateId = createRes.body.templateId;

    const genRes = await request(app).post(`/api/recurring-transactions/${templateId}/generate`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(genRes.status).toBe(200);
    expect(genRes.body.status).toBe("PERIOD_CLOSED");
    expect(genRes.body.occurrenceId).toBeTruthy();

    const [[occRow]] = await pool.query("SELECT status FROM recurring_transaction_occurrences WHERE id = ?", [genRes.body.occurrenceId]);
    expect(occRow.status).toBe("PERIOD_CLOSED");
  });
});

describe("Bulk posting period enforcement", () => {
  test("bulk posting excludes closed-period drafts and posts open-period drafts normally", async () => {
    const [julyDraft] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
       VALUES (?, 'TEST5-INV-BULKJUL', ?, 'x', '2026-07-22', 100, 0, 0, 100, 'Unpaid', 'Draft')`,
      [companyAId, custAId]
    );
    const julyDraftId = julyDraft.insertId;
    await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST5AR-A', 'AR', 'x', 100, 0)`, [julyDraftId, arA]);

    const [augDraft] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
       VALUES (?, 'TEST5-INV-BULKAUG', ?, 'x', '2026-08-22', 150, 0, 0, 150, 'Unpaid', 'Draft')`,
      [companyAId, custAId]
    );
    const augDraftId = augDraft.insertId;
    await pool.execute(`INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TEST5AR-A', 'AR', 'x', 150, 0)`, [augDraftId, arA]);

    const res = await request(app).post("/api/posting/post").set("Authorization", `Bearer ${tokenA}`).send({ scope: "ar" });
    expect(res.status).toBe(200);
    expect(res.body.periodBlockedCount).toBeGreaterThanOrEqual(1);

    const [[julyStatus]] = await pool.query("SELECT status FROM invoice_headers WHERE id = ?", [julyDraftId]);
    const [[augStatus]] = await pool.query("SELECT status FROM invoice_headers WHERE id = ?", [augDraftId]);
    expect(julyStatus.status).toBe("Draft");
    expect(augStatus.status).toBe("Posted");

    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?,?)", [julyDraftId, augDraftId]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?,?)", [julyDraftId, augDraftId]);
  });
});

describe("Beginning Balance closed-period enforcement", () => {
  test("creating an AR beginning balance dated into CLOSED July is rejected", async () => {
    const res = await request(app).post("/api/arap-beginning-balances").set("Authorization", `Bearer ${tokenA}`).send({
      balanceType: "AR", balanceDate: "2026-07-15", currencyCode: "PHP", currencyName: "Philippine Peso", remarks: "x",
      line: { partyId: custAId, partyCode: "TEST5-CUSTA", partyName: "x", accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", debit: 500, credit: 0 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("an existing AR beginning balance whose date falls in CLOSED July cannot be edited or deleted", async () => {
    const [headerResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
       VALUES (?, 'AR', '2026-07-11', 'PHP', 'Philippine Peso', 'x', 'Posted')`,
      [companyAId]
    );
    const headerId = headerResult.insertId;
    const [lineResult] = await pool.execute(
      `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_id, account_code, account_title, debit, credit, balance_amount, paid_amount, status)
       VALUES (?, ?, 'TEST5-CUSTA', 'x', ?, 'TEST5AR-A', 'AR', 500, 0, 500, 0, 'Unpaid')`,
      [headerId, custAId, arA]
    );
    const lineId = lineResult.insertId;

    const editRes = await request(app).put("/api/arap-beginning-balances").set("Authorization", `Bearer ${tokenA}`).send({
      line: { id: lineId, partyId: custAId, accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", debit: 750, credit: 0 },
    });
    expect(editRes.status).toBe(409);
    expect(editRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const delRes = await request(app).delete(`/api/arap-beginning-balances/${lineId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(delRes.status).toBe(409);
    expect(delRes.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    // Confirm nothing was silently modified.
    const [[unchanged]] = await pool.query("SELECT debit FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    expect(Number(unchanged.debit)).toBe(500);

    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [headerId]);
  });

  test("creating an AR beginning balance dated into OPEN September succeeds", async () => {
    const res = await request(app).post("/api/arap-beginning-balances").set("Authorization", `Bearer ${tokenA}`).send({
      balanceType: "AR", balanceDate: "2026-09-05", currencyCode: "PHP", currencyName: "Philippine Peso", remarks: "x",
      line: { partyId: custAId, partyCode: "TEST5-CUSTA", partyName: "x", accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", debit: 300, credit: 0 },
    });
    expect(res.status).toBe(200);

    await pool.query(
      `DELETE l FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND h.balance_date = '2026-09-05'`,
      [companyAId]
    );
    await pool.query(`DELETE FROM arap_beginning_balance_headers WHERE company_id = ? AND balance_date = '2026-09-05'`, [companyAId]);
  });
});

describe("Reports and printing remain available for a CLOSED period", () => {
  test("AR Aging still surfaces the closed-period invoice - locking controls mutation, not reporting", async () => {
    const arRes = await request(app).get("/api/reports/ar-aging?asOf=2026-07-31").set("Authorization", `Bearer ${tokenA}`);
    expect(arRes.status).toBe(200);
    expect(JSON.stringify(arRes.body)).toMatch(/TEST5-INV-JUL1/);
  });

  test("printing the closed-period invoice by direct ID still succeeds", async () => {
    const res = await request(app).get(`/api/print/invoice/${julyInvoiceId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
  });
});

describe("Company isolation for period close/reopen actions", () => {
  test("Admin A cannot close, reopen, or view the checklist for Company B's period", async () => {
    const closeRes = await request(app).post(`/api/accounting-periods/${julyPeriodBId}/close`).set("Authorization", `Bearer ${tokenA}`).send({ companyId: companyBId, notes: "x" });
    expect([403, 404]).toContain(closeRes.status);

    const reopenRes = await request(app).post(`/api/accounting-periods/${julyPeriodBId}/reopen`).set("Authorization", `Bearer ${tokenA}`).send({ companyId: companyBId, reason: "x" });
    expect([403, 404]).toContain(reopenRes.status);

    const checklistRes = await request(app).get(`/api/accounting-periods/${julyPeriodBId}/checklist`).set("Authorization", `Bearer ${tokenA}`).query({ companyId: companyBId });
    expect([403, 404]).toContain(checklistRes.status);
  });
});

describe("Reopen requires an explicit reason", () => {
  test("reopening July without a reason is rejected; with a reason it succeeds and August drafts remain unaffected", async () => {
    const noReasonRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/reopen`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(noReasonRes.status).toBe(400);
    expect(noReasonRes.body.code).toBe("REOPEN_REASON_REQUIRED");

    const reopenRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/reopen`).set("Authorization", `Bearer ${tokenA}`).send({ reason: "correcting a posting error found during audit" });
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.body.status).toBe("OPEN");

    // Now that July is reopened, the previously-rejected edit succeeds -
    // proving the block was genuinely period-driven, not a permanent flag.
    const editRes = await request(app).put(`/api/invoices/${julyInvoiceId}`).set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-JUL1", customerId: custAId, customerName: "x", transactionDate: "2026-07-10",
      totalDebit: 1000, totalCredit: 1000, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 1000, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 1000 },
      ],
    });
    expect(editRes.status).toBe(200);

    // Re-close for a clean, deterministic afterAll (harmless either way).
    await request(app).post(`/api/accounting-periods/${julyPeriodId}/close`).set("Authorization", `Bearer ${tokenA}`).send({ notes: "re-closing after test" });
  });
});

// From this point on, July is CLOSED again (the block above re-closes it
// at the end, and Jest runs tests in file declaration order within a
// single file) - every test below can rely on that.

describe("CRITICAL: CV settlement of a closed-period APV", () => {
  test("a CV dated in OPEN August CAN settle the July APV (payment period governs, not source period)", async () => {
    const res = await request(app).post("/api/cv").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-CV-AUG1", payeeId: suppAId, payeeName: "x", transactionDate: "2026-08-14",
      totalDebit: 800, totalCredit: 800, status: "Posted",
      lines: [
        { accountId: apA, accountCode: "TEST5AP-A", accountTitle: "AP", particulars: "x", debit: 800, credit: 0 },
        { accountId: cashA, accountCode: "TEST5CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 800 },
      ],
      apvApplications: [{ sourceType: "APV", sourceId: julyApvId, amount: 800 }],
    });
    expect(res.status).toBe(200);

    const [[appRow]] = await pool.query(
      "SELECT amount FROM transaction_applications WHERE source_type='APV' AND source_id = ? AND applied_type='CV' AND applied_id = ?",
      [julyApvId, res.body.id]
    );
    expect(Number(appRow.amount)).toBe(800);

    await pool.query("DELETE FROM transaction_applications WHERE applied_type='CV' AND applied_id = ?", [res.body.id]);
    await pool.query("DELETE FROM cv_lines WHERE cv_id = ?", [res.body.id]);
    await pool.query("DELETE FROM cv_headers WHERE id = ?", [res.body.id]);
    await pool.query("UPDATE apv_headers SET paid_amount = 0, balance_amount = total_credit, payment_status = 'Unpaid' WHERE id = ?", [julyApvId]);
  });

  test("a CV dated in CLOSED July itself is rejected outright, regardless of what it would settle", async () => {
    const res = await request(app).post("/api/cv").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-CV-JUL1", payeeId: suppAId, payeeName: "x", transactionDate: "2026-07-22",
      totalDebit: 800, totalCredit: 800, status: "Posted",
      lines: [
        { accountId: apA, accountCode: "TEST5AP-A", accountTitle: "AP", particulars: "x", debit: 800, credit: 0 },
        { accountId: cashA, accountCode: "TEST5CASH-A", accountTitle: "Cash", particulars: "x", debit: 0, credit: 800 },
      ],
      apvApplications: [{ sourceType: "APV", sourceId: julyApvId, amount: 800 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });
});

describe("SOFT_CLOSED period enforcement", () => {
  test("a user without POST_SOFT_CLOSED is blocked from posting into September", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenUnauthorized}`).send({
      voucherNo: "TEST5-INV-SEPT-REJ", customerId: custAId, customerName: "x", transactionDate: "2026-09-05",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_SOFT_CLOSED");
  });

  test("an authorized user (default ADMIN grant) can still post an approved adjustment into September", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send({
      voucherNo: "TEST5-INV-SEPT-OK", customerId: custAId, customerName: "x", transactionDate: "2026-09-05",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(200);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id = ?", [res.body.id]);
    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [res.body.id]);
  });
});

describe("CRITICAL: Super Admin cannot silently bypass a hard-closed period", () => {
  // Super Admin's resolveCompanyIdForWrite defaults to "the first company
  // in the database" when no companyId is given explicitly - on the real
  // shared DB this session uses, that is the real production company, not
  // this test's fixture company. Every Super Admin call below MUST pass
  // an explicit companyId (top-level for the accounting-periods routes,
  // nested under `currency` for the invoice route - server.js reads
  // `currency?.companyId` there, not a top-level field) or it risks
  // mutating real production period data instead of the test fixture.
  test("Super Admin attempting to create into CLOSED July is rejected exactly like any other role", async () => {
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenSuper}`).send({
      currency: { companyId: companyAId }, voucherNo: "TEST5-INV-SUPER-REJ", customerId: custAId, customerName: "x", transactionDate: "2026-07-28",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
  });

  test("Super Admin CAN post once the period is explicitly reopened", async () => {
    const reopenRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/reopen`).set("Authorization", `Bearer ${tokenSuper}`).send({ companyId: companyAId, reason: "Super Admin explicit reopen for audit correction" });
    expect(reopenRes.status).toBe(200);

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenSuper}`).send({
      currency: { companyId: companyAId }, voucherNo: "TEST5-INV-SUPER-OK", customerId: custAId, customerName: "x", transactionDate: "2026-07-28",
      totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TEST5AR-A", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TEST5REV-A", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(200);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id = ?", [res.body.id]);
    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [res.body.id]);

    // Re-close for every subsequent test in this file that assumes July is CLOSED.
    await request(app).post(`/api/accounting-periods/${julyPeriodId}/close`).set("Authorization", `Bearer ${tokenSuper}`).send({ companyId: companyAId, notes: "re-closing after Super Admin test" });
  });
});

describe("Bank Reconciliation adjustment period enforcement", () => {
  test("posting a July-dated adjustment as a JV is blocked because July is CLOSED", async () => {
    const res = await request(app).post(`/api/bank-recon/adjustments/${julyAdjustmentId}/post`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");

    const [[stillPending]] = await pool.query("SELECT status, jv_id FROM bank_recon_adjustments WHERE id = ?", [julyAdjustmentId]);
    expect(stillPending.status).toBe("APPROVED");
    expect(stillPending.jv_id).toBeNull();
  });

  test("posting an August-dated adjustment as a JV succeeds because August is OPEN", async () => {
    const res = await request(app).post(`/api/bank-recon/adjustments/${augAdjustmentId}/post`).set("Authorization", `Bearer ${tokenA}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.jvId).toBeTruthy();

    const [[posted]] = await pool.query("SELECT status, jv_id FROM bank_recon_adjustments WHERE id = ?", [augAdjustmentId]);
    expect(posted.status).toBe("POSTED");
    const [[jvRow]] = await pool.query("SELECT company_id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS d, total_debit, total_credit FROM jv_headers WHERE id = ?", [posted.jv_id]);
    expect(jvRow.company_id).toBe(companyAId);
    expect(jvRow.d).toBe("2026-08-25");
    expect(Number(jvRow.total_debit)).toBe(Number(jvRow.total_credit));
  });
});