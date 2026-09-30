const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 3 of the CRUD audit-trail improvement: EDIT-only auditing for
// Invoice, APV, OR, CV, PO, Quotation, and AR/AP Beginning Balance.
// GL Beginning Balance has no EDIT route (GET/POST only - confirmed by
// direct search of server.js) and is deliberately not tested here.
// action is always the literal "EDIT" (not toggled to "POST"/"UPDATE" the
// way JV/Petty Cash/Memo's own pre-existing EDIT audit convention does it),
// matching how Phase 2 used a literal "CREATE". OR/CV EDIT routes also
// reverse/reapply payment applications (applyInvoicePayment/applyApvPayment)
// as part of their normal behavior - that is explicitly out of scope this
// phase, so only the document-level EDIT event is asserted, never anything
// about the application side effects.

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

async function editAuditRowsFor(module, entityId) {
  const [rows] = await pool.query(
    "SELECT id, module, entity_type AS entityType, entity_id AS entityId, action, company_id AS companyId, before_data AS beforeData, after_data AS afterData, user_id AS userId FROM audit_logs WHERE module = ? AND entity_id = ? AND action = 'EDIT'",
    [module, entityId]
  );
  return rows;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTEA Company A");
  companyBId = await makeCompany("TESTEA Company B");

  userAId = await makeUser("testea_a", "TestEaPass!A1", 2, companyAId);
  userBId = await makeUser("testea_b", "TestEaPass!B1", 2, companyBId);
  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testea_a", "TestEaPass!A1");
  tokenB = await loginAs("testea_b", "TestEaPass!B1");

  arA = await makeAccount("TESTEA-AR", "TestEA Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTEA-AP", "TestEA Accounts Payable", "LIABILITY");
  revA = await makeAccount("TESTEA-REV", "TestEA Revenue", "INCOME");
  custAId = await makeParty("TESTEA-CUST", "CUSTOMER", "TestEA Customer", companyAId);
  suppAId = await makeParty("TESTEA-SUPP", "SUPPLIER", "TestEA Supplier", companyAId);

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
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('TESTEA-CUST','TESTEA-SUPP')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTEA-%'");
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("Invoice EDIT audit", () => {
  let invoiceId;

  test("1. successful edit produces exactly one EDIT audit event with correct shape", async () => {
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTEA-INV-1", customerId: custAId, customerName: "TestEA Customer",
      transactionDate: "2026-09-01", totalDebit: 500, totalCredit: 500, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", particulars: "x", debit: 500, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 500 },
      ],
    });
    expect(c.status).toBe(200);
    invoiceId = c.body.id;

    const u = await request(app).put(`/api/invoices/${invoiceId}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-INV-1", customerId: custAId, customerName: "TestEA Customer Updated",
      transactionDate: "2026-09-01", totalDebit: 700, totalCredit: 700, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", particulars: "x", debit: 700, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 700 },
      ],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("INV", invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("INV");
    expect(rows[0].companyId).toBe(companyAId);
    expect(rows[0].userId).toBe(userAId);
    expect(rows[0].beforeData.customerName).toBe("TestEA Customer");
    expect(Number(rows[0].beforeData.totalDebit)).toBe(500);
    expect(rows[0].afterData.customerName).toBe("TestEA Customer Updated");
    expect(Number(rows[0].afterData.totalDebit)).toBe(700);
    expect(rows[0].afterData.lines).toBeUndefined();
  });

  test("2. a failed edit (unbalanced lines) creates no EDIT audit event", async () => {
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV' AND action = 'EDIT'");
    const u = await request(app).put(`/api/invoices/${invoiceId}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-INV-1", customerId: custAId, customerName: "TestEA Customer Updated",
      transactionDate: "2026-09-01", totalDebit: 700, totalCredit: 700, status: "Draft",
      lines: [{ accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", particulars: "x", debit: 700, credit: 0 }],
    });
    expect(u.status).toBe(400);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV' AND action = 'EDIT'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });

  test("3. editing a Posted invoice is rejected and creates no EDIT audit event", async () => {
    const c = await request(app).post("/api/invoices").set(auth(tokenA)).send({
      voucherNo: "TESTEA-INV-POSTED", customerId: custAId, customerName: "TestEA Customer",
      transactionDate: "2026-09-01", totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(c.status).toBe(200);
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV' AND action = 'EDIT'");
    const u = await request(app).put(`/api/invoices/${c.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-INV-POSTED", customerId: custAId, customerName: "Should Not Apply",
      transactionDate: "2026-09-01", totalDebit: 100, totalCredit: 100, status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 100 },
      ],
    });
    expect(u.status).toBe(409);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'INV' AND action = 'EDIT'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });
});

describe("APV EDIT audit", () => {
  test("4. successful edit produces exactly one EDIT audit event under APV's TRANSACTIONS module", async () => {
    const c = await request(app).post("/api/apv").set(auth(tokenA)).send({
      voucherNo: "TESTEA-APV-1", supplierId: suppAId, supplierName: "TestEA Supplier",
      transactionDate: "2026-09-01", totalDebit: 400, totalCredit: 400, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Expense", particulars: "x", debit: 400, credit: 0 },
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 400 },
      ],
    });
    expect(c.status).toBe(200);

    const u = await request(app).put(`/api/apv/${c.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-APV-1", supplierId: suppAId, supplierName: "TestEA Supplier Updated",
      transactionDate: "2026-09-01", totalDebit: 450, totalCredit: 450, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Expense", particulars: "x", debit: 450, credit: 0 },
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 450 },
      ],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("TRANSACTIONS", c.body.id);
    const apvRows = rows.filter((r) => r.entityType === "APV");
    expect(apvRows).toHaveLength(1);
    expect(apvRows[0].beforeData.supplierName).toBe("TestEA Supplier");
    expect(apvRows[0].afterData.supplierName).toBe("TestEA Supplier Updated");
  });
});

describe("OR EDIT audit", () => {
  test("5. successful edit produces exactly one EDIT audit event under OR's TRANSACTIONS.OR module, without describing payment applications", async () => {
    const c = await request(app).post("/api/or").set(auth(tokenA)).send({
      voucherNo: "TESTEA-OR-1", customerId: custAId, customerName: "TestEA Customer",
      transactionDate: "2026-09-01", totalDebit: 300, totalCredit: 300, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "Cash", particulars: "x", debit: 300, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 300 },
      ],
    });
    expect(c.status).toBe(200);

    const u = await request(app).put(`/api/or/${c.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-OR-1", customerId: custAId, customerName: "TestEA Customer Updated",
      transactionDate: "2026-09-01", totalDebit: 320, totalCredit: 320, status: "Draft",
      lines: [
        { accountId: arA, accountCode: "TESTEA-AR", accountTitle: "Cash", particulars: "x", debit: 320, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: 320 },
      ],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("TRANSACTIONS.OR", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe("OR");
    expect(rows[0].afterData.customerName).toBe("TestEA Customer Updated");
    expect(rows[0].afterData.invoiceApplications).toBeUndefined();
    expect(rows[0].beforeData.invoiceApplications).toBeUndefined();
  });
});

describe("CV EDIT audit", () => {
  test("6. successful edit produces exactly one EDIT audit event under CV's TRANSACTIONS module, without describing payment applications", async () => {
    const c = await request(app).post("/api/cv").set(auth(tokenA)).send({
      voucherNo: "TESTEA-CV-1", payeeId: suppAId, payeeName: "TestEA Supplier",
      transactionDate: "2026-09-01", totalDebit: 250, totalCredit: 250, status: "Draft",
      lines: [
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 250, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Cash", particulars: "x", debit: 0, credit: 250 },
      ],
    });
    expect(c.status).toBe(200);

    const u = await request(app).put(`/api/cv/${c.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-CV-1", payeeId: suppAId, payeeName: "TestEA Supplier Updated",
      transactionDate: "2026-09-01", totalDebit: 260, totalCredit: 260, status: "Draft",
      lines: [
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 260, credit: 0 },
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Cash", particulars: "x", debit: 0, credit: 260 },
      ],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("TRANSACTIONS", c.body.id);
    const cvRows = rows.filter((r) => r.entityType === "CV");
    expect(cvRows).toHaveLength(1);
    expect(cvRows[0].afterData.payeeName).toBe("TestEA Supplier Updated");
    expect(cvRows[0].afterData.apvApplications).toBeUndefined();
  });
});

describe("PO EDIT audit", () => {
  test("7. successful edit produces exactly one EDIT audit event under module PO", async () => {
    const c = await request(app).post("/api/purchase-orders").set(auth(tokenA)).send({
      voucherNo: "TESTEA-PO-1", supplierId: suppAId, supplierName: "TestEA Supplier",
      transactionDate: "2026-09-01", totalCredit: 600, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Expense", particulars: "x", debit: 600, credit: 0 },
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 600 },
      ],
    });
    expect(c.status).toBe(200);

    const u = await request(app).put(`/api/purchase-orders/${c.body.id}`).set(auth(tokenA)).send({
      voucherNo: "TESTEA-PO-1", supplierId: suppAId, supplierName: "TestEA Supplier Updated",
      transactionDate: "2026-09-01", totalCredit: 650, status: "Draft",
      lines: [
        { accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Expense", particulars: "x", debit: 650, credit: 0 },
        { accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: 650 },
      ],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("PO", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].afterData.supplierName).toBe("TestEA Supplier Updated");
  });
});

describe("Quotation EDIT audit", () => {
  test("8. successful edit produces exactly one EDIT audit event under module QUOTATION", async () => {
    const c = await request(app).post("/api/quotations").set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestEA Customer",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 700,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 700, taxRate: 0, amount: 700, accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev" }],
    });
    expect(c.status).toBe(200);

    const u = await request(app).put(`/api/quotations/${c.body.id}`).set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestEA Customer Updated",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 750,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 750, taxRate: 0, amount: 750, accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev" }],
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("QUOTATION", c.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.customerName).toBe("TestEA Customer");
    expect(rows[0].afterData.customerName).toBe("TestEA Customer Updated");
    expect(Number(rows[0].afterData.totalAmount)).toBe(750);
    expect(rows[0].afterData.currencyCode).toBeUndefined();
  });

  test("9. editing a Converted quotation is rejected and creates no EDIT audit event", async () => {
    // The CREATE route only ever stores status "Sent" or "Draft" - a
    // quotation only reaches "Converted" via the separate (untouched)
    // convert-to-invoice route, so that terminal state is set directly here
    // to exercise the EDIT route's own guard in isolation.
    const c = await request(app).post("/api/quotations").set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "TestEA Customer",
      quotationDate: "2026-09-01", status: "Draft", totalAmount: 100,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 100, taxRate: 0, amount: 100, accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev" }],
    });
    expect(c.status).toBe(200);
    await pool.execute("UPDATE quotation_headers SET status = 'Converted' WHERE id = ?", [c.body.id]);
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'QUOTATION' AND action = 'EDIT'");
    const u = await request(app).put(`/api/quotations/${c.body.id}`).set(auth(tokenA)).send({
      companyId: companyAId, customerId: custAId, customerName: "Should Not Apply",
      quotationDate: "2026-09-01", status: "Converted", totalAmount: 999,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitLabel: "Units", unitPrice: 999, taxRate: 0, amount: 999, accountId: revA, accountCode: "TESTEA-REV", accountTitle: "Rev" }],
    });
    expect(u.status).toBe(400);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE module = 'QUOTATION' AND action = 'EDIT'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });
});

