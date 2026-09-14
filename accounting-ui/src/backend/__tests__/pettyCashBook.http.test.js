const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase L.6 - Books of Accounts: Petty Cash Book.
// GET /api/reports/books/petty-cash is a thin filter (source_type =
// 'PETTY CASH', with a space - verified directly in buildTransactionUnionSql,
// not assumed) over the SAME canonical LedgerReportService union every other
// Book (Journal, Income, Cash Receipt, Cash Disbursement, Accounts Payable)
// is built on, via the shared getBookRows({sourceTypes, ...}) engine - no
// new recognition logic, no PCV creation/editing/posting/currency workflow
// touched anywhere. Unlike CV/APV, this repository has NO /void, /cancel,
// or /reverse route for petty-cash at all (verified by direct grep of
// server.js) - the entire lifecycle is Draft (freely PUT-editable/
// DELETE-able) -> Posted (both blocked with 409 once Posted, Phase 7A.1
// immutability), with no reversal mechanism of any kind. This suite proves:
// auth, REPORTS.FINANCIAL enforcement, company isolation, Posted-only
// inclusion, inclusive date boundaries, multi-line preservation,
// debit/credit correctness, empty range, that lifecycle (no void/cancel/
// reverse route exists), six-way cross-book isolation, no transaction
// mutation, menu/route wiring for exactly the six unlocked Books, and CSV
// safety.

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

async function makePettyCash(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO petty_cash_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Petty Cash Book test payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO petty_cash_lines (petty_cash_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
  return h.insertId;
}

async function makeApv(companyId, suppId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'Petty Cash Book cross-leak supplier', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
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
     VALUES (?, ?, ?, 'Petty Cash Book cross-leak payee', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Petty Cash Book cross-leak customer', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
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
     VALUES (?, ?, ?, 'Petty Cash Book cross-leak customer', ?, ?, ?, ?)`,
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
     VALUES (?, ?, ?, 'Petty Cash Book cross-leak fixture', ?, ?, ?)`,
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

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PCB Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PCB Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("PcbPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('pcb_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("pcb_admin", "PcbPass!1");

  const hash2 = await bcrypt.hash("PcbPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('pcb_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("pcb_norole", "PcbPass!2");

  const payeeA = await makeParty("PCB-PAYEE-A", "SUPPLIER", "PCB Payee A", companyAId);
  const payeeB = await makeParty("PCB-PAYEE-B", "SUPPLIER", "PCB Payee B", companyBId);
  const custA = await makeParty("PCB-CUST-A", "CUSTOMER", "PCB Customer A", companyAId);

  await makeCoa("PCB-EXP", "PCB Expense", "EXPENSE");
  await makeCoa("PCB-CASH", "PCB Cash", "ASSET");
  await makeCoa("PCB-AP", "PCB Accounts Payable", "LIABILITY");
  await makeCoa("PCB-AR", "PCB Accounts Receivable", "ASSET");
  await makeCoa("PCB-REV", "PCB Sales Revenue", "INCOME");

  // Posted, in-range, 2 lines (petty cash disbursement) - multi-line
  // preservation + debit/credit correctness.
  await makePettyCash(companyAId, payeeA, "PCB-POSTED-1", "2026-08-05", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 850, credit: 0, particulars: "office supplies" },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 850, particulars: "cash disbursed" },
  ]);

  // Non-Posted (Draft) - must be excluded.
  await makePettyCash(companyAId, payeeA, "PCB-DRAFT-1", "2026-08-05", "Draft", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 300, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 300 },
  ]);

  // Exact lower/upper boundary dates - inclusive filtering.
  await makePettyCash(companyAId, payeeA, "PCB-BOUNDARY-FROM", "2026-08-01", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 50, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 50 },
  ]);
  await makePettyCash(companyAId, payeeA, "PCB-BOUNDARY-TO", "2026-08-31", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 60, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 60 },
  ]);

  // Outside the query range entirely.
  await makePettyCash(companyAId, payeeA, "PCB-OUTSIDE", "2026-09-05", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 999, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 999 },
  ]);

  // Company B, Posted, same date range - must never leak into Company A's report.
  await makePettyCash(companyBId, payeeB, "PCB-B-POSTED", "2026-08-05", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 4321, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 4321 },
  ]);

  // Cross-book isolation fixtures - same company, same date range, but a
  // different source_type each. Petty Cash Book must show none of these;
  // the existing five Books must show only their own.
  await makeInvoice(companyAId, custA, "PCB-CROSS-INV", "2026-08-06", "Posted", [
    { code: "PCB-AR", title: "PCB Accounts Receivable", debit: 210, credit: 0 },
    { code: "PCB-REV", title: "PCB Sales Revenue", debit: 0, credit: 210 },
  ]);
  await makeOr(companyAId, custA, "PCB-CROSS-OR", "2026-08-12", "Posted", [
    { code: "PCB-CASH", title: "PCB Cash", debit: 150, credit: 0 },
    { code: "PCB-AR", title: "PCB Accounts Receivable", debit: 0, credit: 150 },
  ]);
  await makeJv(companyAId, "PCB-CROSS-JV", "2026-08-13", "Posted", [
    { code: "PCB-CASH", title: "PCB Cash", debit: 321, credit: 0 },
    { code: "PCB-REV", title: "PCB Sales Revenue", debit: 0, credit: 321 },
  ]);
  await makeCv(companyAId, payeeA, "PCB-CROSS-CV", "2026-08-16", "Posted", [
    { code: "PCB-AP", title: "PCB Accounts Payable", debit: 111, credit: 0 },
    { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 111 },
  ]);
  await makeApv(companyAId, payeeA, "PCB-CROSS-APV", "2026-08-17", "Posted", [
    { code: "PCB-EXP", title: "PCB Expense", debit: 222, credit: 0 },
    { code: "PCB-AP", title: "PCB Accounts Payable", debit: 0, credit: 222 },
  ]);
});

