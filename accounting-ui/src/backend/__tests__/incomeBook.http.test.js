const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.2 - Books of Accounts: Income Book.
// GET /api/reports/books/income is a thin filter (source_type = 'INV') over
// the SAME canonical LedgerReportService.buildTransactionUnionSql every
// other ledger/financial report - and now Journal Book (Phase L.1) - is
// built on, via the shared getBookRows({sourceTypes, ...}) engine extracted
// in this phase. No new recognition logic, no invoice creation/posting/
// approval/tax workflow touched anywhere. This suite proves: auth,
// REPORTS.FINANCIAL enforcement, company isolation, Posted-only inclusion,
// inclusive date boundaries, multi-line preservation, debit/credit
// correctness, empty range, cross-book isolation in BOTH directions
// (non-INV rows never leak into Income Book; Journal Book still returns JV
// only), no transaction mutation, menu/route wiring for exactly the two
// unlocked Books, and CSV safety.

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

async function makeInvoice(companyId, custId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'Income Book test customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, date, totalDebit, totalCredit, totalDebit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Income Book cross-leak fixture', ?, ?, ?)`,
    [companyId, voucherNo, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO jv_lines (jv_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, "x", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeCv(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Income Book cross-leak payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO cv_lines (cv_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, "x", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('IBK Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('IBK Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("IbkPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ibk_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("ibk_admin", "IbkPass!1");

  const hash2 = await bcrypt.hash("IbkPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ibk_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("ibk_norole", "IbkPass!2");

  const custA = await makeParty("IBK-CUST-A", "CUSTOMER", "IBK Customer A", companyAId);
  const custB = await makeParty("IBK-CUST-B", "CUSTOMER", "IBK Customer B", companyBId);
  const suppA = await makeParty("IBK-SUPP-A", "SUPPLIER", "IBK Supplier A", companyAId);

  await makeCoa("IBK-AR", "IBK Accounts Receivable", "ASSET");
  await makeCoa("IBK-REV", "IBK Sales Revenue", "INCOME");
  await makeCoa("IBK-VAT", "IBK Output VAT Payable", "LIABILITY");
  await makeCoa("IBK-CASH", "IBK Cash", "ASSET");

  // Posted, in-range, 3 lines (a realistic AR / Revenue / Output VAT invoice
  // shape) - multi-line preservation + debit/credit correctness.
  await makeInvoice(companyAId, custA, "IBK-POSTED-1", "2026-08-05", "Posted", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 1120, credit: 0, particulars: "AR line" },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 1000, particulars: "revenue line" },
    { code: "IBK-VAT", title: "IBK Output VAT Payable", debit: 0, credit: 120, particulars: "output vat line" },
  ]);

  // Non-Posted (Draft) - must be excluded.
  await makeInvoice(companyAId, custA, "IBK-DRAFT-1", "2026-08-05", "Draft", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 500, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 500 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeInvoice(companyAId, custA, "IBK-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 50, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 50 },
  ]);
  await makeInvoice(companyAId, custA, "IBK-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 60, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makeInvoice(companyAId, custA, "IBK-OUTSIDE", "2026-09-05", "Posted", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 999, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeInvoice(companyBId, custB, "IBK-B-POSTED", "2026-08-05", "Posted", [
    { code: "IBK-AR", title: "IBK Accounts Receivable", debit: 8888, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 8888 },
  ]);

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each. Income Book must show none of these; the
  // existing Journal Book must show ONLY the JV one.
  await makeJv(companyAId, "IBK-CROSS-JV", "2026-08-06", "Posted", [
    { code: "IBK-CASH", title: "IBK Cash", debit: 321, credit: 0 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 0, credit: 321 },
  ]);
  await makeCv(companyAId, suppA, "IBK-CROSS-CV", "2026-08-07", "Posted", [
    { code: "IBK-CASH", title: "IBK Cash", debit: 0, credit: 654 },
    { code: "IBK-REV", title: "IBK Sales Revenue", debit: 654, credit: 0 },
  ]);
});

afterAll(async () => {
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'IBK-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'IBK-%'");
  await pool.query(
    "DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'IBK-%'"
  );
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'IBK-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'IBK-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'IBK-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'IBK-%'");
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

describe("GET /api/reports/books/income", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/income").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted Invoice is included", () => {
    expect(rows.some((r) => r.reference_no === "IBK-POSTED-1")).toBe(true);
  });

  test("5. non-Posted (Draft) Invoice is excluded", () => {
    expect(rows.some((r) => r.reference_no === "IBK-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "IBK-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "IBK-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "IBK-OUTSIDE")).toBe(false);
  });

  test("3 / 20. company isolation - Company B's Posted Invoice never appears", () => {
    expect(rows.some((r) => r.reference_no === "IBK-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 8888 || Number(r.credit) === 8888)).toBe(false);
  });

  test("7. invoice accounting lines are preserved (3-line invoice -> 3 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "IBK-POSTED-1");
    expect(posted).toHaveLength(3);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["IBK-AR", "IBK-REV", "IBK-VAT"]);
  });

  test("8. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "IBK-POSTED-1" && r.account_code === "IBK-AR");
    expect(Number(line.debit)).toBe(1120);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are preserved", () => {
    const rev = rows.find((r) => r.reference_no === "IBK-POSTED-1" && r.account_code === "IBK-REV");
    const vat = rows.find((r) => r.reference_no === "IBK-POSTED-1" && r.account_code === "IBK-VAT");
    expect(Number(rev.credit)).toBe(1000);
    expect(Number(vat.credit)).toBe(120);
  });

  test("10. totals derive correctly from the actual rows", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // 1120 (posted-1 AR) + 50 (boundary-from AR) + 60 (boundary-to AR) = 1230
    expect(totalDebit).toBeCloseTo(1230, 2);
  });

  test("12. non-INV transactions (JV, CV) do not leak into Income Book", () => {
    expect(rows.some((r) => r.reference_no === "IBK-CROSS-JV")).toBe(false);
    expect(rows.some((r) => r.reference_no === "IBK-CROSS-CV")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 321 || Number(r.credit) === 321)).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 654 || Number(r.credit) === 654)).toBe(false);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/income")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("19. no transaction mutation occurs - invoice rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM invoice_headers WHERE voucher_no = 'IBK-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1120);
    expect(Number(header.total_credit)).toBe(1120);
    const [lines] = await pool.query(
      `SELECT il.debit, il.credit FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no = 'IBK-POSTED-1' ORDER BY il.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [1120, 0],
      [0, 1000],
      [0, 120],
    ]);
  });
});

