const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 1 print-completeness checkpoint: the OR print pipeline previously
// never queried transaction_applications at all, so an OR that settled one
// or more Invoices printed with no record of what it was actually paying
// for. This file proves the new getAppliedInvoices()/resolveCurrencyForDisplay()
// data path in transactionPrintDataService.js: applied-invoice data is
// correct, company-isolated, and a direct OR (no applications) still
// prints cleanly with nothing invented.

jest.setTimeout(180000);

let companyAId, companyBId;
let tokenA, tokenB, adminAId, adminBId;
let cashA, arA, revA;
let custAId, custBId;
let usdId;
const createdInvoiceIds = [];
const createdOrIds = [];

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
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, cls) {
  const [existing] = await pool.execute("SELECT id FROM chart_of_accounts WHERE code = ?", [code]);
  if (existing.length) return existing[0].id;
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
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

  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTPRTX%'");
  await pool.execute("DELETE FROM companies WHERE name LIKE 'TEST Print Applications%'");

  companyAId = await makeCompany("TEST Print Applications Co A");
  companyBId = await makeCompany("TEST Print Applications Co B");
  adminAId = await makeLoginUser("test_prtx_admin_a", "PrtxPass!A1", 2, companyAId);
  adminBId = await makeLoginUser("test_prtx_admin_b", "PrtxPass!B1", 2, companyBId);
  tokenA = await loginAs("test_prtx_admin_a", "PrtxPass!A1");
  tokenB = await loginAs("test_prtx_admin_b", "PrtxPass!B1");

  cashA = await makeAccount("TESTPRTXCASH", "Cash (Print Test)", "ASSET");
  arA = await makeAccount("TESTPRTXAR", "Accounts Receivable (Print Test)", "ASSET");
  revA = await makeAccount("TESTPRTXREV", "Revenue (Print Test)", "INCOME");

  custAId = await makeParty("TESTPRTX-CUSTA", "CUSTOMER", "Print Test Customer A", companyAId);
  custBId = await makeParty("TESTPRTX-CUSTB", "CUSTOMER", "Print Test Customer B", companyBId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: adminBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
  const usd = await CurrencyService.createCurrency({ id: adminAId, roleCode: "ADMIN" }, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyAId,
  });
  usdId = usd.id;
  await CurrencyService.recordRate({ id: adminAId, roleCode: "ADMIN" }, usdId, { rateMode: "MANUAL", rate: 56.0, effectiveDate: "2026-08-01" });
});

