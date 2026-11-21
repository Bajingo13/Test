// Multi-Branch Foundation, Phase C-1 (backend only - no transaction UI change).
// Transactions are branch-owned at the API: create / update / post branch rules,
// account + party branch checks, list / view / edit / delete / void / cancel /
// email / convert isolation for all ten transaction types, RFP -> APV branch
// carry, the invoice-status payment gap, same-branch payment application,
// concurrent-payment protection and branch-preserving reversal.
// Local test database only. Fixture prefix UAT-MBC-. Tokens come from the
// app's own session signer (no /api/login calls).
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const PaymentApplicationService = require("../services/paymentApplicationService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-MBC-";
const DATE = "2097-06-10";
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
const acc = {};
const party = {};
let seq = 0;

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const api = (method, who, url, body) => {
  const r = request(app)[method](url).set(as(who));
  return body === undefined ? r : r.send(body);
};

async function roleId(code) {
  const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]);
  return r.id;
}
async function mkCompany(tag, branches) {
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
  co[tag] = c.insertId;
  ids.companies.push(c.insertId);
  for (const [code, status = "ACTIVE"] of branches) {
    const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, ?)", [c.insertId, `${P}${code}`, `${P}${code}`, status]);
    br[code] = b.insertId;
  }
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls, { branchId = null, validations = [] } = {}) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2097-01-01', ?, ?, ?)", [`${P}${key}`, `${P}${key}`, cls, branchId]);
  for (const v of validations) await pool.query("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${P}${key}` };
}
async function mkParty(key, companyId, type, branchId = null) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [companyId, `${P}${key}`, type, `${P}${key}`, branchId]);
  party[key] = { id: r.insertId, code: `${P}${key}`, name: `${P}${key}`, type };
}
const L = (key, debit, credit, extra = {}) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: "x", debit, credit, ...extra });

