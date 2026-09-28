const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 14: GET /api/posting/pending company-isolation fix. Previously the
// route's 5-way UNION ALL (Invoice/OR/APV/CV/PO) had no company_id
// restriction at all - any authenticated user with POSTING.VIEW saw every
// company's pending Draft documents. The fix reuses
// CurrencyService.resolveCompanyIdForRead() exactly as it already exists
// (unmodified) - the same read-scope resolver currencyService.js's own
// listCurrencies() already uses - applied identically to all five UNION
// ALL branches. POST /api/posting/post itself was not touched.

jest.setTimeout(120000);

let companyAId, companyBId, companyCId;
let userAId, userBId, multiUserId, superUserId;
let tokenA, tokenB, tokenMulti, tokenSuper;
let arA, apA, revA;
let custAId, suppAId;

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(username, password, roleId, companyIds) {
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = r.insertId;
  for (const companyId of companyIds || []) {
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  }
  return userId;
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

// Invoice/OR/APV/CV/PO CREATE all resolve companyId from currency?.companyId
// (confirmed by direct read of each route), never a top-level companyId
// field - required here so a multi-company caller (tokenMulti) can target
// a specific company instead of hitting resolveCompanyIdForWrite's
// "companyId is required - you have access to multiple companies" error.
async function createDraftInvoice(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/invoices").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestPP Customer", currency: { companyId },
    transactionDate: "2026-09-15", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: arA, accountCode: "TESTPP-AR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA, accountCode: "TESTPP-REV", accountTitle: "Rev", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftOr(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/or").set(auth(token)).send({
    voucherNo, customerId: custAId, customerName: "TestPP Customer", currency: { companyId },
    transactionDate: "2026-09-15", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTPP-CASH", accountTitle: "Cash", particulars: "x", debit: amount, credit: 0 },
      { accountId: arA, accountCode: "TESTPP-AR", accountTitle: "AR", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftApv(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/apv").set(auth(token)).send({
    voucherNo, supplierId: suppAId, supplierName: "TestPP Supplier", currency: { companyId },
    transactionDate: "2026-09-15", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: revA, accountCode: "TESTPP-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTPP-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftCv(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/cv").set(auth(token)).send({
    voucherNo, payeeId: suppAId, payeeName: "TestPP Supplier", currency: { companyId },
    transactionDate: "2026-09-15", totalDebit: amount, totalCredit: amount, status: "Draft",
    lines: [
      { accountId: apA, accountCode: "TESTPP-AP", accountTitle: "AP", particulars: "x", debit: amount, credit: 0 },
      { accountId: revA, accountCode: "TESTPP-CASH2", accountTitle: "Cash", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}
async function createDraftPo(token, { voucherNo, amount, companyId }) {
  const res = await request(app).post("/api/purchase-orders").set(auth(token)).send({
    voucherNo, supplierId: suppAId, supplierName: "TestPP Supplier", currency: { companyId },
    transactionDate: "2026-09-15", totalCredit: amount, status: "Draft",
    lines: [
      { accountId: revA, accountCode: "TESTPP-REV", accountTitle: "Expense", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTPP-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  expect(res.status).toBe(200);
  return res.body.id;
}

function findRow(rows, sourceType, voucherNo) {
  return rows.find((r) => r.sourceType === sourceType && r.voucherNo === voucherNo);
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTPP Company A");
  companyBId = await makeCompany("TESTPP Company B");
  companyCId = await makeCompany("TESTPP Company C");

  userAId = await makeUser("testpp_a", "TestPpPass!A1", 2, [companyAId]);
  userBId = await makeUser("testpp_b", "TestPpPass!B1", 2, [companyBId]);
  multiUserId = await makeUser("testpp_multi", "TestPpPass!M1", 2, [companyAId, companyBId]);
  superUserId = await makeUser("testpp_super", "TestPpPass!S1", 1, []); // SUPER_ADMIN, no company membership row needed

  tokenA = await loginAs("testpp_a", "TestPpPass!A1");
  tokenB = await loginAs("testpp_b", "TestPpPass!B1");
  tokenMulti = await loginAs("testpp_multi", "TestPpPass!M1");
  tokenSuper = await loginAs("testpp_super", "TestPpPass!S1");

  arA = await makeAccount("TESTPP-AR", "TestPP Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTPP-AP", "TestPP Accounts Payable/Cash", "LIABILITY");
  revA = await makeAccount("TESTPP-REV", "TestPP Revenue/Expense", "INCOME");
  custAId = await makeParty("TESTPP-CUST", "CUSTOMER", "TestPP Customer", companyAId);
  suppAId = await makeParty("TESTPP-SUPP", "SUPPLIER", "TestPP Supplier", companyAId);
  // Company B needs its own parties for its own Draft documents.
  const custBId = await makeParty("TESTPP-CUST-B", "CUSTOMER", "TestPP Customer B", companyBId);
  const suppBId = await makeParty("TESTPP-SUPP-B", "SUPPLIER", "TestPP Supplier B", companyBId);
  void custBId;
  void suppBId;

  const CurrencyService = require("../services/currencyService");
  for (const [uid, cid] of [[userAId, companyAId], [userBId, companyBId]]) {
    await CurrencyService.createCurrency({ id: uid, roleCode: "ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: cid,
    });
  }
});

afterAll(async () => {
  for (const co of [companyAId, companyBId, companyCId]) {
    await pool.query("DELETE FROM audit_logs WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM invoice_lines l JOIN invoice_headers h ON h.id = l.invoice_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM or_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM apv_lines l JOIN apv_headers h ON h.id = l.apv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE l FROM purchase_order_lines l JOIN purchase_order_headers h ON h.id = l.po_id WHERE h.company_id = ?", [co]);
    await pool.query("DELETE FROM purchase_order_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'TESTPP-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTPP-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?, ?, ?)", [userAId, userBId, multiUserId, superUserId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?, ?, ?)", [userAId, userBId, multiUserId, superUserId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?, ?)", [companyAId, companyBId, companyCId]);
  await pool.end();
});

describe("Per-module company isolation (1-6)", () => {
  test("1/2. Company A user sees Company A's Draft invoice, not Company B's", async () => {
    const invAId = await createDraftInvoice(tokenA, { voucherNo: "TESTPP-INV-1A", amount: 100, companyId: companyAId });
    const invBId = await createDraftInvoice(tokenB, { voucherNo: "TESTPP-INV-1B", amount: 100, companyId: companyBId });

    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(findRow(res.body, "INV", "TESTPP-INV-1A")).toBeTruthy();
    expect(findRow(res.body, "INV", "TESTPP-INV-1B")).toBeUndefined();
    void invAId;
    void invBId;
  });

  test("3. OR isolation", async () => {
    await createDraftOr(tokenA, { voucherNo: "TESTPP-OR-3A", amount: 50, companyId: companyAId });
    await createDraftOr(tokenB, { voucherNo: "TESTPP-OR-3B", amount: 50, companyId: companyBId });

    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    expect(findRow(res.body, "OR", "TESTPP-OR-3A")).toBeTruthy();
    expect(findRow(res.body, "OR", "TESTPP-OR-3B")).toBeUndefined();
  });

  test("4. APV isolation", async () => {
    await createDraftApv(tokenA, { voucherNo: "TESTPP-APV-4A", amount: 60, companyId: companyAId });
    await createDraftApv(tokenB, { voucherNo: "TESTPP-APV-4B", amount: 60, companyId: companyBId });

    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    expect(findRow(res.body, "APV", "TESTPP-APV-4A")).toBeTruthy();
    expect(findRow(res.body, "APV", "TESTPP-APV-4B")).toBeUndefined();
  });

  test("5. CV isolation", async () => {
    await createDraftCv(tokenA, { voucherNo: "TESTPP-CV-5A", amount: 70, companyId: companyAId });
    await createDraftCv(tokenB, { voucherNo: "TESTPP-CV-5B", amount: 70, companyId: companyBId });

    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    expect(findRow(res.body, "CV", "TESTPP-CV-5A")).toBeTruthy();
    expect(findRow(res.body, "CV", "TESTPP-CV-5B")).toBeUndefined();
  });

  test("6. PO isolation", async () => {
    await createDraftPo(tokenA, { voucherNo: "TESTPP-PO-6A", amount: 80, companyId: companyAId });
    await createDraftPo(tokenB, { voucherNo: "TESTPP-PO-6B", amount: 80, companyId: companyBId });

    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    expect(findRow(res.body, "PO", "TESTPP-PO-6A")).toBeTruthy();
    expect(findRow(res.body, "PO", "TESTPP-PO-6B")).toBeUndefined();
  });
});

describe("Explicit companyId selection (7, 8)", () => {
  test("7. a multi-company user explicitly selecting an authorized companyId sees only that company", async () => {
    const invAId = await createDraftInvoice(tokenMulti, { voucherNo: "TESTPP-INV-7A", amount: 40, companyId: companyAId });
    const invBId = await createDraftInvoice(tokenMulti, { voucherNo: "TESTPP-INV-7B", amount: 40, companyId: companyBId });

    const resA = await request(app).get("/api/posting/pending").query({ companyId: companyAId }).set(auth(tokenMulti));
    expect(resA.status).toBe(200);
    expect(findRow(resA.body, "INV", "TESTPP-INV-7A")).toBeTruthy();
    expect(findRow(resA.body, "INV", "TESTPP-INV-7B")).toBeUndefined();

    const resB = await request(app).get("/api/posting/pending").query({ companyId: companyBId }).set(auth(tokenMulti));
    expect(findRow(resB.body, "INV", "TESTPP-INV-7B")).toBeTruthy();
    expect(findRow(resB.body, "INV", "TESTPP-INV-7A")).toBeUndefined();

    void invAId;
    void invBId;
  });

  test("8. requesting an unauthorized companyId is rejected with 403, matching the existing convention", async () => {
    const res = await request(app).get("/api/posting/pending").query({ companyId: companyBId }).set(auth(tokenA));
    expect(res.status).toBe(403);
  });
});

describe("SUPER_ADMIN behavior (9)", () => {
  test("9. SUPER_ADMIN with no companyId sees pending documents across all companies; with an explicit companyId, only that one", async () => {
    const invAId = await createDraftInvoice(tokenA, { voucherNo: "TESTPP-INV-9A", amount: 20, companyId: companyAId });
    const invBId = await createDraftInvoice(tokenB, { voucherNo: "TESTPP-INV-9B", amount: 20, companyId: companyBId });

    const resAll = await request(app).get("/api/posting/pending").set(auth(tokenSuper));
    expect(resAll.status).toBe(200);
    expect(findRow(resAll.body, "INV", "TESTPP-INV-9A")).toBeTruthy();
    expect(findRow(resAll.body, "INV", "TESTPP-INV-9B")).toBeTruthy(); // sees BOTH - consistent with system-wide SUPER_ADMIN behavior

    const resScoped = await request(app).get("/api/posting/pending").query({ companyId: companyAId }).set(auth(tokenSuper));
    expect(findRow(resScoped.body, "INV", "TESTPP-INV-9A")).toBeTruthy();
    expect(findRow(resScoped.body, "INV", "TESTPP-INV-9B")).toBeUndefined();

    void invAId;
    void invBId;
  });
});

describe("Response shape and empty-result behavior (10, 11)", () => {
  test("10. existing response structure (field names) is unchanged", async () => {
    await createDraftInvoice(tokenA, { voucherNo: "TESTPP-INV-10A", amount: 33, companyId: companyAId });
    const res = await request(app).get("/api/posting/pending").set(auth(tokenA));
    const row = findRow(res.body, "INV", "TESTPP-INV-10A");
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(["amount", "id", "party", "sourceType", "status", "transactionDate", "voucherNo"].sort());
    expect(row.status).toBe("Draft");
    expect(row.party).toBe("TestPP Customer");
  });

  test("11. a company with no pending Draft documents gets an empty array", async () => {
    const res = await request(app).get("/api/posting/pending").query({ companyId: companyCId }).set(auth(tokenSuper));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("POST /api/posting/post behavior is unchanged (12)", () => {
  test("12. bulk posting still only posts and scopes to the resolved company, unaffected by the GET-route fix", async () => {
    const invId = await createDraftInvoice(tokenA, { voucherNo: "TESTPP-INV-12A", amount: 15, companyId: companyAId });
    const res = await request(app).post("/api/posting/post").set(auth(tokenA)).send({ scope: "ar", companyId: companyAId });
    expect(res.status).toBe(200);
    expect(res.body.postedCount).toBeGreaterThanOrEqual(1);

    const [[row]] = await pool.query("SELECT status FROM invoice_headers WHERE id = ?", [invId]);
    expect(row.status).toBe("Posted");
  });
});
