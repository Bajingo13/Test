const fs = require("fs");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 4 of the CRUD/audit-trail improvement: PAYMENT_APPLIED /
// PAYMENT_UNAPPLIED auditing for OR CREATE/EDIT and CV CREATE/EDIT. Follows
// the codebase's own existing precedent (logFxSettlementAudit's curated,
// document-level, per-application-summary shape, and CV CANCEL/VOID/
// REVERSE's existing embedded unwind summaries) rather than inventing a new
// architecture. One event per OR/CV CREATE/EDIT call (never one row per
// transaction_applications insert), fired only when the relevant
// application set (new or old) is actually non-empty.
//
// Out of scope, untouched this phase: applyInvoicePayment, applyApvPayment,
// unwindCvApplications, the standalone /api/apply-payment route, CV/APV
// CANCEL/VOID/REVERSE, Invoice/APV DELETE. Source guards below prove this.

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

async function auditRowsFor(module, entityId, action) {
  const [rows] = await pool.query(
    "SELECT id, module, entity_type AS entityType, entity_id AS entityId, action, company_id AS companyId, before_data AS beforeData, after_data AS afterData, user_id AS userId FROM audit_logs WHERE module = ? AND entity_id = ? AND action = ?",
    [module, entityId, action]
  );
  return rows;
}

