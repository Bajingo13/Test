const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.7 - Books of Accounts: Debit/Credit Memo Book, the
// seventh and final individual Book. GET /api/reports/books/debit-credit-memo
// is a thin filter over the SAME canonical LedgerReportService union every
// other Book is built on, via the shared getBookRows({sourceTypes, ...})
// engine - but this is the one Book with TWO source types instead of one:
// source_type = 'DEBIT MEMO' or 'CREDIT MEMO', verified directly in
// buildTransactionUnionSql as CONCAT(h.memo_type, ' MEMO') computed from
// memo_headers.memo_type (ENUM('DEBIT','CREDIT')) - one shared memo_headers/
// memo_lines table pair, not two physical tables. No memo creation/editing/
// posting/currency workflow touched anywhere. Like Petty Cash, this
// repository has NO /void, /cancel, or /reverse route for either Debit or
// Credit Memo (verified by direct grep of server.js) - the entire lifecycle
// is Draft (freely PUT-editable/DELETE-able) -> Posted (both blocked with
// 409 once Posted, Phase 7A.1 immutability), with no reversal mechanism of
// any kind. This suite additionally proves the one genuine shared-UI
// addition this phase required: getBookRows now also selects tx.source_type
// (inert for the other six single-source Books, which never read it), and
// BookReport.jsx gained an optional, default-off `typeColumn` prop that only
// this Book's wrapper passes - because Debit Memo and Credit Memo share one
// free-typed, user-entered voucher_no column (UNIQUE(company_id, memo_type,
// voucher_no), confirmed via phase7g_voucher_no_company_scope_migration.sql)
// with no enforced DM-/CM- prefix, so a Debit Memo and a Credit Memo in the
// same company CAN legitimately carry the identical reference number.

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