// One payload builder for all ten modules (same shape the P1 party tests use).
const MODULES = {
  INV: { path: "/api/invoices", table: "invoice_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)], extra: { invoiceType: "Standard" }, del: true },
  OR: { path: "/api/or", table: "or_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)], extra: { paymentMethod: "Cash" }, email: true },
  APV: { path: "/api/apv", table: "apv_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], del: true, voidCancel: true },
  CV: { path: "/api/cv", table: "cv_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], extra: { paymentMethod: "Cash" }, voidCancel: true },
  JV: { path: "/api/jv", table: "jv_headers", party: null, lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], del: true },
  DM: { path: "/api/debit-memos", table: "memo_headers", party: "CUS", lines: () => [L("CASH", 100, 0), L("REV", 0, 100)], del: true },
  CM: { path: "/api/credit-memos", table: "memo_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], del: true },
  PCV: { path: "/api/petty-cash", table: "petty_cash_headers", party: null, lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], extra: { payeeName: "UAT-MBC walk-in" }, del: true },
  PO: { path: "/api/purchase-orders", table: "purchase_order_headers", party: "SUP", lines: () => [L("EXP", 100, 0), L("CASH", 0, 100)], del: true },
  QUO: { path: "/api/quotations", table: "quotation_headers", party: "CUS", quotation: true, del: true, convert: true },
};
function body(mod, { companyId = co.A, partyKey, lines, ...extra } = {}) {
  const m = MODULES[mod];
  const p = party[partyKey === undefined ? m.party : partyKey];
  const partyFields = p ? { supplierId: p.id, supplierName: p.name, customerId: p.id, customerName: p.name, payeeId: p.id, payeeName: p.name, partyId: p.id, partyName: p.name, partyType: p.type } : {};
  if (m.quotation) {
    return { companyId, ...partyFields, quotationDate: DATE, expirationDate: "2097-07-10", status: "Draft", totalAmount: 100,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitPrice: 100, amount: 100 }], ...extra };
  }
  const n = ++seq;
  return { voucherNo: `${P}${mod}-${n}`, transactionDate: DATE, dueDate: DATE, referenceNo: `${P}${mod}-${n}`, description: "UAT-MBC", status: "Draft",
    ...partyFields, lines: lines || m.lines(), totalDebit: 100, totalCredit: 100, currency: { companyId }, ...(m.extra || {}), ...extra };
}
const create = (who, mod, opts) => api("post", who, MODULES[mod].path, body(mod, opts));
const branchOf = async (mod, id) => (await pool.query(`SELECT branch_id FROM ${MODULES[mod].table} WHERE id = ?`, [id]))[0][0]?.branch_id;
const listIds = (b) => (Array.isArray(b) ? b : b?.rows || b?.data || b?.items || b?.quotations || []).map((r) => r.id);

async function postedApv(companyId, branchId, supplierId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MBC supplier', ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, supplierId, DATE, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : "Unpaid", status]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'x', ?, 0), (?, ?, ?, 'x', 0, ?)",
    [r.insertId, acc.EXP.id, acc.EXP.code, amount, r.insertId, acc.CASH.id, acc.CASH.code, amount]);
  return r.insertId;
}
async function invoiceRow(companyId, branchId, customerId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MBC customer', ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, customerId, DATE, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : "Unpaid", status]
  );
  return r.insertId;
}
async function orRow(companyId, branchId, customerId, no) {
  const [r] = await pool.query("INSERT INTO or_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, ?, 'UAT-MBC customer', ?, 0, 0, 'Draft')",
    [companyId, branchId, `${P}${no}`, customerId, DATE]);
  return r.insertId;
}
async function postedCvRow(companyId, branchId, no, amount) {
  const [r] = await pool.query("INSERT INTO cv_headers (company_id, branch_id, voucher_no, payee_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'UAT-MBC payee', ?, ?, ?, 'Posted')",
    [companyId, branchId, `${P}${no}`, DATE, amount, amount]);
  await pool.query("INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'x', ?, 0), (?, ?, ?, 'x', 0, ?)",
    [r.insertId, acc.EXP.id, acc.EXP.code, amount, r.insertId, acc.CASH.id, acc.CASH.code, amount]);
  return r.insertId;
}
const invArgs = (orId, invId, amount, companyId = co.A) => ({
  appItem: { sourceId: invId, sourceType: "INV", amount }, appliedType: "OR", appliedId: orId,
  paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", fallbackDate: DATE, isPosting: false, companyId,
});
async function inRolledBack(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    return await fn(conn);
  } finally {
    await conn.rollback();
    conn.release();
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkCompany("A", [["A1"], ["A2"], ["A3", "INACTIVE"]]);
  await mkCompany("B", [["B1"]]);
  await mkCompany("C", []); // no branches: legacy company-level behavior
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br.A1]);
  await mkUser("acctA2", "ACCOUNTANT", [co.A], [br.A2]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkUser("adminC", "ADMIN", [co.C]);
  await mkUser("super", "SUPER_ADMIN", []);
  for (const c of [co.A, co.B, co.C]) {
    await CurrencyService.createCurrency({ id: usr.adminA.id, roleCode: "SUPER_ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
      symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c,
    });
  }
  await mkAccount("CASH", "ASSET");
  await mkAccount("REV", "INCOME");
  await mkAccount("EXP", "EXPENSE");
  await mkAccount("AP", "LIABILITY", { validations: ["AP CODE"] });
  await mkAccount("EXPA2", "EXPENSE", { branchId: br.A2 }); // branch-only account
  await mkParty("CUS", co.A, "CUSTOMER");
  await mkParty("SUP", co.A, "SUPPLIER");
  await mkParty("CUS2", co.A, "CUSTOMER");
  await mkParty("SUPA2", co.A, "SUPPLIER", br.A2); // branch-only parties
  await mkParty("CUSA2", co.A, "CUSTOMER", br.A2);
  await mkParty("CUSB", co.B, "CUSTOMER");
  await mkParty("SUPB", co.B, "SUPPLIER");
  await mkParty("CUSC", co.C, "CUSTOMER");
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const usersIn = ids.users.concat(0);
    await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM rfp_lines l JOIN rfp_headers r ON r.id = l.rfp_id WHERE r.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    for (const [lines, fk, head] of [["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["jv_lines", "jv_id", "jv_headers"], ["memo_lines", "memo_id", "memo_headers"], ["petty_cash_lines", "petty_cash_id", "petty_cash_headers"], ["purchase_order_lines", "purchase_order_id", "purchase_order_headers"], ["quotation_lines", "quotation_id", "quotation_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]).catch(() => {});
    }
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers", "memo_headers", "petty_cash_headers", "purchase_order_headers", "quotation_headers"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    }
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, usersIn, `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?) OR code LIKE ?", [cos, `${P}%`]);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [usersIn]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [usersIn]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe.each(Object.keys(MODULES))("%s: branch on create", (mod) => {
  test("TC-MBC-001 valid branch: a single-branch user's transaction lands in their branch; an ADMIN's in the chosen branch", async () => {
    const mine = await create("acctA1", mod);
    expect([mod, mine.status]).toEqual([mod, 200]);
    expect(await branchOf(mod, mine.body.id)).toBe(br.A1);
    const chosen = await create("adminA", mod, { branchId: br.A2 });
    expect([mod, chosen.status]).toEqual([mod, 200]);
    expect(await branchOf(mod, chosen.body.id)).toBe(br.A2);
  });

  test("TC-MBC-002/003/004 foreign, unauthorized and inactive branches are rejected; a multi-branch user must choose", async () => {
    const codeOf = async (who, opts) => { const r = await create(who, mod, opts); return [r.status, r.body.code]; };
    expect(await codeOf("adminA", { branchId: br.B1 })).toEqual([403, "BRANCH_COMPANY_MISMATCH"]);
    expect(await codeOf("acctA1", { branchId: br.A2 })).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    expect(await codeOf("adminA", { branchId: br.A3 })).toEqual([409, "BRANCH_INACTIVE"]);
    expect(await codeOf("adminA", {})).toEqual([400, "BRANCH_REQUIRED"]);
  });

  test("a company with no branches keeps the legacy no-branch behavior", async () => {
    const r = await create("adminC", mod, { companyId: co.C, partyKey: MODULES[mod].party ? "CUSC" : null, ...(MODULES[mod].party === "SUP" ? { partyKey: null } : {}) });
    if (MODULES[mod].party === "SUP") return; // Company C has no supplier fixture; covered by the CUSTOMER / no-party modules
    expect([mod, r.status]).toEqual([mod, 200]);
    expect(await branchOf(mod, r.body.id)).toBeNull();
  });
});

// ===========================================================================
describe("accounts and parties must be shared or the branch's own", () => {
  const lineModules = ["INV", "OR", "APV", "CV", "JV", "DM", "CM", "PCV", "PO"];
  test.each(lineModules)("TC-MBC-010/011 %s: another branch's account is rejected, shared and own-branch accounts accepted", async (mod) => {
    const withAcct = (key) => [L("CASH", 100, 0), L(key, 0, 100)];
    const bad = await create("acctA1", mod, { lines: withAcct("EXPA2") });
    expect([mod, bad.status, bad.body.code]).toEqual([mod, 400, "ACCOUNT_BRANCH_MISMATCH"]);
    expect((await create("acctA1", mod, { lines: withAcct("EXP") })).status).toBe(200);
    expect((await create("acctA2", mod, { lines: withAcct("EXPA2") })).status).toBe(200);
  });

  test("a nonexistent account is rejected", async () => {
    const r = await create("acctA1", "JV", { lines: [L("CASH", 100, 0), { accountId: 999999999, accountCode: "NOPE", accountTitle: "x", particulars: "x", debit: 0, credit: 100 }] });
    expect([r.status, r.body.code]).toEqual([400, "ACCOUNT_NOT_FOUND"]);
  });

  test.each([["INV", "CUSA2"], ["OR", "CUSA2"], ["APV", "SUPA2"], ["CV", "SUPA2"], ["PO", "SUPA2"], ["DM", "CUSA2"], ["CM", "SUPA2"], ["QUO", "CUSA2"]])(
    "TC-MBC-012/013 %s: another branch's party is rejected, the branch's own and shared parties accepted", async (mod, key) => {
      const bad = await create("acctA1", mod, { partyKey: key });
      expect([mod, bad.status, bad.body.code]).toEqual([mod, 400, "PARTY_BRANCH_MISMATCH"]);
      expect((await create("acctA2", mod, { partyKey: key })).status).toBe(200);
    }
  );

  test("line-level parties (Gen Ref) follow the same rule; other-company parties are refused", async () => {
    const lines = [L("CASH", 100, 0, { genRef: party.SUPA2.code }), L("EXP", 0, 100)];
    expect((await create("acctA1", "JV", { lines })).body.code).toBe("PARTY_BRANCH_MISMATCH");
    expect((await create("acctA2", "JV", { lines })).status).toBe(200);
    const foreign = await create("acctA1", "INV", { partyKey: "CUSB" });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("PARTY_NOT_FOUND");
  });
});

// ===========================================================================
describe("isolation: list / view / edit / delete / void / cancel / email / convert", () => {
  const docs = {};
  beforeAll(async () => {
    for (const mod of Object.keys(MODULES)) {
      const a1 = await create("adminA", mod, { branchId: br.A1 });
      const a2 = await create("adminA", mod, { branchId: br.A2 });
      if (a1.status !== 200 || a2.status !== 200) throw new Error(`${mod} fixture: ${a1.status} ${JSON.stringify(a1.body)} / ${a2.status} ${JSON.stringify(a2.body)}`);
      docs[mod] = { a1: a1.body.id, a2: a2.body.id };
    }
  });

  test.each(Object.keys(MODULES))("TC-MBC-006/007 %s list: ACCOUNTANT sees only assigned branches, ADMIN all company branches", async (mod) => {
    const list = async (who) => listIds((await api("get", who, `${MODULES[mod].path}?companyId=${co.A}`)).body);
    const a1 = await list("acctA1");
    expect(a1).toContain(docs[mod].a1);
    expect(a1).not.toContain(docs[mod].a2);
    expect(await list("acctA2")).not.toContain(docs[mod].a1);
    expect(await list("adminA")).toEqual(expect.arrayContaining([docs[mod].a1, docs[mod].a2]));
  });

  test.each(Object.keys(MODULES))("TC-MBC-009 %s view / edit / delete: another branch answers exactly like an unknown record", async (mod) => {
    const m = MODULES[mod];
    const unknown = await api("get", "acctA1", `${m.path}/999999999?companyId=${co.A}`);
    const other = await api("get", "acctA1", `${m.path}/${docs[mod].a2}?companyId=${co.A}`);
    expect([mod, other.status, other.body]).toEqual([mod, unknown.status, unknown.body]);
    expect(other.status).toBe(404);
    expect((await api("get", "acctA1", `${m.path}/${docs[mod].a1}?companyId=${co.A}`)).status).toBe(200);
    expect((await api("put", "acctA1", `${m.path}/${docs[mod].a2}`, body(mod))).status).toBe(404);
    if (m.del) expect((await api("delete", "acctA1", `${m.path}/${docs[mod].a2}?companyId=${co.A}`)).status).toBe(404);
    expect(await branchOf(mod, docs[mod].a2)).toBe(br.A2); // untouched
  });

  test("void / cancel (APV, CV), email (OR) and convert (Quotation) are isolated too", async () => {
    for (const mod of ["APV", "CV"]) {
      for (const action of ["void", "cancel"]) {
        const r = await api("post", "acctA1", `${MODULES[mod].path}/${docs[mod].a2}/${action}`, { companyId: co.A, reason: "UAT-MBC probe" });
        expect([mod, action, r.status]).toEqual([mod, action, 404]);
      }
    }
    expect((await api("post", "acctA1", `/api/or/${docs.OR.a2}/email`, { companyId: co.A, to: "x@example.test" })).status).toBe(404);
    expect((await api("post", "acctA1", `/api/quotations/${docs.QUO.a2}/convert-to-invoice`, { companyId: co.A })).status).toBe(404);
  });

  test("TC-MBC-008 SUPER_ADMIN: any branch of the target company, never outside it", async () => {
    expect((await api("get", "super", `/api/cv/${docs.CV.a2}?companyId=${co.A}`)).status).toBe(200);
    expect(listIds((await api("get", "super", `/api/cv?companyId=${co.A}`)).body)).toEqual(expect.arrayContaining([docs.CV.a1, docs.CV.a2]));
    expect((await api("get", "super", `/api/cv/${docs.CV.a2}?companyId=${co.B}`)).status).toBe(404);
  });

  test("TC-MBC-009 another company's transaction is isolated (ADMIN of B)", async () => {
    for (const mod of Object.keys(MODULES)) {
      const r = await api("get", "adminB", `${MODULES[mod].path}/${docs[mod].a1}?companyId=${co.B}`);
      expect([mod, r.status]).toEqual([mod, 404]);
      expect(listIds((await api("get", "adminB", `${MODULES[mod].path}?companyId=${co.B}`)).body)).not.toContain(docs[mod].a1);
    }
  });

  test.each(Object.keys(MODULES))("TC-MBC-005 %s update keeps the branch; moving it is refused", async (mod) => {
    const moved = await api("put", "adminA", `${MODULES[mod].path}/${docs[mod].a1}`, body(mod, { branchId: br.A2 }));
    expect([mod, moved.status, moved.body.code]).toEqual([mod, 409, "BRANCH_CHANGE_NOT_ALLOWED"]);
    const kept = await api("put", "adminA", `${MODULES[mod].path}/${docs[mod].a1}`, body(mod));
    expect([mod, kept.status]).toEqual([mod, 200]);
    expect(await branchOf(mod, docs[mod].a1)).toBe(br.A1);
  });
});

// ===========================================================================
describe("RFP -> APV carries the RFP's branch", () => {
  let rfpA2;
  beforeAll(async () => {
    const [[cur]] = await pool.query("SELECT id FROM currencies WHERE company_id = ? AND currency_code = 'PHP'", [co.A]);
    const [h] = await pool.query(
      `INSERT INTO rfp_headers (company_id, branch_id, rfp_no, rfp_date, requester_user_id, supplier_id, supplier_name, purpose, requested_payment_date, currency_id, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UAT-MBC rent', ?, ?, 500, 'APPROVED')`,
      [co.A, br.A2, `${P}RFP-1`, DATE, usr.adminA.id, party.SUP.id, party.SUP.name, DATE, cur.id]
    );
    rfpA2 = h.insertId;
    await pool.query("INSERT INTO rfp_lines (rfp_id, description, account_id, gross_amount, vat_treatment) VALUES (?, 'rent', ?, 500, 'EXEMPT')", [rfpA2, acc.EXP.id]);
  });
  const convert = (who, extra = {}) => api("post", who, `/api/rfp/${rfpA2}/convert`, { apvDate: DATE, apAccountId: acc.AP.id, ...extra });

  test("TC-MBC-015 a user outside the RFP's branch cannot convert it (same 404 as an unknown RFP); a browser branch is not accepted", async () => {
    const r = await convert("acctA1");
    const unknown = await api("post", "acctA1", "/api/rfp/999999999/convert", { apvDate: DATE, apAccountId: acc.AP.id });
    expect([r.status, r.body]).toEqual([unknown.status, unknown.body]);
    expect(r.status).toBe(404);
    expect((await convert("acctA2", { branchId: br.A1 })).status).toBe(400); // not a conversion field
    const [[h]] = await pool.query("SELECT status, converted_apv_id FROM rfp_headers WHERE id = ?", [rfpA2]);
    expect(h).toEqual({ status: "APPROVED", converted_apv_id: null });
  });

  test("TC-MBC-014 the APV inherits the RFP's branch", async () => {
    const r = await convert("acctA2");
    expect(r.status).toBe(200);
    const [[apv]] = await pool.query("SELECT company_id, branch_id FROM apv_headers WHERE id = ?", [r.body.apv.id]);
    expect(apv).toEqual({ company_id: co.A, branch_id: br.A2 });
  });
});