async function createInvoice(token, { voucherNo, customerId, customerName, amount }) {
  const res = await request(app).post("/api/invoices").set(auth(token)).send({
    voucherNo, customerId, customerName, transactionDate: "2026-09-01",
    totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: arA, accountCode: "TESTPA-AR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA, accountCode: "TESTPA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function createApv(token, { voucherNo, supplierId, supplierName, amount }) {
  const res = await request(app).post("/api/apv").set(auth(token)).send({
    voucherNo, supplierId, supplierName, transactionDate: "2026-09-01",
    totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: revA, accountCode: "TESTPA-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTPA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

function orPayload({ voucherNo, amount, invoiceApplications }) {
  return {
    voucherNo, customerId: custAId, customerName: "TestPA Customer",
    transactionDate: "2026-09-02", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: cashA, accountCode: "TESTPA-CASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTPA-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
    ],
    invoiceApplications,
  };
}

function cvPayload({ voucherNo, amount, apvApplications }) {
  return {
    voucherNo, payeeId: suppAId, payeeName: "TestPA Supplier",
    transactionDate: "2026-09-02", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTPA-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: cashA, accountCode: "TESTPA-CASH", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
    apvApplications,
  };
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTPA Company A");
  companyBId = await makeCompany("TESTPA Company B");

  userAId = await makeUser("testpa_a", "TestPaPass!A1", 2, companyAId);
  userBId = await makeUser("testpa_b", "TestPaPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testpa_a", "TestPaPass!A1");
  tokenB = await loginAs("testpa_b", "TestPaPass!B1");

  arA = await makeAccount("TESTPA-AR", "TestPA Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTPA-AP", "TestPA Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTPA-REV", "TestPA Revenue/Expense", "INCOME");
  cashA = await makeAccount("TESTPA-CASH", "TestPA Cash", "ASSET");
  custAId = await makeParty("TESTPA-CUST", "CUSTOMER", "TestPA Customer", companyAId);
  suppAId = await makeParty("TESTPA-SUPP", "SUPPLIER", "TestPA Supplier", companyAId);

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
      "DELETE ta FROM transaction_applications ta JOIN or_headers h ON h.id = ta.applied_id AND ta.applied_type = 'OR' WHERE h.company_id = ?",
      [co]
    );
    await pool.query(
      "DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM or_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTPA-CUST','TESTPA-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTPA-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("AR: OR CREATE PAYMENT_APPLIED", () => {
  test("1. OR CREATE with one invoice application produces exactly one PAYMENT_APPLIED event", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-1", customerId: custAId, customerName: "TestPA Customer", amount: 5000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-1", amount: 1000, invoiceApplications: [{ sourceId: invId, amount: 1000, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);

    const create = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "CREATE");
    expect(create).toHaveLength(1); // existing CREATE event untouched

    const applied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(applied).toHaveLength(1);
    expect(applied[0].companyId).toBe(companyAId);
    expect(applied[0].afterData.applications).toHaveLength(1);
    expect(applied[0].afterData.applications[0]).toMatchObject({
      sourceType: "INV", sourceId: invId, applicationDate: "2026-09-02",
    });
    expect(Number(applied[0].afterData.applications[0].amount)).toBe(1000);
    expect(applied[0].afterData.applications[0].id).toBeUndefined();
    expect(applied[0].afterData.applications[0].fxAccountCode).toBeUndefined();
  });

  test("2. OR CREATE with multiple invoice applications produces exactly one PAYMENT_APPLIED event containing all of them", async () => {
    const inv1 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-2", customerId: custAId, customerName: "TestPA Customer", amount: 3000 });
    const inv2 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-3", customerId: custAId, customerName: "TestPA Customer", amount: 4000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({
        voucherNo: "TESTPA-OR-2", amount: 2500,
        invoiceApplications: [
          { sourceId: inv1, amount: 1000, applicationDate: "2026-09-02" },
          { sourceId: inv2, amount: 1500, applicationDate: "2026-09-02" },
        ],
      })
    );
    expect(or.status).toBe(200);

    const applied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(applied).toHaveLength(1);
    expect(applied[0].afterData.applications).toHaveLength(2);
    const sourceIds = applied[0].afterData.applications.map((a) => a.sourceId).sort();
    expect(sourceIds).toEqual([inv1, inv2].sort());
    const amounts = applied[0].afterData.applications.map((a) => Number(a.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([1000, 1500]);
  });

  test("3. OR CREATE with no applications produces no PAYMENT_APPLIED event", async () => {
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-3", amount: 500, invoiceApplications: [] })
    );
    expect(or.status).toBe(200);
    const applied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(applied).toHaveLength(0);
  });
});

describe("AR: OR EDIT PAYMENT_APPLIED / PAYMENT_UNAPPLIED", () => {
  test("4-6. OR EDIT removing an application (no replacement) produces only PAYMENT_UNAPPLIED", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-4", customerId: custAId, customerName: "TestPA Customer", amount: 2000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-4", amount: 800, invoiceApplications: [{ sourceId: invId, amount: 800, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);

    // OR CREATE itself already produced one PAYMENT_APPLIED row (asserted
    // in test 1's shape) - capture that count as a watermark so the EDIT's
    // own contribution (expected: zero, since the new set is empty) can be
    // measured as a delta rather than an absolute count.
    const appliedBeforeEdit = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(appliedBeforeEdit).toHaveLength(1);

    const u = await request(app).put(`/api/or/${or.body.id}`).set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-4", amount: 800, invoiceApplications: [] })
    );
    expect(u.status).toBe(200);

    const unapplied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_UNAPPLIED");
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].beforeData.applications).toHaveLength(1);
    expect(unapplied[0].beforeData.applications[0]).toMatchObject({ sourceType: "INV", sourceId: invId });
    expect(Number(unapplied[0].beforeData.applications[0].amount)).toBe(800);

    const appliedAfterEdit = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(appliedAfterEdit).toHaveLength(1); // unchanged from before the edit -> no new applications -> no PAYMENT_APPLIED (covers case 6)

    const editRows = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "EDIT");
    expect(editRows).toHaveLength(1); // existing EDIT event untouched
  });

  test("5. OR EDIT replacing applications produces one PAYMENT_UNAPPLIED and one PAYMENT_APPLIED", async () => {
    const inv1 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-5", customerId: custAId, customerName: "TestPA Customer", amount: 2000 });
    const inv2 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-6", customerId: custAId, customerName: "TestPA Customer", amount: 2000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-5", amount: 600, invoiceApplications: [{ sourceId: inv1, amount: 600, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);

    const u = await request(app).put(`/api/or/${or.body.id}`).set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-5", amount: 700, invoiceApplications: [{ sourceId: inv2, amount: 700, applicationDate: "2026-09-03" }] })
    );
    expect(u.status).toBe(200);

    const unapplied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_UNAPPLIED");
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].beforeData.applications[0].sourceId).toBe(inv1);

    // Two PAYMENT_APPLIED rows exist for this OR in total (one from CREATE
    // applying inv1, one from this EDIT applying inv2) - the EDIT's own
    // contribution is the most recent one (highest id), which must
    // describe inv2, not inv1.
    const applied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(applied).toHaveLength(2);
    const fromEdit = applied.reduce((a, b) => (b.id > a.id ? b : a));
    expect(fromEdit.afterData.applications[0].sourceId).toBe(inv2);
    expect(fromEdit.afterData.applications[0].applicationDate).toBe("2026-09-03");
  });

  test("7. OR EDIT with no old applications but new applications produces only PAYMENT_APPLIED", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-7", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-7", amount: 300, invoiceApplications: [] })
    );
    expect(or.status).toBe(200);

    const u = await request(app).put(`/api/or/${or.body.id}`).set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-7", amount: 300, invoiceApplications: [{ sourceId: invId, amount: 300, applicationDate: "2026-09-02" }] })
    );
    expect(u.status).toBe(200);

    const unapplied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_UNAPPLIED");
    expect(unapplied).toHaveLength(0);
    const applied = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "PAYMENT_APPLIED");
    expect(applied).toHaveLength(1);
  });

  test("8. failed OR EDIT (unbalanced lines) leaves no new payment audit events after rollback", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-8", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-8", amount: 400, invoiceApplications: [{ sourceId: invId, amount: 400, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);

    const beforeUnapplied = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS.OR' AND action='PAYMENT_UNAPPLIED'");
    const beforeApplied = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS.OR' AND action='PAYMENT_APPLIED'");

    const badEdit = await request(app).put(`/api/or/${or.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTPA-OR-8", customerId: custAId, customerName: "TestPA Customer",
      transactionDate: "2026-09-02", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [{ accountId: cashA, accountCode: "TESTPA-CASH", accountTitle: "Cash", particulars: "x", debit: 400, credit: 0 }],
      invoiceApplications: [],
    });
    expect(badEdit.status).toBe(400);

    const afterUnapplied = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS.OR' AND action='PAYMENT_UNAPPLIED'");
    const afterApplied = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS.OR' AND action='PAYMENT_APPLIED'");
    expect(afterUnapplied[0][0].c).toBe(beforeUnapplied[0][0].c);
    expect(afterApplied[0][0].c).toBe(beforeApplied[0][0].c);

    // The original application must still be intact (rollback restored it).
    const [[stillThere]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='INV' AND source_id=? AND applied_type='OR' AND applied_id=?",
      [invId, or.body.id]
    );
    expect(stillThere.c).toBe(1);
  });

  test("9. company isolation of AR payment audit events", async () => {
    // GET /api/audit-logs has no `action` query filter (only module/
    // entityType/entityId/userId/from/to/limit) and its SELECT does not
    // return a companyId field - company scoping happens entirely via the
    // route's own already-resolved companyId in its WHERE clause. Company B
    // created zero OR/CV records in this whole suite, so its module-scoped
    // query must come back completely empty; Company A's must be non-empty
    // and contain PAYMENT_APPLIED rows (filtered client-side, since the
    // server doesn't filter by action).
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "TRANSACTIONS.OR" });
    expect(asB.body).toHaveLength(0);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "TRANSACTIONS.OR", limit: 1000 });
    expect(asA.body.some((r) => r.action === "PAYMENT_APPLIED")).toBe(true);
  });
});

describe("AP: CV CREATE PAYMENT_APPLIED", () => {
  test("10. CV CREATE with one APV application produces exactly one PAYMENT_APPLIED event", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTPA-APV-1", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 5000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-1", amount: 1200, apvApplications: [{ sourceId: apvId, amount: 1200, applicationDate: "2026-09-02" }] })
    );
    expect(cv.status).toBe(200);

    const create = await auditRowsFor("TRANSACTIONS", cv.body.id, "CREATE");
    expect(create.filter((r) => r.entityType === "CV")).toHaveLength(1);

    const applied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(applied).toHaveLength(1);
    expect(applied[0].afterData.applications).toHaveLength(1);
    expect(applied[0].afterData.applications[0]).toMatchObject({ sourceType: "APV", sourceId: apvId, applicationDate: "2026-09-02" });
    expect(Number(applied[0].afterData.applications[0].amount)).toBe(1200);
  });

  test("11. CV CREATE with multiple APV applications produces exactly one PAYMENT_APPLIED containing all of them", async () => {
    const apv1 = await createApv(tokenA, { voucherNo: "TESTPA-APV-2", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 3000 });
    const apv2 = await createApv(tokenA, { voucherNo: "TESTPA-APV-3", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 4000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({
        voucherNo: "TESTPA-CV-2", amount: 2500,
        apvApplications: [
          { sourceId: apv1, amount: 1000, applicationDate: "2026-09-02" },
          { sourceId: apv2, amount: 1500, applicationDate: "2026-09-02" },
        ],
      })
    );
    expect(cv.status).toBe(200);

    const applied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(applied).toHaveLength(1);
    expect(applied[0].afterData.applications).toHaveLength(2);
    const sourceIds = applied[0].afterData.applications.map((a) => a.sourceId).sort();
    expect(sourceIds).toEqual([apv1, apv2].sort());
  });

  test("12. CV CREATE with no applications produces no PAYMENT_APPLIED event", async () => {
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-3", amount: 500, apvApplications: [] })
    );
    expect(cv.status).toBe(200);
    const applied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(applied).toHaveLength(0);
  });
});

describe("AP: CV EDIT PAYMENT_APPLIED / PAYMENT_UNAPPLIED", () => {
  test("13-16. CV EDIT removing an application (no replacement) produces only PAYMENT_UNAPPLIED", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTPA-APV-4", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 2000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-4", amount: 800, apvApplications: [{ sourceId: apvId, amount: 800, applicationDate: "2026-09-02" }] })
    );
    expect(cv.status).toBe(200);

    // CV CREATE itself already produced one PAYMENT_APPLIED row - captured
    // as a watermark so the EDIT's own contribution (expected: zero) can be
    // measured as a delta rather than an absolute count.
    const appliedBeforeEdit = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(appliedBeforeEdit).toHaveLength(1);

    const u = await request(app).put(`/api/cv/${cv.body.id}`).set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-4", amount: 800, apvApplications: [] })
    );
    expect(u.status).toBe(200);

    const unapplied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_UNAPPLIED")).filter((r) => r.entityType === "CV");
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].beforeData.applications).toHaveLength(1);
    expect(unapplied[0].beforeData.applications[0]).toMatchObject({ sourceType: "APV", sourceId: apvId });

    const appliedAfterEdit = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(appliedAfterEdit).toHaveLength(1); // unchanged from before the edit -> no new applications -> no PAYMENT_APPLIED (covers case 16)

    const editRows = (await auditRowsFor("TRANSACTIONS", cv.body.id, "EDIT")).filter((r) => r.entityType === "CV");
    expect(editRows).toHaveLength(1);
  });

  test("14. CV EDIT replacing applications produces one PAYMENT_UNAPPLIED and one PAYMENT_APPLIED", async () => {
    const apv1 = await createApv(tokenA, { voucherNo: "TESTPA-APV-5", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 2000 });
    const apv2 = await createApv(tokenA, { voucherNo: "TESTPA-APV-6", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 2000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-5", amount: 600, apvApplications: [{ sourceId: apv1, amount: 600, applicationDate: "2026-09-02" }] })
    );
    expect(cv.status).toBe(200);

    const u = await request(app).put(`/api/cv/${cv.body.id}`).set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-5", amount: 700, apvApplications: [{ sourceId: apv2, amount: 700, applicationDate: "2026-09-03" }] })
    );
    expect(u.status).toBe(200);

    const unapplied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_UNAPPLIED")).filter((r) => r.entityType === "CV");
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].beforeData.applications[0].sourceId).toBe(apv1);

    // Two PAYMENT_APPLIED rows exist in total (CREATE applying apv1, this
    // EDIT applying apv2) - the EDIT's own contribution is the most recent
    // one (highest id).
    const applied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(applied).toHaveLength(2);
    const fromEdit = applied.reduce((a, b) => (b.id > a.id ? b : a));
    expect(fromEdit.afterData.applications[0].sourceId).toBe(apv2);
  });

  test("15. CV EDIT with no old applications but new applications produces only PAYMENT_APPLIED", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTPA-APV-7", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 1000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-7", amount: 300, apvApplications: [] })
    );
    expect(cv.status).toBe(200);

    const u = await request(app).put(`/api/cv/${cv.body.id}`).set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-7", amount: 300, apvApplications: [{ sourceId: apvId, amount: 300, applicationDate: "2026-09-02" }] })
    );
    expect(u.status).toBe(200);

    const unapplied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_UNAPPLIED")).filter((r) => r.entityType === "CV");
    expect(unapplied).toHaveLength(0);
    const applied = (await auditRowsFor("TRANSACTIONS", cv.body.id, "PAYMENT_APPLIED")).filter((r) => r.entityType === "CV");
    expect(applied).toHaveLength(1);
  });

  test("17. failed CV EDIT (unbalanced lines) leaves no new payment audit events after rollback", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTPA-APV-8", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 1000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-8", amount: 400, apvApplications: [{ sourceId: apvId, amount: 400, applicationDate: "2026-09-02" }] })
    );
    expect(cv.status).toBe(200);

    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS' AND entity_type='CV' AND action IN ('PAYMENT_UNAPPLIED','PAYMENT_APPLIED')");

    const badEdit = await request(app).put(`/api/cv/${cv.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTPA-CV-8", payeeId: suppAId, payeeName: "TestPA Supplier",
      transactionDate: "2026-09-02", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [{ accountId: apA, accountCode: "TESTPA-AP", accountTitle: "AP", particulars: "x", debit: 400, credit: 0 }],
      apvApplications: [],
    });
    expect(badEdit.status).toBe(400);

    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module='TRANSACTIONS' AND entity_type='CV' AND action IN ('PAYMENT_UNAPPLIED','PAYMENT_APPLIED')");
    expect(after[0][0].c).toBe(before[0][0].c);

    const [[stillThere]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='APV' AND source_id=? AND applied_type='CV' AND applied_id=?",
      [apvId, cv.body.id]
    );
    expect(stillThere.c).toBe(1);
  });

  test("18. company isolation of AP payment audit events", async () => {
    // Same endpoint contract as test 9: no `action` query filter, no
    // companyId field in the response - Company B created zero APV/CV
    // records in this whole suite, so its module-scoped query must come
    // back completely empty.
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "TRANSACTIONS" });
    expect(asB.body).toHaveLength(0);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "TRANSACTIONS", limit: 1000 });
    expect(asA.body.some((r) => r.entityType === "CV" && r.action === "PAYMENT_APPLIED")).toBe(true);
  });
});