describe("AR/AP Beginning Balance EDIT audit", () => {
  test("10. AR beginning balance line edit is audited under module AR_BEGINNING", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AR", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: custAId, partyName: "TestEA Customer", accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", referenceNo: "EA-AR-REF-1", debit: 900, credit: 0 },
    });
    expect(c.status).toBe(200);
    const [[lineRow]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "EA-AR-REF-1"]
    );

    const u = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineRow.id, partyId: custAId, partyName: "TestEA Customer Updated", accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", referenceNo: "EA-AR-REF-1", debit: 950, credit: 0, balanceAmount: 950, dueDate: "2026-09-01" },
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("AR_BEGINNING", lineRow.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.partyName).toBe("TestEA Customer");
    expect(Number(rows[0].beforeData.debit)).toBe(900);
    expect(rows[0].afterData.partyName).toBe("TestEA Customer Updated");
    expect(Number(rows[0].afterData.debit)).toBe(950);
  });

  test("11. AP beginning balance line edit is audited under module AP_BEGINNING (proves the module is picked from the row's own balanceType)", async () => {
    const c = await request(app).post("/api/arap-beginning-balances").set(auth(tokenA)).send({
      balanceType: "AP", balanceDate: "2026-09-01", currencyCode: "PHP", currencyName: "Philippine Peso",
      line: { partyId: suppAId, partyName: "TestEA Supplier", accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", referenceNo: "EA-AP-REF-1", debit: 0, credit: 500 },
    });
    expect(c.status).toBe(200);
    const [[lineRow]] = await pool.query(
      "SELECT l.id FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE h.company_id = ? AND l.reference_no = ?",
      [companyAId, "EA-AP-REF-1"]
    );

    const u = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: lineRow.id, partyId: suppAId, partyName: "TestEA Supplier Updated", accountId: apA, accountCode: "TESTEA-AP", accountTitle: "AP", referenceNo: "EA-AP-REF-1", debit: 0, credit: 550, balanceAmount: 550, dueDate: "2026-09-01" },
    });
    expect(u.status).toBe(200);

    const rows = await editAuditRowsFor("AP_BEGINNING", lineRow.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeData.partyName).toBe("TestEA Supplier");
    expect(rows[0].afterData.partyName).toBe("TestEA Supplier Updated");
    expect(Number(rows[0].afterData.credit)).toBe(550);
  });

  test("12. editing a nonexistent beginning balance line creates no EDIT audit event", async () => {
    const before = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE (module = 'AR_BEGINNING' OR module = 'AP_BEGINNING') AND action = 'EDIT'");
    const u = await request(app).put("/api/arap-beginning-balances").set(auth(tokenA)).send({
      line: { id: 999999999, partyId: custAId, partyName: "Ghost", accountId: arA, accountCode: "TESTEA-AR", accountTitle: "AR", referenceNo: "GHOST", debit: 1, credit: 0 },
    });
    expect(u.status).toBe(404);
    const after = await pool.query("SELECT COUNT(*) c FROM audit_logs WHERE (module = 'AR_BEGINNING' OR module = 'AP_BEGINNING') AND action = 'EDIT'");
    expect(after[0][0].c).toBe(before[0][0].c);
  });
});