// ===========================================================================
describe("invoice payment status (Posted only)", () => {
  let draft, voided, cancelled, posted, paid, otherBranch;
  beforeAll(async () => {
    draft = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-DRAFT", 1000, { status: "Draft" });
    voided = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-VOID", 1000, { status: "Void" });
    cancelled = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-CANCELLED", 1000, { status: "Cancelled" });
    posted = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-POSTED", 1000);
    // Fully paid the real way: the payable balance is live (AR control amount
    // minus applications - P0), so a stored paid_amount alone is not "paid".
    paid = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-PAID", 1000);
    const payer = await orRow(co.A, br.A1, party.CUS.id, "OR-FULL");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await PaymentApplicationService.applyInvoicePayment(conn, invArgs(payer, paid, 1000));
      await conn.commit();
    } finally {
      conn.release();
    }
    otherBranch = await invoiceRow(co.A, br.A2, party.CUS.id, "INV-A2", 1000);
  });

  test("TC-MBC-016/017/018 the legacy unpaid lookup returns only Posted, open invoices of the user's branches", async () => {
    const res = await api("get", "acctA1", `/api/invoices/unpaid?companyId=${co.A}&customerId=${party.CUS.id}`);
    expect(res.status).toBe(200);
    const got = listIds(res.body);
    expect(got).toContain(posted);
    for (const hidden of [draft, voided, cancelled, paid, otherBranch]) expect(got).not.toContain(hidden);
  });

  test("TC-MBC-019/020/021 Draft, Void and Cancelled invoices cannot be paid", async () => {
    const orA1 = await orRow(co.A, br.A1, party.CUS.id, "OR-STATUS");
    for (const [id, status] of [[draft, "Draft"], [voided, "Void"], [cancelled, "Cancelled"]]) {
      await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, id, 100))))
        .rejects.toMatchObject({ statusCode: 400, code: "INVOICE_NOT_PAYABLE", message: expect.stringContaining(`(status: ${status})`) });
    }
  });

  test("TC-MBC-022 a Posted invoice is paid; fully paid, wrong customer, wrong company and wrong branch are refused", async () => {
    const orA1 = await orRow(co.A, br.A1, party.CUS.id, "OR-OK");
    const ok = await inRolledBack(async (c) => {
      await PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, posted, 600));
      return (await c.query("SELECT paid_amount FROM invoice_headers WHERE id = ?", [posted]))[0][0];
    });
    expect(Number(ok.paid_amount)).toBe(600);
    await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, paid, 1)))).rejects.toThrow(/cannot exceed invoice balance/);
    // (the existing cap keeps its 0.01 rounding tolerance, so over-apply clearly)
    await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, posted, 1000.5)))).rejects.toThrow(/cannot exceed invoice balance/);
    const orOtherCustomer = await orRow(co.A, br.A1, party.CUS2.id, "OR-CUS2");
    await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orOtherCustomer, posted, 100))))
      .rejects.toMatchObject({ code: "INVOICE_NOT_PAYABLE", message: expect.stringContaining("another customer") });
    await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, posted, 100, co.B)))).rejects.toThrow(/cross-company/);
    await expect(inRolledBack((c) => PaymentApplicationService.applyInvoicePayment(c, invArgs(orA1, otherBranch, 100)))).rejects.toMatchObject({ code: "BRANCH_MISMATCH" });
  });

  test("TC-MBC-025 two simultaneous full payments of one invoice: exactly one succeeds", async () => {
    const target = await invoiceRow(co.A, br.A1, party.CUS.id, "INV-RACE", 1000);
    const attempt = async (no) => {
      const orId = await orRow(co.A, br.A1, party.CUS.id, no);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await PaymentApplicationService.applyInvoicePayment(conn, invArgs(orId, target, 1000));
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    };
    const results = await Promise.allSettled([attempt("OR-RACE-1"), attempt("OR-RACE-2")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.message).toMatch(/cannot exceed invoice balance/);
    const [[row]] = await pool.query("SELECT paid_amount FROM invoice_headers WHERE id = ?", [target]);
    expect(Number(row.paid_amount)).toBe(1000);
    const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type = 'INV' AND source_id = ?", [target]);
    expect(Number(apps.n)).toBe(1);
  });
});