describe("Existing behavior remains intact (19-23)", () => {
  test("19. existing CREATE audit source code (Phase 2) is byte-unchanged by this phase", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: invoiceId,\s*\n\s*companyId,\s*\n\s*action: "CREATE",/);
  });

  test("20. existing EDIT audit source code (Phase 3) is byte-unchanged by this phase", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/action: "EDIT",\s*\n\s*description: `Invoice \$\{normalizeVoucherNo\(voucherNo\)\} edited`,/);
  });

  test("21. existing DELETE audit source code (Phase 1) is byte-unchanged by this phase", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
  });

  test("22. existing FOREIGN_SETTLEMENT_POSTED audit remains available for a same-currency (no-FX) OR", async () => {
    // A same-currency application never triggers logFxSettlementAudit
    // (fxResult totals are 0) - confirms this phase did not touch that
    // function's own zero-result short-circuit.
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-22", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-22", amount: 400, invoiceApplications: [{ sourceId: invId, amount: 400, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);
    const fxRows = await auditRowsFor("TRANSACTIONS.OR", or.body.id, "FOREIGN_SETTLEMENT_POSTED");
    expect(fxRows).toHaveLength(0);
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toContain('action: "FOREIGN_SETTLEMENT_POSTED",');
  });

  test("23. existing CV CANCEL/VOID/REVERSE audit source code is byte-unchanged by this phase", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "TRANSACTIONS", entityType: "CV", entityId: Number\(id\), companyId, action: "CANCEL",/);
    expect(src).toMatch(/module: "TRANSACTIONS", entityType: "CV", entityId: Number\(id\), companyId, action: "VOID",/);
    expect(src).toMatch(/module: "TRANSACTIONS", entityType: "CV", entityId: Number\(id\), companyId, action: "REVERSE",/);
    expect(src).toMatch(/beforeData: \{ status: prev \}, afterData: \{ status: CANCELLED, reason, \.\.\.unwind \},/);
  });
});

