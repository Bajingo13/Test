// RFP (Request for Payment) R5: APPROVED -> CONVERTED with a new Draft APV
// over HTTP - the APV is built by the same createApvRecord the APV page
// uses, in the RFP's stored company, inside one transaction with the RFP
// lock, link, history and audit. Covers permissions, every invalid status,
// company isolation, duplicate / concurrent conversion, field mapping, no
// accounting side effects, and rollback when APV creation fails.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const TaxEntryService = require("../services/taxEntryService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "rfpr5-";
const ACC = "RFPR5-";
const PASSWORD = "RfpR5Pass!1";
const UNKNOWN_ID = 2147483000;
const APV_DATE = "2097-05-10";

const co = {};
const cur = {};
const sup = {};
const acc = {};
const users = {};
const tokens = {};

async function makeUser(tag, roleCode, companyIds = [], overrides = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [moduleKey, action, granted] of overrides) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'rfp r5 test' FROM permissions WHERE module_key = ? AND action = ?`,
      [u.insertId, granted, moduleKey, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [`${ACC}${key}`, title, cls]
  );
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = r.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const act = (who, id, action, body) => request(app).post(`/api/rfp/${id}/${action}`).set(auth(who)).send(body);
const convert = (who, id, body = {}) => act(who, id, "convert", { apvDate: APV_DATE, apAccountId: acc.AP, ...body });

function rfpBody(company = "A", overrides = {}) {
  return {
    companyId: co[company],
    rfpDate: "2097-05-01",
    supplierId: sup[company],
    purpose: "Office rent and supplies",
    requestedPaymentDate: "2097-05-31",
    currencyId: cur[company],
    supportingReference: "SI-7781",
    remarks: "Pay before month end",
    lines: [
      { description: "Office rent", grossAmount: "1120.00", accountId: acc.RENT, vatTreatment: "STANDARD", reference: "LEASE-5" },
      { description: "Supplies", grossAmount: "250.25", accountId: acc.SUPPLIES, vatTreatment: "EXEMPT" },
    ],
    ...overrides,
  };
}

async function draft(who = "acctA", company = "A", overrides = {}) {
  const res = await request(app).post("/api/rfp").set(auth(who)).send(rfpBody(company, overrides));
  if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

// acctA (or the given requester) creates + submits; an independent admin approves.
async function approved(requester = "acctA", company = "A", overrides = {}) {
  const id = await draft(requester, company, overrides);
  let res = await act(requester, id, "submit");
  if (res.status !== 200) throw new Error(`submit: ${res.status} ${JSON.stringify(res.body)}`);
  res = await act(company === "A" ? "adminA" : "adminB", id, "approve");
  if (res.status !== 200) throw new Error(`approve: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

async function header(id) {
  const [[row]] = await pool.query(
    "SELECT rfp_no, company_id, status, converted_apv_id, converted_by, converted_at FROM rfp_headers WHERE id = ?",
    [id]
  );
  return row;
}

async function history(id) {
  const [rows] = await pool.query("SELECT previous_status, new_status, action, user_id, note FROM rfp_status_history WHERE rfp_id = ? ORDER BY id", [id]);
  return rows;
}

async function convertAudits(id) {
  const [rows] = await pool.query(
    `SELECT module, entity_type, entity_id, action, company_id, user_id, before_data, after_data, description
     FROM audit_logs WHERE module = 'TRANSACTIONS.RFP' AND entity_id = ? AND action = 'CONVERT_TO_APV' ORDER BY id`,
    [id]
  );
  return rows.map((r) => ({
    ...r,
    before_data: typeof r.before_data === "string" ? JSON.parse(r.before_data) : r.before_data,
    after_data: typeof r.after_data === "string" ? JSON.parse(r.after_data) : r.after_data,
  }));
}

async function setStatus(id, status) {
  await pool.execute("UPDATE rfp_headers SET status = ? WHERE id = ?", [status, id]);
}

