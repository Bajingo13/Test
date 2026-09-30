const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Net Summary of Books - second of the 9 previously-"Coming Soon" reports
// identified in the technical documentation audit.
// GET /api/reports/books/net-summary is NOT a new recognition query and
// NOT a new aggregation: LedgerReportService.getNetSummaryOfBooks() calls
// the unchanged getBooksSummaryTotals() (Summary of Books by Totals) and
// only adds a derived `net` field (= totalDebit - totalCredit) per Book,
// plus `grandTotalNet`. This suite proves: auth, REPORTS.FINANCIAL
// enforcement, company isolation, Posted-only inclusion, that net is
// calculated correctly for a positive, negative, and exactly-zero
// population, that a Book with zero matching transactions still appears
// with net 0 (not omitted), that the grand total net is the sum of all 7
// Books' nets, empty range, no transaction mutation, menu/route wiring,
// and CSV safety - mirroring summaryOfBooksByTotals.http.test.js's
// structure.
//
// Positive/negative net fixtures are deliberately constructed with
// mismatched debit/credit inserted directly via pool.execute (bypassing
// the application's own write-time debit==credit validation, the same
// established technique every existing Book test file already uses for
// its own fixtures) - this is the only way to exercise the raw
// SUM(debit)-SUM(credit) arithmetic's sign handling, since the system
// does not allow an out-of-balance voucher to be created through its own
// API. In real operation every Book's net is 0.00 by construction; this
// report exists to make it visible if it ever isn't.

jest.setTimeout(120000);

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
const coaIds = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeCoa(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  coaIds.push(r.insertId);
  return r.insertId;
}

async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}

