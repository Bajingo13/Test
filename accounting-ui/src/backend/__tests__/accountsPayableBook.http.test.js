const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.5 - Books of Accounts: Accounts Payable Book.
// GET /api/reports/books/accounts-payable is a thin filter (source_type =
// 'APV') over the SAME canonical LedgerReportService.buildTransactionUnionSql
// every other Book (Journal, Income, Cash Receipt, Cash Disbursement) is
// built on, via the shared getBookRows({sourceTypes, ...}) engine - no new
// recognition logic, no APV creation/posting/void/cancel/reversal/CV-
// settlement/AP-aging/tax workflow touched anywhere. This suite proves:
// auth, REPORTS.FINANCIAL enforcement, company isolation, Posted-only
// inclusion, inclusive date boundaries, multi-line preservation,
// debit/credit correctness, empty range, APV lifecycle (Void/Cancelled
// excluded exactly like every other Book; an APV "reversal" produces a
// separate Posted JV, not a second APV row), settlement consistency (a
// later CV payment never changes what the APV Book shows - this is an
// accounting book, not AP Aging), five-way cross-book isolation, no
// transaction mutation, menu/route wiring for exactly the five unlocked
// Books, and CSV safety.

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

async function makeApv(companyId, suppId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'Accounts Payable Book test supplier', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, suppId, date, totalDebit, totalCredit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO apv_lines (apv_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeCv(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'AP Book cross-leak/settlement payee', ?, ?, ?, ?)`,
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

async function makeInvoice(companyId, custId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'AP Book cross-leak customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
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
     VALUES (?, ?, ?, 'AP Book cross-leak customer', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'AP Book cross-leak/reversal fixture', ?, ?, ?)`,
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

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("ApbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("apb_admin", "ApbPass!1");

  const hash2 = await bcrypt.hash("ApbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("apb_norole", "ApbPass!2");

  const suppA = await makeParty("APB-SUPP-A", "SUPPLIER", "APB Supplier A", companyAId);
  const suppB = await makeParty("APB-SUPP-B", "SUPPLIER", "APB Supplier B", companyBId);
  const custA = await makeParty("APB-CUST-A", "CUSTOMER", "APB Customer A", companyAId);

  await makeCoa("APB-EXP", "APB Expense", "EXPENSE");
  await makeCoa("APB-AP", "APB Accounts Payable", "LIABILITY");
  await makeCoa("APB-VAT", "APB Input VAT", "ASSET");
  await makeCoa("APB-CASH", "APB Cash", "ASSET");
  await makeCoa("APB-AR", "APB Accounts Receivable", "ASSET");
  await makeCoa("APB-REV", "APB Sales Revenue", "INCOME");

  // Posted, in-range, 3 lines (a realistic Expense / Input VAT / AP control
  // shape) - multi-line preservation + debit/credit correctness. Represents
  // whatever the canonical union already recognizes: AP control line +
  // expense line + VAT input line, unchanged/unreinterpreted.
  await makeApv(companyAId, suppA, "APB-POSTED-1", "2026-08-05", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 1000, credit: 0, particulars: "expense line" },
    { code: "APB-VAT", title: "APB Input VAT", debit: 120, credit: 0, particulars: "input vat line" },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 1120, particulars: "AP control line" },
  ]);

  // Non-Posted (Draft) - must be excluded.
  await makeApv(companyAId, suppA, "APB-DRAFT-1", "2026-08-05", "Draft", [
    { code: "APB-EXP", title: "APB Expense", debit: 500, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 500 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeApv(companyAId, suppA, "APB-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 50, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 50 },
  ]);
  await makeApv(companyAId, suppA, "APB-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 60, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makeApv(companyAId, suppA, "APB-OUTSIDE", "2026-09-05", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 999, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeApv(companyBId, suppB, "APB-B-POSTED", "2026-08-05", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 6543, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 6543 },
  ]);

  // Lifecycle fixtures - Void and Cancelled APVs, in-range, Company A. Both
  // must be excluded (postedOnlySql = UPPER(status)='POSTED' only).
  await makeApv(companyAId, suppA, "APB-VOID-1", "2026-08-08", "Void", [
    { code: "APB-EXP", title: "APB Expense", debit: 700, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 700 },
  ]);
  await makeApv(companyAId, suppA, "APB-CANCELLED-1", "2026-08-09", "Cancelled", [
    { code: "APB-EXP", title: "APB Expense", debit: 800, credit: 0 },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 800 },
  ]);

  // Reversal scenario - per POST /api/apv/:id/reverse, an APV reversal
  // creates a SEPARATE Posted reversing JV; the original APV row stays
  // Posted, unchanged. Modeled here as: one Posted "reversed" APV (still
  // fully present, values unchanged) + a separate Posted JV playing the
  // reversing entry's role.
  await makeApv(companyAId, suppA, "APB-REVERSED-ORIGINAL", "2026-08-10", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 400, credit: 0, particulars: "original (later reversed)" },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 400, particulars: "original (later reversed)" },
  ]);
  await makeJv(companyAId, "APB-REVERSAL-JV", "2026-08-11", "Posted", [
    { code: "APB-AP", title: "APB Accounts Payable", debit: 400, credit: 0, particulars: "reversal of APB-REVERSED-ORIGINAL" },
    { code: "APB-EXP", title: "APB Expense", debit: 0, credit: 400, particulars: "reversal of APB-REVERSED-ORIGINAL" },
  ]);

  // Settlement scenario (Part 13) - a Posted APV later "paid" by a Posted
  // CV. Settlement in the real app updates apv_headers.payment_status/
  // balance_amount only (never apv_lines) - simulated directly here so the
  // test proves the AP Book is unaffected without touching real settlement
  // logic. The CV is a separate, independent Posted transaction.
  const settledApvId = await makeApv(companyAId, suppA, "APB-SETTLED-1", "2026-08-14", "Posted", [
    { code: "APB-EXP", title: "APB Expense", debit: 300, credit: 0, particulars: "settled later by CV" },
    { code: "APB-AP", title: "APB Accounts Payable", debit: 0, credit: 300, particulars: "settled later by CV" },
  ]);
  await makeCv(companyAId, suppA, "APB-SETTLEMENT-CV", "2026-08-15", "Posted", [
    { code: "APB-AP", title: "APB Accounts Payable", debit: 300, credit: 0, particulars: "payment of APB-SETTLED-1" },
    { code: "APB-CASH", title: "APB Cash", debit: 0, credit: 300, particulars: "payment of APB-SETTLED-1" },
  ]);
  // Simulate what real CV settlement does to the APV header (payment_status
  // / balance_amount only) - proves the AP Book row is unaffected because
  // the union never reads these columns.
  await pool.execute(
    "UPDATE apv_headers SET payment_status = 'Paid', balance_amount = 0, paid_amount = total_credit WHERE id = ?",
    [settledApvId]
  );

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each. AP Book must show none of these; the
  // existing Income / Journal / Cash Receipt / Cash Disbursement Books must
  // show only their own.
  await makeInvoice(companyAId, custA, "APB-CROSS-INV", "2026-08-06", "Posted", [
    { code: "APB-AR", title: "APB Accounts Receivable", debit: 210, credit: 0 },
    { code: "APB-REV", title: "APB Sales Revenue", debit: 0, credit: 210 },
  ]);
  await makeOr(companyAId, custA, "APB-CROSS-OR", "2026-08-12", "Posted", [
    { code: "APB-CASH", title: "APB Cash", debit: 150, credit: 0 },
    { code: "APB-AR", title: "APB Accounts Receivable", debit: 0, credit: 150 },
  ]);
  await makeJv(companyAId, "APB-CROSS-JV", "2026-08-13", "Posted", [
    { code: "APB-CASH", title: "APB Cash", debit: 321, credit: 0 },
    { code: "APB-REV", title: "APB Sales Revenue", debit: 0, credit: 321 },
  ]);
  await makeCv(companyAId, suppA, "APB-CROSS-CV", "2026-08-16", "Posted", [
    { code: "APB-AP", title: "APB Accounts Payable", debit: 111, credit: 0 },
    { code: "APB-CASH", title: "APB Cash", debit: 0, credit: 111 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE al FROM apv_lines al JOIN apv_headers ah ON ah.id = al.apv_id WHERE ah.voucher_no LIKE 'APB-%'");
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'APB-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'APB-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'APB-%'");
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'APB-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'APB-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'APB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'APB-%'");
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'APB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'APB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'APB-%'");
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

describe("GET /api/reports/books/accounts-payable", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted APV is included", () => {
    expect(rows.some((r) => r.reference_no === "APB-POSTED-1")).toBe(true);
  });

  test("5. non-Posted (Draft) APV is excluded", () => {
    expect(rows.some((r) => r.reference_no === "APB-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "APB-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "APB-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "APB-OUTSIDE")).toBe(false);
  });

  test("27. company isolation - Company B's Posted APV never appears", () => {
    expect(rows.some((r) => r.reference_no === "APB-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 6543 || Number(r.credit) === 6543)).toBe(false);
  });

  test("7. multiple APV accounting lines are preserved (3-line APV -> 3 rows, not collapsed to one payable/net row)", () => {
    const posted = rows.filter((r) => r.reference_no === "APB-POSTED-1");
    expect(posted).toHaveLength(3);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["APB-AP", "APB-EXP", "APB-VAT"]);
  });

  test("the Book shows the AP control line, expense line, and VAT input line exactly as the canonical union recognizes them - not reinterpreted", () => {
    const posted = rows.filter((r) => r.reference_no === "APB-POSTED-1");
    const ap = posted.find((r) => r.account_code === "APB-AP");
    const exp = posted.find((r) => r.account_code === "APB-EXP");
    const vat = posted.find((r) => r.account_code === "APB-VAT");
    expect(Number(ap.credit)).toBe(1120);
    expect(Number(exp.debit)).toBe(1000);
    expect(Number(vat.debit)).toBe(120);
  });

  test("8. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "APB-POSTED-1" && r.account_code === "APB-EXP");
    expect(Number(line.debit)).toBe(1000);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "APB-POSTED-1" && r.account_code === "APB-AP");
    expect(Number(line.credit)).toBe(1120);
    expect(Number(line.debit)).toBe(0);
  });

  test("10. totals derive correctly from the actual rows", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // 1120 (posted-1) + 50 (boundary-from) + 60 (boundary-to) + 400 (reversed-original) + 300 (settled-1) = 1930
    expect(totalDebit).toBeCloseTo(1930, 2);
  });

  test("12. INV rows do not leak into AP Book", () => {
    expect(rows.some((r) => r.reference_no === "APB-CROSS-INV")).toBe(false);
  });

  test("13. JV rows do not leak into AP Book", () => {
    expect(rows.some((r) => r.reference_no === "APB-CROSS-JV" || r.reference_no === "APB-REVERSAL-JV")).toBe(false);
  });

  test("14. OR rows do not leak into AP Book", () => {
    expect(rows.some((r) => r.reference_no === "APB-CROSS-OR")).toBe(false);
  });

  test("15. CV rows do not leak into AP Book (including the settlement CV and the pure cross-leak CV)", () => {
    expect(rows.some((r) => r.reference_no === "APB-SETTLEMENT-CV" || r.reference_no === "APB-CROSS-CV")).toBe(false);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/accounts-payable")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("28. no transaction mutation occurs - APV rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM apv_headers WHERE voucher_no = 'APB-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(1120);
    expect(Number(header.total_credit)).toBe(1120);
    const [lines] = await pool.query(
      `SELECT al.debit, al.credit FROM apv_lines al JOIN apv_headers ah ON ah.id = al.apv_id WHERE ah.voucher_no = 'APB-POSTED-1' ORDER BY al.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [1000, 0],
      [120, 0],
      [0, 1120],
    ]);
  });
});

describe("29/30. APV lifecycle / reversal behavior matches the canonical ledger exactly (Part 5)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(adminToken)).query(range());
    rows = res.body;
  });

  test("Void APV is excluded (status != 'POSTED' case-insensitively, inherited from postedOnlySql - no report-specific rule invented)", () => {
    expect(rows.some((r) => r.reference_no === "APB-VOID-1")).toBe(false);
  });

  test("Cancelled APV is excluded (same inherited rule)", () => {
    expect(rows.some((r) => r.reference_no === "APB-CANCELLED-1")).toBe(false);
  });

  test("a reversed APV's original row stays Posted and appears exactly once, values unchanged", () => {
    const original = rows.filter((r) => r.reference_no === "APB-REVERSED-ORIGINAL");
    expect(original).toHaveLength(2);
    expect(original.map((r) => [r.account_code, Number(r.debit), Number(r.credit)]).sort()).toEqual([
      ["APB-AP", 0, 400],
      ["APB-EXP", 400, 0],
    ]);
  });

  test("the reversing entry is a JV, not a second APV row - it never appears in AP Book", () => {
    expect(rows.some((r) => r.reference_no === "APB-REVERSAL-JV")).toBe(false);
  });

  test("the reversing JV appears in Journal Book instead, and Journal Book does not show the original APV", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "APB-REVERSAL-JV")).toBe(true);
    expect(res.body.some((r) => r.reference_no === "APB-REVERSED-ORIGINAL")).toBe(false);
  });
});

describe("29. settlement consistency (Part 13) - AP Book is an accounting book, not AP Aging", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(adminToken)).query(range());
    rows = res.body;
  });

  test("a Posted APV later fully settled by a CV still shows its original Posted entries, unchanged and unreduced", () => {
    const settled = rows.filter((r) => r.reference_no === "APB-SETTLED-1");
    expect(settled).toHaveLength(2);
    expect(settled.map((r) => [r.account_code, Number(r.debit), Number(r.credit)]).sort()).toEqual([
      ["APB-AP", 0, 300],
      ["APB-EXP", 300, 0],
    ]);
  });

  test("settlement (payment_status/balance_amount) on the APV header does not remove or alter it from the Book", async () => {
    const [[header]] = await pool.query(
      "SELECT payment_status, balance_amount FROM apv_headers WHERE voucher_no = 'APB-SETTLED-1'"
    );
    expect(header.payment_status).toBe("Paid");
    expect(Number(header.balance_amount)).toBe(0);
    // yet the Book row above is completely unaffected by this - proven by
    // the identical assertion in the previous test running against the
    // SAME already-fetched rows.
  });

  test("the settlement CV is not subtracted from or merged into the APV row - it is a wholly separate transaction, shown (if at all) only in Cash Disbursement Book", async () => {
    expect(rows.some((r) => r.reference_no === "APB-SETTLEMENT-CV")).toBe(false);
    const cvRes = await request(app)
      .get("/api/reports/books/cash-disbursement")
      .set(auth(adminToken))
      .query(range());
    expect(cvRes.body.some((r) => r.reference_no === "APB-SETTLEMENT-CV")).toBe(true);
    expect(cvRes.body.some((r) => r.reference_no === "APB-SETTLED-1")).toBe(false);
  });
});

describe("16/17/18/19/20. five-way cross-book isolation - the other directions", () => {
  test("16. APV rows do not leak into Income Book", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "APB-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "APB-CROSS-INV")).toBe(true);
  });

  test("17. APV rows do not leak into Journal Book (only the reversal JV / cross JV appear)", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "APB-POSTED-1")).toBe(false);
    const apbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("APB-")));
    expect([...apbRefs].sort()).toEqual(["APB-CROSS-JV", "APB-REVERSAL-JV"]);
  });

  test("18. APV rows do not leak into Cash Receipt Book", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "APB-POSTED-1")).toBe(false);
    const apbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("APB-")));
    expect([...apbRefs]).toEqual(["APB-CROSS-OR"]);
  });

  test("19. APV rows do not leak into Cash Disbursement Book (only the CV fixtures appear)", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "APB-POSTED-1")).toBe(false);
    const apbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("APB-")));
    expect([...apbRefs].sort()).toEqual(["APB-CROSS-CV", "APB-SETTLEMENT-CV"]);
  });

  test("20. all five Books remain source-isolated for this fixture set (summary cross-check)", async () => {
    const [jv, inv, or_, cv, apv] = await Promise.all(
      ["journal", "income", "cash-receipt", "cash-disbursement", "accounts-payable"].map((p) =>
        request(app)
          .get(`/api/reports/books/${p}`)
          .set(auth(adminToken))
          .query(range())
          .then((r) => r.body)
      )
    );
    expect(jv.every((r) => !String(r.reference_no || "").includes("APB-POSTED"))).toBe(true);
    expect(inv.every((r) => !String(r.reference_no || "").includes("APB-POSTED"))).toBe(true);
    expect(or_.every((r) => !String(r.reference_no || "").includes("APB-POSTED"))).toBe(true);
    expect(cv.every((r) => !String(r.reference_no || "").includes("APB-POSTED"))).toBe(true);
    expect(apv.some((r) => r.reference_no === "APB-POSTED-1")).toBe(true);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("21. Accounts Payable Book now routes to a real page", () => {
    expect(menuSrc).toMatch(
      /id: "accounts-payable-book", label: "Accounts Payable Book", icon: CreditCard, path: "\/reports\/books\/accounts-payable"/
    );
  });

  test("22. the prior four Books remain unlocked", () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
    expect(menuSrc).toMatch(/id: "income-book", label: "Income Book", icon: Banknote, path: "\/reports\/books\/income"/);
    expect(menuSrc).toMatch(
      /id: "cash-receipt-book", label: "Cash Receipt Book", icon: ArrowDownToLine, path: "\/reports\/books\/cash-receipt"/
    );
    expect(menuSrc).toMatch(
      /id: "cash-disbursement-book", label: "Cash Disbursement Book", icon: ArrowUpFromLine, path: "\/reports\/books\/cash-disbursement"/
    );
  });

  test("23. petty-cash-book (L.6) and debit-credit-memo-book (L.7) are now both unlocked too, see their own test coverage", () => {
    for (const id of ["petty-cash-book", "debit-credit-memo-book"]) {
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

  test("App.jsx routes /reports/books/accounts-payable to AccountsPayableBook, alongside the other four Books", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import AccountsPayableBook from "\.\/pages\/REPORTS\/AccountsPayableBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/accounts-payable" element={<AccountsPayableBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-receipt" element={<CashReceiptBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-disbursement" element={<CashDisbursementBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as every other Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/accounts-payable": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });

  test('"Accounts Payable Voucher" is this repository\'s own existing terminology for APV - verified via transactionsMenuConfig.js/APV.jsx, not guessed', () => {
    const apvMenuSrc = fs.readFileSync(
      path.join(__dirname, "../../components/sidebar/transactionsMenuConfig.js"),
      "utf8"
    );
    expect(apvMenuSrc).toMatch(/label: "Accounts Payable Voucher"/);
    const apvPageSrc = fs.readFileSync(path.join(FRONTEND, "..", "TRANSACTIONS", "APV.jsx"), "utf8");
    expect(apvPageSrc).toMatch(/title="Accounts Payable Voucher"/);
  });

  test("AccountsPayableBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config", () => {
    const src = read(FRONTEND, "AccountsPayableBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Accounts Payable Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/accounts-payable"/);
    expect(src).toMatch(/referenceLabel="APV Number"/);
    expect(src).toMatch(/filenamePrefix="Accounts_Payable_Book"/);
    expect(src).toMatch(/No Posted Accounts Payable Vouchers found for the selected dates\./);
  });

  test("AP Book does not invent supplier/invoice-number/due-date/EWT/VAT/outstanding-balance/payment-status/CV-application/aging fields not authoritative on the canonical union", () => {
    const src = read(FRONTEND, "AccountsPayableBook.jsx");
    // code-shaped identifiers only - the explanatory comment mentioning
    // these terms in prose (documenting why they're excluded) is fine,
    // code is not.
    expect(src).not.toMatch(/supplier_name|supplierName|dueDate|invoiceNo|balanceAmount|paymentStatus|agingBucket/);
    expect(src).not.toMatch(/fetch\(/);
  });
});

describe("26. route and service are read-only (source guard)", () => {
  test("the Accounts Payable Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/accounts-payable"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getAccountsPayableBookRows/);
  });

  test("getAccountsPayableBookRows delegates to the shared getBookRows(sourceTypes:['APV']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getAccountsPayableBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["APV"\], from, to, companyId \}\)/);
  });
});

describe("25. CSV export stays formula-injection safe (shared BookReport, AP Book config)", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([[{ t: "text", v: "=APB(A1:A2)" }, { t: "num", v: "-1120.00" }]]);
    expect(csv).toContain('"\'=APB(A1:A2)"');
    expect(csv).toContain('"-1120.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so AP Book exports as Accounts_Payable_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });
});
