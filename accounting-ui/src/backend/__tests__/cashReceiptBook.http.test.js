const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.3 - Books of Accounts: Cash Receipt Book.
// GET /api/reports/books/cash-receipt is a thin filter (source_type = 'OR')
// over the SAME canonical LedgerReportService.buildTransactionUnionSql
// every other Book (Journal, Income) is built on, via the shared
// getBookRows({sourceTypes, ...}) engine - no new recognition logic, no OR
// creation/settlement/application/tax workflow touched anywhere. This suite
// proves: auth, REPORTS.FINANCIAL enforcement, company isolation,
// Posted-only inclusion, inclusive date boundaries, multi-line preservation,
// debit/credit correctness, empty range, cross-book isolation in every
// direction (INV/JV never leak into Cash Receipt Book; OR never leaks into
// Income Book or Journal Book), no transaction mutation, menu/route wiring
// for exactly the three unlocked Books, and CSV safety.

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

async function makeOr(companyId, custId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Cash Receipt Book test customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, custId, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO or_lines (or_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeInvoice(companyId, custId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'Cash Receipt Book cross-leak customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, custId, date, totalDebit, totalCredit, totalDebit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, "x", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Cash Receipt Book cross-leak fixture', ?, ?, ?)`,
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

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('CRB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('CRB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("CrbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('crb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("crb_admin", "CrbPass!1");

  const hash2 = await bcrypt.hash("CrbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('crb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("crb_norole", "CrbPass!2");

  const custA = await makeParty("CRB-CUST-A", "CUSTOMER", "CRB Customer A", companyAId);
  const custB = await makeParty("CRB-CUST-B", "CUSTOMER", "CRB Customer B", companyBId);

  await makeCoa("CRB-CASH", "CRB Cash", "ASSET");
  await makeCoa("CRB-AR", "CRB Accounts Receivable", "ASSET");
  await makeCoa("CRB-REV", "CRB Sales Revenue", "INCOME");

  // Posted, in-range, 2 lines (settlement of AR via cash) - multi-line
  // preservation + debit/credit correctness.
  await makeOr(companyAId, custA, "CRB-POSTED-1", "2026-08-05", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 1120, credit: 0, particulars: "cash receipt" },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 1120, particulars: "AR settlement" },
  ]);

  // Non-Posted (Draft) - must be excluded.
  await makeOr(companyAId, custA, "CRB-DRAFT-1", "2026-08-05", "Draft", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 500, credit: 0 },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 500 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeOr(companyAId, custA, "CRB-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 50, credit: 0 },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 50 },
  ]);
  await makeOr(companyAId, custA, "CRB-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 60, credit: 0 },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makeOr(companyAId, custA, "CRB-OUTSIDE", "2026-09-05", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 999, credit: 0 },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeOr(companyBId, custB, "CRB-B-POSTED", "2026-08-05", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 7654, credit: 0 },
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 0, credit: 7654 },
  ]);

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each. Cash Receipt Book must show none of these;
  // the existing Income Book / Journal Book must show only their own.
  await makeInvoice(companyAId, custA, "CRB-CROSS-INV", "2026-08-06", "Posted", [
    { code: "CRB-AR", title: "CRB Accounts Receivable", debit: 432, credit: 0 },
    { code: "CRB-REV", title: "CRB Sales Revenue", debit: 0, credit: 432 },
  ]);
  await makeJv(companyAId, "CRB-CROSS-JV", "2026-08-07", "Posted", [
    { code: "CRB-CASH", title: "CRB Cash", debit: 765, credit: 0 },
    { code: "CRB-REV", title: "CRB Sales Revenue", debit: 0, credit: 765 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'CRB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'CRB-%'");
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'CRB-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'CRB-%'");
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'CRB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'CRB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'CRB-%'");
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

describe("GET /api/reports/books/cash-receipt", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted OR is included", () => {
    expect(rows.some((r) => r.reference_no === "CRB-POSTED-1")).toBe(true);
  });

  test("5. non-Posted (Draft) OR is excluded", () => {
    expect(rows.some((r) => r.reference_no === "CRB-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "CRB-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "CRB-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "CRB-OUTSIDE")).toBe(false);
  });

  test("25. company isolation - Company B's Posted OR never appears", () => {
    expect(rows.some((r) => r.reference_no === "CRB-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 7654 || Number(r.credit) === 7654)).toBe(false);
  });

  test("7. multiple OR accounting lines are preserved (2-line OR -> 2 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "CRB-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["CRB-AR", "CRB-CASH"]);
  });

  test("8. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "CRB-POSTED-1" && r.account_code === "CRB-CASH");
    expect(Number(line.debit)).toBe(1120);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "CRB-POSTED-1" && r.account_code === "CRB-AR");
    expect(Number(line.credit)).toBe(1120);
    expect(Number(line.debit)).toBe(0);
  });

  test("10. totals derive correctly from the actual rows", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // 1120 (posted-1 cash) + 50 (boundary-from cash) + 60 (boundary-to cash) = 1230
    expect(totalDebit).toBeCloseTo(1230, 2);
  });

  test("12. INV rows do not leak into Cash Receipt Book", () => {
    expect(rows.some((r) => r.reference_no === "CRB-CROSS-INV")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 432 || Number(r.credit) === 432)).toBe(false);
  });

  test("13. JV rows do not leak into Cash Receipt Book", () => {
    expect(rows.some((r) => r.reference_no === "CRB-CROSS-JV")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 765 || Number(r.credit) === 765)).toBe(false);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/cash-receipt")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("26. no transaction mutation occurs - OR rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM or_headers WHERE voucher_no = 'CRB-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1120);
    expect(Number(header.total_credit)).toBe(1120);
    const [lines] = await pool.query(
      `SELECT ol.debit, ol.credit FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no = 'CRB-POSTED-1' ORDER BY ol.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [1120, 0],
      [0, 1120],
    ]);
  });
});

