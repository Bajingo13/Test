const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// AR Billings & Collections - fifth of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/ar-billings-and-collections is NOT a new recognition
// query: ArBillingsCollectionsService.js is a pure composition layer that
// calls the UNCHANGED ArStatementService.getArStatementOfAccounts once
// per customer and buckets its already-computed rows into Billings/Debit
// Memos/Collections/Credit Memos. Collections is the flat OR total
// (matching AR Statement/Subsidiary Ledger), deliberately NOT
// transaction_applications. This suite proves: auth, REPORTS.AR
// enforcement, required filters, company isolation, all-customers vs
// single-customer scope, that a never-transacted customer is omitted from
// the all-customers view but shown (at zero) when explicitly requested,
// Posted-only inclusion, a fully hand-verified multi-source balance chain
// (AR Beginning Balance + Invoices + Payment + Debit Memo + Credit Memo +
// an in-period AR-Beginning-Balance edge case folded into Billings),
// EXACT reconciliation (Beginning + Billings + DebitMemos - Collections -
// CreditMemos === Ending) for every customer, a split OR (one payment
// allocated across two invoices via transaction_applications) proving
// Collections counts that OR's total exactly once - not once per
// allocation row and not double-counted against transaction_applications,
// grand totals, no transaction mutation, menu/route/permission-map
// wiring, source guards proving no new recognition SQL and that
// ArStatementService.js and its own route are untouched, and CSV safety.

jest.setTimeout(120000);

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
let custA1Id, custA2Id, custA3Id, custB1Id;
const taIds = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}

async function makeInvoice(companyId, custId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'ABC test customer', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, date, date, amount, amount, amount, status]
  );
  return h.insertId;
}

async function makeOr(companyId, custId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'ABC test customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, custId, date, amount, amount, status]
  );
  return h.insertId;
}

async function makeMemo(companyId, memoType, partyId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'ABC test customer', 'CUSTOMER', ?, ?, ?, ?)`,
    [companyId, voucherNo, memoType, partyId, date, amount, amount, status]
  );
  return h.insertId;
}

async function makeArBeginningBalance(companyId, partyId, partyName, date, status, amount) {
  const [h] = await pool.execute(
    "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AR', ?, ?)",
    [companyId, date, status]
  );
  await pool.execute(
    "INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, debit, credit) VALUES (?, ?, ?, ?, 0)",
    [h.insertId, partyId, partyName, amount]
  );
  return h.insertId;
}

async function makeTransactionApplication(sourceId, appliedId, amount, date) {
  const [r] = await pool.execute(
    "INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date) VALUES ('INV', ?, 'OR', ?, ?, ?)",
    [sourceId, appliedId, amount, date]
  );
  taIds.push(r.insertId);
}

const arBeginningHeaderIds = [];

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ABC Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ABC Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("AbcPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('abc_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("abc_admin", "AbcPass!1");

  const hash2 = await bcrypt.hash("AbcPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('abc_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("abc_norole", "AbcPass!2");

  custA1Id = await makeParty("ABC-CUST-A1", "CUSTOMER", "ABC Customer A1", companyAId);
  custA2Id = await makeParty("ABC-CUST-A2", "CUSTOMER", "ABC Customer A2", companyAId);
  custA3Id = await makeParty("ABC-CUST-A3", "CUSTOMER", "ABC Customer A3 (no activity)", companyAId);
  custB1Id = await makeParty("ABC-CUST-B1", "CUSTOMER", "ABC Customer B1", companyBId);

  // ---- Customer A1: full scenario ----
  arBeginningHeaderIds.push(
    await makeArBeginningBalance(companyAId, custA1Id, "ABC Customer A1", "2026-07-01", "Posted", 10000)
  );
  await makeInvoice(companyAId, custA1Id, "ABC-INV-1", "2026-08-05", "Posted", 5000);
  await makeInvoice(companyAId, custA1Id, "ABC-INV-DRAFT", "2026-08-06", "Draft", 999);
  await makeOr(companyAId, custA1Id, "ABC-OR-1", "2026-08-10", "Posted", 2000);
  await makeMemo(companyAId, "DEBIT", custA1Id, "ABC-DM-1", "2026-08-12", "Posted", 300);
  await makeMemo(companyAId, "CREDIT", custA1Id, "ABC-CM-1", "2026-08-15", "Posted", 150);

  // Split-payment scenario: one OR (5000) pays two separate invoices
  // (3000 + 2000) via transaction_applications - proves Collections
  // counts the OR's total exactly once, not per allocation row.
  const invXId = await makeInvoice(companyAId, custA1Id, "ABC-INV-X", "2026-08-18", "Posted", 3000);
  const invYId = await makeInvoice(companyAId, custA1Id, "ABC-INV-Y", "2026-08-19", "Posted", 2000);
  const orSplitId = await makeOr(companyAId, custA1Id, "ABC-OR-SPLIT", "2026-08-20", "Posted", 5000);
  await makeTransactionApplication(invXId, orSplitId, 3000, "2026-08-20");
  await makeTransactionApplication(invYId, orSplitId, 2000, "2026-08-20");

  // Edge case: an AR Beginning Balance import dated INSIDE the period -
  // must be folded into Billings, not silently dropped, so the formula
  // still reconciles exactly.
  arBeginningHeaderIds.push(
    await makeArBeginningBalance(companyAId, custA1Id, "ABC Customer A1", "2026-08-22", "Posted", 500)
  );

  // ---- Customer A2: simple, single invoice only ----
  await makeInvoice(companyAId, custA2Id, "ABC-A2-INV-1", "2026-08-07", "Posted", 1000);

  // ---- Customer A3: intentionally has ZERO transactions and ZERO
  // beginning balance - proves the all-customers view omits it, but an
  // explicit partyId request still shows it (at zero).

  // ---- Company B: must never leak into Company A's report ----
  await makeInvoice(companyBId, custB1Id, "ABC-B-INV-1", "2026-08-05", "Posted", 9999);
});

afterAll(async () => {
  if (taIds.length) {
    await pool.query(`DELETE FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
  }
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'ABC-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'ABC-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'ABC-%'");
  for (const hid of arBeginningHeaderIds) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [hid]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [hid]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('ABC-CUST-A1', 'ABC-CUST-A2', 'ABC-CUST-A3', 'ABC-CUST-B1')");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const range = (extra) => ({ from: "2026-08-01", to: "2026-08-31", ...extra });

