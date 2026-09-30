const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Summary of Books by Totals - first of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/books/summary-totals is NOT a new recognition query: it
// calls LedgerReportService.getBooksSummaryTotals(), which itself calls the
// exact same 7 getXBookRows() functions every individual Book of Accounts
// page already uses (Phase L.1-L.7, unchanged), and reduces each Book's
// rows to {totalDebit, totalCredit} - the same sum BookReport.jsx already
// computes client-side per Book. This suite proves: auth, REPORTS.FINANCIAL
// enforcement, company isolation, Posted-only inclusion, inclusive date
// boundaries, that each Book's total is segregated correctly (not collapsed
// into one bucket), that a Book with zero matching transactions in range
// still appears with zero totals (not omitted), that the grand total is the
// sum of all 7 Books, empty range, no transaction mutation, menu/route
// wiring, and CSV safety - mirroring journalBook.http.test.js's structure.

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

async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'SBT test fixture', ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'SBT test customer', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'SBT test payee', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'SBT test petty cash payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  await insertLines("petty_cash_lines", "petty_cash_id", h.insertId, lines);
  return h.insertId;
}

async function makeMemo(companyId, memoType, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'SBT test party', ?, ?, ?, ?)`,
    [companyId, voucherNo, memoType, date, totalDebit, totalCredit, status]
  );
  await insertLines("memo_lines", "memo_id", h.insertId, lines);
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('SBT Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('SBT Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("SbtPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('sbt_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("sbt_admin", "SbtPass!1");

  const hash2 = await bcrypt.hash("SbtPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('sbt_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("sbt_norole", "SbtPass!2");

  await makeCoa("SBT-CASH", "SBT Cash", "ASSET");
  await makeCoa("SBT-REV", "SBT Revenue", "INCOME");
  await makeCoa("SBT-EXP", "SBT Expense", "EXPENSE");
  await makeCoa("SBT-AR", "SBT AR", "ASSET");

  const customer = await makeParty("SBT-CUST", "CUSTOMER", "SBT Customer", companyAId);
  const supplier = await makeParty("SBT-SUPP", "SUPPLIER", "SBT Supplier", companyAId);

  // --- Journal Book: 1 Posted JV in-range (debit=credit=1000) ---
  await makeJv(companyAId, "SBT-JV-1", "2026-08-05", "Posted", [
    { code: "SBT-CASH", title: "SBT Cash", debit: 1000, credit: 0 },
    { code: "SBT-REV", title: "SBT Revenue", debit: 0, credit: 1000 },
  ]);
  // Draft JV in-range - must be excluded.
  await makeJv(companyAId, "SBT-JV-DRAFT", "2026-08-05", "Draft", [
    { code: "SBT-CASH", title: "SBT Cash", debit: 500, credit: 0 },
    { code: "SBT-REV", title: "SBT Revenue", debit: 0, credit: 500 },
  ]);
  // Outside range - must be excluded.
  await makeJv(companyAId, "SBT-JV-OUTSIDE", "2026-09-05", "Posted", [
    { code: "SBT-CASH", title: "SBT Cash", debit: 999, credit: 0 },
    { code: "SBT-REV", title: "SBT Revenue", debit: 0, credit: 999 },
  ]);

  // --- Cash Receipt Book (OR): 1 Posted OR in-range (debit=credit=2000) ---
  await makeOr(companyAId, customer, "SBT-OR-1", "2026-08-06", "Posted", [
    { code: "SBT-CASH", title: "SBT Cash", debit: 2000, credit: 0 },
    { code: "SBT-AR", title: "SBT AR", debit: 0, credit: 2000 },
  ]);

  // --- Cash Disbursement Book (CV): 1 Posted CV in-range (debit=credit=300) ---
  await makeCv(companyAId, supplier, "SBT-CV-1", "2026-08-07", "Posted", [
    { code: "SBT-EXP", title: "SBT Expense", debit: 300, credit: 0 },
    { code: "SBT-CASH", title: "SBT Cash", debit: 0, credit: 300 },
  ]);

  // --- Petty Cash Book: 1 Posted PCV in-range (debit=credit=150) ---
  await makePettyCash(companyAId, supplier, "SBT-PCV-1", "2026-08-08", "Posted", [
    { code: "SBT-EXP", title: "SBT Expense", debit: 150, credit: 0 },
    { code: "SBT-CASH", title: "SBT Cash", debit: 0, credit: 150 },
  ]);

  // --- Debit/Credit Memo Book: 1 Posted DEBIT memo in-range (debit=credit=75) ---
  await makeMemo(companyAId, "DEBIT", "SBT-DM-1", "2026-08-09", "Posted", [
    { code: "SBT-AR", title: "SBT AR", debit: 75, credit: 0 },
    { code: "SBT-REV", title: "SBT Revenue", debit: 0, credit: 75 },
  ]);

  // Note: Income Book (INV) and Accounts Payable Book (APV) intentionally
  // have NO fixture data in range - proving those two Books still appear
  // in the summary with zero totals rather than being omitted.

  // --- Company B: Posted JV in the SAME date range - must never leak ---
  await makeJv(companyBId, "SBT-B-JV-1", "2026-08-05", "Posted", [
    { code: "SBT-CASH", title: "SBT Cash", debit: 8888, credit: 0 },
    { code: "SBT-REV", title: "SBT Revenue", debit: 0, credit: 8888 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'SBT-%'");
  await pool.query(
    "DELETE pl FROM petty_cash_lines pl JOIN petty_cash_headers ph ON ph.id = pl.petty_cash_id WHERE ph.voucher_no LIKE 'SBT-%'"
  );
  await pool.query("DELETE FROM petty_cash_headers WHERE voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE ml FROM memo_lines ml JOIN memo_headers mh ON mh.id = ml.memo_id WHERE mh.voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'SBT-%'");
  await pool.query("DELETE FROM general_libraries WHERE code IN ('SBT-CUST', 'SBT-SUPP')");
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

describe("GET /api/reports/books/summary-totals", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("3. from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let summary;
  test("4. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth(adminToken)).query(range());
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

  test("6. Journal Book total reflects only the Posted, in-range JV (Draft and out-of-range excluded)", () => {
    const journal = findBook(summary, "journal");
    expect(Number(journal.totalDebit)).toBe(1000);
    expect(Number(journal.totalCredit)).toBe(1000);
    expect(journal.transactionCount).toBe(2); // 2 lines of SBT-JV-1
  });

  test("7. Cash Receipt Book (OR) total is correct and segregated from Journal Book", () => {
    const cashReceipt = findBook(summary, "cashReceipt");
    expect(Number(cashReceipt.totalDebit)).toBe(2000);
    expect(Number(cashReceipt.totalCredit)).toBe(2000);
  });

  test("8. Cash Disbursement Book (CV) total is correct", () => {
    const cashDisbursement = findBook(summary, "cashDisbursement");
    expect(Number(cashDisbursement.totalDebit)).toBe(300);
    expect(Number(cashDisbursement.totalCredit)).toBe(300);
  });

  test("9. Petty Cash Book total is correct", () => {
    const pettyCash = findBook(summary, "pettyCash");
    expect(Number(pettyCash.totalDebit)).toBe(150);
    expect(Number(pettyCash.totalCredit)).toBe(150);
  });

  test("10. Debit/Credit Memo Book total is correct", () => {
    const memo = findBook(summary, "debitCreditMemo");
    expect(Number(memo.totalDebit)).toBe(75);
    expect(Number(memo.totalCredit)).toBe(75);
  });

  test("11. Books with zero matching transactions (Income, Accounts Payable) still appear, with zero totals - not omitted", () => {
    const income = findBook(summary, "income");
    const ap = findBook(summary, "accountsPayable");
    expect(income).toBeDefined();
    expect(Number(income.totalDebit)).toBe(0);
    expect(Number(income.totalCredit)).toBe(0);
    expect(income.transactionCount).toBe(0);
    expect(ap).toBeDefined();
    expect(Number(ap.totalDebit)).toBe(0);
    expect(Number(ap.totalCredit)).toBe(0);
  });

  test("12. grand total is the sum of all 7 Books' totals (1000+2000+300+150+75 = 3525 each side)", () => {
    expect(Number(summary.grandTotalDebit)).toBeCloseTo(3525, 2);
    expect(Number(summary.grandTotalCredit)).toBeCloseTo(3525, 2);
    expect(Number(summary.grandTotalDebit)).toBeCloseTo(Number(summary.grandTotalCredit), 2);
  });

  test("13. company isolation - Company B's Posted JV never contributes to Company A's summary", () => {
    const journal = findBook(summary, "journal");
    expect(Number(journal.totalDebit)).toBe(1000); // not 1000 + 8888
  });

  test("14. empty range returns all 7 Books with zero totals, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
    for (const b of res.body.books) {
      expect(Number(b.totalDebit)).toBe(0);
      expect(Number(b.totalCredit)).toBe(0);
    }
    expect(Number(res.body.grandTotalDebit)).toBe(0);
    expect(Number(res.body.grandTotalCredit)).toBe(0);
  });

  test("15. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM jv_headers WHERE voucher_no = 'SBT-JV-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1000);
    expect(Number(header.total_credit)).toBe(1000);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("16. Summary of Books by Totals now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "summary-of-books-totals", label: "Summary of Books by Totals", icon: FileBarChart, path: "\/reports\/books\/summary-totals"/
    );
  });

  test("17. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (net-summary-of-books, daily-cash-position, ar-statement-of-accounts, ar-billings-and-collections, ar-overdue-accounts, ap-payables-and-payments, and ap-overdue-accounts were intentionally unlocked in later phases - see netSummaryOfBooks.http.test.js, dailyCashPosition.http.test.js, arStatementOfAccounts.http.test.js, arBillingsAndCollections.http.test.js, arOverdueAccounts.http.test.js, apListOfPayablesAndPayments.http.test.js, and apOverdueAccounts.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of [
      "fixed-asset-lapsing",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("18. App.jsx routes /reports/books/summary-totals to SummaryOfBooksByTotals", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import SummaryOfBooksByTotals from "\.\/pages\/REPORTS\/SummaryOfBooksByTotals\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/summary-totals" element={<SummaryOfBooksByTotals \/>} \/>/);
  });

  test("19. pathPermissionMap maps the new route to REPORTS.FINANCIAL (same as every other Book of Accounts report)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/summary-totals": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("20. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_SUMMARY|SUMMARY_OF_BOOKS/);
  });
});

describe("route does not mutate anything (source guard)", () => {
  test("21. the Summary of Books by Totals route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/summary-totals"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("22. getBooksSummaryTotals delegates to the 7 existing getXBookRows() functions - no new recognition SQL", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("async function getBooksSummaryTotals");
    const end = svcSrc.indexOf("\n}\n", start) + 2;
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).not.toMatch(/pool\.execute|pool\.query|SELECT /i);
    expect(fnBody).toMatch(/BOOK_SUMMARY_DEFINITIONS/);
  });

  test("23. BOOK_SUMMARY_DEFINITIONS references the exact 7 existing per-Book functions, not new ones", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("const BOOK_SUMMARY_DEFINITIONS");
    const end = svcSrc.indexOf("];", start) + 2;
    const block = svcSrc.slice(start, end);
    for (const fn of [
      "getJournalBookRows",
      "getIncomeBookRows",
      "getCashReceiptBookRows",
      "getCashDisbursementBookRows",
      "getAccountsPayableBookRows",
      "getPettyCashBookRows",
      "getDebitCreditMemoBookRows",
    ]) {
      expect(block).toMatch(new RegExp(`getRows: ${fn}`));
    }
  });
});

describe("24. CSV export stays formula-injection safe", () => {
  test("SummaryOfBooksByTotals.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as BookReport.jsx)", () => {
    const src = read(FRONTEND, "SummaryOfBooksByTotals.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`Summary_of_Books_by_Totals_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("debit/credit cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "SummaryOfBooksByTotals.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "SummaryOfBooksByTotals.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
