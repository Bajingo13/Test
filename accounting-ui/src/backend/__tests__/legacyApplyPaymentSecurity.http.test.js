const fs = require("fs");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Legacy /api/apply-payment security remediation - a separate phase
// following the completed Phase 4 payment/application audit. This route is
// unused by the frontend (zero callers found repo-wide) but remains
// reachable via the API, and previously wrote transaction_applications rows
// using appliedType/appliedId taken verbatim from the request body with no
// existence or company-ownership check on the applied side, and a plain
// (non-locking) balance SELECT. This suite proves: (1) the route now
// validates sourceType==="APV", appliedType==="CV", and that the target CV
// exists and belongs to the SAME company as the source APV before ever
// inserting a row; (2) the APV balance check now uses the same FOR UPDATE
// row-lock pattern applyApvPayment() already uses elsewhere, so two
// concurrent requests against the same APV cannot both apply against a
// stale balance. No accounting calculation, schema, or other route's
// behavior was touched - only this one route's validation and locking.

jest.setTimeout(120000);

let companyAId, companyBId;
let userAId, userBId;
let tokenA, tokenB;
let apA_acct, revA_acct;
let suppAId, suppBId;

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
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function createApv(token, { voucherNo, supplierId, supplierName, amount, companyId }) {
  const res = await request(app).post("/api/apv").set(auth(token)).send({
    voucherNo, supplierId, supplierName, transactionDate: "2026-09-05",
    totalDebit: amount, totalCredit: amount, status: "Draft", companyId,
    lines: [
      { accountId: revA_acct, accountCode: "TESTLA-EXP", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA_acct, accountCode: "TESTLA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function createCv(token, { voucherNo, payeeId, payeeName, amount, companyId }) {
  const res = await request(app).post("/api/cv").set(auth(token)).send({
    voucherNo, payeeId, payeeName, transactionDate: "2026-09-05",
    totalDebit: amount, totalCredit: amount, status: "Draft", companyId,
    lines: [
      { accountId: apA_acct, accountCode: "TESTLA-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA_acct, accountCode: "TESTLA-EXP", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
    // Deliberately no apvApplications - this CV must exist independently
    // of the legacy route's own attempt to apply it to an APV.
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

function applyPaymentPayload(overrides) {
  return {
    sourceType: "APV",
    amount: 100,
    applicationDate: "2026-09-06",
    ...overrides,
  };
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTLA Company A");
  companyBId = await makeCompany("TESTLA Company B");

  userAId = await makeUser("testla_a", "TestLaPass!A1", 2, companyAId);
  userBId = await makeUser("testla_b", "TestLaPass!B1", 2, companyBId);

  tokenA = await loginAs("testla_a", "TestLaPass!A1");
  tokenB = await loginAs("testla_b", "TestLaPass!B1");

  apA_acct = await makeAccount("TESTLA-AP", "TestLA Accounts Payable", "LIABILITY");
  revA_acct = await makeAccount("TESTLA-EXP", "TestLA Expense/Cash", "EXPENSE");
  suppAId = await makeParty("TESTLA-SUPP-A", "SUPPLIER", "TestLA Supplier A", companyAId);
  suppBId = await makeParty("TESTLA-SUPP-B", "SUPPLIER", "TestLA Supplier B", companyBId);

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
      "DELETE ta FROM transaction_applications ta JOIN apv_headers h ON h.id = ta.source_id AND ta.source_type = 'APV' WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTLA-SUPP-A','TESTLA-SUPP-B')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTLA-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Legacy /api/apply-payment - validation", () => {
  test("1. same-company APV -> same-company CV succeeds", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-1", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const cvId = await createCv(tokenA, { voucherNo: "TESTLA-CV-1", payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 500, companyId: companyAId });

    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvId, amount: 300, companyId: companyAId })
    );
    expect(res.status).toBe(200);

    const [[row]] = await pool.query(
      "SELECT amount FROM transaction_applications WHERE source_type='APV' AND source_id=? AND applied_type='CV' AND applied_id=?",
      [apvId, cvId]
    );
    expect(Number(row.amount)).toBe(300);
  });

  test("2. APV Company A -> CV Company B is rejected", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-2", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const cvBId = await createCv(tokenB, { voucherNo: "TESTLA-CV-B1", payeeId: suppBId, payeeName: "TestLA Supplier B", amount: 500, companyId: companyBId });

    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvBId, amount: 100, companyId: companyAId })
    );
    expect([400, 404]).toContain(res.status);
  });

  test("3. APV Company A -> nonexistent CV is rejected", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-3", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: 999999999, amount: 100, companyId: companyAId })
    );
    expect([400, 404]).toContain(res.status);
  });

  test("4. APV Company A -> appliedType 'APV' is rejected", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-4", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const otherApvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-4B", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 500, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "APV", appliedId: otherApvId, amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(400);
  });

  test("5. APV Company A -> arbitrary appliedType is rejected", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-5", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "SOMETHING_ELSE", appliedId: 1, amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(400);
  });

  test("6. missing appliedId is rejected", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-6", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(400);
  });

  test("7. invalid sourceType is rejected", async () => {
    const cvId = await createCv(tokenA, { voucherNo: "TESTLA-CV-7", payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 500, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceType: "INV", sourceId: 1, appliedType: "CV", appliedId: cvId, amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(400);
  });

  test("8. source APV from another company is rejected", async () => {
    const apvBId = await createApv(tokenB, { voucherNo: "TESTLA-APV-B1", supplierId: suppBId, supplierName: "TestLA Supplier B", amount: 1000, companyId: companyBId });
    const cvAId = await createCv(tokenA, { voucherNo: "TESTLA-CV-8", payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 500, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvBId, appliedType: "CV", appliedId: cvAId, amount: 100, companyId: companyAId })
    );
    expect([400, 404]).toContain(res.status);
  });
});

