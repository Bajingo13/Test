// P1 (TEST CASE 1: TC1-022, TC1-090b, accountant report "all the customers are
// showing in CV and APV"): server-side party rules.
//
//   AR  Invoice / Official Receipt / Quotation -> CUSTOMER
//   AP  APV / Check Voucher / Purchase Order   -> SUPPLIER
//   Debit / Credit Memo -> CUSTOMER or SUPPLIER; party_type stored from the
//       General Library row, never the client
//   missing / unknown / other-company / wrong-type party -> 400, nothing saved
//   General Library: code, name and a known type are required (400, not 500)
// Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "p1pv-";
const ACC = "P1PV-";
let A, B, token, userId;
const party = {};
const acc = {};
let seq = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });

async function mkAccount(key, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, `P1PV ${key}`, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { accountId: r.insertId, accountCode: `${ACC}${key}`, accountTitle: `P1PV ${key}` };
}
async function mkParty(key, companyId, type) {
  const [r] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [companyId, `${P}${key}`, type, `P1PV ${key}`]);
  party[key] = { id: r.insertId, name: `P1PV ${key}`, type };
}
const L = (key, debit, credit) => ({ ...acc[key], particulars: key, genRef: "", genName: "", debit, credit });
const MODULES = {
  INV: { path: "/api/invoices", table: "invoice_headers", ok: "CUS", wrong: "SUP", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)], extra: { invoiceType: "Standard" } },
  OR: { path: "/api/or", table: "or_headers", ok: "CUS", wrong: "SUP", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)], extra: { paymentMethod: "Cash" } },
  APV: { path: "/api/apv", table: "apv_headers", ok: "SUP", wrong: "CUS", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
  CV: { path: "/api/cv", table: "cv_headers", ok: "SUP", wrong: "CUS", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)], extra: { paymentMethod: "Cash" } },
  PO: { path: "/api/purchase-orders", table: "purchase_order_headers", ok: "SUP", wrong: "CUS", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
  DM: { path: "/api/debit-memos", table: "memo_headers", ok: "CUS", wrong: "EMP", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)] },
  CM: { path: "/api/credit-memos", table: "memo_headers", ok: "SUP", wrong: "EMP", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
};
function body(mod, partyKey, extraOverride = {}) {
  const m = MODULES[mod];
  const p = partyKey ? party[partyKey] : null;
  const lines = m.lines();
  return {
    voucherNo: `${P}${mod}-${++seq}`, transactionDate: "2097-06-10", dueDate: "2097-06-10", referenceNo: `${P}${mod}-${seq}`, description: "p1", status: "Draft",
    ...(p ? { supplierId: p.id, supplierName: p.name, customerId: p.id, customerName: p.name, payeeId: p.id, payeeName: p.name, partyId: p.id, partyName: p.name, partyType: p.type } : {}),
    lines, totalDebit: 100, totalCredit: 100, currency: { companyId: A }, ...(m.extra || {}), ...extraOverride,
  };
}
const count = async (table) => (await pool.execute(`SELECT COUNT(*) n FROM ${table} WHERE company_id = ?`, [A]))[0][0].n;

beforeAll(async () => {
  assertNotProductionDatabase();
  A = (await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}A`]))[0].insertId;
  B = (await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}B`]))[0].insertId;
  await pool.execute("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [A]);
  await mkAccount("BANK", "ASSET", ["BANK / CASH"]);
  await mkAccount("REV", "INCOME");
  await mkAccount("EXP", "EXPENSE");
  await mkParty("CUS", A, "CUSTOMER");
  await mkParty("SUP", A, "SUPPLIER");
  await mkParty("EMP", A, "EMPLOYEE");
  await mkParty("CUS-B", B, "CUSTOMER");
  const hash = await bcrypt.hash("P1PvPass!1", 10);
  userId = (await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ADMIN'), 'ACTIVE')", [`${P}acct`, hash]))[0].insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, A]);
  const res = await request(app).post("/api/login").send({ username: `${P}acct`, password: "P1PvPass!1" });
  token = res.body.token;
});

