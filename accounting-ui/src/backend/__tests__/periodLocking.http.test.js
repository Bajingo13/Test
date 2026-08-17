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
let tokenA, tokenB;
let arA, apA, revA, cashA;
let custAId, suppAId;
let julyPeriodId, augustPeriodId, julyPeriodBId;
let julyInvoiceId; // fixture created via direct SQL, dated into the already-closed July

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

  arA = await makeAccount("TEST5AR-A", "Accounts Receivable A (5)", "ASSET");
  apA = await makeAccount("TEST5AP-A", "Accounts Payable A (5)", "LIABILITY");
  revA = await makeAccount("TEST5REV-A", "Sales Revenue A (5)", "INCOME");
  cashA = await makeAccount("TEST5CASH-A", "Cash A (5)", "ASSET");
  custAId = await makeParty("TEST5-CUSTA", "CUSTOMER", "5 Company A Customer", companyAId);
  suppAId = await makeParty("TEST5-SUPPA", "SUPPLIER", "5 Company A Supplier", companyAId);

  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });

  tokenA = await loginAs("test5_admin_a", "Test5Pass!A1");
  tokenB = await loginAs("test5_admin_b", "Test5Pass!B1");

  // Generate 2026 periods for both companies via the real API, then close
  // Company A's July via the real API - proves the whole stack end to end
  // (permission check, transactional close, history row) before any
  // enforcement test runs.
  await request(app).post("/api/accounting-periods/generate-year").set("Authorization", `Bearer ${tokenA}`).send({ year: 2026 });
  await request(app).post("/api/accounting-periods/generate-year").set("Authorization", `Bearer ${tokenB}`).send({ year: 2026 });

  const listA = await request(app).get("/api/accounting-periods?year=2026").set("Authorization", `Bearer ${tokenA}`);
  julyPeriodId = listA.body.find((p) => p.period_month === 7).id;
  augustPeriodId = listA.body.find((p) => p.period_month === 8).id;

  const listB = await request(app).get("/api/accounting-periods?year=2026").set("Authorization", `Bearer ${tokenB}`);
  julyPeriodBId = listB.body.find((p) => p.period_month === 7).id;

  const closeRes = await request(app).post(`/api/accounting-periods/${julyPeriodId}/close`).set("Authorization", `Bearer ${tokenA}`).send({ notes: "test close" });
  if (closeRes.status !== 200) throw new Error(`Failed to close July fixture period: ${JSON.stringify(closeRes.body)}`);

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
});

afterAll(async () => {
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

  await pool.query("DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username IN ('test5_admin_a','test5_admin_b'))");
  await pool.query("DELETE FROM users WHERE username IN ('test5_admin_a','test5_admin_b')");
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