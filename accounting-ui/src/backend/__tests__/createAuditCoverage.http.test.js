const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 2 of the CRUD audit-trail improvement: CREATE-only auditing for
// Invoice, APV, OR, CV, PO, Quotation, AR/AP Beginning Balance, and GL
// Beginning Balance. Mirrors the existing JV/Petty Cash/Memo CREATE audit
// convention (logAudit inside the same connection/transaction the CREATE
// itself uses, curated afterData, the already-resolved companyId) - no
// new audit architecture, action is always "CREATE" (not toggled to
// "POST" the way JV/Petty Cash/Memo do it, per this phase's explicit
// instruction), no EDIT/payment/application/VOID/CANCEL/REVERSE/DELETE
// auditing added or modified.

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
    "SELECT id, module, entity_type AS entityType, entity_id AS entityId, action, company_id AS companyId, after_data AS afterData, user_id AS userId FROM audit_logs WHERE module = ? AND entity_id = ? AND action = 'CREATE'",
    [module, entityId]
  );
  return rows;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTCA Company A");
  companyBId = await makeCompany("TESTCA Company B");

  userAId = await makeUser("testca_a", "TestCaPass!A1", 2, companyAId);
  userBId = await makeUser("testca_b", "TestCaPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testca_a", "TestCaPass!A1");
  tokenB = await loginAs("testca_b", "TestCaPass!B1");

  arA = await makeAccount("TESTCA-AR", "TestCA Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTCA-AP", "TestCA Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTCA-REV", "TestCA Revenue", "INCOME");
  custAId = await makeParty("TESTCA-CUST", "CUSTOMER", "TestCA Customer", companyAId);
  suppAId = await makeParty("TESTCA-SUPP", "SUPPLIER", "TestCA Supplier", companyAId);

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
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM or_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
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
    await pool.query("DELETE l FROM gl_beginning_balance_lines l JOIN gl_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM gl_beginning_balance_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTCA-CUST','TESTCA-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTCA-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Invoice CREATE audit", () => {
  test("1. successful create produces exactly one CREATE audit event with correct shape", async () => {
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTCA-INV-1", customerId: custAId, customerName: "TestCA Customer",
      transactionDate: "2026-09-01", totalDebit: 500, totalCredit: 500, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTCA-AR", accountTitle: "AR", particulars: "x", debit: 500, credit: 0 },
        { accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 500 },
      ],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("INV", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("INV");
    expect(rows[0].action).toBe("CREATE");
    expect(rows[0].companyId).toBe(companyAId);
    expect(rows[0].userId).toBe(userAId);
    const after = rows[0].afterData;
    expect(after.voucherNo).toBe("TESTCA-INV-1");
    expect(after.customerName).toBe("TestCA Customer");
    expect(after.status).toBe("Draft");
    expect(Number(after.totalDebit)).toBe(500);
    expect(after.lines).toBeUndefined(); // no line-level snapshot
  });

  test("2. a validation failure (unbalanced lines) creates no CREATE audit event", async () => {
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV'");
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTCA-INV-BAD", customerId: custAId, customerName: "TestCA Customer",
      transactionDate: "2026-09-01", totalDebit: 500, totalCredit: 500, status: "Draft",
      lines: [{ accountId: arA, accountCode: "TESTCA-AR", accountTitle: "AR", particulars: "x", debit: 500, credit: 0 }],
    });
    expect(c.status).toBe(400);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });
});