afterAll(async () => {
  try {
    for (const [lines, fk, hdr] of [["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["purchase_order_lines", "po_id", "purchase_order_headers"], ["memo_lines", "memo_id", "memo_headers"], ["quotation_lines", "quotation_id", "quotation_headers"]]) {
      await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [[A, B]]).catch(() => {});
    }
    await pool.query("DELETE FROM invoice_verifications WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [[A, B]]).catch(() => {});
    for (const t of ["invoice_headers", "or_headers", "apv_headers", "cv_headers", "purchase_order_headers", "memo_headers", "quotation_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "currencies"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [[A, B]]).catch(() => {});
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [[A, B]]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

describe.each(Object.keys(MODULES))("%s party rule", (mod) => {
  const m = MODULES[mod];
  test("missing party -> 400 PARTY_REQUIRED (Draft too), nothing saved", async () => {
    const before = await count(m.table);
    const res = await request(app).post(m.path).set(auth()).send(body(mod, null));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTY_REQUIRED");
    expect(await count(m.table)).toBe(before);
  });
  test("wrong party type -> 400 PARTY_TYPE_NOT_ALLOWED, nothing saved", async () => {
    const before = await count(m.table);
    const res = await request(app).post(m.path).set(auth()).send(body(mod, m.wrong));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTY_TYPE_NOT_ALLOWED");
    expect(await count(m.table)).toBe(before);
  });
  test("another company's party -> 400 PARTY_NOT_FOUND", async () => {
    const res = await request(app).post(m.path).set(auth()).send(body(mod, "CUS-B"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTY_NOT_FOUND");
  });
  test("valid party saves; editing it to a wrong-type party -> 400", async () => {
    const ok = await request(app).post(m.path).set(auth()).send(body(mod, m.ok));
    expect(ok.status).toBe(200);
    const edit = await request(app).put(`${m.path}/${ok.body.id}`).set(auth()).send(body(mod, m.wrong));
    expect(edit.status).toBe(400);
    expect(edit.body.code).toBe("PARTY_TYPE_NOT_ALLOWED");
  });
});

test("memo party_type comes from the General Library, not the client", async () => {
  const res = await request(app).post("/api/debit-memos").set(auth()).send(body("DM", "SUP", { partyType: "CUSTOMER" }));
  expect(res.status).toBe(200);
  const [[row]] = await pool.execute("SELECT party_type FROM memo_headers WHERE id = ?", [res.body.id]);
  expect(row.party_type).toBe("SUPPLIER");
});

test("quotation requires a customer of this company", async () => {
  const q = (c) => request(app).post("/api/quotations").set(auth()).send({
    companyId: A, ...(c ? { customerId: c.id, customerName: c.name } : { customerName: "walk-in" }), quotationDate: "2097-06-10", expirationDate: "2097-07-10",
    status: "Draft", lines: [{ lineType: "item", description: "Service", quantity: 1, unitPrice: 100, amount: 100 }],
  });
  expect((await q(null)).body.code).toBe("PARTY_REQUIRED");
  expect((await q(party.SUP)).body.code).toBe("PARTY_TYPE_NOT_ALLOWED");
  expect((await q(party.CUS)).status).toBe(200);
});

describe("General Library validation (TC1-022)", () => {
  const g = (over) => request(app).post("/api/genlib").set(auth()).send({ companyId: A, code: `${P}G-${++seq}`, type: "CUSTOMER", name: "P1PV G", ...over });
  test("blank name -> 400 GENLIB_NAME_REQUIRED", async () => {
    const r = await g({ name: "   " });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("GENLIB_NAME_REQUIRED");
  });
  test("missing code -> 400; unknown type -> 400", async () => {
    expect((await g({ code: "" })).body.code).toBe("GENLIB_CODE_REQUIRED");
    expect((await g({ type: "VENDOR" })).body.code).toBe("GENLIB_TYPE_INVALID");
  });
  test("only code / type / name (optional fields omitted) saves - no 500", async () => {
    const r = await g({});
    expect(r.status).toBe(200);
    const edit = await request(app).put(`/api/genlib/${r.body.id}`).set(auth()).send({ companyId: A, code: `${P}G-EDIT`, type: "CUSTOMER", name: "" });
    expect(edit.status).toBe(400);
    expect(edit.body.code).toBe("GENLIB_NAME_REQUIRED");
  });
});