describe("Accounting correctness remains intact (24-28)", () => {
  test("24-25-26-27-28. balances and transaction_applications rows stay correct through partial/split/multiple payments", async () => {
    const inv1 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-24", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });
    const inv2 = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-25", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });

    // Split: one OR pays both invoices partially.
    const or1 = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({
        voucherNo: "TESTPA-OR-24", amount: 900,
        invoiceApplications: [
          { sourceId: inv1, amount: 400, applicationDate: "2026-09-02" },
          { sourceId: inv2, amount: 500, applicationDate: "2026-09-02" },
        ],
      })
    );
    expect(or1.status).toBe(200);

    // Multiple: a second OR pays the remainder of inv1.
    const or2 = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-25", amount: 600, invoiceApplications: [{ sourceId: inv1, amount: 600, applicationDate: "2026-09-03" }] })
    );
    expect(or2.status).toBe(200);

    const [[inv1Row]] = await pool.query("SELECT paid_amount AS paidAmount, balance_amount AS balanceAmount, payment_status AS paymentStatus FROM invoice_headers WHERE id = ?", [inv1]);
    expect(Number(inv1Row.paidAmount)).toBe(1000);
    expect(Number(inv1Row.balanceAmount)).toBe(0);
    expect(inv1Row.paymentStatus).toBe("Paid");

    const [[inv2Row]] = await pool.query("SELECT paid_amount AS paidAmount, balance_amount AS balanceAmount, payment_status AS paymentStatus FROM invoice_headers WHERE id = ?", [inv2]);
    expect(Number(inv2Row.paidAmount)).toBe(500);
    expect(Number(inv2Row.balanceAmount)).toBe(500);
    expect(inv2Row.paymentStatus).toBe("Partially Paid");

    const [taRows] = await pool.query("SELECT source_id AS sourceId, amount FROM transaction_applications WHERE source_type='INV' AND source_id IN (?, ?)", [inv1, inv2]);
    expect(taRows).toHaveLength(3);
    const inv1Total = taRows.filter((r) => r.sourceId === inv1).reduce((s, r) => s + Number(r.amount), 0);
    expect(inv1Total).toBe(1000);

    // Both PAYMENT_APPLIED events reflect the exact per-application amounts.
    const applied1 = await auditRowsFor("TRANSACTIONS.OR", or1.body.id, "PAYMENT_APPLIED");
    expect(applied1[0].afterData.applications.map((a) => Number(a.amount)).sort((a, b) => a - b)).toEqual([400, 500]);
    const applied2 = await auditRowsFor("TRANSACTIONS.OR", or2.body.id, "PAYMENT_APPLIED");
    expect(Number(applied2[0].afterData.applications[0].amount)).toBe(600);
  });
});

