const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.4 - Books of Accounts: Cash Disbursement Book.
// GET /api/reports/books/cash-disbursement is a thin filter (source_type =
// 'CV') over the SAME canonical LedgerReportService.buildTransactionUnionSql
// every other Book (Journal, Income, Cash Receipt) is built on, via the
// shared getBookRows({sourceTypes, ...}) engine - no new recognition logic,
// no Check Voucher creation/posting/void/cancel/reversal/APV-settlement/tax
// workflow touched anywhere. This suite proves: auth, REPORTS.FINANCIAL
// enforcement, company isolation, Posted-only inclusion, inclusive date
// boundaries, multi-line preservation, debit/credit correctness, empty
// range, CV lifecycle (Void/Cancelled excluded exactly like every other
// report; a CV "reversal" produces a separate Posted JV, not a second CV
// row), cross-book isolation in every direction, no transaction mutation,
// menu/route wiring for exactly the four unlocked Books, and CSV safety.

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

async function makeCv(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Cash Disbursement Book test payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO cv_lines (cv_id, account_code, account_title, particulars, debit, credit)
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
     VALUES (?, ?, ?, 'Cash Disbursement Book cross-leak customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
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

async function makeOr(companyId, custId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Cash Disbursement Book cross-leak customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, custId, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO or_lines (or_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Cash Disbursement Book cross-leak/reversal fixture', ?, ?, ?)`,
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

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('CDB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('CDB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("CdbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('cdb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("cdb_admin", "CdbPass!1");

  const hash2 = await bcrypt.hash("CdbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('cdb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("cdb_norole", "CdbPass!2");

  const suppA = await makeParty("CDB-SUPP-A", "SUPPLIER", "CDB Supplier A", companyAId);
  const suppB = await makeParty("CDB-SUPP-B", "SUPPLIER", "CDB Supplier B", companyBId);
  const custA = await makeParty("CDB-CUST-A", "CUSTOMER", "CDB Customer A", companyAId);

  await makeCoa("CDB-CASH", "CDB Cash", "ASSET");
  await makeCoa("CDB-AP", "CDB Accounts Payable", "LIABILITY");
  await makeCoa("CDB-AR", "CDB Accounts Receivable", "ASSET");
  await makeCoa("CDB-REV", "CDB Sales Revenue", "INCOME");

  // Posted, in-range, 2 lines (AP settlement via cash) - multi-line
  // preservation + debit/credit correctness.
  await makeCv(companyAId, suppA, "CDB-POSTED-1", "2026-08-05", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 1120, credit: 0, particulars: "AP settlement" },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 1120, particulars: "cash disbursed" },
  ]);

  // Non-Posted (Draft) - must be excluded.
  await makeCv(companyAId, suppA, "CDB-DRAFT-1", "2026-08-05", "Draft", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 500, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 500 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeCv(companyAId, suppA, "CDB-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 50, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 50 },
  ]);
  await makeCv(companyAId, suppA, "CDB-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 60, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makeCv(companyAId, suppA, "CDB-OUTSIDE", "2026-09-05", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 999, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeCv(companyBId, suppB, "CDB-B-POSTED", "2026-08-05", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 5432, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 5432 },
  ]);

  // Lifecycle fixtures - Void and Cancelled CVs, in-range, Company A. Both
  // must be excluded (postedOnlySql = UPPER(status)='POSTED' only).
  await makeCv(companyAId, suppA, "CDB-VOID-1", "2026-08-08", "Void", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 700, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 700 },
  ]);
  await makeCv(companyAId, suppA, "CDB-CANCELLED-1", "2026-08-09", "Cancelled", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 800, credit: 0 },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 800 },
  ]);

  // Reversal scenario - per POST /api/cv/:id/reverse, a CV reversal creates
  // a SEPARATE Posted reversing JV (module: "CV"); the original CV row
  // stays Posted, unchanged. Modeled here as: one Posted "reversed" CV
  // (still fully present, values unchanged) + a separate Posted JV playing
  // the reversing entry's role - proving the Book shows the CV exactly
  // once, with no collapsing/double-counting/special-casing.
  await makeCv(companyAId, suppA, "CDB-REVERSED-ORIGINAL", "2026-08-10", "Posted", [
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 400, credit: 0, particulars: "original (later reversed)" },
    { code: "CDB-CASH", title: "CDB Cash", debit: 0, credit: 400, particulars: "original (later reversed)" },
  ]);
  await makeJv(companyAId, "CDB-REVERSAL-JV", "2026-08-11", "Posted", [
    { code: "CDB-CASH", title: "CDB Cash", debit: 400, credit: 0, particulars: "reversal of CDB-REVERSED-ORIGINAL" },
    { code: "CDB-AP", title: "CDB Accounts Payable", debit: 0, credit: 400, particulars: "reversal of CDB-REVERSED-ORIGINAL" },
  ]);

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each. Cash Disbursement Book must show none of
  // these; the existing Income Book / Journal Book / Cash Receipt Book must
  // show only their own.
  await makeInvoice(companyAId, custA, "CDB-CROSS-INV", "2026-08-06", "Posted", [
    { code: "CDB-AR", title: "CDB Accounts Receivable", debit: 210, credit: 0 },
    { code: "CDB-REV", title: "CDB Sales Revenue", debit: 0, credit: 210 },
  ]);
  await makeOr(companyAId, custA, "CDB-CROSS-OR", "2026-08-12", "Posted", [
    { code: "CDB-CASH", title: "CDB Cash", debit: 150, credit: 0 },
    { code: "CDB-AR", title: "CDB Accounts Receivable", debit: 0, credit: 150 },
  ]);
  await makeJv(companyAId, "CDB-CROSS-JV", "2026-08-13", "Posted", [
    { code: "CDB-CASH", title: "CDB Cash", debit: 321, credit: 0 },
    { code: "CDB-REV", title: "CDB Sales Revenue", debit: 0, credit: 321 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'CDB-%'");
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'CDB-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'CDB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'CDB-%'");
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

describe("GET /api/reports/books/cash-disbursement", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted CV is included", () => {
    expect(rows.some((r) => r.reference_no === "CDB-POSTED-1")).toBe(true);
  });

  test("5. non-Posted (Draft) CV is excluded", () => {
    expect(rows.some((r) => r.reference_no === "CDB-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "CDB-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "CDB-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "CDB-OUTSIDE")).toBe(false);
  });

  test("27. company isolation - Company B's Posted CV never appears", () => {
    expect(rows.some((r) => r.reference_no === "CDB-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 5432 || Number(r.credit) === 5432)).toBe(false);
  });

  test("7. multiple CV accounting lines are preserved (2-line CV -> 2 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "CDB-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["CDB-AP", "CDB-CASH"]);
  });

  test("8. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "CDB-POSTED-1" && r.account_code === "CDB-AP");
    expect(Number(line.debit)).toBe(1120);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "CDB-POSTED-1" && r.account_code === "CDB-CASH");
    expect(Number(line.credit)).toBe(1120);
    expect(Number(line.debit)).toBe(0);
  });

  test("10. totals derive correctly from the actual rows", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // 1120 (posted-1 AP) + 50 (boundary-from AP) + 60 (boundary-to AP) + 400 (reversed-original AP) = 1630
    expect(totalDebit).toBeCloseTo(1630, 2);
  });

  test("12. INV rows do not leak into Cash Disbursement Book", () => {
    expect(rows.some((r) => r.reference_no === "CDB-CROSS-INV")).toBe(false);
  });

  test("13. JV rows do not leak into Cash Disbursement Book", () => {
    expect(rows.some((r) => r.reference_no === "CDB-CROSS-JV" || r.reference_no === "CDB-REVERSAL-JV")).toBe(false);
  });

  test("14. OR rows do not leak into Cash Disbursement Book", () => {
    expect(rows.some((r) => r.reference_no === "CDB-CROSS-OR")).toBe(false);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/cash-disbursement")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("28. no transaction mutation occurs - CV rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM cv_headers WHERE voucher_no = 'CDB-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1120);
    expect(Number(header.total_credit)).toBe(1120);
    const [lines] = await pool.query(
      `SELECT cl.debit, cl.credit FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no = 'CDB-POSTED-1' ORDER BY cl.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [1120, 0],
      [0, 1120],
    ]);
  });
});

describe("CV lifecycle / reversal behavior follows the canonical union unmodified (Part 12)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(adminToken)).query(range());
    rows = res.body;
  });

  test("Void CV is excluded (status != 'POSTED' case-insensitively, inherited from postedOnlySql - no report-specific rule invented)", () => {
    expect(rows.some((r) => r.reference_no === "CDB-VOID-1")).toBe(false);
  });

  test("Cancelled CV is excluded (same inherited rule)", () => {
    expect(rows.some((r) => r.reference_no === "CDB-CANCELLED-1")).toBe(false);
  });

  test("a reversed CV's original row stays Posted and appears exactly once, values unchanged - reversal does not collapse, duplicate, or zero it out here", () => {
    const original = rows.filter((r) => r.reference_no === "CDB-REVERSED-ORIGINAL");
    expect(original).toHaveLength(2);
    expect(original.map((r) => [r.account_code, Number(r.debit), Number(r.credit)]).sort()).toEqual([
      ["CDB-AP", 400, 0],
      ["CDB-CASH", 0, 400],
    ]);
  });

  test("the reversing entry is a JV, not a second CV row - it never appears in Cash Disbursement Book", () => {
    expect(rows.some((r) => r.reference_no === "CDB-REVERSAL-JV")).toBe(false);
  });

  test("the reversing JV appears in Journal Book instead, and Journal Book does not show the original CV", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CDB-REVERSAL-JV")).toBe(true);
    expect(res.body.some((r) => r.reference_no === "CDB-REVERSED-ORIGINAL")).toBe(false);
  });
});

describe("15/16/17/18/19/20. cross-book isolation - the other directions", () => {
  test("15. CV rows do not leak into Income Book; 18. Income Book remains INV-only for this fixture set", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CDB-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "CDB-CROSS-INV")).toBe(true);
    expect(res.body.every((r) => !String(r.reference_no || "").startsWith("CDB-") || r.reference_no === "CDB-CROSS-INV")).toBe(
      true
    );
  });

  test("16. CV rows do not leak into Journal Book; 19. Journal Book remains JV-only for this fixture set", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CDB-POSTED-1")).toBe(false);
    const cdbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("CDB-")));
    expect([...cdbRefs].sort()).toEqual(["CDB-CROSS-JV", "CDB-REVERSAL-JV"]);
  });

  test("17. CV rows do not leak into Cash Receipt Book; 20. Cash Receipt Book remains OR-only for this fixture set", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "CDB-POSTED-1")).toBe(false);
    const cdbRefs = res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("CDB-"));
    expect(cdbRefs).toEqual(["CDB-CROSS-OR", "CDB-CROSS-OR"]);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("21. Cash Disbursement Book now routes to a real page", () => {
    expect(menuSrc).toMatch(
      /id: "cash-disbursement-book", label: "Cash Disbursement Book", icon: ArrowUpFromLine, path: "\/reports\/books\/cash-disbursement"/
    );
  });

  test("22. the prior three Books remain unlocked", () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
    expect(menuSrc).toMatch(/id: "income-book", label: "Income Book", icon: Banknote, path: "\/reports\/books\/income"/);
    expect(menuSrc).toMatch(
      /id: "cash-receipt-book", label: "Cash Receipt Book", icon: ArrowDownToLine, path: "\/reports\/books\/cash-receipt"/
    );
  });

  test("23. every individual Book of Accounts is now unlocked - accounts-payable-book (L.5), petty-cash-book (L.6) and debit-credit-memo-book (L.7) were unlocked in later phases, see their own test coverage", () => {
    for (const id of ["accounts-payable-book", "petty-cash-book", "debit-credit-memo-book"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/books\\/`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("24. Summary of Books / Net Summary of Books / Daily Cash Position remain path: null", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/cash-disbursement to CashDisbursementBook, alongside the other three Books", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import CashDisbursementBook from "\.\/pages\/REPORTS\/CashDisbursementBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-disbursement" element={<CashDisbursementBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-receipt" element={<CashReceiptBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as every other Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/cash-disbursement": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });

  test("\"Check Voucher\" is this repository's own existing terminology for CV - verified via transactionsMenuConfig.js/CV.jsx, not guessed", () => {
    const cvMenuSrc = fs.readFileSync(
      path.join(__dirname, "../../components/sidebar/transactionsMenuConfig.js"),
      "utf8"
    );
    expect(cvMenuSrc).toMatch(/label: "Check Voucher"/);
    const cvPageSrc = fs.readFileSync(path.join(FRONTEND, "..", "TRANSACTIONS", "CV.jsx"), "utf8");
    expect(cvPageSrc).toMatch(/title="Check Voucher"/);
  });

  test("CashDisbursementBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config", () => {
    const src = read(FRONTEND, "CashDisbursementBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Cash Disbursement Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/cash-disbursement"/);
    expect(src).toMatch(/referenceLabel="CV Number"/);
    expect(src).toMatch(/filenamePrefix="Cash_Disbursement_Book"/);
    expect(src).toMatch(/No Posted Check Vouchers found for the selected dates\./);
  });

  test("Cash Disbursement Book does not invent supplier/APV-application/check-number/bank/EWT/VAT/payment-method fields not authoritative on the canonical union", () => {
    const src = read(FRONTEND, "CashDisbursementBook.jsx");
    // no such prop/column/field in actual code - the explanatory comment
    // mentioning these terms in prose is fine, code is not.
    expect(src).not.toMatch(/payee_name|payeeName|checkNo|bankCode|vatAmount|ewtAmount|paymentMethod/);
    expect(src).not.toMatch(/fetch\(/);
    const bookReportSrc = read(FRONTEND, "BookReport.jsx");
    expect(bookReportSrc).not.toMatch(/payee_name|payeeName|checkNo|bankCode/);
  });
});

describe("26. route and service are read-only (source guard)", () => {
  test("the Cash Disbursement Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/cash-disbursement"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getCashDisbursementBookRows/);
  });

  test("getCashDisbursementBookRows delegates to the shared getBookRows(sourceTypes:['CV']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getCashDisbursementBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["CV"\], from, to, companyId \}\)/);
  });
});

describe("25. CSV export stays formula-injection safe (shared BookReport, Cash Disbursement Book config)", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([[{ t: "text", v: "=CDB(A1:A2)" }, { t: "num", v: "-1120.00" }]]);
    expect(csv).toContain('"\'=CDB(A1:A2)"');
    expect(csv).toContain('"-1120.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so Cash Disbursement Book exports as Cash_Disbursement_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });
});
