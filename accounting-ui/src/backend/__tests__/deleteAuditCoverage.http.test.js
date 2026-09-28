const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 1 of the CRUD audit-trail improvement: DELETE-only auditing for
// Invoice, APV, PO, Quotation, and AR/AP Beginning Balance (GL Beginning
// Balance has no DELETE route at all - confirmed by investigation, so
// there is nothing to test for it). Mirrors the existing JV/Petty Cash
// DELETE audit convention exactly (logAudit inside the same
// connection/transaction the DELETE itself uses, curated beforeData, the
// company_id already resolved by the route) - no new audit architecture,
// no CREATE/EDIT auditing, no payment/application auditing.

jest.setTimeout(180000);

let companyAId, companyBId;
let userAId, userBId;
let tokenA, tokenB;
let arA, apA, revA;
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

async function auditRowsFor(module, entityId) {
  const [rows] = await pool.query(
    "SELECT id, module, entity_type AS entityType, entity_id AS entityId, action, company_id AS companyId, before_data AS beforeData, user_id AS userId FROM audit_logs WHERE module = ? AND entity_id = ? AND action = 'DELETE'",
    [module, entityId]
  );
  return rows;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTDEL Company A");
  companyBId = await makeCompany("TESTDEL Company B");

  userAId = await makeUser("testdel_a", "TestDelPass!A1", 2, companyAId);
  userBId = await makeUser("testdel_b", "TestDelPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testdel_a", "TestDelPass!A1");
  tokenB = await loginAs("testdel_b", "TestDelPass!B1");

  arA = await makeAccount("TESTDEL-AR", "TestDel Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTDEL-AP", "TestDel Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTDEL-REV", "TestDel Revenue", "INCOME");
  custAId = await makeParty("TESTDEL-CUST", "CUSTOMER", "TestDel Customer", companyAId);
  suppAId = await makeParty("TESTDEL-SUPP", "SUPPLIER", "TestDel Supplier", companyAId);

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
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM purchase_order_lines l JOIN purchase_order_headers h ON h.id = l.po_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM purchase_order_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM quotation_lines l JOIN quotation_headers h ON h.id = l.quotation_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM quotation_headers WHERE company_id = ?", [co]);
    await pool.query(
      "DELETE ps FROM arap_payment_schedules ps JOIN arap_beginning_balance_lines l ON l.id = ps.beginning_balance_line_id JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?",
      [co]
    );
    await pool.query("DELETE l FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTDEL-CUST','TESTDEL-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTDEL-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Invoice DELETE audit", () => {
  let invId;
  test("Draft invoice create + delete succeeds, produces exactly one DELETE audit event with correct shape", async () => {
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTDEL-INV-1", customerId: custAId, customerName: "TestDel Customer",
      transactionDate: "2026-09-01", totalDebit: 500, totalCredit: 500, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTDEL-AR", accountTitle: "AR", particulars: "x", debit: 500, credit: 0 },
        { accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 500 },
      ],
    });
    expect(c.status).toBe(200);
    invId = c.body.id;

    const d = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("INV", invId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("INV");
    expect(rows[0].companyId).toBe(companyAId);
    expect(rows[0].userId).toBe(userAId);
    const before = rows[0].beforeData;
    expect(before.voucherNo).toBe("TESTDEL-INV-1");
    expect(before.customerName).toBe("TestDel Customer");
    expect(before.status).toBe("Draft");
  });

  test("deleting an already-deleted invoice 404s and creates no additional audit event", async () => {
    const d = await request(app).delete(`/api/invoices/${invId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(404);
    const rows = await auditRowsFor("INV", invId);
    expect(rows).toHaveLength(1); // still just the one from the successful delete above
  });

  test("a Posted invoice cannot be deleted, and the rejected attempt creates no DELETE audit event", async () => {
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTDEL-INV-2", customerId: custAId, customerName: "TestDel Customer",
      transactionDate: "2026-09-01", totalDebit: 300, totalCredit: 300, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTDEL-AR", accountTitle: "AR", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(c.status).toBe(200);
    const postedId = c.body.id;

    const d = await request(app).delete(`/api/invoices/${postedId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(409);

    const rows = await auditRowsFor("INV", postedId);
    expect(rows).toHaveLength(0);
  });

  test("Company B cannot see Company A's invoice-delete audit event, and vice versa", async () => {
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "INV" });
    expect(asB.body.some((r) => r.entityId === invId)).toBe(false);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "INV" });
    expect(asA.body.some((r) => r.entityId === invId)).toBe(true);
  });
});