async function makeMemo(companyId, memoType, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Debit/Credit Memo Book test party', ?, ?, ?, ?)`,
    [companyId, voucherNo, memoType, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO memo_lines (memo_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makePettyCash(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, voucherNo, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO petty_cash_lines (petty_cash_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, "x", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeApv(companyId, suppId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'Debit/Credit Memo Book cross-leak supplier', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, suppId, date, totalDebit, totalCredit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO apv_lines (apv_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Debit/Credit Memo Book cross-leak payee', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Debit/Credit Memo Book cross-leak customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
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
     VALUES (?, ?, ?, 'Debit/Credit Memo Book cross-leak customer', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Debit/Credit Memo Book cross-leak fixture', ?, ?, ?)`,
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

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('MB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('MB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("MbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('mb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("mb_admin", "MbPass!1");

  const hash2 = await bcrypt.hash("MbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('mb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("mb_norole", "MbPass!2");

  const suppA = await makeParty("MB-SUPP-A", "SUPPLIER", "MB Supplier A", companyAId);
  const custA = await makeParty("MB-CUST-A", "CUSTOMER", "MB Customer A", companyAId);

  await makeCoa("MB-AR", "MB Accounts Receivable", "ASSET");
  await makeCoa("MB-AP", "MB Accounts Payable", "LIABILITY");
  await makeCoa("MB-REV", "MB Sales Revenue", "INCOME");
  await makeCoa("MB-EXP", "MB Expense", "EXPENSE");
  await makeCoa("MB-CASH", "MB Cash", "ASSET");

  // Posted Debit Memo, in-range, 2 lines - multi-line preservation +
  // debit/credit correctness.
  await makeMemo(companyAId, "DEBIT", "MB-DM-POSTED-1", "2026-08-05", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 500, credit: 0, particulars: "billing correction" },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 500, particulars: "billing correction" },
  ]);

  // Posted Credit Memo, in-range, 2 lines.
  await makeMemo(companyAId, "CREDIT", "MB-CM-POSTED-1", "2026-08-06", "Posted", [
    { code: "MB-REV", title: "MB Sales Revenue", debit: 400, credit: 0, particulars: "sales return" },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 400, particulars: "sales return" },
  ]);

  // Draft Debit Memo / Draft Credit Memo - must be excluded.
  await makeMemo(companyAId, "DEBIT", "MB-DM-DRAFT-1", "2026-08-05", "Draft", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 111, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 111 },
  ]);
  await makeMemo(companyAId, "CREDIT", "MB-CM-DRAFT-1", "2026-08-06", "Draft", [
    { code: "MB-REV", title: "MB Sales Revenue", debit: 222, credit: 0 },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 222 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makeMemo(companyAId, "DEBIT", "MB-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 50, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 50 },
  ]);
  await makeMemo(companyAId, "CREDIT", "MB-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "MB-REV", title: "MB Sales Revenue", debit: 60, credit: 0 },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makeMemo(companyAId, "DEBIT", "MB-OUTSIDE", "2026-09-05", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 999, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makeMemo(companyBId, "DEBIT", "MB-B-DM-POSTED", "2026-08-05", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 7654, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 7654 },
  ]);
  await makeMemo(companyBId, "CREDIT", "MB-B-CM-POSTED", "2026-08-05", "Posted", [
    { code: "MB-REV", title: "MB Sales Revenue", debit: 8765, credit: 0 },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 8765 },
  ]);

  // Ambiguity fixture: a Debit Memo and a Credit Memo sharing the IDENTICAL
  // voucher_no in the same company - legitimate per
  // UNIQUE(company_id, memo_type, voucher_no) (phase7g migration). Proves
  // the reference number alone cannot distinguish them.
  await makeMemo(companyAId, "DEBIT", "MB-SAME-0001", "2026-08-19", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 30, credit: 0, particulars: "ambiguity fixture - debit side" },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 30, particulars: "ambiguity fixture - debit side" },
  ]);
  await makeMemo(companyAId, "CREDIT", "MB-SAME-0001", "2026-08-20", "Posted", [
    { code: "MB-REV", title: "MB Sales Revenue", debit: 40, credit: 0, particulars: "ambiguity fixture - credit side" },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 40, particulars: "ambiguity fixture - credit side" },
  ]);

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each (all six prior Books). Memo Book must show
  // none of these; each prior Book must show only its own.
  await makeInvoice(companyAId, custA, "MB-CROSS-INV", "2026-08-07", "Posted", [
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 210, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 210 },
  ]);
  await makeOr(companyAId, custA, "MB-CROSS-OR", "2026-08-12", "Posted", [
    { code: "MB-CASH", title: "MB Cash", debit: 150, credit: 0 },
    { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 150 },
  ]);
  await makeJv(companyAId, "MB-CROSS-JV", "2026-08-13", "Posted", [
    { code: "MB-CASH", title: "MB Cash", debit: 321, credit: 0 },
    { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 321 },
  ]);
  await makeCv(companyAId, suppA, "MB-CROSS-CV", "2026-08-16", "Posted", [
    { code: "MB-AP", title: "MB Accounts Payable", debit: 111, credit: 0 },
    { code: "MB-CASH", title: "MB Cash", debit: 0, credit: 111 },
  ]);
  await makeApv(companyAId, suppA, "MB-CROSS-APV", "2026-08-17", "Posted", [
    { code: "MB-EXP", title: "MB Expense", debit: 222, credit: 0 },
    { code: "MB-AP", title: "MB Accounts Payable", debit: 0, credit: 222 },
  ]);
  await makePettyCash(companyAId, "MB-CROSS-PCV", "2026-08-18", "Posted", [
    { code: "MB-EXP", title: "MB Expense", debit: 33, credit: 0 },
    { code: "MB-CASH", title: "MB Cash", debit: 0, credit: 33 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE ml FROM memo_lines ml JOIN memo_headers mh ON mh.id = ml.memo_id WHERE mh.voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query(
    "DELETE pl FROM petty_cash_lines pl JOIN petty_cash_headers ph ON ph.id = pl.petty_cash_id WHERE ph.voucher_no LIKE 'MB-%'"
  );
  await pool.query("DELETE FROM petty_cash_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query("DELETE al FROM apv_lines al JOIN apv_headers ah ON ah.id = al.apv_id WHERE ah.voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'MB-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'MB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'MB-%'");
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

describe("GET /api/reports/books/debit-credit-memo", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/debit-credit-memo").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/debit-credit-memo").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/debit-credit-memo").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/debit-credit-memo").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted Debit Memo is included", () => {
    expect(rows.some((r) => r.reference_no === "MB-DM-POSTED-1")).toBe(true);
  });

  test("5. Posted Credit Memo is included", () => {
    expect(rows.some((r) => r.reference_no === "MB-CM-POSTED-1")).toBe(true);
  });

  test("6. Draft Debit Memo is excluded", () => {
    expect(rows.some((r) => r.reference_no === "MB-DM-DRAFT-1")).toBe(false);
  });

  test("7. Draft Credit Memo is excluded", () => {
    expect(rows.some((r) => r.reference_no === "MB-CM-DRAFT-1")).toBe(false);
  });

  test("8. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "MB-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "MB-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "MB-OUTSIDE")).toBe(false);
  });

  test("29/30. company isolation - Company B's Posted Debit and Credit Memo never appear", () => {
    expect(rows.some((r) => r.reference_no === "MB-B-DM-POSTED")).toBe(false);
    expect(rows.some((r) => r.reference_no === "MB-B-CM-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 7654 || Number(r.credit) === 8765)).toBe(false);
  });

  test("9. multiple Debit Memo lines are preserved (2-line Debit Memo -> 2 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "MB-DM-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["MB-AR", "MB-REV"]);
  });

  test("10. multiple Credit Memo lines are preserved (2-line Credit Memo -> 2 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "MB-CM-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["MB-AR", "MB-REV"]);
  });

  test("11. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "MB-DM-POSTED-1" && r.account_code === "MB-AR");
    expect(Number(line.debit)).toBe(500);
    expect(Number(line.credit)).toBe(0);
  });

  test("12. credit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "MB-CM-POSTED-1" && r.account_code === "MB-AR");
    expect(Number(line.credit)).toBe(400);
    expect(Number(line.debit)).toBe(0);
  });

  test("13. totals derive correctly across BOTH memo types", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // DM: 500 (posted-1) + 50 (boundary-from) + 30 (same-0001 debit side) = 580
    // CM: 400 (posted-1) + 60 (boundary-to) + 40 (same-0001 credit side) = 500
    // total = 1080
    expect(totalDebit).toBeCloseTo(1080, 2);
  });

  test("15. JV excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-JV")).toBe(false);
  });

  test("16. INV excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-INV")).toBe(false);
  });

  test("17. OR excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-OR")).toBe(false);
  });

  test("18. CV excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-CV")).toBe(false);
  });

  test("19. APV excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-APV")).toBe(false);
  });

  test("20. PETTY CASH excluded from Memo Book", () => {
    expect(rows.some((r) => r.reference_no === "MB-CROSS-PCV")).toBe(false);
  });

  test("14. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/debit-credit-memo")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("31. no transaction mutation occurs - Memo rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit, memo_type FROM memo_headers WHERE voucher_no = 'MB-DM-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(header.memo_type).toBe("DEBIT");
    expect(Number(header.total_debit)).toBe(500);
    expect(Number(header.total_credit)).toBe(500);
    const [lines] = await pool.query(
      `SELECT ml.debit, ml.credit FROM memo_lines ml JOIN memo_headers mh ON mh.id = ml.memo_id WHERE mh.voucher_no = 'MB-DM-POSTED-1' ORDER BY ml.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [500, 0],
      [0, 500],
    ]);
  });

  test("37. Debit Memo rows identify correctly via source_type", () => {
    const posted = rows.filter((r) => r.reference_no === "MB-DM-POSTED-1");
    expect(posted.every((r) => r.source_type === "DEBIT MEMO")).toBe(true);
  });

  test("38. Credit Memo rows identify correctly via source_type", () => {
    const posted = rows.filter((r) => r.reference_no === "MB-CM-POSTED-1");
    expect(posted.every((r) => r.source_type === "CREDIT MEMO")).toBe(true);
  });

  test("the ambiguity fixture proves source_type, not the reference number, distinguishes Debit from Credit Memo rows sharing the identical voucher_no", () => {
    const shared = rows.filter((r) => r.reference_no === "MB-SAME-0001");
    expect(shared).toHaveLength(4);
    const debitSide = shared.filter((r) => r.source_type === "DEBIT MEMO");
    const creditSide = shared.filter((r) => r.source_type === "CREDIT MEMO");
    expect(debitSide).toHaveLength(2);
    expect(creditSide).toHaveLength(2);
    expect(debitSide.some((r) => Number(r.debit) === 30)).toBe(true);
    expect(creditSide.some((r) => Number(r.debit) === 40)).toBe(true);
  });
});

describe("32. Memo lifecycle matches the canonical ledger exactly - no void/cancel/reverse mechanism exists", () => {
  let dmId, cmId;

  beforeAll(async () => {
    dmId = await makeMemo(companyAId, "DEBIT", "MB-LIFECYCLE-DM", "2026-08-21", "Posted", [
      { code: "MB-AR", title: "MB Accounts Receivable", debit: 77, credit: 0 },
      { code: "MB-REV", title: "MB Sales Revenue", debit: 0, credit: 77 },
    ]);
    cmId = await makeMemo(companyAId, "CREDIT", "MB-LIFECYCLE-CM", "2026-08-22", "Posted", [
      { code: "MB-REV", title: "MB Sales Revenue", debit: 88, credit: 0 },
      { code: "MB-AR", title: "MB Accounts Receivable", debit: 0, credit: 88 },
    ]);
  });

  test("there is no POST /api/debit-memos/:id/void route", async () => {
    const res = await request(app).post(`/api/debit-memos/${dmId}/void`).set(auth(adminToken)).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("there is no POST /api/credit-memos/:id/void route", async () => {
    const res = await request(app).post(`/api/credit-memos/${cmId}/void`).set(auth(adminToken)).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("there is no POST /api/debit-memos/:id/cancel or /api/credit-memos/:id/cancel route", async () => {
    const dm = await request(app).post(`/api/debit-memos/${dmId}/cancel`).set(auth(adminToken)).send({ reason: "x" });
    const cm = await request(app).post(`/api/credit-memos/${cmId}/cancel`).set(auth(adminToken)).send({ reason: "x" });
    expect(dm.status).toBe(404);
    expect(cm.status).toBe(404);
  });

  test("there is no POST /api/debit-memos/:id/reverse or /api/credit-memos/:id/reverse route - a Posted Memo can never produce a reversing entry of any kind", async () => {
    const dm = await request(app).post(`/api/debit-memos/${dmId}/reverse`).set(auth(adminToken)).send({ reason: "x" });
    const cm = await request(app).post(`/api/credit-memos/${cmId}/reverse`).set(auth(adminToken)).send({ reason: "x" });
    expect(dm.status).toBe(404);
    expect(cm.status).toBe(404);
  });

  test("a Posted Debit Memo cannot be edited or deleted (Phase 7A.1 immutability) - both return 409", async () => {
    const putRes = await request(app)
      .put(`/api/debit-memos/${dmId}`)
      .set(auth(adminToken))
      .send({
        voucherNo: "MB-LIFECYCLE-DM",
        transactionDate: "2026-08-21",
        status: "Draft",
        currency: { companyId: companyAId },
        lines: [{ accountCode: "MB-AR", debit: 1, credit: 0 }],
      });
    expect(putRes.status).toBe(409);
    expect(putRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    const delRes = await request(app).delete(`/api/debit-memos/${dmId}`).set(auth(adminToken));
    expect(delRes.status).toBe(409);
    expect(delRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test("a Posted Credit Memo cannot be edited or deleted (Phase 7A.1 immutability) - both return 409, identical rule to Debit Memo", async () => {
    const putRes = await request(app)
      .put(`/api/credit-memos/${cmId}`)
      .set(auth(adminToken))
      .send({
        voucherNo: "MB-LIFECYCLE-CM",
        transactionDate: "2026-08-22",
        status: "Draft",
        currency: { companyId: companyAId },
        lines: [{ accountCode: "MB-REV", debit: 1, credit: 0 }],
      });
    expect(putRes.status).toBe(409);
    expect(putRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    const delRes = await request(app).delete(`/api/credit-memos/${cmId}`).set(auth(adminToken));
    expect(delRes.status).toBe(409);
    expect(delRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test("consequently both Posted Memos still appear in the Book, unchanged, exactly once each, with no reversing entry anywhere", async () => {
    const res = await request(app).get("/api/reports/books/debit-credit-memo").set(auth(adminToken)).query(range());
    const dmRows = res.body.filter((r) => r.reference_no === "MB-LIFECYCLE-DM");
    const cmRows = res.body.filter((r) => r.reference_no === "MB-LIFECYCLE-CM");
    expect(dmRows).toHaveLength(2);
    expect(cmRows).toHaveLength(2);
    expect(dmRows.every((r) => r.source_type === "DEBIT MEMO")).toBe(true);
    expect(cmRows.every((r) => r.source_type === "CREDIT MEMO")).toBe(true);

    const jvRes = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(jvRes.body.some((r) => String(r.reference_no || "").includes("MB-LIFECYCLE"))).toBe(false);
  });
});

describe("21/22/23. Memo excluded from all other six Books, and each retains its own source only", () => {
  test("21. Debit Memo (MB-DM-POSTED-1) excluded from all six other Books", async () => {
    for (const p of ["journal", "income", "cash-receipt", "cash-disbursement", "accounts-payable", "petty-cash"]) {
      const res = await request(app).get(`/api/reports/books/${p}`).set(auth(adminToken)).query(range());
      expect(res.status).toBe(200);
      expect(res.body.some((r) => r.reference_no === "MB-DM-POSTED-1")).toBe(false);
    }
  });

  test("22. Credit Memo (MB-CM-POSTED-1) excluded from all six other Books", async () => {
    for (const p of ["journal", "income", "cash-receipt", "cash-disbursement", "accounts-payable", "petty-cash"]) {
      const res = await request(app).get(`/api/reports/books/${p}`).set(auth(adminToken)).query(range());
      expect(res.status).toBe(200);
      expect(res.body.some((r) => r.reference_no === "MB-CM-POSTED-1")).toBe(false);
    }
  });

  test("23. prior six Books remain source-isolated for this fixture set (each shows only its own cross-leak fixture)", async () => {
    const [jv, inv, or_, cv, apv, pcv] = await Promise.all(
      ["journal", "income", "cash-receipt", "cash-disbursement", "accounts-payable", "petty-cash"].map((p) =>
        request(app)
          .get(`/api/reports/books/${p}`)
          .set(auth(adminToken))
          .query(range())
          .then((r) => r.body)
      )
    );
    expect(jv.some((r) => r.reference_no === "MB-CROSS-JV")).toBe(true);
    expect(inv.some((r) => r.reference_no === "MB-CROSS-INV")).toBe(true);
    expect(or_.some((r) => r.reference_no === "MB-CROSS-OR")).toBe(true);
    expect(cv.some((r) => r.reference_no === "MB-CROSS-CV")).toBe(true);
    expect(apv.some((r) => r.reference_no === "MB-CROSS-APV")).toBe(true);
    expect(pcv.some((r) => r.reference_no === "MB-CROSS-PCV")).toBe(true);
    for (const list of [jv, inv, or_, cv, apv, pcv]) {
      expect(list.every((r) => !String(r.reference_no || "").includes("MB-DM-POSTED"))).toBe(true);
      expect(list.every((r) => !String(r.reference_no || "").includes("MB-CM-POSTED"))).toBe(true);
    }
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("24. Debit/Credit Memo Book now routes to a real page", () => {
    expect(menuSrc).toMatch(
      /id: "debit-credit-memo-book", label: "Debit\/Credit Memo Book", icon: FileWarning, path: "\/reports\/books\/debit-credit-memo"/
    );
  });

  test("25. all six prior Books remain unlocked - after this phase, all seven individual Books are live", () => {
    expect(menuSrc).toMatch(/id: "journal-book", label: "Journal Book", icon: FileText, path: "\/reports\/books\/journal"/);
    expect(menuSrc).toMatch(/id: "income-book", label: "Income Book", icon: Banknote, path: "\/reports\/books\/income"/);
    expect(menuSrc).toMatch(
      /id: "cash-receipt-book", label: "Cash Receipt Book", icon: ArrowDownToLine, path: "\/reports\/books\/cash-receipt"/
    );
    expect(menuSrc).toMatch(
      /id: "cash-disbursement-book", label: "Cash Disbursement Book", icon: ArrowUpFromLine, path: "\/reports\/books\/cash-disbursement"/
    );
    expect(menuSrc).toMatch(
      /id: "accounts-payable-book", label: "Accounts Payable Book", icon: CreditCard, path: "\/reports\/books\/accounts-payable"/
    );
    expect(menuSrc).toMatch(
      /id: "petty-cash-book", label: "Petty Cash Book", icon: PiggyBank, path: "\/reports\/books\/petty-cash"/
    );
  });

  test("26. Summary of Books / Net Summary of Books / Daily Cash Position remain path: null", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/debit-credit-memo to DebitCreditMemoBook, alongside the other six Books", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import DebitCreditMemoBook from "\.\/pages\/REPORTS\/DebitCreditMemoBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/debit-credit-memo" element={<DebitCreditMemoBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-receipt" element={<CashReceiptBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-disbursement" element={<CashDisbursementBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/accounts-payable" element={<AccountsPayableBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/petty-cash" element={<PettyCashBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as every other Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/debit-credit-memo": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("35/36. no new permission module was introduced for this phase - both source types are server-controlled literals, never client-supplied", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);

    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/debit-credit-memo"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    // the route never reads req.query/req.body for anything but from/to/
    // companyId - sourceTypes never appears here at all, it's hardcoded
    // one level down in getDebitCreditMemoBookRows.
    expect(routeBody).not.toMatch(/sourceTypes/);
    expect(routeBody).not.toMatch(/req\.query\.(source|type)/i);
    expect(routeBody).not.toMatch(/req\.body/);
  });

  test('34. "Debit Memo" and "Credit Memo" are this repository\'s own existing terminology - verified via transactionsMenuConfig.js/DebitMemo.jsx/CreditMemo.jsx, not guessed', () => {
    const memoMenuSrc = fs.readFileSync(
      path.join(__dirname, "../../components/sidebar/transactionsMenuConfig.js"),
      "utf8"
    );
    expect(memoMenuSrc).toMatch(/label: "Debit Memo"/);
    expect(memoMenuSrc).toMatch(/label: "Credit Memo"/);
    const dmPageSrc = fs.readFileSync(path.join(FRONTEND, "..", "TRANSACTIONS", "DebitMemo.jsx"), "utf8");
    const cmPageSrc = fs.readFileSync(path.join(FRONTEND, "..", "TRANSACTIONS", "CreditMemo.jsx"), "utf8");
    expect(dmPageSrc).toMatch(/title="Debit Memo"/);
    expect(cmPageSrc).toMatch(/title="Credit Memo"/);
  });

  test("DebitCreditMemoBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config plus the optional typeColumn", () => {
    const src = read(FRONTEND, "DebitCreditMemoBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Debit\/Credit Memo Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/debit-credit-memo"/);
    expect(src).toMatch(/referenceLabel="Memo Number"/);
    expect(src).toMatch(/filenamePrefix="Debit_Credit_Memo_Book"/);
    expect(src).toMatch(/No Posted Debit or Credit Memos found for the selected dates\./);
    expect(src).toMatch(/typeColumn=\{\{/);
    expect(src).toMatch(/label: "Memo Type"/);
  });

  test("Debit/Credit Memo Book does not invent party/source-invoice-or-APV/correction-reason fields not authoritative on the canonical union", () => {
    const src = read(FRONTEND, "DebitCreditMemoBook.jsx");
    // code-shaped identifiers only - the explanatory comment mentioning
    // these terms in prose (documenting why they're excluded) is fine,
    // code is not.
    expect(src).not.toMatch(/partyName|party_name|sourceInvoice|sourceApv|correctionReason/);
    expect(src).not.toMatch(/fetch\(/);
  });

  test("39. the six prior Book wrapper pages retain unchanged columns - none of them pass the new typeColumn prop", () => {
    for (const f of [
      "JournalBook.jsx",
      "IncomeBook.jsx",
      "CashReceiptBook.jsx",
      "CashDisbursementBook.jsx",
      "AccountsPayableBook.jsx",
      "PettyCashBook.jsx",
    ]) {
      const src = read(FRONTEND, f);
      expect(src).not.toMatch(/typeColumn/);
    }
  });

  test("BookReport.jsx's typeColumn prop is optional and default-off (no default value forces it on)", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/typeColumn,\s*\n\}\)/);
    expect(src).not.toMatch(/typeColumn = \{/);
  });
});

describe("28. route and service are read-only (source guard)", () => {
  test("the Debit/Credit Memo Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/debit-credit-memo"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getDebitCreditMemoBookRows/);
  });

  test("33. exact source_type literals verified in source guard - getDebitCreditMemoBookRows delegates to the shared getBookRows(sourceTypes:['DEBIT MEMO','CREDIT MEMO']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getDebitCreditMemoBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["DEBIT MEMO", "CREDIT MEMO"\], from, to, companyId \}\)/);
  });

  test("the canonical union's Memo branch computes source_type as CONCAT(h.memo_type, ' MEMO'), verified not assumed", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    expect(svcSrc).toMatch(/CONCAT\(h\.memo_type, ' MEMO'\) AS source_type/);
    expect(svcSrc).toMatch(/FROM memo_lines l JOIN memo_headers h ON h\.id = l\.memo_id/);
  });

  test("memo_type is a strict ENUM('DEBIT','CREDIT') in the migration - not free text - so exactly two source_type values can ever result", () => {
    const migSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/petty_cash_and_memo_migration.sql"),
      "utf8"
    );
    expect(migSrc).toMatch(/memo_type ENUM\('DEBIT','CREDIT'\) NOT NULL/);
  });
});

describe("27/40. CSV export stays formula-injection safe and includes Memo Type only where intended", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([[{ t: "text", v: "=MB(A1:A2)" }, { t: "num", v: "-500.00" }]]);
    expect(csv).toContain('"\'=MB(A1:A2)"');
    expect(csv).toContain('"-500.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so Debit/Credit Memo Book exports as Debit_Credit_Memo_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("40. BookReport's CSV header/row/total construction conditionally includes the type column only when typeColumn is passed", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/if \(typeColumn\) headerRow\.push\(T\(typeColumn\.label\)\)/);
    expect(src).toMatch(/if \(typeColumn\) row\.push\(T\(typeColumn\.getValue\(r\)\)\)/);
    expect(src).toMatch(/if \(typeColumn\) totalRow\.push\(T\(""\)\)/);
  });
});
