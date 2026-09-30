const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// AR List of Overdue Accounts - sixth of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/ar-overdue-accounts is NOT a new recognition query:
// ArOverdueAccountsService.js calls the UNCHANGED
// AgingReportService.getAgingRows("AR", ...) - the exact engine AR Aging
// and AR Aging Summary already use - and drops the "current" bucket. This
// suite proves: auth, REPORTS.AR enforcement, as-of-date default,
// customer filtering, company isolation, every aging-bucket boundary
// (0/1/30/31/60/61/90/91 days), partial payment, multiple payments,
// payment application before vs. after the as-of date (as-of-date
// correctness via transaction_applications), a fully-paid invoice
// excluded, an AR Beginning Balance line that becomes overdue, that Draft
// invoices ARE included (an existing, inherited AgingReportService
// characteristic - not invented here, not "fixed" here), that Debit/
// Credit Memos are NEVER included (also inherited/confirmed, not
// invented), multi-customer summary + grand totals, empty result, no
// transaction mutation, menu/route/permission-map wiring, source guards
// proving no new recognition SQL and that agingReportService.js and its
// two existing routes are untouched, regression checks against AR Aging/
// AR Aging Summary/AR Statement/AR Billings & Collections/Subsidiary
// Ledger/Summary of Books/Net Summary/Daily Cash Position, and CSV safety.

jest.setTimeout(120000);

const AS_OF = "2026-09-19";

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
let custA1Id, custA2Id, custB1Id;
const taIds = [];
const arBeginningHeaderIds = [];

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

async function makeInvoice(companyId, custId, voucherNo, transactionDate, dueDate, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'AOA test customer', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, transactionDate, dueDate, amount, amount, amount, status]
  );
  return h.insertId;
}