describe("14/15/16/17. cross-book isolation - the other directions", () => {
  test("14. OR rows do not leak into Income Book", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CRB-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "CRB-CROSS-INV")).toBe(true);
  });

  test("17. Income Book remains INV-only for this fixture set", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.body.every((r) => r.reference_no !== "CRB-POSTED-1" && r.reference_no !== "CRB-CROSS-JV")).toBe(true);
  });

  test("15. OR rows do not leak into Journal Book", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CRB-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "CRB-CROSS-JV")).toBe(true);
  });

  test("16. Journal Book remains JV-only for this fixture set", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.body.every((r) => r.reference_no !== "CRB-POSTED-1" && r.reference_no !== "CRB-CROSS-INV")).toBe(true);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("18. Cash Receipt Book now routes to a real page", () => {
    expect(menuSrc).toMatch(
      /id: "cash-receipt-book", label: "Cash Receipt Book", icon: ArrowDownToLine, path: "\/reports\/books\/cash-receipt"/
    );
  });

  test("19. Journal Book remains unlocked", () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
  });

  test("20. Income Book remains unlocked", () => {
    expect(menuSrc).toMatch(/id: "income-book", label: "Income Book", icon: Banknote, path: "\/reports\/books\/income"/);
  });

  test("21. every individual Book of Accounts is now unlocked - cash-disbursement-book (L.4), accounts-payable-book (L.5), petty-cash-book (L.6) and debit-credit-memo-book (L.7) were unlocked in later phases, see their own test coverage", () => {
    for (const id of [
      "cash-disbursement-book",
      "accounts-payable-book",
      "petty-cash-book",
      "debit-credit-memo-book",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/books\\/`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("22. Summary of Books / Net Summary of Books / Daily Cash Position remain path: null", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/cash-receipt to CashReceiptBook, alongside Journal Book and Income Book", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import CashReceiptBook from "\.\/pages\/REPORTS\/CashReceiptBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-receipt" element={<CashReceiptBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as Journal/Income Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/cash-receipt": \["REPORTS\.FINANCIAL", "VIEW"\]/);
    expect(mapSrc).toMatch(/"\/reports\/books\/journal": \["REPORTS\.FINANCIAL", "VIEW"\]/);
    expect(mapSrc).toMatch(/"\/reports\/books\/income": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });

  test("CashReceiptBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config", () => {
    const src = read(FRONTEND, "CashReceiptBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Cash Receipt Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/cash-receipt"/);
    expect(src).toMatch(/referenceLabel="OR Number"/);
    expect(src).toMatch(/filenamePrefix="Cash_Receipt_Book"/);
  });

  test("Cash Receipt Book does not invent payment-method/bank/check-number/customer fields not authoritative on the canonical union", () => {
    const src = read(FRONTEND, "CashReceiptBook.jsx");
    expect(src).not.toMatch(/payment_?method|bank_?code|check_?no|customer_name|customerName/i);
    expect(src).not.toMatch(/fetch\(/);
  });
});

describe("24. route and service are read-only (source guard)", () => {
  test("the Cash Receipt Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/cash-receipt"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getCashReceiptBookRows/);
  });

  test("getCashReceiptBookRows delegates to the shared getBookRows(sourceTypes:['OR']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getCashReceiptBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["OR"\], from, to, companyId \}\)/);
  });
});

describe("23. CSV export stays formula-injection safe (shared BookReport, Cash Receipt Book config)", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([[{ t: "text", v: "=CRB(A1:A2)" }, { t: "num", v: "-1120.00" }]]);
    expect(csv).toContain('"\'=CRB(A1:A2)"');
    expect(csv).toContain('"-1120.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so Cash Receipt Book exports as Cash_Receipt_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });
});
