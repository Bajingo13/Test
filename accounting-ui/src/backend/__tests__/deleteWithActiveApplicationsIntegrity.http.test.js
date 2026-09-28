const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 6: Invoice/APV DELETE payment-application integrity fix. Following
// the Phase (investigation-only) report, both DELETE routes previously
// deleted transaction_applications rows unconditionally, silently
// destroying an OR/CV's documented settlement history if the Invoice/APV
// being deleted still had one. This suite proves the minimal reject-
// outright fix: DELETE /api/invoices/:id and DELETE /api/apv/:id now
// reject (409) when any transaction_applications row still references that
// document, leaving both the application row and the document itself
// intact, with no application-removal, no lifecycle change, and no DELETE
// audit event for the rejected attempt. Existing behavior with zero
// applications is unchanged. Concurrency is protected by the same FOR
// UPDATE row-lock both DELETE routes now take on their own header row -
// the identical lock applyInvoicePayment()/applyApvPayment() already take
// before inserting a new application - so a DELETE and a concurrent
// payment application against the same document genuinely serialize.

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

async function createInvoice(token, { voucherNo, amount, status = "Draft" }) {
  const res = await request(app).post("/api/invoices").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestDI Customer",
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: arA, accountCode: "TESTDI-AR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA, accountCode: "TESTDI-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function createApv(token, { voucherNo, amount, status = "Draft" }) {
  const res = await request(app).post("/api/apv").set(auth(token)).send({
    voucherNo, supplierId: suppAId, supplierName: "TestDI Supplier",
    transactionDate: "2026-09-10", totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: revA, accountCode: "TESTDI-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTDI-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function createOrApplying(token, { voucherNo, amount, invoiceApplications, status = "Draft" }) {
  const res = await request(app).post("/api/or").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestDI Customer",
    transactionDate: "2026-09-11", totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: cashA, accountCode: "TESTDI-CASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTDI-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
    ],
    invoiceApplications,
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function createCvApplying(token, { voucherNo, amount, apvApplications, status = "Draft" }) {
  const res = await request(app).post("/api/cv").set(auth(token)).send({
    voucherNo, payeeId: suppAId, payeeName: "TestDI Supplier",
    transactionDate: "2026-09-11", totalDebit: amount, totalCredit: amount, status,
    lines: [
      { accountId: apA, accountCode: "TESTDI-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: cashA, accountCode: "TESTDI-CASH", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
    apvApplications,
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function deleteAuditCountFor(module, entityId) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) c FROM audit_logs WHERE module = ? AND entity_id = ? AND action = 'DELETE'",
    [module, entityId]
  );
  return row.c;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTDI Company A");
  companyBId = await makeCompany("TESTDI Company B");

  userAId = await makeUser("testdi_a", "TestDiPass!A1", 2, companyAId);
  userBId = await makeUser("testdi_b", "TestDiPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testdi_a", "TestDiPass!A1");
  tokenB = await loginAs("testdi_b", "TestDiPass!B1");

  arA = await makeAccount("TESTDI-AR", "TestDI Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTDI-AP", "TestDI Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTDI-REV", "TestDI Revenue/Expense", "INCOME");
  cashA = await makeAccount("TESTDI-CASH", "TestDI Cash", "ASSET");
  custAId = await makeParty("TESTDI-CUST", "CUSTOMER", "TestDI Customer", companyAId);
  suppAId = await makeParty("TESTDI-SUPP", "SUPPLIER", "TestDI Supplier", companyAId);

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
    await pool.query(
      "DELETE ta FROM transaction_applications ta JOIN apv_headers h ON h.id = ta.source_id AND ta.source_type = 'APV' WHERE h.company_id = ?",
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
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTDI-CUST','TESTDI-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTDI-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Invoice DELETE - active-application guard", () => {
  test("1. Draft invoice with no applications -> DELETE succeeds", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-1", amount: 500 });
    const res = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(200);
    const [[gone]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE id = ?", [invId]);
    expect(gone.n).toBe(0);
  });

  test("2/3/4. Draft invoice with an application -> DELETE returns conflict, application and invoice remain, no DELETE audit event", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-2", amount: 1000 });
    await createOrApplying(tokenA, {
      voucherNo: "TESTDI-OR-2", amount: 400,
      invoiceApplications: [{ sourceId: invId, amount: 400, applicationDate: "2026-09-11" }],
    });

    const res = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVOICE_HAS_ACTIVE_PAYMENTS");

    const [[stillInvoice]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE id = ?", [invId]);
    expect(stillInvoice.n).toBe(1); // invoice not deleted

    const [[stillApp]] = await pool.query(
      "SELECT COUNT(*) n FROM transaction_applications WHERE source_type='INV' AND source_id=?",
      [invId]
    );
    expect(stillApp.n).toBe(1); // application not deleted

    const auditCount = await deleteAuditCountFor("INV", invId);
    expect(auditCount).toBe(0); // no DELETE audit event for the rejected attempt
  });
});

describe("APV DELETE - active-application guard", () => {
  test("5. Draft APV with no applications -> DELETE succeeds", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-1", amount: 500 });
    const res = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(200);
    const [[gone]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id = ?", [apvId]);
    expect(gone.n).toBe(0);
  });

  test("6/7/8. Draft APV with an application -> DELETE returns conflict, application and APV remain, no DELETE audit event", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-2", amount: 1000 });
    await createCvApplying(tokenA, {
      voucherNo: "TESTDI-CV-2", amount: 400,
      apvApplications: [{ sourceId: apvId, amount: 400, applicationDate: "2026-09-11" }],
    });

    const res = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APV_HAS_ACTIVE_PAYMENTS");

    const [[stillApv]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id = ?", [apvId]);
    expect(stillApv.n).toBe(1);

    const [[stillApp]] = await pool.query(
      "SELECT COUNT(*) n FROM transaction_applications WHERE source_type='APV' AND source_id=?",
      [apvId]
    );
    expect(stillApp.n).toBe(1);

    const auditCount = await deleteAuditCountFor("TRANSACTIONS", apvId);
    expect(auditCount).toBe(0);
  });
});

describe("Posted OR/CV applications against Draft Invoice/APV also block deletion", () => {
  test("9. Posted OR application against a Draft Invoice blocks deletion", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-9", amount: 1000 });
    await createOrApplying(tokenA, {
      voucherNo: "TESTDI-OR-9", amount: 400, status: "Posted",
      invoiceApplications: [{ sourceId: invId, amount: 400, applicationDate: "2026-09-11" }],
    });
    // Confirms the exact integrity scenario from the investigation: the
    // invoice itself is still Draft (not blocked by the Posted-immutability
    // guard) even though the OR that settled it is already Posted.
    const [[invRow]] = await pool.query("SELECT status FROM invoice_headers WHERE id = ?", [invId]);
    expect(invRow.status).toBe("Draft");

    const res = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVOICE_HAS_ACTIVE_PAYMENTS");
  });

  test("10. Posted CV application against a Draft APV blocks deletion", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-10", amount: 1000 });
    await createCvApplying(tokenA, {
      voucherNo: "TESTDI-CV-10", amount: 400, status: "Posted",
      apvApplications: [{ sourceId: apvId, amount: 400, applicationDate: "2026-09-11" }],
    });
    const [[apvRow]] = await pool.query("SELECT status FROM apv_headers WHERE id = ?", [apvId]);
    expect(apvRow.status).toBe("Draft");

    const res = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APV_HAS_ACTIVE_PAYMENTS");
  });
});

describe("Company isolation cannot bypass the guard", () => {
  test("11. Company B cannot delete Company A's invoice/APV at all, regardless of applications", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-11", amount: 300 });
    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-11", amount: 300 });

    const delInv = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenB));
    expect([403, 404]).toContain(delInv.status);
    const delApv = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenB));
    expect([403, 404]).toContain(delApv.status);

    // Both must still exist - company B never reached the application
    // guard at all, since ownership is checked first (unchanged behavior).
    const [[invStill]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE id = ?", [invId]);
    expect(invStill.n).toBe(1);
    const [[apvStill]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id = ?", [apvId]);
    expect(apvStill.n).toBe(1);
  });
});

