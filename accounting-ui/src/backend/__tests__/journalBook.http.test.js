const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.1 - Books of Accounts: Journal Book.
// GET /api/reports/books/journal is a thin filter (source_type = 'JV') over
// the SAME canonical LedgerReportService.buildTransactionUnionSql every
// other ledger/financial report is built on - no new recognition logic, no
// new table, no JV posting/reversal behavior touched anywhere in this
// phase. This suite proves: auth, REPORTS.FINANCIAL permission enforcement,
// company isolation, Posted-only inclusion, inclusive date boundaries,
// multi-line preservation, debit/credit correctness, empty range, reversal
// pairs pass through unmodified, no transaction mutation, plus source-level
// guards that only Journal Book was unlocked in the menu and the CSV export
// path stays formula-injection safe.

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

async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Journal Book test fixture', ?, ?, ?)`,
    [companyId, voucherNo, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO jv_lines (jv_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('JBK Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('JBK Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("JbkPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('jbk_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("jbk_admin", "JbkPass!1");

  // role_id NULL, ACTIVE - authenticates fine, has no role at all so every
  // authorizePermission check default-denies (permissionService.can():
  // `if (!user.role_code) return false;`).
  const hash2 = await bcrypt.hash("JbkPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('jbk_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("jbk_norole", "JbkPass!2");

  const cash = await makeCoa("JBK-CASH", "JBK Cash", "ASSET");
  const rev = await makeCoa("JBK-REV", "JBK Revenue", "INCOME");
  const exp = await makeCoa("JBK-EXP", "JBK Expense", "EXPENSE");

  // Posted, in-range, 2 lines (multi-line + debit/credit correctness).
  await makeJv(companyAId, "JBK-POSTED-1", "2026-08-05", "Posted", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 1000, credit: 0, particulars: "posted debit line" },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 1000, particulars: "posted credit line" },
  ]);

  // Draft, in-range - must be excluded.
  await makeJv(companyAId, "JBK-DRAFT-1", "2026-08-05", "Draft", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 500, credit: 0 },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 500 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeJv(companyAId, "JBK-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 50, credit: 0 },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 50 },
  ]);
  await makeJv(companyAId, "JBK-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 60, credit: 0 },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely - must be excluded.
  await makeJv(companyAId, "JBK-OUTSIDE", "2026-09-05", "Posted", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 999, credit: 0 },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 999 },
  ]);

  // Reversal pair, both Posted, in-range - the union carries both rows as-is
  // (no reversal-specific logic invented here); net effect is zero.
  await makeJv(companyAId, "JBK-ORIG", "2026-08-10", "Posted", [
    { code: "JBK-EXP", title: "JBK Expense", debit: 300, credit: 0, particulars: "original" },
    { code: "JBK-CASH", title: "JBK Cash", debit: 0, credit: 300, particulars: "original" },
  ]);
  await makeJv(companyAId, "JBK-REVERSAL", "2026-08-11", "Posted", [
    { code: "JBK-EXP", title: "JBK Expense", debit: 0, credit: 300, particulars: "reversal" },
    { code: "JBK-CASH", title: "JBK Cash", debit: 300, credit: 0, particulars: "reversal" },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeJv(companyBId, "JBK-B-POSTED", "2026-08-05", "Posted", [
    { code: "JBK-CASH", title: "JBK Cash", debit: 7777, credit: 0 },
    { code: "JBK-REV", title: "JBK Revenue", debit: 0, credit: 7777 },
  ]);
});

