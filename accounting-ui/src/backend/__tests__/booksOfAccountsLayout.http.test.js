// Books of Accounts - standardized layout (legacy BOOKS.XLT order with
// Customer/Supplier Name + TIN right after Account Title):
//   Account Code | Account Title | Customer/Supplier Name | TIN | Debit |
//   Credit | General Reference | Proj/Dept Code | Document No. Ref.
//
// Backend: LedgerReportService.getBookRows now adds party_name, party_tin,
// general_reference, proj_dept_code and document_ref to every Book row,
// resolved AFTER the canonical union query (buildTransactionUnionSql itself
// is unchanged). Frontend: the shared BookReport.jsx renders/exports/prints
// all seven Books in that one order.
//
// Covers: customer and supplier parties, no party, party without TIN,
// deleted party, JV with different parties per line, APV/CV stored
// payee_tin, company isolation, unchanged debit/credit and book filtering,
// and screen/CSV/print column order.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const FRONTEND = path.join(__dirname, "..", "..", "pages", "REPORTS");
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

const P = "BKL-"; // fixture prefix (vouchers + party codes)
const RANGE = { from: "2026-07-01", to: "2026-07-31" };

let companyAId, companyBId, adminId, token;
const party = {};

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
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

// Generic header+lines insert. `header` = extra header columns (party etc.).
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
  return h.insertId;
}

const BOOK = {
  income: "/api/reports/books/income",
  cashReceipt: "/api/reports/books/cash-receipt",
  cashDisbursement: "/api/reports/books/cash-disbursement",
  accountsPayable: "/api/reports/books/accounts-payable",
  journal: "/api/reports/books/journal",
  pettyCash: "/api/reports/books/petty-cash",
  memo: "/api/reports/books/debit-credit-memo",
};

