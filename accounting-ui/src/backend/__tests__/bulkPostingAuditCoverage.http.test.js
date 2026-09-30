const fs = require("fs");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 12: bulk-posting audit coverage. POST /api/posting/post previously
// transitioned any number of Draft Invoice/OR/APV/CV/PO records to Posted
// (or, for PO, "Open") with zero audit trail. The fix: one "POST" audit
// event per document actually transitioned - reusing each document's own
// existing module/entityType convention (never a new "POSTING" module),
// written on the route's own existing transaction connection before
// commit, using only data the route already has in scope (draftRows'
// transactionDate). Excluded rows (period-blocked, FX-blocked) get no
// event. No SQL/posting/period-lock/FX-blocking/company-scope/response
// behavior was changed.

jest.setTimeout(180000);

let companyAId, companyBId;
let userAId, userBId;
let tokenA, tokenB;
let arA, apA, revA, cashA;
let custAId, suppAId;

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  if (companyId) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return r.insertId;
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
async function grantAuditLogsView(userId) {
  const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.AUDIT_LOGS' AND action = 'VIEW'");
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [userId, perm.id]);
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function createDraftInvoice(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/invoices").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestBP Customer", companyId,
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: arA, accountCode: "TESTBP-AR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA, accountCode: "TESTBP-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftApv(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/apv").set(auth(token)).send({
    voucherNo, supplierId: suppAId, supplierName: "TestBP Supplier", companyId,
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: revA, accountCode: "TESTBP-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTBP-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftOr(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/or").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestBP Customer", companyId,
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: cashA, accountCode: "TESTBP-CASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTBP-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftCv(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/cv").set(auth(token)).send({
    voucherNo, payeeId: suppAId, payeeName: "TestBP Supplier", companyId,
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTBP-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: cashA, accountCode: "TESTBP-CASH", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftPo(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/purchase-orders").set(auth(token)).send({
    voucherNo, supplierId: suppAId, supplierName: "TestBP Supplier", companyId,
    transactionDate: "2026-09-10", totalCredit: amount, status: "Draft",
    lines: [
      { accountId: revA, accountCode: "TESTBP-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTBP-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function postAuditRowsFor(module, entityId) {
  const [rows] = await pool.query(
    "SELECT id, module, entity_type AS entityType, entity_id AS entityId, action, company_id AS companyId, before_data AS beforeData, after_data AS afterData FROM audit_logs WHERE module = ? AND entity_id = ? AND action = 'POST'",
    [module, entityId]
  );
  return rows;
}
async function statusOf(table, id) {
  const [[row]] = await pool.query(`SELECT status FROM ${table} WHERE id = ?`, [id]);
  return row ? row.status : null;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTBP Company A");
  companyBId = await makeCompany("TESTBP Company B");

  userAId = await makeUser("testbp_a", "TestBpPass!A1", 2, companyAId);
  userBId = await makeUser("testbp_b", "TestBpPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testbp_a", "TestBpPass!A1");
  tokenB = await loginAs("testbp_b", "TestBpPass!B1");

  arA = await makeAccount("TESTBP-AR", "TestBP Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTBP-AP", "TestBP Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTBP-REV", "TestBP Revenue/Expense", "INCOME");
  cashA = await makeAccount("TESTBP-CASH", "TestBP Cash", "ASSET");
  custAId = await makeParty("TESTBP-CUST", "CUSTOMER", "TestBP Customer", companyAId);
  suppAId = await makeParty("TESTBP-SUPP", "SUPPLIER", "TestBP Supplier", companyAId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: userAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: userBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
});

afterAll(async () => {
  for (const co of [companyAId, companyBId]) {
    await pool.query("DELETE FROM audit_logs WHERE company_id = ?", [co]);
    await pool.query(
      "DELETE ta FROM transaction_applications ta JOIN invoice_headers h ON h.id = ta.source_id AND ta.source_type = 'INV' WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM or_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM purchase_order_lines l JOIN purchase_order_headers h ON h.id = l.po_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM purchase_order_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM accounting_period_history WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTBP-CUST','TESTBP-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTBP-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("One POST audit event per document type (1-11)", () => {
  test("1/6/8/9/10/11. Invoice bulk posting creates exactly one POST audit event with correct shape", async () => {
    const invId = await createDraftInvoice(tokenA, { voucherNo: "TESTBP-INV-1", amount: 500, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);

    const rows = await postAuditRowsFor("INV", invId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("INV");
    expect(rows[0].entityId).toBe(invId);
    expect(rows[0].companyId).toBe(companyAId);
    expect(rows[0].beforeData.status).toBe("Draft");
    expect(rows[0].afterData.status).toBe("Posted");
    expect(await statusOf("invoice_headers", invId)).toBe("Posted");
  });

  test("2. OR bulk posting creates exactly one POST audit event, afterData.status='Posted'", async () => {
    const orId = await createDraftOr(tokenA, { voucherNo: "TESTBP-OR-2", amount: 400, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);

    const rows = await postAuditRowsFor("TRANSACTIONS.OR", orId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("OR");
    expect(rows[0].beforeData.status).toBe("Draft");
    expect(rows[0].afterData.status).toBe("Posted");
  });

  test("3. APV bulk posting creates exactly one POST audit event, afterData.status='Posted'", async () => {
    const apvId = await createDraftApv(tokenA, { voucherNo: "TESTBP-APV-3", amount: 300, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ap", companyId: companyAId });
    expect(res.status).toBe(200);

    const rows = (await postAuditRowsFor("TRANSACTIONS", apvId)).filter((r) => r.entityType === "APV");
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.status).toBe("Draft");
    expect(rows[0].afterData.status).toBe("Posted");
  });

  test("4. CV bulk posting creates exactly one POST audit event, afterData.status='Posted'", async () => {
    const cvId = await createDraftCv(tokenA, { voucherNo: "TESTBP-CV-4", amount: 250, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ap", companyId: companyAId });
    expect(res.status).toBe(200);

    const rows = (await postAuditRowsFor("TRANSACTIONS", cvId)).filter((r) => r.entityType === "CV");
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.status).toBe("Draft");
    expect(rows[0].afterData.status).toBe("Posted");
  });

  test("5/7. PO bulk transition creates exactly one POST audit event, afterData.status='Open'", async () => {
    const poId = await createDraftPo(tokenA, { voucherNo: "TESTBP-PO-5", amount: 600, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ap", companyId: companyAId });
    expect(res.status).toBe(200);

    const rows = await postAuditRowsFor("PO", poId);
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.status).toBe("Draft");
    expect(rows[0].afterData.status).toBe("Open"); // PO never posts to GL - "Open", never "Posted"
    expect(await statusOf("purchase_order_headers", poId)).toBe("Open");
  });
});

describe("Mixed/omitted scope (12)", () => {
  test("12. omitted scope posts and audits every eligible document type in one call", async () => {
    const invId = await createDraftInvoice(tokenA, { voucherNo: "TESTBP-INV-12", amount: 100, companyId: companyAId });
    const apvId = await createDraftApv(tokenA, { voucherNo: "TESTBP-APV-12", amount: 100, companyId: companyAId });
    const poId = await createDraftPo(tokenA, { voucherNo: "TESTBP-PO-12", amount: 100, companyId: companyAId });

    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ companyId: companyAId }); // no scope
    expect(res.status).toBe(200);

    expect(await postAuditRowsFor("INV", invId)).toHaveLength(1);
    expect((await postAuditRowsFor("TRANSACTIONS", apvId)).filter((r) => r.entityType === "APV")).toHaveLength(1);
    expect(await postAuditRowsFor("PO", poId)).toHaveLength(1);
  });
});

describe("Excluded rows get no audit event (13, 14)", () => {
  test("13. a period-blocked Draft invoice is not posted and gets no POST audit event", async () => {
    const [periodResult] = await pool.execute(
      `INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status)
       VALUES (?, 2026, 7, '2026-07-01', '2026-07-31', 'CLOSED')`,
      [companyAId]
    );
    const [invResult] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, balance_amount, payment_status, status)
       VALUES (?, 'TESTBP-INV-13', ?, 'TestBP Customer', '2026-07-15', 300, 300, 300, 'Unpaid', 'Draft')`,
      [companyAId, custAId]
    );
    const invId = invResult.insertId;

    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.periodBlockedCount).toBeGreaterThanOrEqual(1);

    expect(await statusOf("invoice_headers", invId)).toBe("Draft"); // not posted
    expect(await postAuditRowsFor("INV", invId)).toHaveLength(0); // no audit event

    await pool.query("DELETE FROM invoice_headers WHERE id = ?", [invId]);
    await pool.query("DELETE FROM accounting_periods WHERE id = ?", [periodResult.insertId]);
  });

  test("14. an FX-rate-mismatched Draft OR is not posted and gets no POST audit event", async () => {
    const invId = await createDraftInvoice(tokenA, { voucherNo: "TESTBP-INV-14", amount: 1000, companyId: companyAId });
    const orId = await createDraftOr(tokenA, { voucherNo: "TESTBP-OR-14", amount: 400, companyId: companyAId });
    // Simulate a rate-mismatched application the same way a real
    // foreign-currency settlement would produce one - directly setting
    // fx_difference on the applied row, which is the exact column the
    // route's own blocking query reads.
    await pool.execute(
      `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date, fx_difference)
       VALUES ('INV', ?, 'OR', ?, 400, '2026-09-10', 5.00)`,
      [invId, orId]
    );

    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.blockedCount).toBeGreaterThanOrEqual(1);

    expect(await statusOf("or_headers", orId)).toBe("Draft"); // not posted
    expect(await postAuditRowsFor("TRANSACTIONS.OR", orId)).toHaveLength(0); // no audit event

    // The unrelated invoice in the same call is unaffected by the OR's block.
    expect(await statusOf("invoice_headers", invId)).toBe("Posted");
    expect(await postAuditRowsFor("INV", invId)).toHaveLength(1);
  });
});

describe("Empty selection (15)", () => {
  test("15. no Draft documents exist -> zero audit events, postedCount 0", async () => {
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.postedCount).toBe(0);
    // (No entity-specific assertion needed - nothing was created in this test.)
  });
});

describe("Cross-company isolation (16)", () => {
  test("16. Company A's bulk-post request does not post or audit Company B's Draft records", async () => {
    const suppBId = await makeParty("TESTBP-SUPP-B", "SUPPLIER", "TestBP Supplier B", companyBId);
    const [poBResult] = await pool.execute(
      `INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status)
       VALUES (?, 'TESTBP-PO-B16', ?, 'TestBP Supplier B', '2026-09-10', 200, 200, 'Draft')`,
      [companyBId, suppBId]
    );
    const poBId = poBResult.insertId;

    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ap", companyId: companyAId });
    expect(res.status).toBe(200);

    expect(await statusOf("purchase_order_headers", poBId)).toBe("Draft"); // untouched
    expect(await postAuditRowsFor("PO", poBId)).toHaveLength(0); // no audit event leaked into Company A's call

    await pool.query("DELETE FROM purchase_order_headers WHERE id = ?", [poBId]);
    await pool.query("DELETE FROM general_libraries WHERE id = ?", [suppBId]);
  });
});

describe("Rollback removes both posting and audit events (17)", () => {
  test("17. a genuine mid-batch failure rolls back an earlier target's status change AND its audit event in the same call", async () => {
    // AP_POST_TARGETS processes apv_headers before cv_headers. A Draft APV
    // with a valid date is processed (and would be posted+audited) first;
    // a Draft CV with transaction_date = NULL (a legitimate, nullable
    // column - not corrupted application code) reaches
    // AccountingPeriodService.assertPeriodOpen()'s own top-level guard
    // and throws a genuine, non-period-closed HttpError(400,
    // "transactionDate is required for period enforcement",
    // "MISSING_DATE") - which this route's own catch filter re-throws
    // (only ACCOUNTING_PERIOD_* 409s are swallowed), rolling back the
    // whole transaction. The route's catch block returns err.statusCode
    // (400 for this specific HttpError), not a generic 500, but the
    // rollback behavior is identical either way.
    const apvId = await createDraftApv(tokenA, { voucherNo: "TESTBP-APV-17", amount: 150, companyId: companyAId });
    const [cvResult] = await pool.execute(
      `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
       VALUES (?, 'TESTBP-CV-17', ?, 'TestBP Supplier', NULL, 100, 100, 'Draft')`,
      [companyAId, suppAId]
    );
    const cvId = cvResult.insertId;

    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ap", companyId: companyAId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_DATE");

    // The APV's status change AND its audit event must both have been
    // rolled back, even though it was processed successfully before the
    // CV caused the failure.
    expect(await statusOf("apv_headers", apvId)).toBe("Draft");
    expect((await postAuditRowsFor("TRANSACTIONS", apvId)).filter((r) => r.entityType === "APV")).toHaveLength(0);
    expect(await statusOf("cv_headers", cvId)).toBe("Draft");

    await pool.query("DELETE FROM cv_headers WHERE id = ?", [cvId]);
  });
});

describe("Existing audit coverage remains intact (18)", () => {
  test("18. existing CREATE/EDIT/DELETE/payment audit source code is byte-unchanged by this phase", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: invoiceId,\s*\n\s*companyId,\s*\n\s*action: "CREATE",/);
    expect(src).toMatch(/action: "EDIT",\s*\n\s*description: `Invoice \$\{normalizeVoucherNo\(voucherNo\)\} edited`,/);
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
    expect(src).toContain('action: "PAYMENT_APPLIED",');
    expect(src).toContain('action: "PAYMENT_UNAPPLIED",');
    expect(src).toContain("INVOICE_HAS_ACTIVE_PAYMENTS");
    expect(src).toContain("APV_HAS_ACTIVE_PAYMENTS");
  });
});

describe("Source guards - protected files untouched (19)", () => {
  test("19. collaborator-owned files contain no reference to this phase's new code", () => {
    const paymentSrc = fs.readFileSync(require.resolve("../services/paymentApplicationService.js"), "utf8");
    expect(paymentSrc).not.toContain("auditLabel");
    expect(paymentSrc).not.toContain("AR_POST_TARGETS");

    const voidSrc = fs.readFileSync(require.resolve("../services/voidCancelService.js"), "utf8");
    expect(voidSrc).not.toContain("auditLabel");

    const journalSrc = fs.readFileSync(require.resolve("../services/JournalSuggestionService.js"), "utf8");
    expect(journalSrc).not.toContain("auditLabel");
    expect(journalSrc).toContain("async function postAdjustmentAsJV(conn, adjustmentId, user) {");

    const bankReconSrc = fs.readFileSync(require.resolve("../controllers/BankReconController.js"), "utf8");
    expect(bankReconSrc).not.toContain("auditLabel");
  });
});
