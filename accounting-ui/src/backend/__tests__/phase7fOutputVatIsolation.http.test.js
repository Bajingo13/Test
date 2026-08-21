const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Checkpoint 7F: /api/reports/output-vat previously had NO company_id filter
// at all on either UNION branch (invoice_lines/invoice_headers, or_lines/
// or_headers) - the same class of cross-company leak Checkpoint 6A fixed for
// Income Statement, confirmed during the Checkpoint 7 pre-deployment review.
// It also had no Posted-only predicate, unlike every other financial report
// (Checkpoint 6B's postedOnlySql) - Draft transactions were leaking into a
// report that must reflect only financially-recognized entries. Both are
// fixed together and covered here.

jest.setTimeout(120000);

let companyA, companyB;
let userId, token;
let outputVatAccountId, arId, salesId, cashId;
let custAId, custBId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function makeParty(companyId, code, name) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, 'CUSTOMER', ?, 'ACTIVE')",
    [companyId, code, name]
  );
  return result.insertId;
}

function invoiceLines({ gross, vatAmount }) {
  const net = gross - vatAmount;
  return [
    { accountId: arId, accountCode: "PH7F-AR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "", genName: "", debit: gross, credit: 0 },
    { accountId: salesId, accountCode: "PH7F-SALES", accountTitle: "Sales Revenue", particulars: "Sales", genRef: "", genName: "", debit: 0, credit: net },
    { accountId: outputVatAccountId, accountCode: "PH7F-OUTVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)", genRef: "", genName: "", debit: 0, credit: vatAmount },
  ];
}

async function createInvoice({ companyId, customerId, customerName, voucherNo, date, gross, vatAmount, status }) {
  return request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
    voucherNo, customerId, customerName, transactionDate: date, referenceNo: voucherNo,
    description: "Output VAT isolation test invoice", status,
    lines: invoiceLines({ gross, vatAmount }),
    totalDebit: gross, totalCredit: gross,
    currency: { companyId },
  });
}

function orLines({ gross, vatAmount }) {
  const net = gross - vatAmount;
  return [
    { accountId: cashId, accountCode: "PH7F-CASH", accountTitle: "Cash on Hand", particulars: "Cash", genRef: "", genName: "", debit: gross, credit: 0 },
    { accountId: salesId, accountCode: "PH7F-SALES", accountTitle: "Sales Revenue", particulars: "Sales", genRef: "", genName: "", debit: 0, credit: net },
    { accountId: outputVatAccountId, accountCode: "PH7F-OUTVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)", genRef: "", genName: "", debit: 0, credit: vatAmount },
  ];
}

// Direct OR (no invoiceApplications) - a legitimate direct source document
// per the Phase 7D audit, not a settlement of an existing Invoice.
async function createDirectOr({ companyId, customerId, customerName, voucherNo, date, gross, vatAmount, status }) {
  return request(app).post("/api/or").set("Authorization", `Bearer ${token}`).send({
    voucherNo, customerId, customerName, transactionDate: date, referenceNo: voucherNo, receiptNo: voucherNo,
    description: "Output VAT isolation test OR", status, paymentMethod: "Cash",
    lines: orLines({ gross, vatAmount }),
    totalDebit: gross, totalCredit: gross,
    currency: { companyId },
  });
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyA = await makeCompany("PH7F Company A");
  companyB = await makeCompany("PH7F Company B");

  const hash = await bcrypt.hash("Ph7fPass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7f_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyA]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyB]);

  const loginRes = await request(app).post("/api/login").send({ username: "ph7f_admin", password: "Ph7fPass!1" });
  token = loginRes.body.token;

  const adminUser = { id: userId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyA,
  });
  await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyB,
  });

  // chart_of_accounts is a single global catalog, NOT company-scoped (see
  // reportRecognitionService.js/Checkpoint 6A's own comment on this) - the
  // SAME account row/code is used by both companies below deliberately
  // (section 11's "same account code" requirement), proving any isolation
  // observed comes from company_id on invoice_headers/or_headers, never
  // from account-level uniqueness.
  arId = await makeAccount("PH7F-AR", "Accounts Receivable", "ASSET");
  salesId = await makeAccount("PH7F-SALES", "Sales Revenue", "INCOME");
  cashId = await makeAccount("PH7F-CASH", "Cash on Hand", "ASSET");
  outputVatAccountId = await makeAccount("PH7F-OUTVAT", "Output VAT Payable", "LIABILITY");

  custAId = await makeParty(companyA, "PH7F-CUSTA", "Company A Customer");
  custBId = await makeParty(companyB, "PH7F-CUSTB", "Company B Customer");
});

afterAll(async () => {
  // The shared astrea_accounting_test database persists between runs (only
  // npm run db:test:reset wipes it) - clean up everything this file created
  // so a re-run doesn't collide on unique usernames/account codes.
  for (const companyId of [companyA, companyB]) {
    await pool.execute("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [companyId]);
    await pool.execute("DELETE FROM invoice_headers WHERE company_id = ?", [companyId]);
    await pool.execute("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [companyId]);
    await pool.execute("DELETE FROM or_headers WHERE company_id = ?", [companyId]);
    await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
    await pool.execute("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
    await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  }
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username IN ('ph7f_admin', 'ph7f_outsider'))");
  await pool.execute("DELETE FROM users WHERE username IN ('ph7f_admin', 'ph7f_outsider')");
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyA, companyB]);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7F-%'");
  await pool.end();
});