describe("Legacy /api/apply-payment - failed requests create zero rows", () => {
  test("9. failed cross-company request creates ZERO transaction_applications rows", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-9", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const cvBId = await createCv(tokenB, { voucherNo: "TESTLA-CV-B2", payeeId: suppBId, payeeName: "TestLA Supplier B", amount: 500, companyId: companyBId });

    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvBId, amount: 100, companyId: companyAId })
    );
    expect([400, 404]).toContain(res.status);

    const [[count]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='APV' AND source_id=? AND applied_type='CV' AND applied_id=?",
      [apvId, cvBId]
    );
    expect(count.c).toBe(0);
  });

  test("10. failed nonexistent-CV request creates ZERO transaction_applications rows", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-10", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: 999999998, amount: 100, companyId: companyAId })
    );
    expect([400, 404]).toContain(res.status);

    const [[count]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='APV' AND source_id=? AND applied_id=999999998",
      [apvId]
    );
    expect(count.c).toBe(0);
  });

  test("11. failed invalid-appliedType request creates ZERO transaction_applications rows", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-11", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "WEIRD", appliedId: 1, amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(400);

    const [[count]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_applications WHERE source_type='APV' AND source_id=?",
      [apvId]
    );
    expect(count.c).toBe(0);
  });
});

describe("Legacy /api/apply-payment - concurrency / FOR UPDATE protection", () => {
  test("a manually held FOR UPDATE lock on the APV row genuinely blocks a concurrent /api/apply-payment request until released", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-LOCK", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const cvId = await createCv(tokenA, { voucherNo: "TESTLA-CV-LOCK", payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 500, companyId: companyAId });

    const lockConn = await pool.getConnection();
    try {
      await lockConn.beginTransaction();
      // The exact same lock the route itself now takes.
      await lockConn.execute(
        "SELECT id FROM apv_headers WHERE id = ? AND company_id = ? FOR UPDATE",
        [apvId, companyAId]
      );

      const reqPromise = request(app).post("/api/apply-payment").set(auth(tokenA)).send(
        applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvId, amount: 200, companyId: companyAId })
      );

      const sentinel = Symbol("pending");
      const raceCheck = await Promise.race([
        reqPromise.then((r) => ({ settled: true, status: r.status })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false, sentinel }), 700)),
      ]);
      expect(raceCheck.settled).toBe(false); // genuinely blocked, not just slow

      await lockConn.commit();

      const finalRes = await reqPromise;
      expect(finalRes.status).toBe(200);
    } finally {
      lockConn.release();
    }
  });

  test("repeated real concurrent over-application attempts never let combined applied amount exceed the APV balance", async () => {
    const ITERATIONS = 6;
    for (let i = 0; i < ITERATIONS; i++) {
      const apvId = await createApv(tokenA, { voucherNo: `TESTLA-APV-RACE-${i}`, supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
      const cvId = await createCv(tokenA, { voucherNo: `TESTLA-CV-RACE-${i}`, payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 1000, companyId: companyAId });

      // Two concurrent requests for 600 each against a 1000 balance - only
      // one can legally succeed once the first commits and the second
      // re-reads the reduced balance. Without the FOR UPDATE fix, both
      // could read balance=1000 before either commits and both succeed,
      // over-applying to 1200.
      const [r1, r2] = await Promise.all([
        request(app).post("/api/apply-payment").set(auth(tokenA)).send(
          applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvId, amount: 600, companyId: companyAId })
        ),
        request(app).post("/api/apply-payment").set(auth(tokenA)).send(
          applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvId, amount: 600, companyId: companyAId })
        ),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 400]); // exactly one succeeds, one is correctly rejected

      const [[sumRow]] = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM transaction_applications WHERE source_type='APV' AND source_id=?",
        [apvId]
      );
      expect(Number(sumRow.total)).toBe(600); // never 1200
      expect(Number(sumRow.n)).toBe(1);

      const [[apvRow]] = await pool.query("SELECT paid_amount AS paidAmount, balance_amount AS balanceAmount FROM apv_headers WHERE id = ?", [apvId]);
      expect(Number(apvRow.paidAmount)).toBe(600);
      expect(Number(apvRow.balanceAmount)).toBe(400);
    }
  });
});