// Everything a conversion could conceivably touch beyond the one APV.
async function sideEffects() {
  const ids = Object.values(co);
  const [[row]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM apv_headers WHERE company_id IN (?)) apv,
            (SELECT COUNT(*) FROM apv_headers WHERE company_id IN (?) AND UPPER(status) <> 'DRAFT') apvNotDraft,
            (SELECT COUNT(*) FROM jv_headers WHERE company_id IN (?)) jv,
            (SELECT COUNT(*) FROM cv_headers WHERE company_id IN (?)) cv,
            (SELECT COUNT(*) FROM or_headers WHERE company_id IN (?)) orh,
            (SELECT COUNT(*) FROM invoice_headers WHERE company_id IN (?)) inv,
            (SELECT COUNT(*) FROM transaction_applications) app,
            (SELECT COUNT(*) FROM bank_recon_matches) recon,
            (SELECT COUNT(*) FROM transaction_tax_entries WHERE company_id IN (?)) tax`,
    [ids, ids, ids, ids, ids, ids, ids]
  );
  return row;
}

async function apvCount() {
  return (await sideEffects()).apv;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
      [co[tag]]
    );
    cur[tag] = k.insertId;
    const [s] = await pool.execute(
      "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', ?, '123-456-789-000', 'ACTIVE')",
      [co[tag], `${P}sup${tag}`, `Supplier ${tag}`]
    );
    sup[tag] = s.insertId;
  }

  await mkAccount("RENT", "Rent Expense", "EXPENSE");
  await mkAccount("SUPPLIES", "Office Supplies Expense", "EXPENSE");
  await mkAccount("MISC", "Miscellaneous Expense", "EXPENSE");
  await mkAccount("AP", "Accounts Payable - Trade", "LIABILITY", ["AP CODE"]);
  await mkAccount("NOTAP", "Accrued Liabilities", "LIABILITY");
  await mkAccount("IVAT", "Input VAT", "ASSET", ["INPUT VAT"]);

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctA2", "ACCOUNTANT", [co.A]);
  await makeUser("adminB", "ADMIN", [co.B]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  // RFP CONVERT explicitly denied
  await makeUser("noConvertA", "ACCOUNTANT", [co.A], [["TRANSACTIONS.RFP", "CONVERT", 0]]);
  // RFP CONVERT but APV CREATE denied
  await makeUser("noApvCreateA", "ACCOUNTANT", [co.A], [["TRANSACTIONS.APV", "CREATE", 0]]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_tax_entries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE ln FROM apv_lines ln JOIN apv_headers h ON h.id = ln.apv_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM accounting_periods WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

describe("successful conversion", () => {
  test("APPROVED -> CONVERTED: one Draft APV in the RFP's company, linked, one history row, one audit row", async () => {
    const id = await approved();
    const before = await sideEffects();
    const res = await convert("acctA2", id);
    expect(res.status).toBe(200);
    const h = await header(id);
    expect(res.body).toMatchObject({
      id, rfpNo: h.rfp_no, companyId: co.A, previousStatus: "APPROVED", status: "CONVERTED", convertedBy: users.acctA2,
      apv: { voucherNo: `APV-${h.rfp_no}`, status: "Draft", companyId: co.A, totalAmount: "1370.25" },
    });
    expect(res.body.convertedAt).toBeTruthy();

    expect(h).toMatchObject({ status: "CONVERTED", converted_apv_id: res.body.apv.id, converted_by: users.acctA2 });
    expect(h.converted_at).toBeInstanceOf(Date);

    const [[apv]] = await pool.query("SELECT id, company_id, voucher_no, status FROM apv_headers WHERE id = ?", [h.converted_apv_id]);
    expect(apv).toMatchObject({ id: res.body.apv.id, company_id: co.A, voucher_no: `APV-${h.rfp_no}`, status: "Draft" });

    expect((await history(id)).map((r) => r.action)).toEqual(["SUBMIT", "APPROVE", "CONVERT_TO_APV"]);
    expect((await history(id))[2]).toEqual({
      previous_status: "APPROVED", new_status: "CONVERTED", action: "CONVERT_TO_APV", user_id: users.acctA2, note: `APV APV-${h.rfp_no}`,
    });

    const audits = await convertAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ module: "TRANSACTIONS.RFP", entity_type: "RFP", action: "CONVERT_TO_APV", company_id: co.A, user_id: users.acctA2 });
    expect(audits[0].before_data).toMatchObject({ rfpNo: h.rfp_no, companyId: co.A, status: "APPROVED" });
    expect(audits[0].after_data).toMatchObject({
      rfpNo: h.rfp_no, companyId: co.A, previousStatus: "APPROVED", status: "CONVERTED",
      apvId: apv.id, apvVoucherNo: apv.voucher_no, apvStatus: "Draft", convertedBy: users.acctA2,
    });
    expect(JSON.stringify(audits[0])).not.toMatch(/password|token|secret/i);

    const after = await sideEffects();
    expect(after).toEqual({ ...before, apv: before.apv + 1 });
  });

  test("APV fields are carried from the RFP, not copied blindly", async () => {
    const id = await approved("acctA", "A", { lines: [
      { description: "Office rent", grossAmount: "1120.00", accountId: acc.RENT, vatTreatment: "STANDARD", reference: "LEASE-5" },
      { description: "Supplies", grossAmount: "250.25", accountId: acc.SUPPLIES, vatTreatment: "EXEMPT" },
      { description: "Courier", grossAmount: "80.00", accountId: acc.MISC },
    ] });
    const res = await convert("adminA", id, { voucherNo: "APV-R5-MAP-1" });
    expect(res.status).toBe(200);
    const h = await header(id);

    const [[apv]] = await pool.query(
      `SELECT company_id, voucher_no, supplier_id, supplier_name, DATE_FORMAT(transaction_date, '%Y-%m-%d') transaction_date,
              DATE_FORMAT(due_date, '%Y-%m-%d') due_date, reference_no, description, remarks, total_debit, total_credit,
              paid_amount, balance_amount, payment_status, status, source_po_id, atc_code, tax_withheld_amount, payee_tin, currency_id
       FROM apv_headers WHERE id = ?`,
      [res.body.apv.id]
    );
    expect(apv).toMatchObject({
      company_id: co.A, voucher_no: "APV-R5-MAP-1", supplier_id: sup.A, supplier_name: "Supplier A",
      transaction_date: APV_DATE, due_date: "2097-05-31", reference_no: "SI-7781", description: "Office rent and supplies",
      total_debit: "1450.25", total_credit: "1450.25", paid_amount: "0.00", balance_amount: "1450.25",
      payment_status: "Unpaid", status: "Draft", source_po_id: null, atc_code: null, tax_withheld_amount: null,
      payee_tin: null, currency_id: cur.A,
    });
    expect(apv.remarks).toContain(`Converted from Request for Payment ${h.rfp_no} (requested by ${P}acctA)`);
    expect(apv.remarks).toContain("record VAT and withholding on this APV before posting");
    expect(apv.remarks).toContain("RFP remarks: Pay before month end");

    const [lines] = await pool.query(
      "SELECT account_id, account_code, particulars, debit, credit, gen_ref, gen_name FROM apv_lines WHERE apv_id = ? ORDER BY id",
      [res.body.apv.id]
    );
    expect(lines).toEqual([
      { account_id: acc.RENT, account_code: `${ACC}RENT`, particulars: "Office rent | Ref LEASE-5 | VAT standard (gross, VAT not yet split)", debit: "1120.00", credit: "0.00", gen_ref: "", gen_name: "" },
      { account_id: acc.SUPPLIES, account_code: `${ACC}SUPPLIES`, particulars: "Supplies | VAT exempt", debit: "250.25", credit: "0.00", gen_ref: "", gen_name: "" },
      { account_id: acc.MISC, account_code: `${ACC}MISC`, particulars: "Courier", debit: "80.00", credit: "0.00", gen_ref: "", gen_name: "" },
      { account_id: acc.AP, account_code: `${ACC}AP`, particulars: "Accounts Payable - Supplier A", debit: "0.00", credit: "1450.25", gen_ref: `${P}supA`, gen_name: "Supplier A" },
    ]);

    // Draft only: no tax entries, unlocked currency snapshot, APV CREATE audit in the same company.
    const [[tax]] = await pool.query("SELECT COUNT(*) n FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?", [res.body.apv.id]);
    expect(tax.n).toBe(0);
    const [[snap]] = await pool.query("SELECT company_id, rate_locked, currency_code FROM transaction_currency_snapshots WHERE transaction_type = 'APV' AND transaction_id = ?", [res.body.apv.id]);
    expect(snap).toMatchObject({ company_id: co.A, rate_locked: 0, currency_code: "PHP" });
    const [apvAudits] = await pool.query("SELECT module, action, company_id FROM audit_logs WHERE entity_type = 'APV' AND entity_id = ?", [res.body.apv.id]);
    expect(apvAudits).toEqual([{ module: "TRANSACTIONS", action: "CREATE", company_id: co.A }]);
  });

  test("GET shows the APV reference; the RFP is no longer editable, deletable or actionable", async () => {
    const id = await approved();
    const conv = await convert("adminA", id, { voucherNo: "APV-R5-GET-1" });
    expect(conv.status).toBe(200);

    const got = await request(app).get(`/api/rfp/${id}`).set(auth("acctA"));
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      status: "CONVERTED", convertedApvId: conv.body.apv.id, convertedApvNo: "APV-R5-GET-1", convertedApvStatus: "Draft",
      convertedBy: users.adminA, convertedByUsername: `${P}adminA`,
    });

    expect((await request(app).put(`/api/rfp/${id}`).set(auth("acctA")).send(rfpBody())).status).toBe(409);
    expect((await request(app).delete(`/api/rfp/${id}`).set(auth("acctA"))).status).toBe(409);
    for (const route of ["submit", "cancel"]) expect((await act("acctA", id, route)).status).toBe(409);
    for (const route of ["approve", "return", "reject"]) expect((await act("adminA", id, route, { note: "x" })).status).toBe(409);
    expect((await header(id)).status).toBe("CONVERTED");
  });

  test("lines without an account are given one at conversion (only those lines)", async () => {
    const id = await approved("acctA", "A", { lines: [
      { description: "Rent", grossAmount: "100.00", accountId: acc.RENT },
      { description: "Unclassified", grossAmount: "40.00" },
    ] });
    const [[noAcct]] = await pool.query("SELECT id FROM rfp_lines WHERE rfp_id = ? AND account_id IS NULL", [id]);
    const [[withAcct]] = await pool.query("SELECT id FROM rfp_lines WHERE rfp_id = ? AND account_id IS NOT NULL", [id]);

    let res = await convert("adminA", id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Line 2 has no account/);

    res = await convert("adminA", id, { lineAccounts: { [withAcct.id]: acc.MISC, [noAcct.id]: acc.MISC } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already has its approved account/);

    res = await convert("adminA", id, { lineAccounts: { [noAcct.id]: acc.IVAT } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/VAT \/ withholding control account/);
    expect((await header(id)).status).toBe("APPROVED");

    res = await convert("adminA", id, { voucherNo: "APV-R5-LA-1", lineAccounts: { [noAcct.id]: acc.MISC } });
    expect(res.status).toBe(200);
    const [lines] = await pool.query("SELECT account_id, debit FROM apv_lines WHERE apv_id = ? AND debit > 0 ORDER BY id", [res.body.apv.id]);
    expect(lines).toEqual([{ account_id: acc.RENT, debit: "100.00" }, { account_id: acc.MISC, debit: "40.00" }]);
  });
});

describe("permissions", () => {
  test("without RFP CONVERT -> 403, nothing changes", async () => {
    const id = await approved();
    const before = await apvCount();
    expect((await convert("noConvertA", id)).status).toBe(403);
    expect((await header(id)).status).toBe("APPROVED");
    expect(await apvCount()).toBe(before);
  });

  test("RFP CONVERT without APV CREATE -> 403 (conversion is not a way around APV rights)", async () => {
    const id = await approved();
    const before = await apvCount();
    const res = await convert("noApvCreateA", id);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not have permission to create/);
    expect((await header(id)).status).toBe("APPROVED");
    expect(await apvCount()).toBe(before);
    expect(await convertAudits(id)).toEqual([]);
  });

  test("Accountant (default CONVERT) may convert; the requester is not blocked from converting", async () => {
    const id = await approved();
    expect((await convert("acctA", id, { voucherNo: "APV-R5-REQ-1" })).status).toBe(200);
  });
});

describe("invalid states", () => {
  test.each(["DRAFT", "SUBMITTED", "RETURNED", "REJECTED", "CANCELLED"])("%s -> 409, status unchanged, nothing created", async (status) => {
    const id = await approved();
    await setStatus(id, status);
    const before = await sideEffects();
    const histBefore = await history(id);
    const res = await convert("adminA", id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Only an APPROVED Request for Payment can be converted/);
    expect(await header(id)).toMatchObject({ status, converted_apv_id: null, converted_by: null, converted_at: null });
    expect(await history(id)).toEqual(histBefore);
    expect(await convertAudits(id)).toEqual([]);
    expect(await sideEffects()).toEqual(before);
  });

  test("CONVERTED -> 409 on a second conversion; no second APV", async () => {
    const id = await approved();
    const first = await convert("adminA", id, { voucherNo: "APV-R5-TWICE-1" });
    expect(first.status).toBe(200);
    const before = await sideEffects();
    const second = await convert("adminA", id, { voucherNo: "APV-R5-TWICE-2" });
    expect(second.status).toBe(409);
    expect(await sideEffects()).toEqual(before);
    expect((await header(id)).converted_apv_id).toBe(first.body.apv.id);
    expect((await history(id)).filter((r) => r.action === "CONVERT_TO_APV")).toHaveLength(1);
    expect(await convertAudits(id)).toHaveLength(1);
  });
});

describe("company isolation", () => {
  test("Company B users cannot convert Company A's RFP - the same 404 as an unknown id", async () => {
    const id = await approved();
    const before = await apvCount();
    const cross = await convert("adminB", id);
    const unknown = await convert("adminB", UNKNOWN_ID);
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect((await convert("acctB", id)).status).toBe(404);
    expect((await header(id)).status).toBe("APPROVED");
    expect(await apvCount()).toBe(before);
  });

  test("Super Admin converts an accessible RFP; APV and audit carry the RFP's company", async () => {
    const id = await approved("acctB", "B");
    const res = await convert("super", id, { voucherNo: "APV-R5-SUPER-1" });
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(co.B);
    const [[apv]] = await pool.query("SELECT company_id FROM apv_headers WHERE id = ?", [res.body.apv.id]);
    expect(apv.company_id).toBe(co.B);
    const audits = await convertAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ company_id: co.B, user_id: users.super });
  });

  test("a client-supplied company cannot redirect the APV; other APV fields cannot be injected", async () => {
    const id = await approved();
    const before = await sideEffects();
    for (const extra of [{ companyId: co.B }, { companyId: "abc" }]) {
      expect((await convert("super", id, extra)).status).toBe(400);
    }
    for (const extra of [{ currency: { companyId: co.B } }, { status: "Posted" }, { lines: [] }, { supplierId: sup.B }, { totalCredit: 1 }]) {
      const res = await convert("adminA", id, extra);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unsupported field/);
    }
    expect(await sideEffects()).toEqual(before);
    expect((await header(id)).status).toBe("APPROVED");

    // Echoing the RFP's own company is harmless.
    const ok = await convert("adminA", id, { companyId: co.A, voucherNo: "APV-R5-ECHO-1" });
    expect(ok.status).toBe(200);
    const [[apv]] = await pool.query("SELECT company_id FROM apv_headers WHERE id = ?", [ok.body.apv.id]);
    expect(apv.company_id).toBe(co.A);
  });
});

describe("validation", () => {
  test.each([
    ["missing APV date", { apvDate: undefined }, /APV date is required/],
    ["bad APV date", { apvDate: "2097-02-31" }, /APV date must be a valid date/],
    ["missing AP account", { apAccountId: undefined }, /Accounts Payable account is required/],
    ["unknown AP account", { apAccountId: UNKNOWN_ID }, /Accounts Payable account not found/],
    ["AP account not flagged AP CODE", { apAccountId: "NOTAP" }, /must be flagged "AP CODE"/],
    ["voucher number too long", { voucherNo: "X".repeat(51) }, /at most 50 characters/],
  ])("%s -> 400", async (_label, patch, message) => {
    const id = await approved();
    const body = { apvDate: APV_DATE, apAccountId: acc.AP, ...patch };
    if (patch.apAccountId === "NOTAP") body.apAccountId = acc.NOTAP;
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const res = await act("adminA", id, "convert", body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect((await header(id)).status).toBe("APPROVED");
  });
});

describe("concurrency", () => {
  test("two simultaneous conversions of one RFP -> exactly one APV, one history row, one audit row", async () => {
    const id = await approved();
    const before = await apvCount();
    const results = await Promise.all([
      convert("adminA", id, { voucherNo: "APV-R5-RACE-1" }),
      convert("acctA2", id, { voucherNo: "APV-R5-RACE-2" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200);
    expect(await apvCount()).toBe(before + 1);
    expect((await header(id)).converted_apv_id).toBe(winner.body.apv.id);
    const [[apv]] = await pool.query("SELECT id FROM apv_headers WHERE id = ?", [winner.body.apv.id]);
    expect(apv.id).toBe(winner.body.apv.id);
    const [losers] = await pool.query("SELECT id FROM apv_headers WHERE company_id = ? AND voucher_no IN ('APV-R5-RACE-1', 'APV-R5-RACE-2')", [co.A]);
    expect(losers).toHaveLength(1);
    expect((await history(id)).filter((r) => r.action === "CONVERT_TO_APV")).toHaveLength(1);
    expect(await convertAudits(id)).toHaveLength(1);
  });

  test("two RFPs racing for the same APV number -> one succeeds, the other 409 and stays APPROVED", async () => {
    const a = await approved();
    const b = await approved();
    const results = await Promise.all([
      convert("adminA", a, { voucherNo: "APV-R5-SAMENO" }),
      convert("acctA2", b, { voucherNo: "APV-R5-SAMENO" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [rows] = await pool.query("SELECT id FROM apv_headers WHERE company_id = ? AND voucher_no = 'APV-R5-SAMENO'", [co.A]);
    expect(rows).toHaveLength(1);
    const statuses = [(await header(a)).status, (await header(b)).status].sort();
    expect(statuses).toEqual(["APPROVED", "CONVERTED"]);
  });
});

describe("rollback", () => {
  test("duplicate APV number -> 409, RFP stays APPROVED, nothing written", async () => {
    const first = await approved();
    expect((await convert("adminA", first, { voucherNo: "APV-R5-DUP" })).status).toBe(200);
    const id = await approved();
    const before = await sideEffects();
    const res = await convert("adminA", id, { voucherNo: "APV-R5-DUP" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/);
    expect(await header(id)).toMatchObject({ status: "APPROVED", converted_apv_id: null });
    expect((await history(id)).filter((r) => r.action === "CONVERT_TO_APV")).toEqual([]);
    expect(await convertAudits(id)).toEqual([]);
    expect(await sideEffects()).toEqual(before);
  });

  test("APV date in a CLOSED accounting period -> 409 from the APV rules, nothing written", async () => {
    const id = await approved();
    await pool.execute(
      "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2097, 6, '2097-06-01', '2097-06-30', 'CLOSED')",
      [co.A]
    );
    try {
      const before = await sideEffects();
      const res = await convert("adminA", id, { apvDate: "2097-06-15", voucherNo: "APV-R5-CLOSED" });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/closed/i);
      expect(await header(id)).toMatchObject({ status: "APPROVED", converted_apv_id: null });
      expect(await convertAudits(id)).toEqual([]);
      expect(await sideEffects()).toEqual(before);
    } finally {
      await pool.execute("DELETE FROM accounting_periods WHERE company_id = ?", [co.A]);
    }
  });

  test("a failure after the APV rows are inserted rolls everything back (safe 500)", async () => {
    const id = await approved();
    const before = await sideEffects();
    const [[maxApv]] = await pool.query("SELECT COALESCE(MAX(id), 0) m FROM apv_headers");
    const spy = jest.spyOn(TaxEntryService, "saveTaxEntries").mockRejectedValueOnce(new Error("simulated failure after APV insert"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await convert("adminA", id, { voucherNo: "APV-R5-BOOM" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: "Failed to convert the Request for Payment to an APV" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    const [[apvAfter]] = await pool.query("SELECT COUNT(*) n FROM apv_headers WHERE id > ?", [maxApv.m]);
    expect(apvAfter.n).toBe(0);
    const [[orphanLines]] = await pool.query("SELECT COUNT(*) n FROM apv_lines WHERE apv_id > ?", [maxApv.m]);
    expect(orphanLines.n).toBe(0);
    expect(await header(id)).toMatchObject({ status: "APPROVED", converted_apv_id: null, converted_by: null });
    expect((await history(id)).filter((r) => r.action === "CONVERT_TO_APV")).toEqual([]);
    expect(await convertAudits(id)).toEqual([]);
    expect(await sideEffects()).toEqual(before);

    // The same RFP converts normally afterwards.
    expect((await convert("adminA", id, { voucherNo: "APV-R5-BOOM" })).status).toBe(200);
  });
});

describe("lookups", () => {
  test("accounts carry AP-control / tax-control flags for the conversion dialog", async () => {
    const res = await request(app).get(`/api/rfp/lookups?companyId=${co.A}`).set(auth("acctA"));
    expect(res.status).toBe(200);
    const byId = new Map(res.body.accounts.map((a) => [a.id, a]));
    expect(byId.get(acc.AP)).toMatchObject({ isApControl: true, isTaxControl: false });
    expect(byId.get(acc.IVAT)).toMatchObject({ isApControl: false, isTaxControl: true });
    expect(byId.get(acc.RENT)).toMatchObject({ isApControl: false, isTaxControl: false });
  });
});