describe("13. Journal Book still returns JV only (cross-book isolation, the other direction)", () => {
  test("Journal Book excludes the Income Book / CV cross-leak fixtures and includes only the JV one", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "IBK-CROSS-JV")).toBe(true);
    expect(res.body.some((r) => r.reference_no === "IBK-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "IBK-CROSS-CV")).toBe(false);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("14. Income Book now routes to a real page", () => {
    expect(menuSrc).toMatch(/id: "income-book", label: "Income Book", icon: Banknote, path: "\/reports\/books\/income"/);
  });

  test("15. Journal Book remains unlocked", () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
  });

  test("16. every individual Book of Accounts is now unlocked - cash-receipt-book (L.3), cash-disbursement-book (L.4), accounts-payable-book (L.5), petty-cash-book (L.6) and debit-credit-memo-book (L.7) were unlocked in later phases, see their own test coverage", () => {
    for (const id of [
      "cash-receipt-book",
      "cash-disbursement-book",
      "accounts-payable-book",
      "petty-cash-book",
      "debit-credit-memo-book",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/books\\/`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("17. Summary of Books / Net Summary of Books / Daily Cash Position remain path: null", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/income to IncomeBook, alongside Journal Book", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import IncomeBook from "\.\/pages\/REPORTS\/IncomeBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as Journal Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/income": \["REPORTS\.FINANCIAL", "VIEW"\]/);
    expect(mapSrc).toMatch(/"\/reports\/books\/journal": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });

  test("IncomeBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config", () => {
    const src = read(FRONTEND, "IncomeBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Income Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/income"/);
    expect(src).toMatch(/referenceLabel="Invoice Number"/);
    expect(src).toMatch(/filenamePrefix="Income_Book"/);
  });

  test("Income Book does not invent a customer/client column - not part of the canonical union's authoritative fields", () => {
    const src = read(FRONTEND, "IncomeBook.jsx");
    // no customer/client prop passed to BookReport, no independent join/fetch -
    // the explanatory comment mentioning "customer" is fine, code is not.
    expect(src).not.toMatch(/customer_name|customerName|customerLabel|customerId/i);
    expect(src).not.toMatch(/fetch\(/);
    const bookReportSrc = read(FRONTEND, "BookReport.jsx");
    expect(bookReportSrc).not.toMatch(/customer_name|customerName/i);
  });
});

describe("19. route does not mutate anything (source guard)", () => {
  test("the Income Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/income"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getIncomeBookRows/);
  });

  test("getIncomeBookRows delegates to the shared getBookRows(sourceTypes:['INV']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getIncomeBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["INV"\], from, to, companyId \}\)/);
  });
});

describe("18. CSV export stays formula-injection safe (shared BookReport, Income Book config)", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([
      [{ t: "text", v: "=IBK(A1:A2)" }, { t: "num", v: "-1120.00" }],
    ]);
    expect(csv).toContain('"\'=IBK(A1:A2)"');
    expect(csv).toContain('"-1120.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so Income Book exports as Income_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });
});