describe("No PAYMENT_APPLIED/PAYMENT_UNAPPLIED audit event is added to this route", () => {
  test("a successful legacy apply-payment call creates no PAYMENT_APPLIED audit row (Phase 4 decision preserved)", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTLA-APV-NOAUDIT", supplierId: suppAId, supplierName: "TestLA Supplier A", amount: 1000, companyId: companyAId });
    const cvId = await createCv(tokenA, { voucherNo: "TESTLA-CV-NOAUDIT", payeeId: suppAId, payeeName: "TestLA Supplier A", amount: 500, companyId: companyAId });

    const res = await request(app).post("/api/apply-payment").set(auth(tokenA)).send(
      applyPaymentPayload({ sourceId: apvId, appliedType: "CV", appliedId: cvId, amount: 100, companyId: companyAId })
    );
    expect(res.status).toBe(200);

    const [[count]] = await pool.query(
      "SELECT COUNT(*) c FROM audit_logs WHERE action IN ('PAYMENT_APPLIED','PAYMENT_UNAPPLIED') AND entity_id = ?",
      [apvId]
    );
    expect(count.c).toBe(0);
  });
});

describe("Source guards - other implementations and protected files untouched", () => {
  test("paymentApplicationService.js's applyInvoicePayment/applyApvPayment are unchanged", () => {
    const src = fs.readFileSync(require.resolve("../services/paymentApplicationService.js"), "utf8");
    expect(src).toContain("async function applyInvoicePayment(conn, {");
    expect(src).toContain("async function applyApvPayment(conn, {");
    expect(src).toContain(
      'SELECT COALESCE(balance_amount, total_credit, 0) AS balanceAmount, company_id AS companyId FROM apv_headers WHERE id = ? FOR UPDATE'
    );
  });

  test("unwindCvApplications is unchanged", () => {
    const src = fs.readFileSync(require.resolve("../services/voidCancelService.js"), "utf8");
    expect(src).toContain("async function unwindCvApplications(conn, cvId) {");
    expect(src).toContain("return { unwoundApplications: oldApplications.length, affectedApvIds };");
  });

  test("Phase 1 DELETE audit code remains intact", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
  });

  test("Phase 2 CREATE audit code remains intact", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: invoiceId,\s*\n\s*companyId,\s*\n\s*action: "CREATE",/);
  });

  test("Phase 3 EDIT audit code remains intact", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/action: "EDIT",\s*\n\s*description: `Invoice \$\{normalizeVoucherNo\(voucherNo\)\} edited`,/);
  });

  test("Phase 4 PAYMENT_APPLIED/PAYMENT_UNAPPLIED code remains intact", () => {
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toContain('action: "PAYMENT_APPLIED",');
    expect(src).toContain('action: "PAYMENT_UNAPPLIED",');
    const orCreateMatches = src.match(/action: "PAYMENT_APPLIED",/g) || [];
    expect(orCreateMatches.length).toBeGreaterThanOrEqual(4); // OR CREATE, OR EDIT, CV CREATE, CV EDIT
  });
});