afterAll(async () => {
  await pool.query(
    "DELETE pl FROM petty_cash_lines pl JOIN petty_cash_headers ph ON ph.id = pl.petty_cash_id WHERE ph.voucher_no LIKE 'PCB-%'"
  );
  await pool.query("DELETE FROM petty_cash_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE al FROM apv_lines al JOIN apv_headers ah ON ah.id = al.apv_id WHERE ah.voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query(
    "DELETE il FROM invoice_lines il JOIN invoice_headers ih ON ih.id = il.invoice_id WHERE ih.voucher_no LIKE 'PCB-%'"
  );
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'PCB-%'");
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'PCB-%'");
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

describe("GET /api/reports/books/petty-cash", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/books/petty-cash").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/books/petty-cash").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("from/to are required", async () => {
    const res = await request(app).get("/api/reports/books/petty-cash").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let rows;
  test("generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/books/petty-cash").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. Posted PCV is included", () => {
    expect(rows.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(true);
  });

  test("5. non-Posted (Draft) PCV is excluded", () => {
    expect(rows.some((r) => r.reference_no === "PCB-DRAFT-1")).toBe(false);
  });

  test("6. date filtering is inclusive on both boundaries, and excludes rows outside the range", () => {
    expect(rows.some((r) => r.reference_no === "PCB-BOUNDARY-FROM")).toBe(true);
    expect(rows.some((r) => r.reference_no === "PCB-BOUNDARY-TO")).toBe(true);
    expect(rows.some((r) => r.reference_no === "PCB-OUTSIDE")).toBe(false);
  });

  test("29. company isolation - Company B's Posted PCV never appears", () => {
    expect(rows.some((r) => r.reference_no === "PCB-B-POSTED")).toBe(false);
    expect(rows.some((r) => Number(r.debit) === 4321 || Number(r.credit) === 4321)).toBe(false);
  });

  test("7. multiple PCV accounting lines are preserved (2-line PCV -> 2 rows, not collapsed)", () => {
    const posted = rows.filter((r) => r.reference_no === "PCB-POSTED-1");
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.account_code).sort()).toEqual(["PCB-CASH", "PCB-EXP"]);
  });

  test("8. debit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "PCB-POSTED-1" && r.account_code === "PCB-EXP");
    expect(Number(line.debit)).toBe(850);
    expect(Number(line.credit)).toBe(0);
  });

  test("9. credit values are preserved", () => {
    const line = rows.find((r) => r.reference_no === "PCB-POSTED-1" && r.account_code === "PCB-CASH");
    expect(Number(line.credit)).toBe(850);
    expect(Number(line.debit)).toBe(0);
  });

  test("10. totals derive correctly from the actual rows", () => {
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.005);
    // 850 (posted-1) + 50 (boundary-from) + 60 (boundary-to) = 960
    expect(totalDebit).toBeCloseTo(960, 2);
  });

  test("13. INV rows do not leak into Petty Cash Book", () => {
    expect(rows.some((r) => r.reference_no === "PCB-CROSS-INV")).toBe(false);
  });

  test("12. JV rows do not leak into Petty Cash Book", () => {
    expect(rows.some((r) => r.reference_no === "PCB-CROSS-JV")).toBe(false);
  });

  test("14. OR rows do not leak into Petty Cash Book", () => {
    expect(rows.some((r) => r.reference_no === "PCB-CROSS-OR")).toBe(false);
  });

  test("15. CV rows do not leak into Petty Cash Book", () => {
    expect(rows.some((r) => r.reference_no === "PCB-CROSS-CV")).toBe(false);
  });

  test("16. APV rows do not leak into Petty Cash Book", () => {
    expect(rows.some((r) => r.reference_no === "PCB-CROSS-APV")).toBe(false);
  });

  test("11. empty range returns a clean empty array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/books/petty-cash")
      .set(auth(adminToken))
      .query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("30. no transaction mutation occurs - PCV rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM petty_cash_headers WHERE voucher_no = 'PCB-POSTED-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(850);
    expect(Number(header.total_credit)).toBe(850);
    const [lines] = await pool.query(
      `SELECT pl.debit, pl.credit FROM petty_cash_lines pl JOIN petty_cash_headers ph ON ph.id = pl.petty_cash_id WHERE ph.voucher_no = 'PCB-POSTED-1' ORDER BY pl.id`
    );
    expect(lines.map((l) => [Number(l.debit), Number(l.credit)])).toEqual([
      [850, 0],
      [0, 850],
    ]);
  });
});