describe("No duplicate audit rows / correct identifiers (29-30)", () => {
  test("29-30. exactly one PAYMENT_APPLIED row per CREATE call, using the OR/CV's own module/entityType", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTPA-INV-29", customerId: custAId, customerName: "TestPA Customer", amount: 1000 });
    const or = await request(app).post("/api/or").set(auth(tokenA)).send(
      orPayload({ voucherNo: "TESTPA-OR-29", amount: 300, invoiceApplications: [{ sourceId: invId, amount: 300, applicationDate: "2026-09-02" }] })
    );
    expect(or.status).toBe(200);
    const [[count]] = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE action='PAYMENT_APPLIED' AND entity_id=? AND module='TRANSACTIONS.OR'", [or.body.id]);
    expect(count.c).toBe(1);

    const apvId = await createApv(tokenA, { voucherNo: "TESTPA-APV-29", supplierId: suppAId, supplierName: "TestPA Supplier", amount: 1000 });
    const cv = await request(app).post("/api/cv").set(auth(tokenA)).send(
      cvPayload({ voucherNo: "TESTPA-CV-29", amount: 300, apvApplications: [{ sourceId: apvId, amount: 300, applicationDate: "2026-09-02" }] })
    );
    expect(cv.status).toBe(200);
    const [[cvCount]] = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE action='PAYMENT_APPLIED' AND entity_id=? AND module='TRANSACTIONS' AND entity_type='CV'", [cv.body.id]);
    expect(cvCount.c).toBe(1);
  });
});