async function bookRows(key) {
  const res = await request(app).get(BOOK[key]).set(auth()).query(RANGE);
  expect(res.status).toBe(200);
  return res.body.filter((r) => String(r.reference_no).startsWith(P));
}
const byVoucher = (rows, v) => rows.filter((r) => r.reference_no === v);

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('BKL Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('BKL Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("BklPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('bkl_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  token = await login("bkl_admin", "BklPass!1");

  party.cust = await makeParty(companyAId, `${P}C1`, "CUSTOMER", "Alpha Customer", "111-111-111-000");
  party.supp = await makeParty(companyAId, `${P}S1`, "SUPPLIER", "Beta Supplier", "222-222-222-000");
  party.noTin = await makeParty(companyAId, `${P}S2`, "SUPPLIER", "Gamma NoTin Supplier", null);
  party.jv1 = await makeParty(companyAId, `${P}J1`, "CUSTOMER", "JV Party One", "333-333-333-000");
  party.jv2 = await makeParty(companyAId, `${P}J2`, "SUPPLIER", "JV Party Two", "444-444-444-000");
  party.deleted = await makeParty(companyAId, `${P}DEL`, "SUPPLIER", "Deleted Party", "555-555-555-000");
  party.otherCo = await makeParty(companyBId, `${P}B1`, "CUSTOMER", "Other Company Party", "999-999-999-000");

  const d = "2026-07-10";

  // Income Book: customer header + AR/VAT lines carrying the party's gen_ref.
  await makeVoucher({ headers: "invoice_headers", lines: "invoice_lines", fk: "invoice_id", companyId: companyAId,
    voucherNo: `${P}INV-1`, date: d,
    header: { customer_id: party.cust, customer_name: "Alpha Customer", paid_amount: 0, balance_amount: 1120, payment_status: "Unpaid" },
    rows: [
      { code: "BKL-AR", title: "Accounts Receivable", debit: 1120, genRef: `${P}C1`, genName: "Alpha Customer" },
      { code: "BKL-REV", title: "Sales Revenue", credit: 1000 },
      { code: "BKL-OVAT", title: "Output VAT", credit: 120, genRef: `${P}C1`, genName: "Alpha Customer" },
    ] });

  // Cash Receipt Book: customer.
  await makeVoucher({ headers: "or_headers", lines: "or_lines", fk: "or_id", companyId: companyAId,
    voucherNo: `${P}OR-1`, date: d, header: { customer_id: party.cust, customer_name: "Alpha Customer" },
    rows: [
      { code: "BKL-CASH", title: "Cash in Bank", debit: 500 },
      { code: "BKL-AR", title: "Accounts Receivable", credit: 500, genRef: `${P}C1`, genName: "Alpha Customer" },
    ] });

  // Accounts Payable Book: supplier with a STORED payee_tin that differs from
  // the master TIN (stored wins for the header party) ...
  await makeVoucher({ headers: "apv_headers", lines: "apv_lines", fk: "apv_id", companyId: companyAId,
    voucherNo: `${P}APV-1`, date: d,
    header: { supplier_id: party.supp, supplier_name: "Beta Supplier", payee_tin: "222-STORED-000", paid_amount: 0, balance_amount: 800, payment_status: "Unpaid" },
    rows: [
      { code: "BKL-EXP", title: "Office Expense", debit: 800 },
      { code: "BKL-AP", title: "Accounts Payable", credit: 800, genRef: `${P}S1`, genName: "Beta Supplier" },
    ] });
  // ... and one with no stored payee_tin (falls back to master TIN).
  await makeVoucher({ headers: "apv_headers", lines: "apv_lines", fk: "apv_id", companyId: companyAId,
    voucherNo: `${P}APV-2`, date: d,
    header: { supplier_id: party.supp, supplier_name: "Beta Supplier", payee_tin: null, paid_amount: 0, balance_amount: 300, payment_status: "Unpaid" },
    rows: [
      { code: "BKL-EXP", title: "Office Expense", debit: 300 },
      { code: "BKL-AP", title: "Accounts Payable", credit: 300 },
    ] });

  // Cash Disbursement Book: payee with no TIN in master and none stored ...
  await makeVoucher({ headers: "cv_headers", lines: "cv_lines", fk: "cv_id", companyId: companyAId,
    voucherNo: `${P}CV-1`, date: d, header: { payee_id: party.noTin, payee_name: "Gamma NoTin Supplier", payee_tin: null },
    rows: [
      { code: "BKL-AP", title: "Accounts Payable", debit: 250 },
      { code: "BKL-CASH", title: "Cash in Bank", credit: 250 },
    ] });
  // ... and one whose header payee has a stored TIN, plus a line that names a
  // DIFFERENT party (the stored TIN must not leak onto that line).
  await makeVoucher({ headers: "cv_headers", lines: "cv_lines", fk: "cv_id", companyId: companyAId,
    voucherNo: `${P}CV-2`, date: d, header: { payee_id: party.supp, payee_name: "Beta Supplier", payee_tin: "CV-STORED-TIN" },
    rows: [
      { code: "BKL-AP", title: "Accounts Payable", debit: 400, genRef: `${P}J1`, genName: "JV Party One" },
      { code: "BKL-CASH", title: "Cash in Bank", credit: 400 },
    ] });

  // Journal Book: different parties on different lines + a line with no party
  // + a gen_name-only line (no gen_ref) + another company's party code.
  await makeVoucher({ headers: "jv_headers", lines: "jv_lines", fk: "jv_id", companyId: companyAId,
    voucherNo: `${P}JV-1`, date: d,
    rows: [
      { code: "BKL-AR", title: "Accounts Receivable", debit: 100, genRef: `${P}J1`, genName: "JV Party One" },
      { code: "BKL-AP", title: "Accounts Payable", debit: 50, genRef: `${P}J2`, genName: "JV Party Two" },
      { code: "BKL-CASH", title: "Cash in Bank", credit: 150 },
    ] });
  await makeVoucher({ headers: "jv_headers", lines: "jv_lines", fk: "jv_id", companyId: companyAId,
    voucherNo: `${P}JV-2`, date: d,
    rows: [
      { code: "BKL-AR", title: "Accounts Receivable", debit: 70, genName: "Name Only Party" },
      { code: "BKL-AR", title: "Accounts Receivable", debit: 30, genRef: `${P}B1`, genName: "Other Company Party" },
      { code: "BKL-CASH", title: "Cash in Bank", credit: 100 },
    ] });

  // Petty Cash Book: no party at all, and a party that is deleted afterwards.
  await makeVoucher({ headers: "petty_cash_headers", lines: "petty_cash_lines", fk: "petty_cash_id", companyId: companyAId,
    voucherNo: `${P}PCV-1`, date: d, header: { payee_id: null, payee_name: "" },
    rows: [
      { code: "BKL-EXP", title: "Office Expense", debit: 60 },
      { code: "BKL-PCF", title: "Petty Cash Fund", credit: 60 },
    ] });
  await makeVoucher({ headers: "petty_cash_headers", lines: "petty_cash_lines", fk: "petty_cash_id", companyId: companyAId,
    voucherNo: `${P}PCV-2`, date: d, header: { payee_id: party.deleted, payee_name: "Deleted Party" },
    rows: [
      { code: "BKL-EXP", title: "Office Expense", debit: 40, genRef: `${P}DEL`, genName: "Deleted Party" },
      { code: "BKL-PCF", title: "Petty Cash Fund", credit: 40 },
    ] });
  await pool.execute("DELETE FROM general_libraries WHERE id = ?", [party.deleted]);

  // Debit/Credit Memo Book: customer (debit memo) and supplier (credit memo).
  await makeVoucher({ headers: "memo_headers", lines: "memo_lines", fk: "memo_id", companyId: companyAId,
    voucherNo: `${P}DM-1`, date: d,
    header: { memo_type: "DEBIT", party_id: party.cust, party_name: "Alpha Customer", party_type: "CUSTOMER" },
    rows: [
      { code: "BKL-AR", title: "Accounts Receivable", debit: 90 },
      { code: "BKL-REV", title: "Sales Revenue", credit: 90 },
    ] });
  await makeVoucher({ headers: "memo_headers", lines: "memo_lines", fk: "memo_id", companyId: companyAId,
    voucherNo: `${P}CM-1`, date: d,
    header: { memo_type: "CREDIT", party_id: party.supp, party_name: "Beta Supplier", party_type: "SUPPLIER" },
    rows: [
      { code: "BKL-AP", title: "Accounts Payable", debit: 35 },
      { code: "BKL-EXP", title: "Office Expense", credit: 35 },
    ] });

  // Company B: must never appear in company A's Books.
  await makeVoucher({ headers: "invoice_headers", lines: "invoice_lines", fk: "invoice_id", companyId: companyBId,
    voucherNo: `${P}B-INV-1`, date: d,
    header: { customer_id: party.otherCo, customer_name: "Other Company Party", paid_amount: 0, balance_amount: 777, payment_status: "Unpaid" },
    rows: [
      { code: "BKL-AR", title: "Accounts Receivable", debit: 777, genRef: `${P}B1`, genName: "Other Company Party" },
      { code: "BKL-REV", title: "Sales Revenue", credit: 777 },
    ] });
});

