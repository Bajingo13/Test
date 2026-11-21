// Multi-Branch Phase C-2B - the server side of the transaction-entry workflow:
// the branch-aware unpaid APV / Invoice lookups the amount-field modal calls,
// branchId on list / view responses, and CV -> APV / OR -> Invoice applications
// saved through the real CV / OR routes (partial, full, multiple, over, wrong
// supplier / customer / branch, persisted and reloaded). Branch-on-create,
// isolation, reversal and the concurrency race are covered by the C-1 suite
// (multiBranchPhaseCBackend.http.test.js); conversions are re-checked here.
// Local test database only. Fixture prefix UAT-MBT-.
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-MBT-";
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
const api = (method, who, url, body) => { const r = request(app)[method](url).set(as(who)); return body === undefined ? r : r.send(body); };

async function roleId(code) { const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]); return r.id; }
async function mkCompany(tag, branches) {
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
  co[tag] = c.insertId; ids.companies.push(c.insertId);
  for (const [code, status = "ACTIVE"] of branches) {
    const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, ?)", [c.insertId, `${P}${code}`, `${P}${code}`, status]);
    br[code] = b.insertId;
  }
  await CurrencyService.createCurrency({ id: 0, roleCode: "SUPER_ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
    symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.insertId,
  });
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  ids.users.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function mkAccount(key, cls, validations = [], title = `${P}${key}`) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2097-01-01', ?, ?)", [`${P}${key}`, title, cls]);
  for (const v of validations) await pool.query("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${P}${key}` };
}
async function mkParty(key, companyId, type, branchId = null) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [companyId, `${P}${key}`, type, `${P}${key}`, branchId]);
  party[key] = { id: r.insertId, name: `${P}${key}`, type };
}
async function apv(branchId, supplierKey, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [co.A, branchId, `${P}${no}`, party[supplierKey].id, party[supplierKey].name, DATE, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : "Unpaid", status]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'x', ?, 0), (?, ?, ?, 'x', 0, ?)",
    [r.insertId, acc.EXP.id, acc.EXP.code, amount, r.insertId, acc.AP.id, acc.AP.code, amount]);
  return r.insertId;
}
async function invoice(branchId, customerKey, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [co.A, branchId, `${P}${no}`, party[customerKey].id, party[customerKey].name, DATE, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : "Unpaid", status]
  );
  await pool.query("INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, ?, 'x', ?, 0), (?, ?, ?, 'x', 0, ?)",
    [r.insertId, acc.AR.id, acc.AR.code, amount, r.insertId, acc.REV.id, acc.REV.code, amount]);
  return r.insertId;
}
const L = (key, debit, credit) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].code, particulars: "x", debit, credit });
function cvBody(supplierKey, amount, apvApplications, extra = {}) {
  const p = party[supplierKey]; const n = ++seq;
  return { voucherNo: `${P}CV-${n}`, referenceNo: `${P}CV-${n}`, transactionDate: DATE, description: "UAT-MBT", status: "Draft", paymentMethod: "Cash",
    payeeId: p.id, payeeName: p.name, supplierId: p.id, supplierName: p.name, partyId: p.id, partyName: p.name, partyType: p.type,
    lines: [L("AP", amount, 0), L("CASH", 0, amount)], totalDebit: amount, totalCredit: amount, currency: { companyId: co.A },
    apvApplications: apvApplications.map(([sourceId, a]) => ({ sourceType: "APV", sourceId, amount: a, appliedType: "CV", applicationDate: DATE })), ...extra };
}
function orBody(customerKey, amount, invoiceApplications, extra = {}) {
  const p = party[customerKey]; const n = ++seq;
  return { voucherNo: `${P}OR-${n}`, referenceNo: `${P}OR-${n}`, transactionDate: DATE, description: "UAT-MBT", status: "Draft", paymentMethod: "Cash",
    customerId: p.id, customerName: p.name, partyId: p.id, partyName: p.name, partyType: p.type,
    lines: [L("CASH", amount, 0), L("AR", 0, amount)], totalDebit: amount, totalCredit: amount, currency: { companyId: co.A },
    invoiceApplications: invoiceApplications.map(([sourceId, a]) => ({ sourceType: "INV", sourceId, amount: a, appliedType: "OR", applicationDate: DATE })), ...extra };
}
const unpaidApvs = (who, supplierKey, branchId) =>
  api("get", who, `/api/apv/unpaid?companyId=${co.A}&supplierId=${party[supplierKey].id}${branchId ? `&branchId=${branchId}` : ""}`);