describe("APV DELETE audit", () => {
  let apvId;
  test("Draft APV create + delete succeeds, produces exactly one DELETE audit event under the SAME module APV's Cancel/Void/Reverse events already use", async () => {
    const c = await request(app).post("/api/apv").set(auth(tokenA)).send({
      voucherNo: "TESTDEL-APV-1", supplierId: suppAId, supplierName: "TestDel Supplier",
      transactionDate: "2026-09-01", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Expense", particulars: "x", debit: 400, credit: 0 },
        { accountId: apA, accountCode: "TESTDEL-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 400 },
      ],
    });
    expect(c.status).toBe(200);
    apvId = c.body.id;

    const d = await request(app).delete(`/api/apv/${apvId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("TRANSACTIONS", apvId);
    const apvRows = rows.filter((r) => r.entityType === "APV");
    expect(apvRows).toHaveLength(1);
    expect(apvRows[0].companyId).toBe(companyAId);
    const before = apvRows[0].beforeData;
    expect(before.voucherNo).toBe("TESTDEL-APV-1");
    expect(before.supplierName).toBe("TestDel Supplier");
    expect(before.status).toBe("Draft");
  });

  test("a Posted APV cannot be deleted, and the rejected attempt creates no DELETE audit event", async () => {
    const c = await request(app).post("/api/apv").set(auth(tokenA)).send({
      voucherNo: "TESTDEL-APV-2", supplierId: suppAId, supplierName: "TestDel Supplier",
      transactionDate: "2026-09-01", totalDebit: 250, totalCredit: 250, status: "Posted",
      lines: [
        { accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Expense", particulars: "x", debit: 250, credit: 0 },
        { accountId: apA, accountCode: "TESTDEL-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 250 },
      ],
    });
    expect(c.status).toBe(200);
    const postedId = c.body.id;

    const d = await request(app).delete(`/api/apv/${postedId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(409);

    const rows = await auditRowsFor("TRANSACTIONS", postedId);
    expect(rows.filter((r) => r.entityType === "APV")).toHaveLength(0);
  });
});

describe("PO DELETE audit (non-transactional route, preserved as-is)", () => {
  let poId;
  test("PO create + delete succeeds, produces exactly one DELETE audit event", async () => {
    const c = await request(app).post("/api/purchase-orders").set(auth(tokenA)).send({
      voucherNo: "TESTDEL-PO-1", supplierId: suppAId, supplierName: "TestDel Supplier",
      transactionDate: "2026-09-01", totalCredit: 600, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Expense", particulars: "x", debit: 600, credit: 0 },
        { accountId: apA, accountCode: "TESTDEL-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 600 },
      ],
    });
    expect(c.status).toBe(200);
    poId = c.body.id;

    const d = await request(app).delete(`/api/purchase-orders/${poId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("PO", poId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("PO");
    expect(rows[0].companyId).toBe(companyAId);
    const before = rows[0].beforeData;
    expect(before.voucherNo).toBe("TESTDEL-PO-1");
    expect(before.supplierName).toBe("TestDel Supplier");
  });

  test("deleting a non-existent PO 404s and creates no audit event", async () => {
    const d = await request(app).delete("/api/purchase-orders/999999999").set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(404);
    const rows = await auditRowsFor("PO", 999999999);
    expect(rows).toHaveLength(0);
  });
});

describe("Quotation DELETE audit", () => {
  let qId;
  test("Quotation create + delete succeeds, produces exactly one DELETE audit event (this route previously had no pre-read at all)", async () => {
    const c = await request(app).post("/api/quotations").set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestDel Customer",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 700,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 700, taxRate: 0, amount: 700, accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Rev" }],
    });
    expect(c.status).toBe(200);
    qId = c.body.id;

    const d = await request(app).delete(`/api/quotations/${qId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("QUOTATION", qId);
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(companyAId);
    const before = rows[0].beforeData;
    expect(before.quotationNo).toBe(c.body.quotationNo);
    expect(before.customerName).toBe("TestDel Customer");
  });

  test("Company B cannot delete Company A's quotation, and no audit event about Company A's data is created under Company B", async () => {
    const c = await request(app).post("/api/quotations").set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestDel Customer",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 100,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 100, taxRate: 0, amount: 100, accountId: revA, accountCode: "TESTDEL-REV", accountTitle: "Rev" }],
    });
    const crossId = c.body.id;
    const d = await request(app).delete(`/api/quotations/${crossId}`).set(auth(tokenB)).query({ companyId: companyBId });
    expect(d.status).toBe(404);
    const rows = await auditRowsFor("QUOTATION", crossId);
    expect(rows).toHaveLength(0);
    // cleanup this one directly since it was never deleted via the route
    await pool.query("DELETE FROM quotation_lines WHERE quotation_id = ?", [crossId]);
    await pool.query("DELETE FROM quotation_headers WHERE id = ?", [crossId]);
  });
});

describe("AR/AP Beginning Balance DELETE audit (single-line delete, shared route)", () => {
  let arLineId, apLineId;

  test("AR beginning balance line create + delete succeeds, audited under module AR_BEGINNING", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AR", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: custAId, partyName: "TestDel Customer", accountId: arA, accountCode: "TESTDEL-AR", accountTitle: "AR", referenceNo: "AR-REF-1", debit: 900, credit: 0 },
    });
    expect(c.status).toBe(200);
    // The create route's own response body is just { success, message } -
    // no id is returned - so the line id is looked up the same way any
    // caller without a returned id would have to: by its own unique
    // reference_no, scoped to this company.
    const [[arLine]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "AR-REF-1"]
    );
    arLineId = arLine.id;
    expect(arLineId).toBeTruthy();

    const d = await request(app).delete(`/api/arap-beginning-balances/${arLineId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("AR_BEGINNING", arLineId);
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(companyAId);
    const before = rows[0].beforeData;
    expect(before.partyName).toBe("TestDel Customer");
    expect(before.referenceNo).toBe("AR-REF-1");
    expect(Number(before.debit)).toBe(900);
  });

  test("AP beginning balance line create + delete succeeds, audited under module AP_BEGINNING (proves the shared route picks the correct module from the row's own balance_type, not a guess)", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AP", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: suppAId, partyName: "TestDel Supplier", accountId: apA, accountCode: "TESTDEL-AP", accountTitle: "AP", referenceNo: "AP-REF-1", debit: 0, credit: 500 },
    });
    expect(c.status).toBe(200);
    const [[apLine]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "AP-REF-1"]
    );
    apLineId = apLine.id;
    expect(apLineId).toBeTruthy();

    const d = await request(app).delete(`/api/arap-beginning-balances/${apLineId}`).set(auth(tokenA)).query({ companyId: companyAId });
    expect(d.status).toBe(200);

    const rows = await auditRowsFor("AP_BEGINNING", apLineId);
    expect(rows).toHaveLength(1);
    const before = rows[0].beforeData;
    expect(before.partyName).toBe("TestDel Supplier");
    expect(Number(before.credit)).toBe(500);
  });
});

describe("Existing audit behavior remains unchanged", () => {
  test("JV/Petty Cash/Memo DELETE audit conventions are untouched (source guard - this phase only added new calls, never modified existing ones)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "JV",\s*\n\s*entityType: "JV",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
    expect(src).toMatch(/module: "PETTY_CASH",\s*\n\s*entityType: "PETTY_CASH",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
  });

  test("existing GET /api/audit-logs filters (module, limit) still work within company scope", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "INV", limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
    expect(res.body.every((r) => r.module === "INV")).toBe(true);
  });
});