afterAll(async () => {
  await pool.query(
    "DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'JBK-%'"
  );
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'JBK-%'");
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

describe("GET /api/reports/books/journal", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/journal").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted JV lines are included", () => {
    const posted = rows.filter((r) => r.reference_no === "JBK-POSTED-1");
    expect(posted.length).toBe(2);
  });

  test("5. Draft JV is excluded entirely", () => {
    expect(rows.some((r) => r.reference_no === "JBK-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "JBK-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "JBK-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "JBK-OUTSIDE")).toBe(false);
  });

  test("3. company isolation - Company B's Posted JV never appears", () => {
    expect(rows.some((r) => r.reference_no === "JBK-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 7777 || Number(r.credit) === 7777)).toBe(false);
  });

  test("7. multiple JV lines are preserved, not collapsed to one net row", () => {
    const posted = rows.filter((r) => r.reference_no === "JBK-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["JBK-CASH", "JBK-REV"]);
  });

  test("8. debit values are correct", () => {
    const line = rows.find((r) => r.reference_no === "JBK-POSTED-1" && r.account_code === "JBK-CASH");
    expect(Number(line.debit)).toBe(1000);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are correct", () => {
    const line = rows.find((r) => r.reference_no === "JBK-POSTED-1" && r.account_code === "JBK-REV");
    expect(Number(line.credit)).toBe(1000);
    expect(Number(line.debit)).toBe(0);
  });

  test("10. totals derive correctly from the actual rows (sum of debit == sum of credit for this balanced population)", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // total DEBIT alone (== total CREDIT, the population is balanced):
    // 1000 (posted-1 cash) + 50 (boundary-from cash) + 60 (boundary-to cash)
    // + 300 (orig expense) + 300 (reversal cash) = 1710
    expect(totalDebit).toBeCloseTo(1710, 2);
  });

  test("12. reversal pair passes through the canonical union unmodified - both vouchers present, net effect zero, no special-casing", () => {
    const orig = rows.filter((r) => r.reference_no === "JBK-ORIG");
    const reversal = rows.filter((r) => r.reference_no === "JBK-REVERSAL");
    expect(orig).toHaveLength(2);
    expect(reversal).toHaveLength(2);
    const net =
      orig.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0) +
      reversal.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
    expect(Math.abs(net)).toBeLessThan(0.005);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/journal")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("16. no transaction mutation occurs - JV rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM jv_headers WHERE voucher_no = 'JBK-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1000);
    expect(Number(header.total_credit)).toBe(1000);
    const [lines] = await pool.query(
      `SELECT jl.debit, jl.credit FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no = 'JBK-POSTED-1' ORDER BY jl.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [1000, 0],
      [0, 1000],
    ]);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test('13. Journal Book now routes to a real page', () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
  });

  test("14. every individual Book of Accounts is now unlocked - income-book (L.2), cash-receipt-book (L.3), cash-disbursement-book (L.4), accounts-payable-book (L.5), petty-cash-book (L.6) and debit-credit-memo-book (L.7) were unlocked in later phases, see their own test coverage", () => {
    for (const id of [
      "income-book",
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

  test("no other Books-of-Accounts/Summary/Daily-Cash-Position item was unlocked", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/journal to JournalBook", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import JournalBook from "\.\/pages\/REPORTS\/JournalBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL (Super Admin bypasses it, same as every other financial report)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/journal": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });
});

describe("route does not mutate anything (source guard)", () => {
  test("the Journal Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/journal"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("getJournalBookRows delegates to the shared getBookRows(sourceTypes:['JV']) engine (Phase L.2 extraction)", () => {
    const svcSrc = fs.readFileSync(
      path.join(__dirname, "../services/LedgerReportService.js"),
      "utf8"
    );
    const start = svcSrc.indexOf("function getJournalBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["JV"\], from, to, companyId \}\)/);
  });

  test("the shared getBookRows engine is read-only (SELECT only, reuses buildTransactionUnionSql, sourceTypes is parameterized not interpolated)", () => {
    const svcSrc = fs.readFileSync(
      path.join(__dirname, "../services/LedgerReportService.js"),
      "utf8"
    );
    const start = svcSrc.indexOf("async function getBookRows");
    const end = svcSrc.indexOf("\n}\n", start) + 2;
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/buildTransactionUnionSql\(/);
    expect(fnBody).toMatch(/WHERE tx\.source_type IN \(\$\{placeholders\}\)/);
    expect(fnBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    // sourceTypes values are bound as query params, never string-interpolated
    // into the SQL text itself - only the placeholder COUNT is interpolated.
    expect(fnBody).not.toMatch(/source_type IN \(\$\{sourceTypes/);
    expect(fnBody).toMatch(/\.\.\.sourceTypes/);
  });
});

describe("15. CSV export stays formula-injection safe", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv guards text cells but leaves numeric cells untouched", () => {
    const csv = M.typedRowsToCsv([
      [{ t: "text", v: "=SUM(A1:A2)" }, { t: "num", v: "-400.00" }],
      [{ t: "text", v: "  -danger" }, { t: "num", v: "0.00" }],
    ]);
    expect(csv).toContain('"\'=SUM(A1:A2)"');
    expect(csv).toContain('"-400.00"');
    expect(csv).toContain('"\'  -danger"');
    expect(csv).not.toMatch(/^"=SUM/m);
  });

  test("the shared BookReport.jsx exports via downloadCsvText + typedRowsToCsv (UTF-8 BOM applied at the download boundary), filename uses the caller's filenamePrefix", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("debit/credit cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("JournalBook.jsx is a thin, explicit wrapper configuring BookReport with its own literal filenamePrefix/apiPath (Phase L.2 extraction did not change Journal Book behavior)", () => {
    const src = read(FRONTEND, "JournalBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Journal Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/journal"/);
    expect(src).toMatch(/referenceLabel="JV Number"/);
    expect(src).toMatch(/filenamePrefix="Journal_Book"/);
  });

  test("no heavy PDF dependency was introduced (JournalBook.jsx + the shared BookReport.jsx)", () => {
    for (const f of ["JournalBook.jsx", "BookReport.jsx"]) {
      const src = read(FRONTEND, f);
      expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    }
    const bookReportSrc = read(FRONTEND, "BookReport.jsx");
    expect(bookReportSrc).toMatch(/window\.print\(\)/);
    expect(bookReportSrc).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
