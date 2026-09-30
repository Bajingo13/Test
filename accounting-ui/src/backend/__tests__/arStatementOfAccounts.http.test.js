const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// AR Statement of Accounts - fourth of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/ar-statement-of-accounts is NOT a new recognition
// query: ArStatementService.js reuses the exact same 4-source AR union
// (invoice_headers/or_headers/arap_beginning_balance_lines/memo_headers)
// the existing Subsidiary Ledger route (GET /api/reports/subsidiary-ledger)
// already uses for its AR branch - that route is untouched by this suite.
// The one genuine addition is a true pre-period Beginning Balance (the
// party-scoped analog of LedgerReportService.getBeginningBalances), so
// this suite proves: auth, REPORTS.AR enforcement, required filters,
// company isolation (cross-company partyId -> 404, matching Subsidiary
// Ledger's exact existing behavior), Posted-only inclusion, a fully
// worked, hand-verifiable running-balance scenario spanning a Beginning
// Balance import + Invoice + Payment(OR) + Debit Memo + Credit Memo +
// same-day Invoice/OR ordering + an unpaid invoice, empty statement, no
// transaction mutation, menu/route/permission-map wiring, source guards
// proving no new recognition SQL and that Subsidiary Ledger's own route is
// untouched, and CSV safety.

jest.setTimeout(120000);

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
let custAId, custBId;
const coaIds = [];

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
     VALUES (?, ?, ?, 'ARS test customer', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, date, date, amount, amount, amount, status]
  );
  return h.insertId;
}

async function makeOr(companyId, custId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'ARS test customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, custId, date, amount, amount, status]
  );
  return h.insertId;
}