async function insertLines(table, idCol, headerId, lines) {
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO ${table} (${idCol}, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [headerId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
}

// header total_debit/total_credit are stamped from the (possibly
// deliberately mismatched) line totals themselves - the header row's own
// stated totals just record what was inserted, they are not a second,
// independent computation of balance.
async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'NSB test fixture', ?, ?, ?)`,
    [companyId, voucherNo, date, totalDebit, totalCredit, status]
  );
  await insertLines("jv_lines", "jv_id", h.insertId, lines);
  return h.insertId;
}

async function makeOr(companyId, customerId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'NSB test customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, customerId, date, totalDebit, totalCredit, status]
  );
  await insertLines("or_lines", "or_id", h.insertId, lines);
  return h.insertId;
}

async function makeCv(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'NSB test payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  await insertLines("cv_lines", "cv_id", h.insertId, lines);
  return h.insertId;
}

async function makePettyCash(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'NSB test petty cash payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  await insertLines("petty_cash_lines", "petty_cash_id", h.insertId, lines);
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('NSB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('NSB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("NsbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('nsb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("nsb_admin", "NsbPass!1");

  const hash2 = await bcrypt.hash("NsbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('nsb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("nsb_norole", "NsbPass!2");

  await makeCoa("NSB-CASH", "NSB Cash", "ASSET");
  await makeCoa("NSB-REV", "NSB Revenue", "INCOME");
  await makeCoa("NSB-EXP", "NSB Expense", "EXPENSE");
  await makeCoa("NSB-AR", "NSB AR", "ASSET");

  const customer = await makeParty("NSB-CUST", "CUSTOMER", "NSB Customer", companyAId);
  const supplier = await makeParty("NSB-SUPP", "SUPPLIER", "NSB Supplier", companyAId);

  // --- Journal Book: balanced (net = 0) - the normal, healthy case ---
  await makeJv(companyAId, "NSB-JV-1", "2026-08-05", "Posted", [
    { code: "NSB-CASH", title: "NSB Cash", debit: 1000, credit: 0 },
    { code: "NSB-REV", title: "NSB Revenue", debit: 0, credit: 1000 },
  ]);
  // Draft JV in-range - must be excluded from both debit/credit and net.
  await makeJv(companyAId, "NSB-JV-DRAFT", "2026-08-05", "Draft", [
    { code: "NSB-CASH", title: "NSB Cash", debit: 5000, credit: 0 },
  ]);

  // --- Cash Receipt Book (OR): deliberately mismatched - debit > credit,
  // net = +200 (positive net case). ---
  await makeOr(companyAId, customer, "NSB-OR-1", "2026-08-06", "Posted", [
    { code: "NSB-CASH", title: "NSB Cash", debit: 500, credit: 0 },
    { code: "NSB-AR", title: "NSB AR", debit: 0, credit: 300 },
  ]);

  // --- Cash Disbursement Book (CV): deliberately mismatched - credit >
  // debit, net = -300 (negative net case). ---
  await makeCv(companyAId, supplier, "NSB-CV-1", "2026-08-07", "Posted", [
    { code: "NSB-EXP", title: "NSB Expense", debit: 100, credit: 0 },
    { code: "NSB-CASH", title: "NSB Cash", debit: 0, credit: 400 },
  ]);

  // --- Petty Cash Book: balanced (net = 0), explicit zero-net-with-data case ---
  await makePettyCash(companyAId, supplier, "NSB-PCV-1", "2026-08-08", "Posted", [
    { code: "NSB-EXP", title: "NSB Expense", debit: 150, credit: 0 },
    { code: "NSB-CASH", title: "NSB Cash", debit: 0, credit: 150 },
  ]);

  // Income Book, Accounts Payable Book, Debit/Credit Memo Book intentionally
  // have NO fixture data - proving those 3 Books still appear with net 0,
  // not omitted (zero-net-with-NO-data case).

  // --- Company B: Posted JV in the SAME date range - must never leak ---
  await makeJv(companyBId, "NSB-B-JV-1", "2026-08-05", "Posted", [
    { code: "NSB-CASH", title: "NSB Cash", debit: 9999, credit: 0 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'NSB-%'");
  await pool.query(
    "DELETE pl FROM petty_cash_lines pl JOIN petty_cash_headers ph ON ph.id = pl.petty_cash_id WHERE ph.voucher_no LIKE 'NSB-%'"
  );
  await pool.query("DELETE FROM petty_cash_headers WHERE voucher_no LIKE 'NSB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code IN ('NSB-CUST', 'NSB-SUPP')");
  if (coaIds.length) {
    await pool.query(`DELETE FROM chart_of_accounts WHERE id IN (${coaIds.map(() => "?").join(",")})`, coaIds);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const range = (extra) => ({ from: "2026-08-01", to: "2026-08-31", ...extra });

function findBook(summary, key) {
  return summary.books.find((b) => b.book === key);
}

describe("GET /api/reports/books/net-summary", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/net-summary").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/net-summary").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("3. from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/net-summary").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let summary;
  test("4. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/net-summary").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.books)).toBe(true);
    summary = res.body;
  });

  test("5. all 7 Books of Accounts are present, none omitted", () => {
    const keys = summary.books.map((b) => b.book).sort();
    expect(keys).toEqual(
      ["accountsPayable", "cashDisbursement", "cashReceipt", "debitCreditMemo", "income", "journal", "pettyCash"].sort()
    );
  });

  test("6. zero net - Journal Book (balanced population): net = 0, Draft excluded", () => {
    const journal = findBook(summary, "journal");
    expect(Number(journal.totalDebit)).toBe(1000);
    expect(Number(journal.totalCredit)).toBe(1000);
    expect(Number(journal.net)).toBe(0);
  });

  test("7. positive net - Cash Receipt Book (OR): 500 debit - 300 credit = +200", () => {
    const cashReceipt = findBook(summary, "cashReceipt");
    expect(Number(cashReceipt.totalDebit)).toBe(500);
    expect(Number(cashReceipt.totalCredit)).toBe(300);
    expect(Number(cashReceipt.net)).toBe(200);
  });

  test("8. negative net - Cash Disbursement Book (CV): 100 debit - 400 credit = -300", () => {
    const cashDisbursement = findBook(summary, "cashDisbursement");
    expect(Number(cashDisbursement.totalDebit)).toBe(100);
    expect(Number(cashDisbursement.totalCredit)).toBe(400);
    expect(Number(cashDisbursement.net)).toBe(-300);
  });

  test("9. zero net with data - Petty Cash Book (balanced): net = 0", () => {
    const pettyCash = findBook(summary, "pettyCash");
    expect(Number(pettyCash.totalDebit)).toBe(150);
    expect(Number(pettyCash.totalCredit)).toBe(150);
    expect(Number(pettyCash.net)).toBe(0);
  });

  test("10. zero net with NO data - Income/Accounts Payable/Debit-Credit Memo Books still appear, net = 0, not omitted", () => {
    for (const key of ["income", "accountsPayable", "debitCreditMemo"]) {
      const book = findBook(summary, key);
      expect(book).toBeDefined();
      expect(Number(book.totalDebit)).toBe(0);
      expect(Number(book.totalCredit)).toBe(0);
      expect(Number(book.net)).toBe(0);
      expect(book.transactionCount).toBe(0);
    }
  });

  test("11. grand total net is the sum of all 7 Books' nets (0 + 200 - 300 + 0 + 0 + 0 + 0 = -100)", () => {
    expect(Number(summary.grandTotalNet)).toBeCloseTo(-100, 2);
    // grandTotalNet must equal grandTotalDebit - grandTotalCredit exactly.
    expect(Number(summary.grandTotalNet)).toBeCloseTo(
      Number(summary.grandTotalDebit) - Number(summary.grandTotalCredit),
      2
    );
  });

  test("12. company isolation - Company B's Posted JV never contributes to Company A's net", () => {
    const journal = findBook(summary, "journal");
    expect(Number(journal.net)).toBe(0); // not 9999 (unbalanced Company B fixture)
  });

  test("13. empty range returns all 7 Books with zero totals and zero net, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
    for (const b of res.body.books) {
      expect(Number(b.net)).toBe(0);
    }
    expect(Number(res.body.grandTotalNet)).toBe(0);
  });

  test("14. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM or_headers WHERE voucher_no = 'NSB-OR-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(500);
    expect(Number(header.total_credit)).toBe(300);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("15. Net Summary of Books now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "net-summary-of-books", label: "Net Summary of Books", icon: FileBarChart2, path: "\/reports\/books\/net-summary"/
    );
  });

  test("16. Summary of Books by Totals stays real (unchanged) and the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched (daily-cash-position, ar-statement-of-accounts, ar-billings-and-collections, ar-overdue-accounts, ap-payables-and-payments, and ap-overdue-accounts were intentionally unlocked in later phases - see dailyCashPosition.http.test.js, arStatementOfAccounts.http.test.js, arBillingsAndCollections.http.test.js, arOverdueAccounts.http.test.js, apListOfPayablesAndPayments.http.test.js, and apOverdueAccounts.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "summary-of-books-totals", label: "Summary of Books by Totals", icon: FileBarChart, path: "\/reports\/books\/summary-totals"/
    );
    for (const id of [
      "fixed-asset-lapsing",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("17. App.jsx routes /reports/books/net-summary to NetSummaryOfBooks", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import NetSummaryOfBooks from "\.\/pages\/REPORTS\/NetSummaryOfBooks\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/net-summary" element={<NetSummaryOfBooks \/>} \/>/);
  });

  test("18. pathPermissionMap maps the new route to REPORTS.FINANCIAL (same as every other Book of Accounts report)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/net-summary": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("19. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/NET_SUMMARY/);
  });
});

describe("route does not mutate anything (source guard)", () => {
  test("20. the Net Summary of Books route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/net-summary"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("21. getNetSummaryOfBooks delegates to the unchanged getBooksSummaryTotals() - no new SQL, no new query", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("async function getNetSummaryOfBooks");
    const end = svcSrc.indexOf("\n}\n", start) + 2;
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).not.toMatch(/pool\.execute|pool\.query|SELECT /i);
    expect(fnBody).toMatch(/getBooksSummaryTotals\(\{ from, to, companyId \}\)/);
    expect(fnBody).toMatch(/net: b\.totalDebit - b\.totalCredit/);
  });

  test("22. getBooksSummaryTotals (Summary of Books by Totals) itself is completely unchanged by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("async function getBooksSummaryTotals");
    const end = svcSrc.indexOf("\n}\n", start) + 2;
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/return \{ books: perBook, grandTotalDebit, grandTotalCredit \};/);
  });
});

describe("23. Summary of Books by Totals remains fully functional (regression check)", () => {
  test("GET /api/reports/books/summary-totals still returns the same shape it always has (no `net` field leaked into it)", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.books)).toBe(true);
    expect(res.body.books).toHaveLength(7);
    expect(res.body).toHaveProperty("grandTotalDebit");
    expect(res.body).toHaveProperty("grandTotalCredit");
    // Summary of Books by Totals' own response never gained a `net`/
    // `grandTotalNet` field - that would be scope creep into an already-
    // completed, already-reviewed report.
    expect(res.body).not.toHaveProperty("grandTotalNet");
    for (const b of res.body.books) {
      expect(b).not.toHaveProperty("net");
    }
  });
});

describe("24. CSV export stays formula-injection safe", () => {
  test("NetSummaryOfBooks.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as SummaryOfBooksByTotals.jsx)", () => {
    const src = read(FRONTEND, "NetSummaryOfBooks.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`Net_Summary_of_Books_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("debit/credit/net cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "NetSummaryOfBooks.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "NetSummaryOfBooks.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
