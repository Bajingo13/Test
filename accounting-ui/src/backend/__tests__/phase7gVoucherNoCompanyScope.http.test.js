const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7G: voucher/reference numbers are unique PER COMPANY, not globally.
// Composite UNIQUE(company_id, voucher_no) on every company-scoped header
// table (memo_headers also keys on memo_type). App-level pre-check returns
// 409 { code: "DUPLICATE_VOUCHER_NO" }; the DB index is the race backstop.

jest.setTimeout(180000);

let A, B, userId, token;
let accA1, accA2, accB1, accB2; // one debit + one credit account per company
let custA, custB;

async function mkCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function mkAccount(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  A = await mkCompany("PH7G Company A");
  B = await mkCompany("PH7G Company B");

  const hash = await bcrypt.hash("Ph7gPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7g_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, A]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, B]);
  token = (await request(app).post("/api/login").send({ username: "ph7g_admin", password: "Ph7gPass!1" })).body.token;

  const admin = { id: userId, roleCode: "ADMIN" };
  for (const co of [A, B]) {
    await CurrencyService.createCurrency(admin, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: co,
    });
  }
  accA1 = await mkAccount("PH7G-A-DR", "PH7G A Debit", "ASSET");
  accA2 = await mkAccount("PH7G-A-CR", "PH7G A Credit", "INCOME");
  accB1 = await mkAccount("PH7G-B-DR", "PH7G B Debit", "ASSET");
  accB2 = await mkAccount("PH7G-B-CR", "PH7G B Credit", "INCOME");
  const [ca] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'PH7G-CA', 'BOTH', 'PH7G Cust A', 'ACTIVE')", [A]);
  custA = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'PH7G-CB', 'BOTH', 'PH7G Cust B', 'ACTIVE')", [B]);
  custB = cb.insertId;
});

afterAll(async () => {
  for (const co of [A, B]) {
    for (const t of ["invoice", "apv", "or", "cv", "jv", "purchase_order", "petty_cash", "memo"]) {
      const h = `${t}_headers`;
      const lk = t === "purchase_order" ? "purchase_order_lines" : `${t}_lines`;
      const fk = t === "purchase_order" ? "purchase_order_id" : `${t.replace("purchase_order", "po")}_id`;
      try { await pool.query(`DELETE ln FROM ${lk} ln JOIN ${h} hd ON hd.id = ln.${t === "invoice" ? "invoice_id" : fk} WHERE hd.company_id = ?`, [co]); } catch (e) {}
      try { await pool.query(`DELETE FROM ${h} WHERE company_id = ?`, [co]); } catch (e) {}
    }
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [co]);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [A, B]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7G-%'");
  await pool.end();
});

// Minimal balanced 2-line body per module. Returns { route, method, body }.
function build(module, { companyId, voucherNo, id }) {
  const dr = companyId === A ? accA1 : accB1;
  const drCode = companyId === A ? "PH7G-A-DR" : "PH7G-B-DR";
  const cr = companyId === A ? accA2 : accB2;
  const crCode = companyId === A ? "PH7G-A-CR" : "PH7G-B-CR";
  const cust = companyId === A ? custA : custB;
  const custName = companyId === A ? "PH7G Cust A" : "PH7G Cust B";
  const lines = [
    { accountId: dr, accountCode: drCode, accountTitle: "DR", particulars: "x", genRef: "", genName: "", debit: 100, credit: 0 },
    { accountId: cr, accountCode: crCode, accountTitle: "CR", particulars: "x", genRef: "", genName: "", debit: 0, credit: 100 },
  ];
  const common = { voucherNo, transactionDate: "2026-11-15", referenceNo: voucherNo, description: "ph7g", status: "Draft", lines, totalDebit: 100, totalCredit: 100, currency: { companyId } };
  const M = {
    INV: { url: "invoices", body: { ...common, customerId: cust, customerName: custName } },
    APV: { url: "apv", body: { ...common, supplierId: cust, supplierName: custName } },
    OR: { url: "or", body: { ...common, customerId: cust, customerName: custName, receiptNo: voucherNo, paymentMethod: "Cash" } },
    CV: { url: "cv", body: { ...common, payeeId: cust, payeeName: custName, paymentMethod: "Check" } },
    JV: { url: "jv", body: { ...common, preparedFor: custName } },
    PO: { url: "purchase-orders", body: { ...common, supplierId: cust, supplierName: custName } },
    PCV: { url: "petty-cash", body: { ...common, payeeId: cust, payeeName: custName } },
    DM: { url: "debit-memos", body: { ...common, partyId: cust, partyName: custName, partyType: "CUSTOMER" } },
    CM: { url: "credit-memos", body: { ...common, partyId: cust, partyName: custName, partyType: "CUSTOMER" } },
  };
  const m = M[module];
  return { url: id ? `/api/${m.url}/${id}` : `/api/${m.url}`, method: id ? "put" : "post", body: m.body };
}

async function create(module, opts) {
  const b = build(module, opts);
  return request(app)[b.method](b.url).set("Authorization", `Bearer ${token}`).send(b.body);
}

const MODULES = ["INV", "APV", "OR", "CV", "JV", "PO", "PCV", "DM", "CM"];