afterAll(async () => {
  if (createdOrIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'OR' AND applied_id IN (?)", [createdOrIds]);
    await pool.query("DELETE FROM or_lines WHERE or_id IN (?)", [createdOrIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'OR' AND transaction_id IN (?)", [createdOrIds]);
    await pool.query("DELETE FROM or_headers WHERE id IN (?)", [createdOrIds]);
  }
  if (createdInvoiceIds.length) {
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [createdInvoiceIds]);
  }
  await pool.execute("DELETE FROM currency_rates WHERE currency_id = ?", [usdId]);
  await pool.execute("DELETE FROM currencies WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.execute("DELETE FROM general_libraries WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTPRTX%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [adminAId, adminBId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminAId, adminBId]);
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

async function createPostedInvoice(token, { voucherNo, customerId, amount, companyId }) {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({
      voucherNo, customerId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
      status: "Posted",
      lines: [
        { accountId: arA, accountCode: "TESTPRTXAR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
        { accountId: revA, accountCode: "TESTPRTXREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId },
    });
  if (res.status !== 200 || !res.body.success) throw new Error(`Invoice create failed: ${JSON.stringify(res.body)}`);
  createdInvoiceIds.push(res.body.id);
  return res.body.id;
}

async function createDirectOR(token, { voucherNo, customerId, amount, companyId }) {
  const res = await request(app)
    .post("/api/or")
    .set("Authorization", `Bearer ${token}`)
    .send({
      voucherNo, customerId, customerName: "x", transactionDate: "2026-08-05", status: "Posted",
      lines: [
        { accountId: cashA, accountCode: "TESTPRTXCASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
        { accountId: arA, accountCode: "TESTPRTXAR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId },
    });
  if (res.status !== 200 || !res.body.success) throw new Error(`OR create failed: ${JSON.stringify(res.body)}`);
  createdOrIds.push(res.body.id);
  return res.body.id;
}

async function createSettlingOR(token, { voucherNo, customerId, amount, companyId, invoiceApplications }) {
  const res = await request(app)
    .post("/api/or")
    .set("Authorization", `Bearer ${token}`)
    .send({
      voucherNo, customerId, customerName: "x", transactionDate: "2026-08-05", status: "Posted",
      lines: [
        { accountId: cashA, accountCode: "TESTPRTXCASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
        { accountId: arA, accountCode: "TESTPRTXAR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId },
      invoiceApplications,
    });
  if (res.status !== 200 || !res.body.success) throw new Error(`Settling OR create failed: ${JSON.stringify(res.body)}`);
  createdOrIds.push(res.body.id);
  return res.body.id;
}

describe("1: OR with one applied Invoice", () => {
  test("print data includes exactly one correctly-populated applied invoice row", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-1", customerId: custAId, amount: 5000, companyId: companyAId });
    const orId = await createSettlingOR(tokenA, {
      voucherNo: "TESTPRTX-OR-1", customerId: custAId, amount: 5000, companyId: companyAId,
      invoiceApplications: [{ sourceId: invId, amount: 5000, applicationDate: "2026-08-05" }],
    });

    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toHaveLength(1);
    expect(res.body.appliedInvoices[0].invoiceNo).toBe("TESTPRTX-INV-1");
    expect(res.body.appliedInvoices[0].invoiceAmount).toBe(5000);
    expect(res.body.appliedInvoices[0].amountPaid).toBe(5000);
    expect(res.body.appliedInvoices[0].description).toMatch(/TESTPRTX-INV-1/);
  });
});

describe("2: OR with multiple applied Invoices", () => {
  test("print data includes every applied invoice with the correct per-row amount", async () => {
    const inv1 = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-2A", customerId: custAId, amount: 3000, companyId: companyAId });
    const inv2 = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-2B", customerId: custAId, amount: 2000, companyId: companyAId });
    const orId = await createSettlingOR(tokenA, {
      voucherNo: "TESTPRTX-OR-2", customerId: custAId, amount: 5000, companyId: companyAId,
      invoiceApplications: [
        { sourceId: inv1, amount: 3000, applicationDate: "2026-08-05" },
        { sourceId: inv2, amount: 2000, applicationDate: "2026-08-05" },
      ],
    });

    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toHaveLength(2);
    const byVoucher = Object.fromEntries(res.body.appliedInvoices.map((a) => [a.invoiceNo, a]));
    expect(byVoucher["TESTPRTX-INV-2A"].amountPaid).toBe(3000);
    expect(byVoucher["TESTPRTX-INV-2B"].amountPaid).toBe(2000);
  });
});

describe("3: direct OR with no applications", () => {
  test("print data has an empty appliedInvoices array, nothing invented", async () => {
    const orId = await createDirectOR(tokenA, { voucherNo: "TESTPRTX-OR-3", customerId: custAId, amount: 1500, companyId: companyAId });

    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toEqual([]);
  });

  test("Invoice print (a module with no applied-invoice concept) has appliedInvoices: null, not an empty array or an error", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-3", customerId: custAId, amount: 1000, companyId: companyAId });
    const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.appliedInvoices).toBeNull();
  });
});

describe("4: cross-company application data cannot leak into print", () => {
  test("a raw cross-company transaction_applications row is excluded from the print payload", async () => {
    // Simulates a hypothetical data-integrity anomaly (the normal API path
    // already refuses to create a genuine cross-company application - see
    // paymentApplicationService.js's own company check) by inserting the
    // row directly, bypassing application logic entirely. This proves the
    // print QUERY's own defense-in-depth company filter actually does
    // something, not just that upstream creation-time validation exists.
    const orId = await createDirectOR(tokenA, { voucherNo: "TESTPRTX-OR-4", customerId: custAId, amount: 800, companyId: companyAId });
    const foreignInvId = await createPostedInvoice(tokenB, { voucherNo: "TESTPRTX-INV-4-B", customerId: custBId, amount: 800, companyId: companyBId });

    await pool.execute(
      `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date)
       VALUES ('INV', ?, 'OR', ?, 800, '2026-08-05')`,
      [foreignInvId, orId]
    );

    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    // The cross-company application row exists in the table but must never
    // surface in the print payload - the JOIN's own ih.company_id filter
    // excludes it since foreignInvId belongs to companyBId, not companyAId.
    expect(res.body.appliedInvoices).toEqual([]);

    await pool.execute("DELETE FROM transaction_applications WHERE applied_type = 'OR' AND applied_id = ? AND source_id = ?", [orId, foreignInvId]);
  });

  test("Company B cannot print Company A's OR at all (existing company-scope guard, unchanged)", async () => {
    const orId = await createDirectOR(tokenA, { voucherNo: "TESTPRTX-OR-4B", customerId: custAId, amount: 400, companyId: companyAId });
    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenB}`).query({ mode: "without_entries", companyId: companyBId });
    expect(res.status).toBe(404);
  });
});

describe("7-8: currency display", () => {
  test("base-currency OR now returns a populated, non-foreign currency object", async () => {
    const orId = await createDirectOR(tokenA, { voucherNo: "TESTPRTX-OR-7", customerId: custAId, amount: 900, companyId: companyAId });
    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.doc.currency).not.toBeNull();
    expect(res.body.doc.currency.isForeign).toBe(false);
    expect(res.body.doc.currency.currencyCode).toBe("PHP");
    expect(res.body.doc.currency.currencyName).toBe("Philippine Peso");
  });

  test("foreign-currency Invoice still returns isForeign: true with rate/name populated", async () => {
    const res0 = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        voucherNo: "TESTPRTX-INV-8", customerId: custAId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
        status: "Posted",
        lines: [
          { accountId: arA, accountCode: "TESTPRTXAR", accountTitle: "AR", particulars: "x", debit: 100, credit: 0 },
          { accountId: revA, accountCode: "TESTPRTXREV", accountTitle: "Revenue", particulars: "x", debit: 0, credit: 100 },
        ],
        totalDebit: 100, totalCredit: 100, currency: { companyId: companyAId, currencyId: usdId },
      });
    expect(res0.body.success).toBe(true);
    createdInvoiceIds.push(res0.body.id);

    const res = await request(app).get(`/api/print/invoice/${res0.body.id}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.doc.currency.isForeign).toBe(true);
    expect(res.body.doc.currency.currencyCode).toBe("USD");
    expect(res.body.doc.currency.currencyName).toBe("US Dollar");
    expect(Number(res.body.doc.currency.exchangeRate)).toBeCloseTo(56, 5);
  });
});

describe("13-14: Invoice and OR print regression", () => {
  test("Invoice print still returns every previously-existing field unchanged", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-13", customerId: custAId, amount: 2500, companyId: companyAId });
    const res = await request(app).get(`/api/print/invoice/${invId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "without_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.doc.voucherNo).toBe("TESTPRTX-INV-13");
    expect(Number(res.body.doc.totalDebit)).toBe(2500);
    expect(res.body.party.name).toBe("Print Test Customer A");
    expect(res.body.lines.length).toBeGreaterThan(0);
  });

  test("OR print with entries still returns entriesSummary balanced, applied invoices alongside it", async () => {
    const invId = await createPostedInvoice(tokenA, { voucherNo: "TESTPRTX-INV-14", customerId: custAId, amount: 1200, companyId: companyAId });
    const orId = await createSettlingOR(tokenA, {
      voucherNo: "TESTPRTX-OR-14", customerId: custAId, amount: 1200, companyId: companyAId,
      invoiceApplications: [{ sourceId: invId, amount: 1200, applicationDate: "2026-08-05" }],
    });
    const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${tokenA}`).query({ mode: "with_entries", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.entriesSummary.balanced).toBe(true);
    expect(res.body.appliedInvoices).toHaveLength(1);
  });
});