afterAll(async () => {
  for (const t of ["invoice", "or", "apv", "cv", "jv", "petty_cash", "memo"]) {
    const fk = t === "petty_cash" ? "petty_cash_id" : `${t}_id`;
    await pool.query(
      `DELETE l FROM ${t}_lines l JOIN ${t}_headers h ON h.id = l.${fk} WHERE h.voucher_no LIKE ?`,
      [`${P}%`]
    );
    await pool.query(`DELETE FROM ${t}_headers WHERE voucher_no LIKE ?`, [`${P}%`]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id = ?", [adminId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("getBookRows - additive standardized fields", () => {
  test("every Book row carries party_name, party_tin, general_reference, proj_dept_code (null) and document_ref (= voucher no.)", async () => {
    for (const key of Object.keys(BOOK)) {
      const rows = await bookRows(key);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r).toHaveProperty("party_name");
        expect(r).toHaveProperty("party_tin");
        expect(r).toHaveProperty("general_reference");
        expect(r.proj_dept_code).toBeNull();
        expect(r.document_ref).toBe(r.reference_no);
      }
    }
  });

  test("customer transaction (Income Book): customer name + master TIN on every line; General Reference = line gen_ref", async () => {
    const rows = byVoucher(await bookRows("income"), `${P}INV-1`);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.party_name).toBe("Alpha Customer");
      expect(r.party_tin).toBe("111-111-111-000");
    }
    const ar = rows.find((r) => r.account_code === "BKL-AR");
    const rev = rows.find((r) => r.account_code === "BKL-REV");
    expect(ar.general_reference).toBe(`${P}C1`);
    expect(rev.general_reference).toBe(""); // header party used, no line ref invented
  });

  test("customer transaction (Cash Receipt Book)", async () => {
    const rows = byVoucher(await bookRows("cashReceipt"), `${P}OR-1`);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.party_name).toBe("Alpha Customer");
      expect(r.party_tin).toBe("111-111-111-000");
    });
  });

  test("supplier transaction (APV): stored payee_tin wins for the header party, also on a line naming that same party", async () => {
    const rows = byVoucher(await bookRows("accountsPayable"), `${P}APV-1`);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.party_name).toBe("Beta Supplier");
      expect(r.party_tin).toBe("222-STORED-000");
    });
  });

  test("APV without a stored payee_tin falls back to the supplier master TIN", async () => {
    const rows = byVoucher(await bookRows("accountsPayable"), `${P}APV-2`);
    rows.forEach((r) => expect(r.party_tin).toBe("222-222-222-000"));
  });

  test("CV: party with no TIN -> name shown, TIN blank", async () => {
    const rows = byVoucher(await bookRows("cashDisbursement"), `${P}CV-1`);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.party_name).toBe("Gamma NoTin Supplier");
      expect(r.party_tin).toBe("");
    });
  });

  test("CV: header's stored TIN stays with the header payee; a line naming another party gets that party's own TIN", async () => {
    const rows = byVoucher(await bookRows("cashDisbursement"), `${P}CV-2`);
    const lineParty = rows.find((r) => r.account_code === "BKL-AP");
    const headerParty = rows.find((r) => r.account_code === "BKL-CASH");
    expect(lineParty.party_name).toBe("JV Party One");
    expect(lineParty.party_tin).toBe("333-333-333-000");
    expect(lineParty.general_reference).toBe(`${P}J1`);
    expect(headerParty.party_name).toBe("Beta Supplier");
    expect(headerParty.party_tin).toBe("CV-STORED-TIN");
  });

  test("JV: different parties on different lines; a line with no party stays blank (no voucher-wide party)", async () => {
    const rows = byVoucher(await bookRows("journal"), `${P}JV-1`);
    expect(rows).toHaveLength(3);
    const l1 = rows.find((r) => r.account_code === "BKL-AR");
    const l2 = rows.find((r) => r.account_code === "BKL-AP");
    const l3 = rows.find((r) => r.account_code === "BKL-CASH");
    expect([l1.party_name, l1.party_tin, l1.general_reference]).toEqual(["JV Party One", "333-333-333-000", `${P}J1`]);
    expect([l2.party_name, l2.party_tin, l2.general_reference]).toEqual(["JV Party Two", "444-444-444-000", `${P}J2`]);
    expect([l3.party_name, l3.party_tin, l3.general_reference]).toEqual(["", "", ""]);
  });

  test("JV: gen_name without gen_ref shows the stored name with no TIN (nothing inferred from the name)", async () => {
    const rows = byVoucher(await bookRows("journal"), `${P}JV-2`);
    const nameOnly = rows.find((r) => r.party_name === "Name Only Party");
    expect(nameOnly).toBeDefined();
    expect(nameOnly.party_tin).toBe("");
    expect(nameOnly.general_reference).toBe("");
  });

  test("company isolation: another company's party code on a line never resolves to its TIN", async () => {
    const rows = byVoucher(await bookRows("journal"), `${P}JV-2`);
    const other = rows.find((r) => r.general_reference === `${P}B1`);
    expect(other.party_name).toBe("Other Company Party"); // name stored on the line itself
    expect(other.party_tin).toBe(""); // company B's master TIN is not looked up
  });

  test("company isolation: company B's vouchers never appear in company A's Books", async () => {
    for (const key of Object.keys(BOOK)) {
      const rows = await bookRows(key);
      expect(rows.some((r) => r.reference_no === `${P}B-INV-1`)).toBe(false);
      expect(rows.some((r) => r.party_tin === "999-999-999-000")).toBe(false);
    }
  });

  test("Petty Cash: transaction with no party -> name and TIN blank", async () => {
    const rows = byVoucher(await bookRows("pettyCash"), `${P}PCV-1`);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.party_name).toBe("");
      expect(r.party_tin).toBe("");
    });
  });

  test("deleted party: stored name still shown, TIN blank (master record gone)", async () => {
    const rows = byVoucher(await bookRows("pettyCash"), `${P}PCV-2`);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.party_name).toBe("Deleted Party");
      expect(r.party_tin).toBe("");
    });
  });

  test("Debit/Credit Memo Book: customer and supplier parties", async () => {
    const rows = await bookRows("memo");
    byVoucher(rows, `${P}DM-1`).forEach((r) => {
      expect(r.party_name).toBe("Alpha Customer");
      expect(r.party_tin).toBe("111-111-111-000");
    });
    byVoucher(rows, `${P}CM-1`).forEach((r) => {
      expect(r.party_name).toBe("Beta Supplier");
      expect(r.party_tin).toBe("222-222-222-000");
    });
  });

  test("debit/credit values are unchanged and each Book still contains only its own source type", async () => {
    const expected = {
      income: { [`${P}INV-1`]: [1120, 1120] },
      cashReceipt: { [`${P}OR-1`]: [500, 500] },
      accountsPayable: { [`${P}APV-1`]: [800, 800], [`${P}APV-2`]: [300, 300] },
      cashDisbursement: { [`${P}CV-1`]: [250, 250], [`${P}CV-2`]: [400, 400] },
      journal: { [`${P}JV-1`]: [150, 150], [`${P}JV-2`]: [100, 100] },
      pettyCash: { [`${P}PCV-1`]: [60, 60], [`${P}PCV-2`]: [40, 40] },
      memo: { [`${P}DM-1`]: [90, 90], [`${P}CM-1`]: [35, 35] },
    };
    for (const [key, vouchers] of Object.entries(expected)) {
      const rows = await bookRows(key);
      expect([...new Set(rows.map((r) => r.reference_no))].sort()).toEqual(Object.keys(vouchers).sort());
      for (const [v, [dr, cr]] of Object.entries(vouchers)) {
        const vr = byVoucher(rows, v);
        expect(vr.reduce((s, r) => s + Number(r.debit), 0)).toBeCloseTo(dr, 2);
        expect(vr.reduce((s, r) => s + Number(r.credit), 0)).toBeCloseTo(cr, 2);
      }
    }
  });

  test("Summary of Books by Totals still equals the sum of each Book's own rows", async () => {
    const res = await request(app).get("/api/reports/books/summary-totals").set(auth()).query(RANGE);
    expect(res.status).toBe(200);
    const keyMap = { journal: "journal", income: "income", cashReceipt: "cashReceipt", cashDisbursement: "cashDisbursement",
      accountsPayable: "accountsPayable", pettyCash: "pettyCash", memo: "debitCreditMemo" };
    for (const [bookKey, summaryKey] of Object.entries(keyMap)) {
      const all = (await request(app).get(BOOK[bookKey]).set(auth()).query(RANGE)).body;
      const s = res.body.books.find((b) => b.book === summaryKey);
      expect(s.totalDebit).toBeCloseTo(all.reduce((t, r) => t + Number(r.debit), 0), 2);
      expect(s.totalCredit).toBeCloseTo(all.reduce((t, r) => t + Number(r.credit), 0), 2);
    }
  });
});