describe("Audit-log retrieval remains unaffected (31)", () => {
  test("31. existing GET /api/audit-logs filters (module, limit) still work alongside the new action values", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "TRANSACTIONS.OR", limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
    expect(res.body.every((r) => r.module === "TRANSACTIONS.OR")).toBe(true);
  });
});

describe("Source guards - payment/application internals and protected files untouched", () => {
  test("applyInvoicePayment / applyApvPayment signatures and core logic are unchanged", () => {
    const src = fs.readFileSync(require.resolve("../services/paymentApplicationService.js"), "utf8");
    expect(src).toContain("async function applyInvoicePayment(conn, {");
    expect(src).toContain("async function applyApvPayment(conn, {");
    expect(src).toContain("Payment amount cannot exceed invoice balance of");
    expect(src).toContain("Payment amount cannot exceed APV balance of");
    expect(src).not.toContain("PAYMENT_APPLIED");
    expect(src).not.toContain("PAYMENT_UNAPPLIED");
    expect(src).not.toContain("logAudit");
  });

  test("unwindCvApplications is unchanged", () => {
    const src = fs.readFileSync(require.resolve("../services/voidCancelService.js"), "utf8");
    expect(src).toContain("async function unwindCvApplications(conn, cvId) {");
    expect(src).toContain("return { unwoundApplications: oldApplications.length, affectedApvIds };");
    expect(src).not.toContain("PAYMENT_APPLIED");
    expect(src).not.toContain("PAYMENT_UNAPPLIED");
  });

  test("standalone /api/apply-payment route is unchanged", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toContain('app.post("/api/apply-payment"');
    expect(src).toContain("Only APV payment application is available right now.");
    expect(src).toContain('"Payment applied to APV successfully."');
    // No audit call was added to this route - confirmed by the absence of
    // any logAudit call between its declaration and its closing route body.
    const routeStart = src.indexOf('app.post("/api/apply-payment"');
    const routeEnd = src.indexOf("// ===================== CV API", routeStart);
    const routeBody = src.slice(routeStart, routeEnd);
    expect(routeBody).not.toContain("logAudit");
    expect(routeBody).not.toContain("PAYMENT_APPLIED");
  });
});