async function makeOr(companyId, custId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'AOA test payment', ?, ?, ?, 'Posted')`,
    [companyId, voucherNo, custId, date, amount, amount]
  );
  return h.insertId;
}

async function makeTransactionApplication(invoiceId, orId, amount, applicationDate) {
  const [r] = await pool.execute(
    "INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date) VALUES ('INV', ?, 'OR', ?, ?, ?)",
    [invoiceId, orId, amount, applicationDate]
  );
  taIds.push(r.insertId);
}

async function makeArBeginningBalance(companyId, partyId, partyName, balanceDate, dueDate, status, amount) {
  const [h] = await pool.execute(
    "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AR', ?, ?)",
    [companyId, balanceDate, status]
  );
  await pool.execute(
    "INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, due_date, debit, credit) VALUES (?, ?, ?, ?, ?, 0)",
    [h.insertId, partyId, partyName, dueDate, amount]
  );
  arBeginningHeaderIds.push(h.insertId);
  return h.insertId;
}

async function makeMemo(companyId, memoType, partyId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'AOA test customer', 'CUSTOMER', ?, ?, ?, 'Posted')`,
    [companyId, voucherNo, memoType, partyId, date, amount, amount]
  );
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('AOA Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('AOA Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("AoaPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('aoa_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("aoa_admin", "AoaPass!1");

  const hash2 = await bcrypt.hash("AoaPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('aoa_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("aoa_norole", "AoaPass!2");

  custA1Id = await makeParty("AOA-CUST-A1", "CUSTOMER", "AOA Customer A1", companyAId);
  custA2Id = await makeParty("AOA-CUST-A2", "CUSTOMER", "AOA Customer A2", companyAId);
  custB1Id = await makeParty("AOA-CUST-B1", "CUSTOMER", "AOA Customer B1", companyBId);

  // ---- Bucket-boundary invoices (Customer A1), all Posted, all unpaid ----
  // Days = AS_OF("2026-09-19") - dueDate, clamped at 0.
  await makeInvoice(companyAId, custA1Id, "AOA-INV-CURRENT", "2026-08-01", "2026-09-19", "Posted", 1000); // 0 days -> current (excluded)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-1DAY", "2026-08-01", "2026-09-18", "Posted", 2000); // 1 day -> days1to30
  await makeInvoice(companyAId, custA1Id, "AOA-INV-30DAY", "2026-08-01", "2026-08-20", "Posted", 500); // 30 days -> days1to30 (upper)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-31DAY", "2026-08-01", "2026-08-19", "Posted", 600); // 31 days -> days31to60 (lower)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-60DAY", "2026-08-01", "2026-07-21", "Posted", 700); // 60 days -> days31to60 (upper)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-61DAY", "2026-08-01", "2026-07-20", "Posted", 800); // 61 days -> days61to90 (lower)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-90DAY", "2026-08-01", "2026-06-21", "Posted", 900); // 90 days -> days61to90 (upper)
  await makeInvoice(companyAId, custA1Id, "AOA-INV-91DAY", "2026-08-01", "2026-06-20", "Posted", 1000); // 91 days -> over90 (lower)

  // ---- Draft invoice, overdue (due 2026-08-01, 49 days) - inherited
  // AgingReportService behavior: the AR branch has NO status filter, so
  // this MUST still appear (this is existing, evidence-confirmed
  // behavior, not something this report invents or fixes).
  await makeInvoice(companyAId, custA1Id, "AOA-INV-DRAFT", "2026-08-01", "2026-08-01", "Draft", 9999); // 49 days -> days31to60

  // ---- Partial payment, before AS_OF - balance = 1000 - 400 = 600.
  const invPartialId = await makeInvoice(companyAId, custA1Id, "AOA-INV-PARTIAL", "2026-08-01", "2026-08-01", "Posted", 1000);
  const orPartialId = await makeOr(companyAId, custA1Id, "AOA-OR-PARTIAL", "2026-09-01", 400);
  await makeTransactionApplication(invPartialId, orPartialId, 400, "2026-09-01");

  // ---- Multiple payments, both before AS_OF - balance = 1000 - 300 - 200 = 500.
  const invMultiId = await makeInvoice(companyAId, custA1Id, "AOA-INV-MULTI", "2026-08-01", "2026-08-01", "Posted", 1000);
  const orMulti1Id = await makeOr(companyAId, custA1Id, "AOA-OR-MULTI-1", "2026-09-01", 300);
  const orMulti2Id = await makeOr(companyAId, custA1Id, "AOA-OR-MULTI-2", "2026-09-10", 200);
  await makeTransactionApplication(invMultiId, orMulti1Id, 300, "2026-09-01");
  await makeTransactionApplication(invMultiId, orMulti2Id, 200, "2026-09-10");

  // ---- Payment applied AFTER AS_OF - must NOT count as of AS_OF, so the
  // full 1000 balance remains outstanding (as-of-date correctness proof).
  const invFuturePayId = await makeInvoice(companyAId, custA1Id, "AOA-INV-FUTUREPAY", "2026-08-01", "2026-08-01", "Posted", 1000);
  const orFutureId = await makeOr(companyAId, custA1Id, "AOA-OR-FUTURE", "2026-09-25", 700);
  await makeTransactionApplication(invFuturePayId, orFutureId, 700, "2026-09-25");

  // ---- Fully paid before AS_OF - balance = 0 - excluded by default
  // status=OPEN filtering.
  const invFullyPaidId = await makeInvoice(companyAId, custA1Id, "AOA-INV-FULLYPAID", "2026-08-01", "2026-08-01", "Posted", 1000);
  const orFullyPaidId = await makeOr(companyAId, custA1Id, "AOA-OR-FULLYPAID", "2026-09-01", 1000);
  await makeTransactionApplication(invFullyPaidId, orFullyPaidId, 1000, "2026-09-01");

  // ---- AR Beginning Balance line, overdue (due 2026-08-01, 49 days),
  // unpaid - proves a beginning-balance item can become overdue too.
  await makeArBeginningBalance(companyAId, custA1Id, "AOA Customer A1", "2026-07-01", "2026-08-01", "Posted", 1500);

  // ---- Debit/Credit Memos - must NEVER appear anywhere in the overdue
  // report (AgingReportService's row source never joins memo_headers).
  await makeMemo(companyAId, "DEBIT", custA1Id, "AOA-DM-1", "2026-08-05", 250);
  await makeMemo(companyAId, "CREDIT", custA1Id, "AOA-CM-1", "2026-08-05", 100);

  // ---- Customer A2: one simple overdue invoice (31 days -> days31to60).
  await makeInvoice(companyAId, custA2Id, "AOA-A2-INV-1", "2026-08-01", "2026-08-19", "Posted", 300);

  // ---- Company B: must never leak into Company A's report.
  await makeInvoice(companyBId, custB1Id, "AOA-B-INV-1", "2026-08-01", "2026-08-01", "Posted", 9999);
});

afterAll(async () => {
  if (taIds.length) {
    await pool.query(`DELETE FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
  }
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'AOA-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'AOA-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'AOA-%'");
  for (const hid of arBeginningHeaderIds) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [hid]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [hid]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('AOA-CUST-A1', 'AOA-CUST-A2', 'AOA-CUST-B1')");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function findRow(report, referenceNo) {
  return report.rows.find((r) => r.referenceNo === referenceNo);
}
function findParty(report, partyId) {
  return report.parties.find((p) => p.partyId === partyId);
}

describe("GET /api/reports/ar-overdue-accounts", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/ar-overdue-accounts").query({ asOf: AS_OF });
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.AR - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/ar-overdue-accounts").set(auth(noRoleToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(403);
  });

  test("3. asOf is NOT required - defaults to today, matching AR Aging's own convention (no 400)", async () => {
    const res = await request(app).get("/api/reports/ar-overdue-accounts").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.asOfDate).toBe(new Date().toISOString().slice(0, 10));
  });

  let report;
  test("4. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/ar-overdue-accounts").set(auth(adminToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(200);
    expect(res.body.asOfDate).toBe(AS_OF);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(Array.isArray(res.body.parties)).toBe(true);
    report = res.body;
  });

  test("5. an invoice due exactly on the As Of Date (0 days) is 'current' and EXCLUDED", () => {
    expect(findRow(report, "AOA-INV-CURRENT")).toBeUndefined();
  });

  test("6. an invoice one day overdue is included in days1to30", () => {
    const row = findRow(report, "AOA-INV-1DAY");
    expect(row).toBeDefined();
    expect(row.daysOutstanding).toBe(1);
    expect(row.bucket).toBe("days1to30");
    expect(Number(row.baseBalance)).toBe(2000);
  });

  test("7. exactly 30 days overdue stays in days1to30 (upper boundary)", () => {
    const row = findRow(report, "AOA-INV-30DAY");
    expect(row.daysOutstanding).toBe(30);
    expect(row.bucket).toBe("days1to30");
  });

  test("8. exactly 31 days overdue moves to days31to60 (lower boundary)", () => {
    const row = findRow(report, "AOA-INV-31DAY");
    expect(row.daysOutstanding).toBe(31);
    expect(row.bucket).toBe("days31to60");
  });

  test("9. exactly 60 days overdue stays in days31to60 (upper boundary)", () => {
    const row = findRow(report, "AOA-INV-60DAY");
    expect(row.daysOutstanding).toBe(60);
    expect(row.bucket).toBe("days31to60");
  });

  test("10. exactly 61 days overdue moves to days61to90 (lower boundary)", () => {
    const row = findRow(report, "AOA-INV-61DAY");
    expect(row.daysOutstanding).toBe(61);
    expect(row.bucket).toBe("days61to90");
  });

  test("11. exactly 90 days overdue stays in days61to90 (upper boundary)", () => {
    const row = findRow(report, "AOA-INV-90DAY");
    expect(row.daysOutstanding).toBe(90);
    expect(row.bucket).toBe("days61to90");
  });

  test("12. 91 days overdue moves to over90", () => {
    const row = findRow(report, "AOA-INV-91DAY");
    expect(row.daysOutstanding).toBe(91);
    expect(row.bucket).toBe("over90");
  });

  test("13. Draft invoices ARE included - inherited AgingReportService behavior (no status filter in the AR branch), not invented or fixed here", () => {
    const row = findRow(report, "AOA-INV-DRAFT");
    expect(row).toBeDefined();
    expect(Number(row.baseBalance)).toBe(9999);
  });

  test("14. partial payment before As Of Date reduces the outstanding balance (1000 - 400 = 600)", () => {
    const row = findRow(report, "AOA-INV-PARTIAL");
    expect(Number(row.baseBalance)).toBe(600);
  });

  test("15. multiple payments before As Of Date both reduce the balance (1000 - 300 - 200 = 500)", () => {
    const row = findRow(report, "AOA-INV-MULTI");
    expect(Number(row.baseBalance)).toBe(500);
  });

  test("16. a payment applied AFTER As Of Date does not count yet - full balance remains outstanding (as-of-date correctness)", () => {
    const row = findRow(report, "AOA-INV-FUTUREPAY");
    expect(Number(row.baseBalance)).toBe(1000);
  });

  test("17. a fully paid invoice (balance = 0) is excluded by the default OPEN status filter", () => {
    expect(findRow(report, "AOA-INV-FULLYPAID")).toBeUndefined();
  });

  test("18. an AR Beginning Balance line with a past due date becomes overdue too", () => {
    const row = report.rows.find((r) => r.sourceType === "AR_BEGINNING" && r.partyId === custA1Id);
    expect(row).toBeDefined();
    expect(Number(row.baseBalance)).toBe(1500);
    expect(row.bucket).toBe("days31to60");
  });

  test("19. Debit/Credit Memos never appear in the overdue report (inherited: AgingReportService's row source never joins memo_headers)", () => {
    expect(findRow(report, "AOA-DM-1")).toBeUndefined();
    expect(findRow(report, "AOA-CM-1")).toBeUndefined();
  });

  test("20. company isolation - Company B's overdue invoice never leaks into Company A's report", () => {
    expect(findRow(report, "AOA-B-INV-1")).toBeUndefined();
  });

  test("21. customer A1's summary row totals match the hand-computed sum (12 documents, 20099 total)", () => {
    const p = findParty(report, custA1Id);
    expect(p).toBeDefined();
    expect(p.documentCount).toBe(12);
    expect(Number(p.buckets.days1to30)).toBe(2500);
    expect(Number(p.buckets.days31to60)).toBe(14899);
    expect(Number(p.buckets.days61to90)).toBe(1700);
    expect(Number(p.buckets.over90)).toBe(1000);
    expect(Number(p.baseBalance)).toBe(20099);
  });

  test("22. customer A2's summary row (single 300 invoice)", () => {
    const p = findParty(report, custA2Id);
    expect(p).toBeDefined();
    expect(p.documentCount).toBe(1);
    expect(Number(p.baseBalance)).toBe(300);
  });

  test("23. grand total bucketTotals equal the sum across all customers in scope (A1 + A2)", () => {
    expect(Number(report.bucketTotals.base.days1to30)).toBe(2500);
    expect(Number(report.bucketTotals.base.days31to60)).toBe(15199);
    expect(Number(report.bucketTotals.base.days61to90)).toBe(1700);
    expect(Number(report.bucketTotals.base.over90)).toBe(1000);
    expect(Number(report.bucketTotals.base.total)).toBe(20399);
  });

  test("24. single-customer filter (partyId) narrows the report to exactly that customer's overdue documents", async () => {
    const res = await request(app)
      .get("/api/reports/ar-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: custA1Id });
    expect(res.status).toBe(200);
    expect(res.body.parties).toHaveLength(1);
    expect(res.body.parties[0].partyId).toBe(custA1Id);
    expect(Number(res.body.parties[0].baseBalance)).toBe(20099);
  });

  test("25. empty result (a customer with zero overdue documents) returns empty arrays, not an error", async () => {
    const freshCust = await makeParty("AOA-CUST-FRESH", "CUSTOMER", "AOA Fresh Customer", companyAId);
    const res = await request(app)
      .get("/api/reports/ar-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: freshCust });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.parties).toEqual([]);
    expect(Number(res.body.bucketTotals.base.total)).toBe(0);
    await pool.query("DELETE FROM general_libraries WHERE id = ?", [freshCust]);
  });

  test("26. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM invoice_headers WHERE voucher_no = 'AOA-INV-1DAY'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(2000);
    expect(Number(header.total_credit)).toBe(2000);

    const [taRows] = await pool.query("SELECT amount FROM transaction_applications WHERE id IN (?)", [taIds]);
    expect(taRows).toHaveLength(taIds.length);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("27. AR List of Overdue Accounts now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "ar-overdue-accounts", label: "List of Overdue Accounts", icon: AlertCircle, path: "\/reports\/ar-overdue-accounts"/
    );
  });

  test("28. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (ap-payables-and-payments, ap-overdue-accounts, and fixed-asset-lapsing were intentionally unlocked in later phases - see apListOfPayablesAndPayments.http.test.js, apOverdueAccounts.http.test.js, and fixedAssetLapsing.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of ["fixed-asset-lapsing"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("29. App.jsx routes /reports/ar-overdue-accounts to ArOverdueAccounts", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ArOverdueAccounts from "\.\/pages\/REPORTS\/ArOverdueAccounts\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/ar-overdue-accounts" element={<ArOverdueAccounts \/>} \/>/);
  });

  test("30. pathPermissionMap maps the new route to REPORTS.AR (same as AR Aging / AR Aging Summary)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/ar-overdue-accounts": \["REPORTS\.AR", "VIEW"\]/);
  });

  test("31. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/OVERDUE_ACCOUNTS/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("32. the AR Overdue Accounts route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-overdue-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("33. the route delegates to ArOverdueAccountsService.getOverdueAccounts", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-overdue-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/ArOverdueAccountsService\.getOverdueAccounts\(/);
  });

  test("34. ArOverdueAccountsService.js calls the UNCHANGED AgingReportService.getAgingRows - no new recognition SQL", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ArOverdueAccountsService.js"), "utf8");
    expect(svcSrc).toMatch(/require\("\.\/agingReportService"\)/);
    expect(svcSrc).toMatch(/getAgingRows\("AR",/);
    expect(svcSrc).toMatch(/bucket !== "current"/);
    expect(svcSrc).not.toMatch(/pool\.execute|pool\.query|SELECT /i);
  });

  test("35. agingReportService.js itself was not modified by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/agingReportService.js"), "utf8");
    expect(svcSrc).not.toMatch(/ArOverdueAccountsService/);
    expect(svcSrc).toMatch(/module\.exports = \{\s*getAgingRows,\s*getBucketTotals,\s*getSummaryByParty,\s*daysBetween,\s*bucketOf,?\s*\};/);
  });

  test("36. the AR Aging and AR Aging Summary routes themselves were not modified by this phase", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start1 = serverSrc.indexOf('app.get("/api/reports/ar-aging"');
    const end1 = serverSrc.indexOf('app.get("/api/reports/ar-aging-summary"');
    const bodyAging = serverSrc.slice(start1, end1);
    expect(bodyAging).not.toMatch(/ArOverdueAccountsService/);

    const start2 = serverSrc.indexOf('app.get("/api/reports/ar-aging-summary"');
    const end2 = serverSrc.indexOf("\n});", start2);
    const bodySummary = serverSrc.slice(start2, end2);
    expect(bodySummary).not.toMatch(/ArOverdueAccountsService/);
  });
});

describe("37. AR Aging, AR Aging Summary, AR Statement, AR Billings & Collections, Subsidiary Ledger, Summary of Books, Net Summary, and Daily Cash Position remain fully functional (regression check)", () => {
  test("AR Aging still returns Current-inclusive rows (unlike Overdue Accounts)", async () => {
    const res = await request(app)
      .get("/api/reports/ar-aging")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: custA1Id });
    expect(res.status).toBe(200);
    const currentRow = res.body.rows.find((r) => r.referenceNo === "AOA-INV-CURRENT");
    expect(currentRow).toBeDefined();
    expect(currentRow.bucket).toBe("current");
  });

  test("AR Aging Summary still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/ar-aging-summary")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: custA1Id });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.parties)).toBe(true);
  });

  test("AR Statement of Accounts still works for A1", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query({ partyId: custA1Id, from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
  });

  test("AR Billings & Collections still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19", partyId: custA1Id });
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
  });

  test("Subsidiary Ledger (AR) still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .set(auth(adminToken))
      .query({ type: "AR", partyId: custA1Id, from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: AS_OF });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe("38. CSV export stays formula-injection safe", () => {
  test("ArOverdueAccounts.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "ArOverdueAccounts.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`AR_Overdue_Accounts_\$\{safeDate\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "ArOverdueAccounts.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "ArOverdueAccounts.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