describe("BookReport.jsx - one column order for screen, CSV and print", () => {
  const src = read(FRONTEND, "BookReport.jsx");
  const CORE = [
    "Account Code",
    "Account Title",
    "Customer/Supplier Name",
    "TIN",
    "Debit",
    "Credit",
    "General Reference",
    "Proj/Dept Code",
    "Document No. Ref.",
  ];

  test("screen table header follows the standardized order (then the optional type column, Date, Particulars)", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
    const labels = [...thead.matchAll(/<th[^>]*>([^<{]+)<\/th>/g)].map((m) => m[1].trim());
    expect(labels).toEqual([...CORE, "Date", "Particulars"]);
    expect(thead.indexOf("typeColumn.label")).toBeGreaterThan(thead.indexOf("Document No. Ref."));
    expect(thead.indexOf("typeColumn.label")).toBeLessThan(thead.indexOf(">Date<"));
  });

  test("Customer/Supplier Name and TIN come immediately after Account Title", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"));
    const labels = [...thead.matchAll(/<th[^>]*>([^<{]+)<\/th>/g)].map((m) => m[1].trim());
    const i = labels.indexOf("Account Title");
    expect(labels.slice(i + 1, i + 3)).toEqual(["Customer/Supplier Name", "TIN"]);
  });

  test("CSV header uses exactly the same order as the screen table", () => {
    const fn = src.slice(src.indexOf("function exportCSV"), src.indexOf("const generated"));
    const headerBlock = fn.slice(fn.indexOf("const headerRow"), fn.indexOf("const totalRow"));
    const csvLabels = [...headerBlock.matchAll(/T\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(csvLabels).toEqual([...CORE, "Date", "Particulars"]);
    expect(headerBlock).toMatch(/if \(typeColumn\) headerRow\.push\(T\(typeColumn\.label\)\)/);
  });

  test("CSV data rows emit the same fields in the same order", () => {
    const fn = src.slice(src.indexOf("function exportCSV"), src.indexOf("const generated"));
    const rowBlock = fn.slice(fn.indexOf("...filteredRows.map"), fn.indexOf("return row;"));
    const fields = [...rowBlock.matchAll(/[TN]\(r\.([a-z_]+)\)/g)].map((m) => m[1]);
    expect(fields).toEqual([
      "account_code", "account_title", "party_name", "party_tin", "debit", "credit",
      "general_reference", "proj_dept_code", "document_ref", "transaction_date", "particulars",
    ]);
  });

  test("screen rows render the same fields in the same order", () => {
    const tbody = src.slice(src.indexOf("<tbody>"), src.indexOf("</tbody>"));
    const fields = [...tbody.matchAll(/row\.([a-z_]+)/g)].map((m) => m[1]).filter((f) => f !== "line_id");
    const dedup = fields.filter((f, i) => fields.indexOf(f) === i);
    expect(dedup).toEqual([
      "account_code", "account_title", "party_name", "party_tin", "debit", "credit",
      "general_reference", "proj_dept_code", "document_ref", "transaction_date", "particulars",
    ]);
  });

  test("print uses the on-screen table itself (window.print), so its column order is identical", () => {
    expect(src).toMatch(/window\.print\(\)/);
    expect((src.match(/<table/g) || []).length).toBe(1);
  });

  test("debit/credit totals stay under the Debit and Credit columns (TOTAL spans the 4 columns before them)", () => {
    const tfoot = src.slice(src.indexOf("<tfoot>"), src.indexOf("</tfoot>"));
    expect(tfoot).toMatch(/colSpan=\{4\}/);
    const csvTotal = src.slice(src.indexOf("const totalRow"), src.indexOf("const csvRows"));
    expect(csvTotal).toMatch(/\[T\(""\), T\("TOTAL"\), T\(""\), T\(""\), N\(totals\.debit\), N\(totals\.credit\)/);
  });
});