describe("Phase 7G - voucher number is unique per company", () => {
  test.each(MODULES)("%s: Company A and Company B may both use the same voucher number", async (m) => {
    const vno = `PH7G-${m}-SHARED`;
    const rA = await create(m, { companyId: A, voucherNo: vno });
    const rB = await create(m, { companyId: B, voucherNo: vno });
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
  });

  test.each(MODULES)("%s: the same company cannot reuse a voucher number (409, not 500)", async (m) => {
    const vno = `PH7G-${m}-DUP`;
    const first = await create(m, { companyId: A, voucherNo: vno });
    expect(first.status).toBe(200);
    const second = await create(m, { companyId: A, voucherNo: vno });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("DUPLICATE_VOUCHER_NO");
    expect(second.body.message).toMatch(new RegExp(`${vno}.*already exists for this company`, "i"));
    expect(second.status).not.toBe(500);
  });
});

describe("Phase 7G - edit behavior (INV)", () => {
  test("editing a transaction without changing its voucher number succeeds", async () => {
    const c = await create("INV", { companyId: A, voucherNo: "PH7G-EDIT-SELF" });
    expect(c.status).toBe(200);
    const upd = await create("INV", { companyId: A, voucherNo: "PH7G-EDIT-SELF", id: c.body.id });
    expect(upd.status).toBe(200);
  });

  test("editing to another same-company voucher number that already exists fails with 409", async () => {
    const a = await create("INV", { companyId: A, voucherNo: "PH7G-EDIT-A" });
    const b = await create("INV", { companyId: A, voucherNo: "PH7G-EDIT-B" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const clash = await create("INV", { companyId: A, voucherNo: "PH7G-EDIT-A", id: b.body.id });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("a cross-company voucher number does not falsely conflict on edit", async () => {
    await create("INV", { companyId: B, voucherNo: "PH7G-XEDIT" });
    const a = await create("INV", { companyId: A, voucherNo: "PH7G-XEDIT-A" });
    const upd = await create("INV", { companyId: A, voucherNo: "PH7G-XEDIT", id: a.body.id });
    expect(upd.status).toBe(200); // A can use PH7G-XEDIT even though B has it
  });
});

describe("Phase 7G - whitespace normalization (pre-check AND persisted value)", () => {
  test("padded first, trimmed second -> 409, and the PERSISTED value is trimmed", async () => {
    const c = await create("INV", { companyId: A, voucherNo: "  PH7G-WS-1  " });
    expect(c.status).toBe(200);
    const [[row]] = await pool.query("SELECT voucher_no FROM invoice_headers WHERE id = ?", [c.body.id]);
    expect(row.voucher_no).toBe("PH7G-WS-1"); // stored trimmed, not "  PH7G-WS-1  "

    const dup = await create("INV", { companyId: A, voucherNo: "PH7G-WS-1" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("trimmed first, padded second (reverse order) -> also 409", async () => {
    const c = await create("INV", { companyId: A, voucherNo: "PH7G-WS-2" });
    expect(c.status).toBe(200);
    const dup = await create("INV", { companyId: A, voucherNo: "   PH7G-WS-2   " });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_VOUCHER_NO");
  });

  test("editing with a padded version of a transaction's own number does not self-conflict", async () => {
    const c = await create("INV", { companyId: A, voucherNo: "PH7G-WS-3" });
    const upd = await create("INV", { companyId: A, voucherNo: "  PH7G-WS-3  ", id: c.body.id });
    expect(upd.status).toBe(200);
    const [[row]] = await pool.query("SELECT voucher_no FROM invoice_headers WHERE id = ?", [c.body.id]);
    expect(row.voucher_no).toBe("PH7G-WS-3");
  });
});

describe("Phase 7G - DM and CM keep independent series within a company", () => {
  test("Company A can have DEBIT PH7G-MEMO-1 and CREDIT PH7G-MEMO-1", async () => {
    const dm = await create("DM", { companyId: A, voucherNo: "PH7G-MEMO-1" });
    const cm = await create("CM", { companyId: A, voucherNo: "PH7G-MEMO-1" });
    expect(dm.status).toBe(200);
    expect(cm.status).toBe(200);
    const dupDm = await create("DM", { companyId: A, voucherNo: "PH7G-MEMO-1" });
    expect(dupDm.status).toBe(409);
  });
});

describe("Phase 7G - company authorization still enforced", () => {
  test("a user cannot create against a company they do not belong to", async () => {
    const outHash = await bcrypt.hash("Ph7gOut!1", 10);
    const [o] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7g_out', ?, 2, 'ACTIVE')", [outHash]);
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [o.insertId, A]);
    const outToken = (await request(app).post("/api/login").send({ username: "ph7g_out", password: "Ph7gOut!1" })).body.token;

    const b = build("INV", { companyId: B, voucherNo: "PH7G-OUT-1" });
    const res = await request(app).post(b.url).set("Authorization", `Bearer ${outToken}`).send(b.body);
    expect(res.status).not.toBe(200); // resolveCompanyIdForWrite rejects the foreign companyId

    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [o.insertId]);
    await pool.query("DELETE FROM users WHERE id = ?", [o.insertId]);
  });
});

describe("Phase 7G - DB composite index blocks a race", () => {
  test("two concurrent creates of the same (company, voucher_no) -> exactly one succeeds", async () => {
    const vno = "PH7G-RACE-1";
    const [r1, r2] = await Promise.all([
      create("INV", { companyId: A, voucherNo: vno }),
      create("INV", { companyId: A, voucherNo: vno }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200);
    const conflicts = [r1, r2].filter((r) => r.status === 409);
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).not.toBe(500);
  });
});
