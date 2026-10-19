// General Ledger - standardized Books of Accounts columns, inside the
// existing account-grouped / running-balance structure:
//   Account Code | Account Title | Customer/Supplier Name | TIN | Debit |
//   Credit | Balance | General Reference | Proj/Dept Code |
//   Document No. Ref. | Source | Date | Particulars
//
// Backend: LedgerReportService.getLedgerRows adds line_id plus the same
// party fields the seven Books use (party_name, party_tin,
// general_reference, proj_dept_code, document_ref) via the shared
// attachBookPartyFields lookup - now also covering AR/AP beginning-balance
// lines (party stored on the line). buildTransactionUnionSql, amounts,
// ordering and running_balance are unchanged.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const FRONTEND = path.join(__dirname, "..", "..", "pages", "REPORTS");
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), "utf8");

const P = "GLL-";
const RANGE = { from: "2026-07-01", to: "2026-07-31" };

let companyAId, companyBId, adminId, token;
const party = {};
const created = { arapHeaders: [], glbbHeaders: [] };

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.body.token;
}
const auth = () => ({ Authorization: `Bearer ${token}` });

async function makeParty(companyId, code, partyType, name, tin) {
  const [r] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name, tin]
  );
  return r.insertId;
}

async function makeVoucher({ headers, lines, fk, companyId, voucherNo, date, header = {}, rows }) {
  const totalDebit = rows.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = rows.reduce((s, l) => s + (l.credit || 0), 0);
  const cols = ["company_id", "voucher_no", "transaction_date", "total_debit", "total_credit", "status", ...Object.keys(header)];
  const vals = [companyId, voucherNo, date, totalDebit, totalCredit, "Posted", ...Object.values(header)];
  const [h] = await pool.execute(
    `INSERT INTO ${headers} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    vals
  );
  for (const l of rows) {
    await pool.execute(
      `INSERT INTO ${lines} (${fk}, account_code, account_title, particulars, debit, credit, gen_ref, gen_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [h.insertId, l.code, l.title, l.particulars || "line", l.debit || 0, l.credit || 0, l.genRef ?? null, l.genName ?? null]
    );
  }
}