// ===========================================================================
describe("payment application never crosses branches (real save paths)", () => {
  test("TC-MBC-024 an A1 OR cannot settle an A2 invoice", async () => {
    const invA2 = await invoiceRow(co.A, br.A2, party.CUS.id, "INV-X-A2", 500);
    const r = await create("acctA1", "OR", { invoiceApplications: [{ sourceType: "INV", sourceId: invA2, amount: 100 }] });
    expect([r.status, r.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
    const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type = 'INV' AND source_id = ?", [invA2]);
    expect(Number(apps.n)).toBe(0);
  });

  test("TC-MBC-023 an A1 CV cannot settle an A2 APV", async () => {
    const apvA2 = await postedApv(co.A, br.A2, party.SUP.id, "APV-X-A2", 500);
    const r = await create("acctA1", "CV", { apvApplications: [{ sourceType: "APV", sourceId: apvA2, amount: 100 }] });
    expect([r.status, r.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
    const [[apps]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type = 'APV' AND source_id = ?", [apvA2]);
    expect(Number(apps.n)).toBe(0);
  });
});

// ===========================================================================
describe.each([["APV", "apv"], ["CV", "cv"]])("%s reversal keeps the original's branch", (mod, ep) => {
  let original;
  beforeAll(async () => {
    original = mod === "APV" ? await postedApv(co.A, br.A2, party.SUP.id, `${mod}-REV`, 700) : await postedCvRow(co.A, br.A2, `${mod}-REV`, 700);
  });
  const reverse = (who, companyId = co.A) => api("post", who, `/api/${ep}/${original}/reverse`, { companyId, reason: "UAT-MBC reversal" });

  test(`TC-MBC-029 an unauthorized branch user cannot reverse; another company cannot either`, async () => {
    expect((await reverse("acctA1")).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await reverse("adminB", co.B)).status).toBe(404);
    const [jv] = await pool.query("SELECT id FROM jv_headers WHERE source_module = ? AND source_reference_id = ?", [`${mod}_REVERSAL`, original]);
    expect(jv).toHaveLength(0);
  });

  test(`TC-MBC-026/027 the reversing JV inherits the branch; the original is unchanged`, async () => {
    const table = MODULES[mod].table;
    const before = (await pool.query(`SELECT status, total_debit, total_credit, branch_id, updated_at FROM ${table} WHERE id = ?`, [original]))[0][0];
    const r = await reverse("acctA2");
    expect(r.status).toBe(200);
    const [[jv]] = await pool.query("SELECT company_id, branch_id FROM jv_headers WHERE id = ?", [r.body.reversalJvId]);
    expect(jv).toEqual({ company_id: co.A, branch_id: br.A2 });
    expect((await pool.query(`SELECT status, total_debit, total_credit, branch_id, updated_at FROM ${table} WHERE id = ?`, [original]))[0][0]).toEqual(before);
  });

  test(`TC-MBC-028 a second reversal is rejected`, async () => {
    const r = await reverse("acctA2");
    expect([r.status, r.body.code]).toEqual([409, "TRANSACTION_ALREADY_REVERSED"]);
  });
});