describe("APV CREATE audit", () => {
  test("3. successful create produces exactly one CREATE audit event under APV's existing TRANSACTIONS module", async () => {
    const c = await request(app).post("/api/apv").set(auth(tokenA)).send({
      voucherNo: "TESTCA-APV-1", supplierId: suppAId, supplierName: "TestCA Supplier",
      transactionDate: "2026-09-01", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Expense", particulars: "x", debit: 400, credit: 0 },
        { accountId: apA, accountCode: "TESTCA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 400 },
      ],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("TRANSACTIONS", c.body.id);
    const apvRows = rows.filter((r) => r.entityType === "APV");
    expect(apvRows).toHaveLength(1);
    expect(apvRows[0].companyId).toBe(companyAId);
    const after = apvRows[0].afterData;
    expect(after.voucherNo).toBe("TESTCA-APV-1");
    expect(after.supplierName).toBe("TestCA Supplier");
  });
});

describe("OR CREATE audit", () => {
  test("4. successful create produces exactly one CREATE audit event under OR's existing TRANSACTIONS.OR module", async () => {
    const c = await request(app).post("/api/or").set(auth(tokenA)).send({
      voucherNo: "TESTCA-OR-1", customerId: custAId, customerName: "TestCA Customer",
      transactionDate: "2026-09-01", totalDebit: 300, totalCredit: 300, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTCA-AR", accountTitle: "Cash", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("TRANSACTIONS.OR", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("OR");
    const after = rows[0].afterData;
    expect(after.voucherNo).toBe("TESTCA-OR-1");
  });
});

describe("CV CREATE audit", () => {
  test("5. successful create produces exactly one CREATE audit event under CV's existing TRANSACTIONS module", async () => {
    const c = await request(app).post("/api/cv").set(auth(tokenA)).send({
      voucherNo: "TESTCA-CV-1", payeeId: suppAId, payeeName: "TestCA Supplier",
      transactionDate: "2026-09-01", totalDebit: 250, totalCredit: 250, status: "Draft",
      lines: [
        { accountId: apA, accountCode: "TESTCA-AP", accountTitle: "AP", particulars: "x", debit: 250, credit: 0 },
        { accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Cash", particulars: "x", debit: 0, credit: 250 },
      ],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("TRANSACTIONS", c.body.id);
    const cvRows = rows.filter((r) => r.entityType === "CV");
    expect(cvRows).toHaveLength(1);
    expect(cvRows[0].afterData.payeeName).toBe("TestCA Supplier");
  });
});

describe("PO CREATE audit", () => {
  test("6. successful create produces exactly one CREATE audit event under module PO", async () => {
    const c = await request(app).post("/api/purchase-orders").set(auth(tokenA)).send({
      voucherNo: "TESTCA-PO-1", supplierId: suppAId, supplierName: "TestCA Supplier",
      transactionDate: "2026-09-01", totalCredit: 600, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Expense", particulars: "x", debit: 600, credit: 0 },
        { accountId: apA, accountCode: "TESTCA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 600 },
      ],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("PO", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].afterData.supplierName).toBe("TestCA Supplier");
  });
});

describe("Quotation CREATE audit", () => {
  test("7. successful create produces exactly one CREATE audit event under module QUOTATION", async () => {
    const c = await request(app).post("/api/quotations").set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestCA Customer",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 700,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 700, taxRate: 0, amount: 700, accountId: revA, accountCode: "TESTCA-REV", accountTitle: "Rev" }],
    });
    expect(c.status).toBe(200);
    const rows = await auditRowsFor("QUOTATION", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].afterData.quotationNo).toBe(c.body.quotationNo);
    expect(rows[0].afterData.customerName).toBe("TestCA Customer");
    expect(rows[0].afterData.currencyCode).toBeUndefined(); // quotation has no currency concept
  });
});

describe("AR/AP Beginning Balance CREATE audit", () => {
  test("8. AR beginning balance line create is audited under module AR_BEGINNING", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AR", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: custAId, partyName: "TestCA Customer", accountId: arA, accountCode: "TESTCA-AR", accountTitle: "AR", referenceNo: "CA-AR-REF-1", debit: 900, credit: 0 },
    });
    expect(c.status).toBe(200);
    const [[line]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "CA-AR-REF-1"]
    );
    const rows = await auditRowsFor("AR_BEGINNING", line.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].afterData.partyName).toBe("TestCA Customer");
    expect(Number(rows[0].afterData.debit)).toBe(900);
  });

  test("9. AP beginning balance line create is audited under module AP_BEGINNING (proves the module is picked from the row's own balanceType)", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AP", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: suppAId, partyName: "TestCA Supplier", accountId: apA, accountCode: "TESTCA-AP", accountTitle: "AP", referenceNo: "CA-AP-REF-1", debit: 0, credit: 500 },
    });
    expect(c.status).toBe(200);
    const [[line]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "CA-AP-REF-1"]
    );
    const rows = await auditRowsFor("AP_BEGINNING", line.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].afterData.partyName).toBe("TestCA Supplier");
    expect(Number(rows[0].afterData.credit)).toBe(500);
  });
});

describe("GL Beginning Balance CREATE audit", () => {
  test("10. batch create is audited once under module GL_BEGINNING, keyed by the returned headerId", async () => {
    const c = await request(app).post("/api/gl-beginning-balances").set(auth(tokenA)).send({
      header: { date: "2026-09-01", companyId: companyAId, currency: "PHP" },
      rows: [
        { accountId: arA, code: "TESTCA-AR", title: "AR", debit: 1000, credit: 0 },
        { accountId: revA, code: "TESTCA-REV", title: "Rev", debit: 0, credit: 1000 },
      ],
    });
    expect(c.status).toBe(200);
    expect(c.body.headerId).toBeTruthy();

    const rows = await auditRowsFor("GL_BEGINNING", c.body.headerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(companyAId);
    expect(rows[0].afterData.lineCount).toBe(2);
    expect(Number(rows[0].afterData.totalDebit)).toBe(1000);
  });

  test("11. an unbalanced GL beginning balance batch fails and creates no CREATE audit event", async () => {
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'GL_BEGINNING'");
    const c = await request(app).post("/api/gl-beginning-balances").set(auth(tokenA)).send({
      header: { date: "2026-09-05", companyId: companyAId, currency: "PHP" },
      rows: [{ accountId: arA, code: "TESTCA-AR", title: "AR", debit: 999, credit: 0 }],
    });
    expect(c.status).toBe(400);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'GL_BEGINNING'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });
});

describe("Company scope for the new CREATE audit events", () => {
  test("12. Company B cannot see Company A's new CREATE audit events, and vice versa", async () => {
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "INV" });
    expect(asB.body.some((r) => r.afterData && r.afterData.voucherNo === "TESTCA-INV-1")).toBe(false);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "INV" });
    expect(asA.body.some((r) => r.afterData && r.afterData.voucherNo === "TESTCA-INV-1")).toBe(true);
  });

  test("13. GET /api/audit-logs filters (module, limit) remain functional", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "PO", limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(3);
    expect(res.body.every((r) => r.module === "PO")).toBe(true);
  });
});

describe("Existing behavior remains unchanged", () => {
  test("14. existing JV/Petty Cash CREATE audit source code is byte-unchanged by this phase", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "JV",\s*\n\s*entityType: "JV",\s*\n\s*entityId: jvId,\s*\n\s*companyId,\s*\n\s*action: isPosting \? "POST" : "CREATE",/);
    expect(src).toMatch(/module: "PETTY_CASH",\s*\n\s*entityType: "PETTY_CASH",\s*\n\s*entityId: pettyCashId,\s*\n\s*companyId,\s*\n\s*action: isPosting \? "POST" : "CREATE",/);
  });

  test("15. existing DELETE audit source code (Phase 1) is byte-unchanged by this phase", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
  });
});