describe("31. Petty Cash lifecycle matches the canonical ledger exactly - no void/cancel/reverse mechanism exists", () => {
  let pcvId;

  beforeAll(async () => {
    pcvId = await makePettyCash(companyAId, null, "PCB-LIFECYCLE-1", "2026-08-18", "Posted", [
      { code: "PCB-EXP", title: "PCB Expense", debit: 77, credit: 0 },
      { code: "PCB-CASH", title: "PCB Cash", debit: 0, credit: 77 },
    ]);
  });

  test("there is no POST /api/petty-cash/:id/void route (unlike CV/APV) - confirms no report-specific lifecycle rule is needed beyond postedOnlySql", async () => {
    const res = await request(app).post(`/api/petty-cash/${pcvId}/void`).set(auth(adminToken)).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("there is no POST /api/petty-cash/:id/cancel route", async () => {
    const res = await request(app).post(`/api/petty-cash/${pcvId}/cancel`).set(auth(adminToken)).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("there is no POST /api/petty-cash/:id/reverse route - a Posted PCV can never produce a second reversing entry of any kind", async () => {
    const res = await request(app).post(`/api/petty-cash/${pcvId}/reverse`).set(auth(adminToken)).send({ reason: "x" });
    expect(res.status).toBe(404);
  });

  test("a Posted PCV cannot be edited (Phase 7A.1 immutability) - PUT returns 409", async () => {
    const res = await request(app)
      .put(`/api/petty-cash/${pcvId}`)
      .set(auth(adminToken))
      .send({
        voucherNo: "PCB-LIFECYCLE-1",
        transactionDate: "2026-08-18",
        status: "Draft",
        currency: { companyId: companyAId },
        lines: [{ accountCode: "PCB-EXP", debit: 1, credit: 0 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test("a Posted PCV cannot be deleted (Phase 7A.1 immutability) - DELETE returns 409", async () => {
    const res = await request(app).delete(`/api/petty-cash/${pcvId}`).set(auth(adminToken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TRANSACTION_ALREADY_POSTED");
  });

  test("consequently the Posted PCV still appears in the Book, unchanged, exactly once, with no reversing entry anywhere", async () => {
    const res = await request(app).get("/api/reports/books/petty-cash").set(auth(adminToken)).query(range());
    const rows = res.body.filter((r) => r.reference_no === "PCB-LIFECYCLE-1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.account_code, Number(r.debit), Number(r.credit)]).sort()).toEqual([
      ["PCB-CASH", 0, 77],
      ["PCB-EXP", 77, 0],
    ]);
    const jvRes = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(jvRes.body.some((r) => String(r.reference_no || "").includes("PCB-LIFECYCLE-1"))).toBe(false);
  });
});

describe("17/18/19/20/21/22. six-way cross-book isolation - the other directions", () => {
  test("17. PCV rows do not leak into Journal Book", async () => {
    const res = await request(app).get("/api/reports/books/journal").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(false);
    const pcbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("PCB-")));
    expect([...pcbRefs]).toEqual(["PCB-CROSS-JV"]);
  });

  test("18. PCV rows do not leak into Income Book", async () => {
    const res = await request(app).get("/api/reports/books/income").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(false);
    expect(res.body.some((r) => r.reference_no === "PCB-CROSS-INV")).toBe(true);
  });

  test("19. PCV rows do not leak into Cash Receipt Book", async () => {
    const res = await request(app).get("/api/reports/books/cash-receipt").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(false);
    const pcbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("PCB-")));
    expect([...pcbRefs]).toEqual(["PCB-CROSS-OR"]);
  });

  test("20. PCV rows do not leak into Cash Disbursement Book", async () => {
    const res = await request(app).get("/api/reports/books/cash-disbursement").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(false);
    const pcbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("PCB-")));
    expect([...pcbRefs]).toEqual(["PCB-CROSS-CV"]);
  });

  test("21. PCV rows do not leak into Accounts Payable Book", async () => {
    const res = await request(app).get("/api/reports/books/accounts-payable").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.reference_no === "PCB-POSTED-1")).toBe(false);
    const pcbRefs = new Set(res.body.map((r) => r.reference_no).filter((r) => String(r || "").startsWith("PCB-")));
    expect([...pcbRefs]).toEqual(["PCB-CROSS-APV"]);
  });

  test("22. prior five Books remain source-isolated for this fixture set (summary cross-check)", async () => {
    const [jv, inv, or_, cv, apv] = await Promise.all(
      ["journal", "income", "cash-receipt", "cash-disbursement", "accounts-payable"].map((p) =>
        request(app)
          .get(`/api/reports/books/${p}`)
          .set(auth(adminToken))
          .query(range())
          .then((r) => r.body)
      )
    );
    expect(jv.every((r) => !String(r.reference_no || "").includes("PCB-POSTED"))).toBe(true);
    expect(inv.every((r) => !String(r.reference_no || "").includes("PCB-POSTED"))).toBe(true);
    expect(or_.every((r) => !String(r.reference_no || "").includes("PCB-POSTED"))).toBe(true);
    expect(cv.every((r) => !String(r.reference_no || "").includes("PCB-POSTED"))).toBe(true);
    expect(apv.every((r) => !String(r.reference_no || "").includes("PCB-POSTED"))).toBe(true);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");

  test("23. Petty Cash Book now routes to a real page", () => {
    expect(menuSrc).toMatch(
      /id: "petty-cash-book", label: "Petty Cash Book", icon: PiggyBank, path: "\/reports\/books\/petty-cash"/
    );
  });

  test("24. the prior five Books remain unlocked", () => {
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
  });

  test("25. Debit/Credit Memo Book was unlocked in Phase L.7, see its own test coverage", () => {
    const re = new RegExp(`id: "debit-credit-memo-book"[^}]*path: "\\/reports\\/books\\/`);
    expect(menuSrc).toMatch(re);
  });

  test("26. Summary of Books / Net Summary of Books / Daily Cash Position remain path: null", () => {
    for (const id of ["summary-of-books-totals", "net-summary-of-books", "daily-cash-position"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: null`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("App.jsx routes /reports/books/petty-cash to PettyCashBook, alongside the other five Books", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import PettyCashBook from "\.\/pages\/REPORTS\/PettyCashBook\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/petty-cash" element={<PettyCashBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/journal" element={<JournalBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/income" element={<IncomeBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-receipt" element={<CashReceiptBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/cash-disbursement" element={<CashDisbursementBook \/>} \/>/);
    expect(appSrc).toMatch(/<Route path="\/reports\/books\/accounts-payable" element={<AccountsPayableBook \/>} \/>/);
  });

  test("pathPermissionMap maps the new route to REPORTS.FINANCIAL, same as every other Book", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/books\/petty-cash": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/BOOKS_OF_ACCOUNTS/);
  });

  test('32. "Petty Cash Voucher" is this repository\'s own existing terminology for PCV - verified via transactionsMenuConfig.js/PettyCashVoucher.jsx, not guessed', () => {
    const pcvMenuSrc = fs.readFileSync(
      path.join(__dirname, "../../components/sidebar/transactionsMenuConfig.js"),
      "utf8"
    );
    expect(pcvMenuSrc).toMatch(/label: "Petty Cash Voucher"/);
    const pcvPageSrc = fs.readFileSync(path.join(FRONTEND, "..", "TRANSACTIONS", "PettyCashVoucher.jsx"), "utf8");
    expect(pcvPageSrc).toMatch(/title="Petty Cash Voucher"/);
  });

  test("PettyCashBook.jsx is a thin, explicit wrapper configuring the shared BookReport with its own literal config", () => {
    const src = read(FRONTEND, "PettyCashBook.jsx");
    expect(src).toMatch(/import BookReport from "\.\/BookReport\.jsx"/);
    expect(src).toMatch(/title="Petty Cash Book"/);
    expect(src).toMatch(/apiPath="\/api\/reports\/books\/petty-cash"/);
    expect(src).toMatch(/referenceLabel="PCV Number"/);
    expect(src).toMatch(/filenamePrefix="Petty_Cash_Book"/);
    expect(src).toMatch(/No Posted Petty Cash Vouchers found for the selected dates\./);
  });

  test("Petty Cash Book does not invent payee/replenishment-reference/receipt-number/approval fields not authoritative on the canonical union", () => {
    const src = read(FRONTEND, "PettyCashBook.jsx");
    // code-shaped identifiers only - the explanatory comment mentioning
    // these terms in prose (documenting why they're excluded) is fine,
    // code is not.
    expect(src).not.toMatch(/payeeName|payee_name|replenishmentRef|receiptNo|approvalData/);
    expect(src).not.toMatch(/fetch\(/);
  });
});

describe("28. route and service are read-only (source guard)", () => {
  test("the Petty Cash Book route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/books/petty-cash"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(routeBody).toMatch(/getPettyCashBookRows/);
  });

  test("getPettyCashBookRows delegates to the shared getBookRows(sourceTypes:['PETTY CASH']) engine", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    const start = svcSrc.indexOf("function getPettyCashBookRows");
    const end = svcSrc.indexOf("\n}", start);
    const fnBody = svcSrc.slice(start, end);
    expect(fnBody).toMatch(/getBookRows\(\{ sourceTypes: \["PETTY CASH"\], from, to, companyId \}\)/);
  });

  test("the canonical union's Petty Cash branch literal is exactly 'PETTY CASH' (with a space), verified not assumed", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    expect(svcSrc).toMatch(/'PETTY CASH' AS source_type/);
  });
});

describe("27. CSV export stays formula-injection safe (shared BookReport, Petty Cash Book config)", () => {
  let M;
  beforeAll(async () => {
    M = await import("../../pages/REPORTS/reportCsv.mjs");
  });

  test("typedRowsToCsv still guards text cells but leaves numeric cells untouched (unchanged since Phase L.1)", () => {
    const csv = M.typedRowsToCsv([[{ t: "text", v: "=PCB(A1:A2)" }, { t: "num", v: "-850.00" }]]);
    expect(csv).toContain('"\'=PCB(A1:A2)"');
    expect(csv).toContain('"-850.00"');
  });

  test("BookReport's CSV filename uses the caller's filenamePrefix, so Petty Cash Book exports as Petty_Cash_Book_<date>.csv", () => {
    const src = read(FRONTEND, "BookReport.jsx");
    expect(src).toMatch(/downloadCsvText\(`\$\{filenamePrefix\}_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });
});