describe("Output VAT report - company isolation (Checkpoint 7F)", () => {
  test("Company A: only Company A's Invoice + direct OR Output VAT entries are visible", async () => {
    await createInvoice({ companyId: companyA, customerId: custAId, customerName: "Company A Customer", voucherNo: "INV-A-1", date: "2026-08-05", gross: 11200, vatAmount: 1200, status: "Posted" });
    await createDirectOr({ companyId: companyA, customerId: custAId, customerName: "Company A Customer", voucherNo: "OR-A-1", date: "2026-08-06", gross: 5600, vatAmount: 600, status: "Posted" });

    await createInvoice({ companyId: companyB, customerId: custBId, customerName: "Company B Customer", voucherNo: "INV-B-1", date: "2026-08-05", gross: 22400, vatAmount: 2400, status: "Posted" });
    await createDirectOr({ companyId: companyB, customerId: custBId, customerName: "Company B Customer", voucherNo: "OR-B-1", date: "2026-08-06", gross: 3360, vatAmount: 360, status: "Posted" });

    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyA });

    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).toEqual(expect.arrayContaining(["INV-A-1", "OR-A-1"]));
    expect(refs).not.toEqual(expect.arrayContaining(["INV-B-1", "OR-B-1"]));

    const totalVat = res.body.reduce((sum, r) => sum + Number(r.credit || 0), 0);
    expect(totalVat).toBeCloseTo(1200 + 600, 2);
  });

  test("Company B: only Company B's entries are visible (same account code as Company A)", async () => {
    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyB });

    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).toEqual(expect.arrayContaining(["INV-B-1", "OR-B-1"]));
    expect(refs).not.toEqual(expect.arrayContaining(["INV-A-1", "OR-A-1"]));

    const totalVat = res.body.reduce((sum, r) => sum + Number(r.credit || 0), 0);
    expect(totalVat).toBeCloseTo(2400 + 360, 2);
  });

  test("Date-range filtering: Company A August query excludes Company A September and Company B August", async () => {
    await createInvoice({ companyId: companyA, customerId: custAId, customerName: "Company A Customer", voucherNo: "INV-A-SEP", date: "2026-09-10", gross: 4480, vatAmount: 480, status: "Posted" });

    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyA });

    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).not.toContain("INV-A-SEP");
    expect(refs).not.toContain("INV-B-1");
    expect(refs).toEqual(expect.arrayContaining(["INV-A-1", "OR-A-1"]));
  });

  test("Draft transactions are excluded (Posted-only policy, previously missing entirely)", async () => {
    await createInvoice({ companyId: companyA, customerId: custAId, customerName: "Company A Customer", voucherNo: "INV-A-DRAFT", date: "2026-08-07", gross: 1120, vatAmount: 120, status: "Draft" });

    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyA });

    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).not.toContain("INV-A-DRAFT");
  });

  test("Security: Company A's report is unaffected by Company B's transaction/customer/account row IDs existing in the same DB", async () => {
    // custBId/companyB's rows are all real, live rows in this same test DB
    // (created above) - this proves isolation is enforced by company_id
    // predicates in the query itself, not by the test data happening not to
    // exist. Re-querying Company A again with no changes must still be
    // exactly the same safe result.
    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyA });

    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).not.toEqual(expect.arrayContaining(["INV-B-1", "OR-B-1"]));
  });

  test("A user cannot pass an arbitrary companyId they don't belong to", async () => {
    const outsiderHash = await bcrypt.hash("Ph7fOutsider!1", 10);
    const [outsiderResult] = await pool.execute(
      "INSERT INTO users (username, password, role_id, status) VALUES ('ph7f_outsider', ?, 2, 'ACTIVE')",
      [outsiderHash]
    );
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [outsiderResult.insertId, companyA]);
    const outsiderLogin = await request(app).post("/api/login").send({ username: "ph7f_outsider", password: "Ph7fOutsider!1" });
    const outsiderToken = outsiderLogin.body.token;

    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyB });

    // resolveCompanyIdForWrite must reject a companyId the caller doesn't
    // belong to - not silently fall back, not return Company B's data.
    expect(res.status).not.toBe(200);
  });

  test("Response shape is unchanged: same columns, running_balance still computed", async () => {
    const res = await request(app)
      .get("/api/reports/output-vat")
      .set("Authorization", `Bearer ${token}`)
      .query({ from: "2026-08-01", to: "2026-08-31", accountCode: "PH7F-OUTVAT", companyId: companyA });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body[0];
    expect(row).toHaveProperty("transaction_date");
    expect(row).toHaveProperty("source_type");
    expect(row).toHaveProperty("reference_no");
    expect(row).toHaveProperty("transaction_id");
    expect(row).toHaveProperty("account_code");
    expect(row).toHaveProperty("account_title");
    expect(row).toHaveProperty("particulars");
    expect(row).toHaveProperty("debit");
    expect(row).toHaveProperty("credit");
    expect(row).toHaveProperty("running_balance");
  });
});