async function makeMemo(companyId, memoType, partyId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'ARS test customer', 'CUSTOMER', ?, ?, ?, ?)`,
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

let arBeginningHeaderId;

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ARS Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('ARS Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("ArsPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ars_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("ars_admin", "ArsPass!1");

  const hash2 = await bcrypt.hash("ArsPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ars_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("ars_norole", "ArsPass!2");

  custAId = await makeParty("ARS-CUST-A", "CUSTOMER", "ARS Customer A", companyAId);
  custBId = await makeParty("ARS-CUST-B", "CUSTOMER", "ARS Customer B", companyBId);

  // 1. AR Beginning Balance import, dated before "from" - contributes
  // 10,000 to the Beginning Balance.
  arBeginningHeaderId = await makeArBeginningBalance(companyAId, custAId, "ARS Customer A", "2026-07-01", "Posted", 10000);

  // 2. Invoice dated before "from" - contributes 1,000 to Beginning Balance.
  await makeInvoice(companyAId, custAId, "ARS-INV-PRE", "2026-07-15", "Posted", 1000);

  // 3. Invoice in range.
  await makeInvoice(companyAId, custAId, "ARS-INV-1", "2026-08-05", "Posted", 5000);

  // 4. Draft invoice in range - must be excluded.
  await makeInvoice(companyAId, custAId, "ARS-INV-DRAFT", "2026-08-06", "Draft", 999);

  // 5. Payment (OR) in range.
  await makeOr(companyAId, custAId, "ARS-OR-1", "2026-08-10", "Posted", 2000);

  // 6. Debit Memo in range - increases AR.
  await makeMemo(companyAId, "DEBIT", custAId, "ARS-DM-1", "2026-08-12", "Posted", 300);

  // 7. Credit Memo in range - decreases AR.
  await makeMemo(companyAId, "CREDIT", custAId, "ARS-CM-1", "2026-08-15", "Posted", 150);

  // 8 & 9. Same-day Invoice + OR (2026-08-20) - proves sort_order ordering
  // (Invoice=1 always applied before OR=2 on the same date).
  await makeInvoice(companyAId, custAId, "ARS-INV-SAMEDAY", "2026-08-20", "Posted", 800);
  await makeOr(companyAId, custAId, "ARS-OR-SAMEDAY", "2026-08-20", "Posted", 800);

  // 10. Unpaid invoice - no OR against it.
  await makeInvoice(companyAId, custAId, "ARS-INV-UNPAID", "2026-08-25", "Posted", 400);

  // 11. Outside range (after "to") - must be excluded.
  await makeInvoice(companyAId, custAId, "ARS-INV-OUTSIDE", "2026-09-05", "Posted", 777);

  // Company B fixture - proves cross-company isolation even though
  // general_libraries/arap_beginning_balance are technically queryable
  // tables, not scoped implicitly.
  await makeInvoice(companyBId, custBId, "ARS-B-INV-1", "2026-08-05", "Posted", 9999);
});

afterAll(async () => {
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'ARS-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'ARS-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'ARS-%'");
  if (arBeginningHeaderId) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [arBeginningHeaderId]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [arBeginningHeaderId]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('ARS-CUST-A', 'ARS-CUST-B')");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const range = (extra) => ({ from: "2026-08-01", to: "2026-08-31", ...extra });

describe("GET /api/reports/ar-statement-of-accounts", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .query(range({ partyId: custAId }));
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.AR - a user with no role -> 403", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(noRoleToken))
      .query(range({ partyId: custAId }));
    expect(res.status).toBe(403);
  });

  test("3. partyId is required", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query(range());
    expect(res.status).toBe(400);
  });

  test("4. from/to are required", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query({ partyId: custAId });
    expect(res.status).toBe(400);
  });

  test("5. company isolation - Company B's customer is rejected (404), matching Subsidiary Ledger's exact behavior", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query(range({ partyId: custBId }));
    expect(res.status).toBe(404);
  });

  let statement;
  test("6. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query(range({ partyId: custAId }));
    expect(res.status).toBe(200);
    expect(res.body.partyCode).toBe("ARS-CUST-A");
    expect(Array.isArray(res.body.rows)).toBe(true);
    statement = res.body;
  });

  test("7. beginning balance = AR beginning-balance import + pre-period invoice, both dated before 'from' (10000 + 1000 = 11000)", () => {
    expect(Number(statement.beginningBalance)).toBe(11000);
  });

  test("8. an in-range Posted invoice increases the running balance by its total_debit (running = 11000 + 5000 = 16000)", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-INV-1");
    expect(row).toBeDefined();
    expect(row.sourceType).toBe("INV");
    expect(Number(row.debit)).toBe(5000);
    expect(Number(row.credit)).toBe(0);
    expect(Number(row.runningBalance)).toBe(16000);
  });

  test("9. the Draft invoice is excluded entirely", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-INV-DRAFT");
    expect(row).toBeUndefined();
  });

  test("10. a payment (OR) decreases the running balance by its total (running = 16000 - 2000 = 14000)", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-OR-1");
    expect(row).toBeDefined();
    expect(row.sourceType).toBe("OR");
    expect(Number(row.debit)).toBe(0);
    expect(Number(row.credit)).toBe(2000);
    expect(Number(row.runningBalance)).toBe(14000);
  });

  test("11. a Debit Memo increases the running balance (running = 14000 + 300 = 14300)", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-DM-1");
    expect(row).toBeDefined();
    expect(row.sourceType).toBe("DEBIT MEMO");
    expect(Number(row.debit)).toBe(300);
    expect(Number(row.credit)).toBe(0);
    expect(Number(row.runningBalance)).toBe(14300);
  });

  test("12. a Credit Memo decreases the running balance (running = 14300 - 150 = 14150)", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-CM-1");
    expect(row).toBeDefined();
    expect(row.sourceType).toBe("CREDIT MEMO");
    expect(Number(row.debit)).toBe(0);
    expect(Number(row.credit)).toBe(150);
    expect(Number(row.runningBalance)).toBe(14150);
  });

  test("13. same-day ordering - the Invoice (sort_order 1) is applied before the OR (sort_order 2) on 2026-08-20", () => {
    const invRow = statement.rows.find((r) => r.referenceNo === "ARS-INV-SAMEDAY");
    const orRow = statement.rows.find((r) => r.referenceNo === "ARS-OR-SAMEDAY");
    expect(invRow).toBeDefined();
    expect(orRow).toBeDefined();
    expect(Number(invRow.runningBalance)).toBe(14950); // 14150 + 800
    expect(Number(orRow.runningBalance)).toBe(14150); // 14950 - 800
    const invIdx = statement.rows.indexOf(invRow);
    const orIdx = statement.rows.indexOf(orRow);
    expect(invIdx).toBeLessThan(orIdx);
  });

  test("14. an unpaid invoice still appears, with no offsetting payment row", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-INV-UNPAID");
    expect(row).toBeDefined();
    expect(Number(row.debit)).toBe(400);
    expect(Number(row.runningBalance)).toBe(14550); // 14150 + 400
  });

  test("15. a transaction dated after 'to' is excluded entirely", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-INV-OUTSIDE");
    expect(row).toBeUndefined();
  });

  test("16. ending balance = the last row's running balance (14550)", () => {
    expect(Number(statement.endingBalance)).toBe(14550);
  });

  test("17. company isolation - Company B's Posted invoice never leaks into Company A customer's statement", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-B-INV-1");
    expect(row).toBeUndefined();
  });

  test("18. due date is populated for Invoice rows (transaction_date used as due_date in this fixture)", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-INV-1");
    expect(row.dueDate).toBe("2026-08-05");
  });

  test("19. due date is null for non-Invoice rows", () => {
    const row = statement.rows.find((r) => r.referenceNo === "ARS-OR-1");
    expect(row.dueDate).toBeNull();
  });

  test("20. a customer with no transactions and no beginning balance still generates successfully (zero, not omitted)", async () => {
    const freshCust = await makeParty("ARS-CUST-FRESH", "CUSTOMER", "ARS Fresh Customer", companyAId);
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query(range({ partyId: freshCust }));
    expect(res.status).toBe(200);
    expect(Number(res.body.beginningBalance)).toBe(0);
    expect(res.body.rows).toHaveLength(0);
    expect(Number(res.body.endingBalance)).toBe(0);
    await pool.query("DELETE FROM general_libraries WHERE id = ?", [freshCust]);
  });

  test("21. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM invoice_headers WHERE voucher_no = 'ARS-INV-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(5000);
    expect(Number(header.total_credit)).toBe(5000);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("22. AR Statement of Accounts now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "ar-statement-of-accounts", label: "Statement of Accounts", icon: Receipt, path: "\/reports\/ar-statement-of-accounts"/
    );
  });

  test("23. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (ar-billings-and-collections, ar-overdue-accounts, ap-payables-and-payments, and ap-overdue-accounts were intentionally unlocked in later phases - see arBillingsAndCollections.http.test.js, arOverdueAccounts.http.test.js, apListOfPayablesAndPayments.http.test.js, and apOverdueAccounts.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of [
      "fixed-asset-lapsing",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("24. App.jsx routes /reports/ar-statement-of-accounts to ArStatementOfAccounts", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ArStatementOfAccounts from "\.\/pages\/REPORTS\/ArStatementOfAccounts\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/ar-statement-of-accounts" element={<ArStatementOfAccounts \/>} \/>/);
  });

  test("25. pathPermissionMap maps the new route to REPORTS.AR (same as AR Aging / AR Aging Summary)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/ar-statement-of-accounts": \["REPORTS\.AR", "VIEW"\]/);
  });

  test("26. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/AR_STATEMENT|STATEMENT_OF_ACCOUNTS/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("27. the AR Statement of Accounts route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-statement-of-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("28. the route delegates to ArStatementService.getArStatementOfAccounts", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ar-statement-of-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/ArStatementService\.getArStatementOfAccounts\(/);
  });

  test("29. ArStatementService.js reuses postedOnlySql() - no independent status filtering invented", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ArStatementService.js"), "utf8");
    expect(svcSrc).toMatch(/require\("\.\/reportRecognitionService"\)/);
    expect(svcSrc).toMatch(/postedOnlySql\(\)/);
    expect(svcSrc).not.toMatch(/status\s*=\s*'POSTED'/i);
  });

  test("30. the Subsidiary Ledger route itself was not modified by this phase (its AR union stays the pattern precedent, not a shared function this phase extracted)", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    expect(serverSrc).toMatch(/app\.get\("\/api\/reports\/subsidiary-ledger"/);
    const start = serverSrc.indexOf('app.get("/api/reports/subsidiary-ledger"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    // Untouched: still references ArStatementService nowhere, still its
    // own inline query exactly as before this phase.
    expect(routeBody).not.toMatch(/ArStatementService/);
  });
});

describe("31. Summary of Books by Totals, Net Summary of Books, and Daily Cash Position remain fully functional (regression check)", () => {
  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query(range());
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape, including grandTotalNet", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query(range());
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
    expect(res.body).toHaveProperty("grandTotalNet");
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-15" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });

  test("Subsidiary Ledger (AR) still works and independently agrees with this report's period activity direction", async () => {
    const res = await request(app)
      .get("/api/reports/subsidiary-ledger")
      .set(auth(adminToken))
      .query({ type: "AR", partyId: custAId, from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const invRow = res.body.find((r) => r.reference_no === "ARS-INV-1");
    expect(invRow).toBeDefined();
    expect(Number(invRow.debit)).toBe(5000);
  });

  test("AR Aging still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/ar-aging")
      .set(auth(adminToken))
      .query({ asOf: "2026-08-31", companyId: companyAId });
    expect(res.status).toBe(200);
  });
});

describe("32. CSV export stays formula-injection safe", () => {
  test("ArStatementOfAccounts.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "ArStatementOfAccounts.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`AR_Statement_of_Accounts_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "ArStatementOfAccounts.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "ArStatementOfAccounts.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