async function glRows() {
  const res = await request(app).get("/api/reports/general-ledger").set(auth()).query(RANGE);
  expect(res.status).toBe(200);
  return res.body.filter((r) => String(r.account_code).startsWith(P));
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('GLL Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('GLL Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("GllPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('gll_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  token = await login("gll_admin", "GllPass!1");

  party.cust = await makeParty(companyAId, `${P}C1`, "CUSTOMER", "GL Customer", "111-111-111-000");
  party.jv = await makeParty(companyAId, `${P}J1`, "SUPPLIER", "GL JV Party", "333-333-333-000");
  party.gone = await makeParty(companyAId, `${P}GONE`, "CUSTOMER", "Gone Customer", "555-555-555-000");
  party.otherCo = await makeParty(companyBId, `${P}B1`, "CUSTOMER", "Other Co Customer", "999-999-999-000");

  // AR beginning balances (party stored on the line).
  const [arh] = await pool.execute(
    "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AR', '2026-07-01', 'Posted')",
    [companyAId]
  );
  created.arapHeaders.push(arh.insertId);
  await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_code, account_title, reference_no, debit, credit)
     VALUES (?, ?, ?, 'GL Customer', ?, 'Accounts Receivable', 'BB-DOC-1', 1000, 0)`,
    [arh.insertId, party.cust, `${P}C1`, `${P}AR`]
  );
  await pool.execute(
    `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, account_code, account_title, reference_no, debit, credit)
     VALUES (?, ?, NULL, 'Gone Customer', ?, 'Accounts Receivable', 'BB-DOC-2', 50, 0)`,
    [arh.insertId, party.gone, `${P}AR`]
  );

  // GL beginning balance (no party at all).
  const [glh] = await pool.execute(
    `INSERT INTO gl_beginning_balance_headers (company_id, filter_code, balance_date, currency_code, currency_name, title, status)
     VALUES (?, 'NON', '2026-07-01', 'PHP', 'PHILIPPINE PESO', 'GLL GL BB', 'Posted')`,
    [companyAId]
  );
  created.glbbHeaders.push(glh.insertId);
  await pool.execute(
    "INSERT INTO gl_beginning_balance_lines (header_id, account_code, account_title, othrdebit, othrcredit) VALUES (?, ?, 'Cash in Bank', 5000, 0)",
    [glh.insertId, `${P}CASH`]
  );

  await makeVoucher({ headers: "invoice_headers", lines: "invoice_lines", fk: "invoice_id", companyId: companyAId,
    voucherNo: `${P}INV-1`, date: "2026-07-05",
    header: { customer_id: party.cust, customer_name: "GL Customer", paid_amount: 0, balance_amount: 500, payment_status: "Unpaid" },
    rows: [
      { code: `${P}AR`, title: "Accounts Receivable", debit: 500, genRef: `${P}C1`, genName: "GL Customer" },
      { code: `${P}REV`, title: "Sales Revenue", credit: 500 },
    ] });
  await makeVoucher({ headers: "or_headers", lines: "or_lines", fk: "or_id", companyId: companyAId,
    voucherNo: `${P}OR-1`, date: "2026-07-10", header: { customer_id: party.cust, customer_name: "GL Customer" },
    rows: [
      { code: `${P}CASH`, title: "Cash in Bank", debit: 300 },
      { code: `${P}AR`, title: "Accounts Receivable", credit: 300, genRef: `${P}C1`, genName: "GL Customer" },
    ] });
  await makeVoucher({ headers: "jv_headers", lines: "jv_lines", fk: "jv_id", companyId: companyAId,
    voucherNo: `${P}JV-1`, date: "2026-07-12",
    rows: [
      { code: `${P}AR`, title: "Accounts Receivable", debit: 200, genRef: `${P}J1`, genName: "GL JV Party" },
      { code: `${P}CASH`, title: "Cash in Bank", credit: 200 },
    ] });
  // Company B - must never appear.
  await makeVoucher({ headers: "invoice_headers", lines: "invoice_lines", fk: "invoice_id", companyId: companyBId,
    voucherNo: `${P}B-INV-1`, date: "2026-07-05",
    header: { customer_id: party.otherCo, customer_name: "Other Co Customer", paid_amount: 0, balance_amount: 70, payment_status: "Unpaid" },
    rows: [
      { code: `${P}AR`, title: "Accounts Receivable", debit: 70, genRef: `${P}B1`, genName: "Other Co Customer" },
      { code: `${P}REV`, title: "Sales Revenue", credit: 70 },
    ] });

  // Deleted party (AR beginning-balance line keeps its stored name).
  await pool.execute("DELETE FROM general_libraries WHERE id = ?", [party.gone]);
});

afterAll(async () => {
  for (const t of ["invoice", "or", "jv"]) {
    await pool.query(
      `DELETE l FROM ${t}_lines l JOIN ${t}_headers h ON h.id = l.${t}_id WHERE h.voucher_no LIKE ?`,
      [`${P}%`]
    );
    await pool.query(`DELETE FROM ${t}_headers WHERE voucher_no LIKE ?`, [`${P}%`]);
  }
  if (created.arapHeaders.length) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id IN (?)", [created.arapHeaders]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id IN (?)", [created.arapHeaders]);
  }
  if (created.glbbHeaders.length) {
    await pool.query("DELETE FROM gl_beginning_balance_lines WHERE header_id IN (?)", [created.glbbHeaders]);
    await pool.query("DELETE FROM gl_beginning_balance_headers WHERE id IN (?)", [created.glbbHeaders]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id = ?", [adminId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("General Ledger API - standardized party fields (additive)", () => {
  test("every GL row carries line_id, party_name, party_tin, general_reference, proj_dept_code (null), document_ref", async () => {
    const rows = await glRows();
    expect(rows.length).toBe(9);
    for (const r of rows) {
      expect(r).toHaveProperty("line_id");
      expect(r).toHaveProperty("party_name");
      expect(r).toHaveProperty("party_tin");
      expect(r).toHaveProperty("general_reference");
      expect(r.proj_dept_code).toBeNull();
      expect(r.document_ref).toBe(r.reference_no);
      expect(r).toHaveProperty("running_balance"); // existing fields still there
      expect(r).toHaveProperty("beginning_balance");
    }
  });

  test("AR beginning-balance line: party stored on the line -> name, master TIN, General Reference = party code", async () => {
    const row = (await glRows()).find((r) => r.source_type === "AR" && r.reference_no === "BB-DOC-1");
    expect([row.party_name, row.party_tin, row.general_reference]).toEqual(["GL Customer", "111-111-111-000", `${P}C1`]);
  });

  test("AR beginning-balance line of a deleted party: stored name kept, TIN blank", async () => {
    const row = (await glRows()).find((r) => r.source_type === "AR" && r.reference_no === "BB-DOC-2");
    expect(row.party_name).toBe("Gone Customer");
    expect(row.party_tin).toBe("");
  });

  test("GL beginning balance has no party -> blank", async () => {
    const row = (await glRows()).find((r) => r.source_type === "GL BEGINNING");
    expect([row.party_name, row.party_tin, row.general_reference]).toEqual(["", "", ""]);
  });

  test("customer invoice / OR rows: customer name + TIN (line party, else header party)", async () => {
    const rows = await glRows();
    const invAr = rows.find((r) => r.reference_no === `${P}INV-1` && r.account_code === `${P}AR`);
    const invRev = rows.find((r) => r.reference_no === `${P}INV-1` && r.account_code === `${P}REV`);
    const orCash = rows.find((r) => r.reference_no === `${P}OR-1` && r.account_code === `${P}CASH`);
    for (const r of [invAr, invRev, orCash]) {
      expect(r.party_name).toBe("GL Customer");
      expect(r.party_tin).toBe("111-111-111-000");
    }
    expect(invAr.general_reference).toBe(`${P}C1`);
    expect(invRev.general_reference).toBe("");
  });

  test("JV: each line resolves its own party; a line without one stays blank", async () => {
    const rows = await glRows();
    const jvAr = rows.find((r) => r.reference_no === `${P}JV-1` && r.account_code === `${P}AR`);
    const jvCash = rows.find((r) => r.reference_no === `${P}JV-1` && r.account_code === `${P}CASH`);
    expect([jvAr.party_name, jvAr.party_tin]).toEqual(["GL JV Party", "333-333-333-000"]);
    expect([jvCash.party_name, jvCash.party_tin]).toEqual(["", ""]);
  });

  test("company isolation: company B's rows and TINs never appear", async () => {
    const rows = await glRows();
    expect(rows.some((r) => r.reference_no === `${P}B-INV-1`)).toBe(false);
    expect(rows.some((r) => r.party_tin === "999-999-999-000")).toBe(false);
  });

  test("running balance, ordering and debit/credit are unchanged", async () => {
    const rows = await glRows();
    const ar = rows.filter((r) => r.account_code === `${P}AR`);
    // BB 1000 + BB 50 (07-01), INV +500 (07-05), OR -300 (07-10), JV +200 (07-12)
    expect(ar.map((r) => Number(r.running_balance))).toEqual([1000, 1050, 1550, 1250, 1450]);
    const cash = rows.filter((r) => r.account_code === `${P}CASH`);
    expect(cash.map((r) => Number(r.running_balance))).toEqual([5000, 5300, 5100]);
    const totalDebit = rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(1000 + 50 + 5000 + 500 + 300 + 200, 2);
    expect(totalCredit).toBeCloseTo(500 + 300 + 200, 2);
    // still grouped by account, then date
    const keys = rows.map((r) => `${r.account_code}|${r.transaction_date}`);
    expect([...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(keys);
  });

  test("account filter still works and still carries the new fields", async () => {
    const res = await request(app).get("/api/reports/general-ledger").set(auth())
      .query({ ...RANGE, accountCode: `${P}CASH` });
    expect(res.status).toBe(200);
    expect(res.body.every((r) => r.account_code === `${P}CASH`)).toBe(true);
    expect(res.body.find((r) => r.reference_no === `${P}OR-1`).party_name).toBe("GL Customer");
  });
});

describe("GeneralLedger.jsx - one column order for screen, CSV, Excel and print", () => {
  const src = read("GeneralLedger.jsx");
  const EXPECTED = [
    "Account Code", "Account Title", "Customer/Supplier Name", "TIN", "Debit", "Credit", "Balance",
    "General Reference", "Proj/Dept Code", "Document No. Ref.", "Source", "Date", "Particulars",
  ];

  test("GL_COLUMNS defines the approved order", () => {
    const block = src.slice(src.indexOf("const GL_COLUMNS"), src.indexOf("];", src.indexOf("const GL_COLUMNS")));
    expect([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(EXPECTED);
  });

  test("screen table header matches GL_COLUMNS", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
    const labels = [...thead.matchAll(/<th[^>]*>([^<{]+)<\/th>/g)].map((m) => m[1].trim());
    expect(labels).toEqual(EXPECTED);
  });

  test("screen rows render fields in the same order", () => {
    const tbody = src.slice(src.indexOf("<tbody>"), src.indexOf("</tbody>"));
    const tokens = [...tbody.matchAll(/row\.([a-z_]+)|running_balance/g)].map((m) => m[1] || "running_balance");
    const order = tokens.filter((f, i) => tokens.indexOf(f) === i);
    expect(order).toEqual([
      "account_code", "account_title", "party_name", "party_tin", "debit", "credit", "running_balance",
      "general_reference", "proj_dept_code", "document_ref", "reference_no", "source_type", "transaction_date", "particulars",
    ]);
  });

  test("CSV and Excel both use GL_COLUMNS and the same exportRow()", () => {
    const csv = src.slice(src.indexOf("function downloadCSV"), src.indexOf("function downloadExcel"));
    const xls = src.slice(src.indexOf("function downloadExcel"), src.indexOf("return (", src.indexOf("function downloadExcel")));
    expect(csv).toMatch(/csvRows\.push\(GL_COLUMNS\)/);
    expect(csv).toMatch(/exportRow\(row,/);
    expect(xls).toMatch(/cells\(GL_COLUMNS, "th"\)/);
    expect(xls).toMatch(/exportRow\(row,/);
    const fn = src.slice(src.indexOf("function exportRow"), src.indexOf("function beginningRow"));
    const fields = [...fn.matchAll(/row\.([a-z_]+)|balance\.toFixed/g)].map((m) => m[1] || "balance");
    expect(fields.filter((f, i) => fields.indexOf(f) === i)).toEqual([
      "account_code", "account_title", "party_name", "party_tin", "debit", "credit", "balance",
      "general_reference", "proj_dept_code", "document_ref", "reference_no", "source_type", "transaction_date", "particulars",
    ]);
  });

  test("Excel export escapes cell values (party names are user-entered)", () => {
    expect(src).toMatch(/function escapeHtml/);
    const xls = src.slice(src.indexOf("function downloadExcel"), src.indexOf("return (", src.indexOf("function downloadExcel")));
    expect(xls).toMatch(/escapeHtml\(v\)/);
  });

  test("running balance and account grouping are unchanged", () => {
    expect(src).toMatch(/function groupByAccount\(rows\)/);
    expect(src).toMatch(/section\.beginningBalance \+ Number\(row\.running_balance \|\| 0\)/);
    expect(src).toMatch(/Ending Balance/);
  });

  test("print uses the same on-screen tables (window.print)", () => {
    expect(src).toMatch(/window\.print\(\)/);
  });

  test("13 column widths are declared for the 13 GL columns", () => {
    const colgroup = src.slice(src.indexOf("<colgroup>"), src.indexOf("</colgroup>"));
    expect((colgroup.match(/<col /g) || []).length).toBe(13);
  });
});

describe("BookReport.jsx - column widths", () => {
  const src = read("BookReport.jsx");
  const css = read("BookReport.css");

  test("one <col> per column (11 + optional type column)", () => {
    const colgroup = src.slice(src.indexOf("<colgroup>"), src.indexOf("</colgroup>"));
    expect((colgroup.match(/<col /g) || []).length).toBe(12); // incl. the conditional type <col>
    expect(colgroup).toMatch(/typeColumn \? <col className="bkr-col-type" \/> : null/);
  });

  test("Customer/Supplier Name ~200px, TIN ~120-130px, amounts readable", () => {
    expect(css).toMatch(/\.bkr-col-party \{ width: 200px; \}/);
    expect(css).toMatch(/\.bkr-col-tin \{ width: 1[23]0px; \}/);
    expect(css).toMatch(/\.bkr-col-amount \{ width: 105px; \}/);
  });
});