const unpaidInvoices = (who, customerKey, branchId) =>
  api("get", who, `/api/invoices/unpaid?companyId=${co.A}&customerId=${party[customerKey].id}${branchId ? `&branchId=${branchId}` : ""}`);
const idsOf = (res) => (Array.isArray(res.body) ? res.body : []).map((r) => r.id);
const balanceOf = (res, id) => Number((res.body || []).find((r) => r.id === id)?.balanceAmount);

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkCompany("A", [["BA"], ["BB"], ["BC", "INACTIVE"]]);
  await mkCompany("B", [["B1"]]);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA", "ACCOUNTANT", [co.A], [br.BA]);
  await mkUser("acctAB", "ACCOUNTANT", [co.A], [br.BA, br.BB]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkAccount("CASH", "ASSET");
  await mkAccount("AR", "ASSET", ["AR CODE"], `${P}Accounts Receivable`); // Quotation -> Invoice picks the AR account by title
  await mkAccount("AP", "LIABILITY", ["AP CODE"]);
  await mkAccount("EXP", "EXPENSE");
  await mkAccount("REV", "INCOME");
  await mkParty("SUPA", co.A, "SUPPLIER", br.BA); // Branch A: Supplier A
  await mkParty("SUPB", co.A, "SUPPLIER", br.BB); // Branch B: Supplier B
  await mkParty("SUPS", co.A, "SUPPLIER");        // shared supplier
  await mkParty("CUSA", co.A, "CUSTOMER", br.BA);
  await mkParty("CUSS", co.A, "CUSTOMER");
  await mkParty("CUSS2", co.A, "CUSTOMER");
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const usersIn = ids.users.concat(0);
    await pool.query("DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM rfp_lines l JOIN rfp_headers r ON r.id = l.rfp_id WHERE r.company_id IN (?)", [cos]);
    await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    for (const [lines, fk, head] of [["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["jv_lines", "jv_id", "jv_headers"], ["quotation_lines", "quotation_id", "quotation_headers"]]) {
      await pool.query(`DELETE l FROM ${lines} l JOIN ${head} h ON h.id = l.${fk} WHERE h.company_id IN (?)`, [cos]).catch(() => {});
    }
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers", "quotation_headers"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, usersIn, `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
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
describe("CV -> APV: the lookup the amount-field modal calls", () => {
  let apv001, apv002, draft, voided, cancelled, reversed, paid;
  beforeAll(async () => {
    apv001 = await apv(br.BA, "SUPA", "APV-001", 10000);
    apv002 = await apv(br.BB, "SUPB", "APV-002", 20000);
    draft = await apv(br.BA, "SUPA", "APV-DRAFT", 500, { status: "Draft" });
    voided = await apv(br.BA, "SUPA", "APV-VOID", 500, { status: "Void" });
    cancelled = await apv(br.BA, "SUPA", "APV-CANCEL", 500, { status: "Cancelled" });
    reversed = await apv(br.BA, "SUPA", "APV-REV", 500);
    await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status, source_module, source_reference_id) VALUES (?, ?, ?, ?, 500, 500, 'Posted', 'APV_REVERSAL', ?)", [co.A, br.BA, `${P}JV-REV`, DATE, reversed]);
    paid = await apv(br.BA, "SUPA", "APV-PAID", 500, { paid: 500 });
  });

  test("Branch A + Supplier A lists APV-001 only (with its date); never Branch B's APV-002 or any ineligible APV", async () => {
    const res = await unpaidApvs("acctA", "SUPA", br.BA);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([apv001]);
    expect(res.body[0]).toMatchObject({ voucherNo: `${P}APV-001`, transactionDate: DATE });
    for (const hidden of [apv002, draft, voided, cancelled, reversed, paid]) expect(idsOf(res)).not.toContain(hidden);
  });

  test("an ADMIN with both branches sees each branch's APV only under that branch", async () => {
    expect(idsOf(await unpaidApvs("adminA", "SUPA", br.BA))).toEqual([apv001]);
    expect(idsOf(await unpaidApvs("adminA", "SUPB", br.BB))).toEqual([apv002]);
    expect(idsOf(await unpaidApvs("adminA", "SUPB", br.BA))).toEqual([]); // wrong supplier for the branch
  });

  test("the branch is validated by the server: another branch / another company's branch is refused", async () => {
    const other = await unpaidApvs("acctA", "SUPB", br.BB);
    expect([other.status, other.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const foreign = await unpaidApvs("adminA", "SUPA", br.B1);
    expect([foreign.status, foreign.body.code]).toEqual([403, "BRANCH_COMPANY_MISMATCH"]);
  });
});

// ===========================================================================
describe("CV -> APV applications saved through the CV routes", () => {
  let big, a3, a4, apvB;
  beforeAll(async () => {
    big = await apv(br.BA, "SUPA", "APV-BIG", 20000);
    a3 = await apv(br.BA, "SUPA", "APV-003", 15000);
    a4 = await apv(br.BA, "SUPA", "APV-004", 10000);
    apvB = await apv(br.BB, "SUPB", "APV-B", 5000);
  });

  test("partial payment: 8,000 of 20,000 leaves 12,000; it persists and reloads with the CV; 12,001 is refused; 12,000 settles it", async () => {
    const first = await api("post", "acctA", "/api/cv", cvBody("SUPA", 8000, [[big, 8000]]));
    expect(first.status).toBe(200);
    expect(balanceOf(await unpaidApvs("acctA", "SUPA", br.BA), big)).toBe(12000);
    const reload = await api("get", "acctA", `/api/cv/${first.body.id}?companyId=${co.A}`);
    expect(reload.status).toBe(200);
    expect(reload.body.branchId).toBe(br.BA);
    expect(reload.body.applications.map((a) => [Number(a.sourceId ?? a.source_id), Number(a.amount)])).toEqual([[big, 8000]]);
    const over = await api("post", "acctA", "/api/cv", cvBody("SUPA", 12001, [[big, 12001]]));
    expect([over.status, over.body.code]).toEqual([400, "APPLICATION_EXCEEDS_BALANCE"]);
    expect(over.body.message).toMatch(/cannot exceed APV balance of 12000.00/);
    expect((await api("post", "acctA", "/api/cv", cvBody("SUPA", 12000, [[big, 12000]]))).status).toBe(200);
    expect(idsOf(await unpaidApvs("acctA", "SUPA", br.BA))).not.toContain(big); // fully paid -> gone
  });

  test("multiple APVs in one CV (15,000 + 10,000 = 25,000)", async () => {
    const res = await api("post", "acctA", "/api/cv", cvBody("SUPA", 25000, [[a3, 15000], [a4, 10000]]));
    expect(res.status).toBe(200);
    const [rows] = await pool.query("SELECT source_id, amount FROM transaction_applications WHERE applied_type = 'CV' AND applied_id = ? ORDER BY source_id", [res.body.id]);
    expect(rows.map((r) => [r.source_id, Number(r.amount)])).toEqual([[a3, 15000], [a4, 10000]]);
  });

  test("wrong supplier and wrong branch are refused by the server; nothing is applied", async () => {
    const extra = await apv(br.BA, "SUPS", "APV-SHAREDSUP", 3000);
    const wrongSupplier = await api("post", "acctA", "/api/cv", cvBody("SUPA", 1000, [[extra, 1000]]));
    expect([wrongSupplier.status, wrongSupplier.body.message]).toEqual([400, expect.stringContaining("another supplier")]);
    // Branch B's own supplier cannot even be the payee of a Branch A CV ...
    const foreignPayee = await api("post", "acctAB", "/api/cv", cvBody("SUPB", 1000, [[apvB, 1000]], { branchId: br.BA }));
    expect([foreignPayee.status, foreignPayee.body.code]).toEqual([400, "PARTY_BRANCH_MISMATCH"]);
    // ... and a shared supplier's Branch B APV cannot be settled by a Branch A CV.
    const apvBShared = await apv(br.BB, "SUPS", "APV-B-SHARED", 4000);
    const wrongBranch = await api("post", "acctAB", "/api/cv", cvBody("SUPS", 1000, [[apvBShared, 1000]], { branchId: br.BA }));
    expect([wrongBranch.status, wrongBranch.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
    const [[n]] = await pool.query("SELECT COUNT(*) n FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?, ?, ?)", [extra, apvB, apvBShared]);
    expect(Number(n.n)).toBe(0);
  });
});

// ===========================================================================
describe("OR -> Invoice: lookup and applications through the OR routes", () => {
  let invA, invB, draft, voided, cancelled, paid, otherCustomer;
  beforeAll(async () => {
    invA = await invoice(br.BA, "CUSA", "INV-A", 30000);
    invB = await invoice(br.BB, "CUSS", "INV-B", 9000);
    draft = await invoice(br.BA, "CUSA", "INV-DRAFT", 500, { status: "Draft" });
    voided = await invoice(br.BA, "CUSA", "INV-VOID", 500, { status: "Void" });
    cancelled = await invoice(br.BA, "CUSA", "INV-CANCEL", 500, { status: "Cancelled" });
    paid = await invoice(br.BA, "CUSA", "INV-PAID", 500, { paid: 500 });
    otherCustomer = await invoice(br.BA, "CUSS2", "INV-OTHER", 4000);
  });

  test("Branch A + Customer A lists Invoice A only (Posted, open, same branch and customer)", async () => {
    const res = await unpaidInvoices("acctA", "CUSA", br.BA);
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([invA]);
    expect(res.body[0].transactionDate).toBe(DATE);
    for (const hidden of [invB, draft, voided, cancelled, paid, otherCustomer]) expect(idsOf(res)).not.toContain(hidden);
    expect((await unpaidInvoices("acctA", "CUSS", br.BB)).status).toBe(403);
  });

  test("partial, full and over-payment through the OR routes; Draft and wrong customer / branch refused", async () => {
    const part = await api("post", "acctA", "/api/or", orBody("CUSA", 10000, [[invA, 10000]]));
    expect(part.status).toBe(200);
    expect(balanceOf(await unpaidInvoices("acctA", "CUSA", br.BA), invA)).toBe(20000);
    expect((await api("post", "acctA", "/api/or", orBody("CUSA", 20000.5, [[invA, 20000.5]]))).status).toBe(400);
    expect((await api("post", "acctA", "/api/or", orBody("CUSA", 20000, [[invA, 20000]]))).status).toBe(200);
    expect(idsOf(await unpaidInvoices("acctA", "CUSA", br.BA))).not.toContain(invA);
    const draftPay = await api("post", "acctA", "/api/or", orBody("CUSA", 100, [[draft, 100]]));
    expect([draftPay.status, draftPay.body.message]).toEqual([400, expect.stringMatching(/is not Posted \(status: Draft\)/)]);
    const wrongCustomer = await api("post", "acctA", "/api/or", orBody("CUSA", 100, [[otherCustomer, 100]]));
    expect([wrongCustomer.status, wrongCustomer.body.message]).toEqual([400, expect.stringContaining("another customer")]);
    const wrongBranch = await api("post", "acctAB", "/api/or", orBody("CUSS", 100, [[invB, 100]], { branchId: br.BA }));
    expect([wrongBranch.status, wrongBranch.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
  });
});

// ===========================================================================
describe("branch on list / view responses", () => {
  test("lists and details carry branchId for the Branch column and detail line", async () => {
    const created = await api("post", "acctA", "/api/cv", cvBody("SUPA", 100, []));
    expect(created.status).toBe(200);
    const list = await api("get", "acctA", `/api/cv?companyId=${co.A}`);
    expect(list.body.find((r) => r.id === created.body.id).branchId).toBe(br.BA);
    expect((await api("get", "acctA", `/api/cv/${created.body.id}?companyId=${co.A}`)).body.branchId).toBe(br.BA);
    const inv = await api("get", "adminA", `/api/invoices?companyId=${co.A}`);
    expect(inv.body.every((r) => Object.prototype.hasOwnProperty.call(r, "branchId"))).toBe(true);
  });

  test("an accountant with two branches must choose; one with one branch gets it automatically", async () => {
    const choose = await api("post", "acctAB", "/api/cv", cvBody("SUPS", 100, []));
    expect([choose.status, choose.body.code]).toEqual([400, "BRANCH_REQUIRED"]);
    const auto = await api("post", "acctA", "/api/cv", cvBody("SUPS", 100, []));
    expect((await pool.query("SELECT branch_id FROM cv_headers WHERE id = ?", [auto.body.id]))[0][0].branch_id).toBe(br.BA);
    const inactive = await api("post", "adminA", "/api/cv", cvBody("SUPS", 100, [], { branchId: br.BC }));
    expect(inactive.body.code).toBe("BRANCH_INACTIVE");
  });
});

// ===========================================================================
describe("conversions keep the source document's branch", () => {
  test("Quotation (Branch B) -> Invoice (Branch B), no branch switching", async () => {
    const q = await api("post", "adminA", "/api/quotations", {
      companyId: co.A, branchId: br.BB, customerId: party.CUSS.id, customerName: party.CUSS.name, quotationDate: DATE, status: "Draft", totalAmount: 100,
      lines: [{ lineType: "item", description: "svc", quantity: 1, unitPrice: 100, amount: 100, accountId: acc.REV.id, accountCode: acc.REV.code }],
    });
    expect(q.status).toBe(200);
    const conv = await api("post", "adminA", `/api/quotations/${q.body.id}/convert-to-invoice`, { companyId: co.A, branchId: br.BA });
    expect(conv.status).toBe(200);
    const invoiceId = conv.body.invoiceId ?? conv.body.id;
    const [[row]] = await pool.query("SELECT branch_id FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(row.branch_id).toBe(br.BB);
  });

  test("RFP (Branch A) -> APV (Branch A); a Branch-B-only user cannot reach the RFP", async () => {
    await mkUser("acctB", "ACCOUNTANT", [co.A], [br.BB]);
    const [[cur]] = await pool.query("SELECT id FROM currencies WHERE company_id = ? AND currency_code = 'PHP'", [co.A]);
    const [h] = await pool.query(
      `INSERT INTO rfp_headers (company_id, branch_id, rfp_no, rfp_date, requester_user_id, supplier_id, supplier_name, purpose, requested_payment_date, currency_id, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UAT-MBT rent', ?, ?, 500, 'APPROVED')`,
      [co.A, br.BA, `${P}RFP-1`, DATE, usr.adminA.id, party.SUPA.id, party.SUPA.name, DATE, cur.id]
    );
    await pool.query("INSERT INTO rfp_lines (rfp_id, description, account_id, gross_amount, vat_treatment) VALUES (?, 'rent', ?, 500, 'EXEMPT')", [h.insertId, acc.EXP.id]);
    expect((await api("post", "acctB", `/api/rfp/${h.insertId}/convert`, { apvDate: DATE, apAccountId: acc.AP.id })).status).toBe(404);
    const ok = await api("post", "acctA", `/api/rfp/${h.insertId}/convert`, { apvDate: DATE, apAccountId: acc.AP.id });
    expect(ok.status).toBe(200);
    expect((await pool.query("SELECT branch_id FROM apv_headers WHERE id = ?", [ok.body.apv.id]))[0][0].branch_id).toBe(br.BA);
  });
});