function findCustomer(report, partyId) {
  return report.customers.find((c) => c.partyId === partyId);
}

describe("GET /api/reports/ar-billings-and-collections", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/ar-billings-and-collections").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.AR - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/ar-billings-and-collections").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("3. from/to are required", async () => {
    const res = await request(app).get("/api/reports/ar-billings-and-collections").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  test("4. company isolation - a cross-company partyId is rejected (404)", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query(range({ partyId: custB1Id }));
    expect(res.status).toBe(404);
  });

  let report;
  test("5. generates successfully for an authorized company-scoped user (all customers)", async () => {
    const res = await request(app).get("/api/reports/ar-billings-and-collections").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
    report = res.body;
  });

  test("6. the never-transacted customer (A3) is omitted from the all-customers view", () => {
    expect(findCustomer(report, custA3Id)).toBeUndefined();
  });

  test("7. Company B's customer never leaks into Company A's all-customers view", () => {
    expect(findCustomer(report, custB1Id)).toBeUndefined();
  });

  test("8. beginning balance for A1 = the pre-period AR Beginning Balance import (10000)", () => {
    const c = findCustomer(report, custA1Id);
    expect(c).toBeDefined();
    expect(Number(c.beginningBalance)).toBe(10000);
  });

  test("9. billings for A1 = Posted invoices in-period + the in-period AR Beginning Balance edge case, Draft excluded (5000 + 3000 + 2000 + 500 = 10500)", () => {
    const c = findCustomer(report, custA1Id);
    expect(Number(c.billings)).toBe(10500);
  });

  test("10. debit memos for A1 (300)", () => {
    const c = findCustomer(report, custA1Id);
    expect(Number(c.debitMemos)).toBe(300);
  });

  test("11. collections for A1 = OR totals, the split OR counted exactly ONCE at its own total, not per allocation row (2000 + 5000 = 7000, not 2000 + 3000 + 2000 = 7000-by-coincidence-but-verify-not-12000)", () => {
    const c = findCustomer(report, custA1Id);
    expect(Number(c.collections)).toBe(7000);
  });

  test("12. credit memos for A1 (150)", () => {
    const c = findCustomer(report, custA1Id);
    expect(Number(c.creditMemos)).toBe(150);
  });

  test("13. ending balance for A1 reconciles exactly: Beginning + Billings + DebitMemos - Collections - CreditMemos = Ending", () => {
    const c = findCustomer(report, custA1Id);
    const reconciled = c.beginningBalance + c.billings + c.debitMemos - c.collections - c.creditMemos;
    expect(Number(c.endingBalance)).toBeCloseTo(reconciled, 2);
    expect(Number(c.endingBalance)).toBe(13650);
  });

  test("14. customer A2 - simple single-invoice scenario (beginning=0, billings=1000, ending=1000)", () => {
    const c = findCustomer(report, custA2Id);
    expect(c).toBeDefined();
    expect(Number(c.beginningBalance)).toBe(0);
    expect(Number(c.billings)).toBe(1000);
    expect(Number(c.collections)).toBe(0);
    expect(Number(c.endingBalance)).toBe(1000);
  });

  test("15. grand totals are the sum across all included customers (A1 + A2)", () => {
    expect(Number(report.grandTotalBeginningBalance)).toBe(10000);
    expect(Number(report.grandTotalBillings)).toBe(11500);
    expect(Number(report.grandTotalDebitMemos)).toBe(300);
    expect(Number(report.grandTotalCollections)).toBe(7000);
    expect(Number(report.grandTotalCreditMemos)).toBe(150);
    expect(Number(report.grandTotalEndingBalance)).toBe(14650);
  });

  test("16. a never-transacted customer IS shown (at zero) when explicitly requested via partyId", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query(range({ partyId: custA3Id }));
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    const c = res.body.customers[0];
    expect(Number(c.beginningBalance)).toBe(0);
    expect(Number(c.billings)).toBe(0);
    expect(Number(c.collections)).toBe(0);
    expect(Number(c.endingBalance)).toBe(0);
  });

  test("17. single-customer filter (partyId) narrows the report to exactly that customer", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query(range({ partyId: custA1Id }));
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].partyId).toBe(custA1Id);
    expect(Number(res.body.customers[0].endingBalance)).toBe(13650);
  });

  test("18. empty period returns an empty customers array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query({ from: "2020-01-01", to: "2020-01-31" });
    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(Number(res.body.grandTotalBillings)).toBe(0);
  });

  test("19. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM invoice_headers WHERE voucher_no = 'ABC-INV-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(5000);
    expect(Number(header.total_credit)).toBe(5000);

    const [taRows] = await pool.query("SELECT amount FROM transaction_applications WHERE id IN (?, ?)", taIds);
    expect(taRows.map((r) => Number(r.amount)).sort()).toEqual([2000, 3000]);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("20. AR Billings & Collections now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "ar-billings-and-collections", label: "Billings and Collections", icon: HandCoins, path: "\/reports\/ar-billings-and-collections"/
    );
  });

  test("21. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (ar-overdue-accounts and ap-payables-and-payments were intentionally unlocked in later phases - see arOverdueAccounts.http.test.js and apListOfPayablesAndPayments.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of ["fixed-asset-lapsing"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("22. App.jsx routes /reports/ar-billings-and-collections to ArBillingsAndCollections", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ArBillingsAndCollections from "\.\/pages\/REPORTS\/ArBillingsAndCollections\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/ar-billings-and-collections" element={<ArBillingsAndCollections \/>} \/>/);
  });

  test("23. pathPermissionMap maps the new route to REPORTS.AR (same as AR Statement of Accounts / AR Aging)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/ar-billings-and-collections": \["REPORTS\.AR", "VIEW"\]/);
  });

  test("24. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BILLINGS_AND_COLLECTIONS|AR_BILLINGS/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("25. the AR Billings & Collections route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-billings-and-collections"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("26. the route delegates to ArBillingsCollectionsService.getArBillingsAndCollections", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-billings-and-collections"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/ArBillingsCollectionsService\.getArBillingsAndCollections\(/);
  });

  test("27. ArBillingsCollectionsService.js calls the UNCHANGED ArStatementService.getArStatementOfAccounts per customer - no new recognition SQL, transaction_applications never queried", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ArBillingsCollectionsService.js"), "utf8");
    expect(svcSrc).toMatch(/require\("\.\/ArStatementService"\)/);
    expect(svcSrc).toMatch(/getArStatementOfAccounts\(/);
    expect(svcSrc).not.toMatch(/FROM\s+transaction_applications/i);
    expect(svcSrc).not.toMatch(/pool\.(execute|query)\([^)]*transaction_applications/is);
    expect(svcSrc).not.toMatch(/FROM invoice_headers|FROM or_headers|FROM memo_headers/i);
  });

  test("28. ArStatementService.js itself was not modified by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ArStatementService.js"), "utf8");
    expect(svcSrc).not.toMatch(/ArBillingsCollectionsService/);
    expect(svcSrc).toMatch(/module\.exports = \{ getArStatementOfAccounts \};/);
  });

  test("29. the AR Statement of Accounts route itself was not modified by this phase", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-statement-of-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/ArBillingsCollectionsService/);
  });
});

describe("30. AR Statement of Accounts, Subsidiary Ledger, Summary of Books, Net Summary, and Daily Cash Position remain fully functional (regression check)", () => {
  test("AR Statement of Accounts still works for A1 and independently agrees with this report's Billings figure direction", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query(range({ partyId: custA1Id }));
    expect(res.status).toBe(200);
    expect(Number(res.body.endingBalance)).toBe(13650);
  });

  test("Subsidiary Ledger (AR) still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .set(auth(adminToken))
      .query({ type: "AR", partyId: custA1Id, from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape", async () => {
    const res = await request(app).get("/api/reports/books/net-summary").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-15" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe("31. CSV export stays formula-injection safe", () => {
  test("ArBillingsAndCollections.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "ArBillingsAndCollections.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`AR_Billings_and_Collections_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "ArBillingsAndCollections.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "ArBillingsAndCollections.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