describe("GL Beginning Balance has no EDIT route", () => {
  test("13. no PUT route exists for gl-beginning-balances (documented as skipped/nonexistent, not implemented)", async () => {
    const res = await request(app).put("/api/gl-beginning-balances").set(auth(tokenA)).send({});
    expect([404, 405]).toContain(res.status);
  });
});

describe("Company scope for the new EDIT audit events", () => {
  test("14. Company B cannot see Company A's new EDIT audit events, and vice versa", async () => {
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "INV", action: "EDIT" });
    expect(asB.body.some((r) => r.afterData && r.afterData.customerName === "TestEA Customer Updated")).toBe(false);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "INV", action: "EDIT" });
    expect(asA.body.some((r) => r.afterData && r.afterData.customerName === "TestEA Customer Updated")).toBe(true);
  });

  test("15. GET /api/audit-logs filters (module, limit) remain functional for EDIT rows", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "PO", limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(3);
    expect(res.body.every((r) => r.module === "PO")).toBe(true);
  });
});

describe("Existing behavior remains unchanged", () => {
  test("16. CREATE audit coverage (Phase 2) remains intact - source assertions", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: invoiceId,\s*\n\s*companyId,\s*\n\s*action: "CREATE",/);
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: quotationId,\s*\n\s*companyId,\s*\n\s*action: "CREATE",/);
  });

  test("17. DELETE audit coverage (Phase 1) remains intact - source assertions", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "INV",\s*\n\s*entityType: "INV",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
    expect(src).toMatch(/module: "QUOTATION",\s*\n\s*entityType: "QUOTATION",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: "DELETE",/);
  });

  test("18. existing JV/Petty Cash EDIT (POST/UPDATE toggle) audit source code is byte-unchanged by this phase", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../server.js"), "utf8");
    expect(src).toMatch(/module: "JV",\s*\n\s*entityType: "JV",\s*\n\s*entityId: Number\(id\),\s*\n\s*companyId,\s*\n\s*action: isPostingNow \? "POST" : "UPDATE",/);
  });
});