describe("Multiple applications are also blocked", () => {
  test("15. an Invoice/APV with multiple applications is also blocked", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-15", amount: 2000 });
    await createOrApplying(tokenA, { voucherNo: "TESTDI-OR-15A", amount: 300, invoiceApplications: [{ sourceId: invId, amount: 300, applicationDate: "2026-09-11" }] });
    await createOrApplying(tokenA, { voucherNo: "TESTDI-OR-15B", amount: 200, invoiceApplications: [{ sourceId: invId, amount: 200, applicationDate: "2026-09-11" }] });
    const [[appCount]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type='INV' AND source_id=?", [invId]);
    expect(appCount.n).toBe(2);

    const res = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);

    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-15", amount: 2000 });
    await createCvApplying(tokenA, { voucherNo: "TESTDI-CV-15A", amount: 300, apvApplications: [{ sourceId: apvId, amount: 300, applicationDate: "2026-09-11" }] });
    await createCvApplying(tokenA, { voucherNo: "TESTDI-CV-15B", amount: 200, apvApplications: [{ sourceId: apvId, amount: 200, applicationDate: "2026-09-11" }] });
    const resApv = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(resApv.status).toBe(409);
  });
});

describe("Deletion works again once applications are legitimately removed", () => {
  test("16a. OR EDIT removing its application unblocks Invoice DELETE", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-16A", amount: 500 });
    const orId = await createOrApplying(tokenA, {
      voucherNo: "TESTDI-OR-16A", amount: 500,
      invoiceApplications: [{ sourceId: invId, amount: 500, applicationDate: "2026-09-11" }],
    });
    const blocked = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(blocked.status).toBe(409);

    // Legitimate OR-EDIT-driven removal (Phase 3/4's own unwind mechanism) -
    // not touched by this phase.
    const edit = await request(app).put(`/api/or/${orId}`).set(auth(tokenA)).send({
      voucherNo: "TESTDI-OR-16A", customerId: custAId, customerName: "TestDI Customer",
      transactionDate: "2026-09-11", totalDebit: 500, totalCredit: 500, status: "Draft",
      lines: [
        { accountId: cashA, accountCode: "TESTDI-CASH", accountTitle: "Cash", particulars: "x", debit: 500, credit: 0 },
        { accountId: arA, accountCode: "TESTDI-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 500 },
      ],
      invoiceApplications: [],
    });
    expect(edit.status).toBe(200);

    const nowAllowed = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(nowAllowed.status).toBe(200);
  });

  test("16b. CV cancel (unwindCvApplications) unblocks APV DELETE", async () => {
    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-16B", amount: 500 });
    const cvId = await createCvApplying(tokenA, {
      voucherNo: "TESTDI-CV-16B", amount: 500,
      apvApplications: [{ sourceId: apvId, amount: 500, applicationDate: "2026-09-11" }],
    });
    const blocked = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(blocked.status).toBe(409);

    // Legitimate CV-Cancel-driven removal (unwindCvApplications, untouched
    // this phase) - APV stays Draft throughout, so DELETE remains eligible.
    const cancel = await request(app).post(`/api/cv/${cvId}/cancel`).set(auth(tokenA)).send({ reason: "test unwind", companyId: companyAId });
    expect(cancel.status).toBe(200);

    const [[appGone]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type='APV' AND source_id=?", [apvId]);
    expect(appGone.n).toBe(0);

    const nowAllowed = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(nowAllowed.status).toBe(200);
  });
});

describe("Concurrency: DELETE cannot race past a concurrently-created application", () => {
  test("a manually held FOR UPDATE lock on the invoice row genuinely blocks a concurrent DELETE until released", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-LOCK", amount: 500 });

    const lockConn = await pool.getConnection();
    try {
      await lockConn.beginTransaction();
      // The exact same lock applyInvoicePayment() takes before inserting an
      // application, and the exact same lock the DELETE route now takes.
      await lockConn.execute("SELECT id FROM invoice_headers WHERE id = ? FOR UPDATE", [invId]);

      const delPromise = request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });

      const sentinel = Symbol("pending");
      const raceCheck = await Promise.race([
        delPromise.then((r) => ({ settled: true, status: r.status })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false, sentinel }), 700)),
      ]);
      expect(raceCheck.settled).toBe(false); // genuinely blocked, not just slow

      await lockConn.commit();

      const finalRes = await delPromise;
      expect(finalRes.status).toBe(200); // no application was ever created, so the delete succeeds once unblocked
    } finally {
      lockConn.release();
    }
  });

  test("repeated real concurrent DELETE-vs-apply-payment attempts never lose an application or leave an orphan", async () => {
    const ITERATIONS = 6;
    for (let i = 0; i < ITERATIONS; i++) {
      const invId = await createInvoice(tokenA, { voucherNo: `TESTDI-INV-RACE-${i}`, amount: 500 });

      const [delRes, orRes] = await Promise.all([
        request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId }),
        request(app).post("/api/or").set(auth(tokenA)).send({
          voucherNo: `TESTDI-OR-RACE-${i}`, customerId: custAId, customerName: "TestDI Customer",
          transactionDate: "2026-09-11", totalDebit: 500, totalCredit: 500, status: "Draft",
          lines: [
            { accountId: cashA, accountCode: "TESTDI-CASH", accountTitle: "Cash", particulars: "x", debit: 500, credit: 0 },
            { accountId: arA, accountCode: "TESTDI-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: 500 },
          ],
          invoiceApplications: [{ sourceId: invId, amount: 500, applicationDate: "2026-09-11" }],
        }),
      ]);

      const [[invStillExists]] = await pool.query("SELECT COUNT(*) n FROM invoice_headers WHERE id = ?", [invId]);
      const [[appExists]] = await pool.query(
        "SELECT COUNT(*) n FROM transaction_applications WHERE source_type='INV' AND source_id=?",
        [invId]
      );

      if (delRes.status === 200) {
        // DELETE won the race: the invoice is gone, and the OR's attempt to
        // apply a payment to it must NOT have silently succeeded while also
        // leaving an orphaned application row - either the OR creation
        // itself failed (most likely, since applyInvoicePayment's own FOR
        // UPDATE select finds zero rows once the invoice is gone), or if it
        // somehow reported success, no application row may exist.
        expect(invStillExists.n).toBe(0);
        if (orRes.status === 200) {
          expect(appExists.n).toBe(0); // never an orphaned application
        }
      } else {
        // The application guard won the race: DELETE was correctly
        // rejected, the invoice and its just-created application must both
        // still exist intact - nothing was lost.
        expect(delRes.status).toBe(409);
        expect(orRes.status).toBe(200);
        expect(invStillExists.n).toBe(1);
        expect(appExists.n).toBe(1);
      }
    }
  });
});

describe("Existing DELETE/audit behavior with zero applications is unchanged", () => {
  test("14. a Posted invoice/APV is still rejected by the pre-existing Posted-immutability guard, before the new guard is even reached", async () => {
    const invId = await createInvoice(tokenA, { voucherNo: "TESTDI-INV-14", amount: 100, status: "Posted" });
    const res = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    const apvId = await createApv(tokenA, { voucherNo: "TESTDI-APV-14", amount: 100, status: "Posted" });
    const resApv = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(resApv.status).toBe(409);
    expect(resApv.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });
});
