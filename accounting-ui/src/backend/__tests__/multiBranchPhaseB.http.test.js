// Multi-Branch Foundation, Phase B (backend only - no transaction-entry UI).
// COA code reuse across branches (and never double counting), General Library
// company-scoped codes + branch isolation, transaction-entry pre-checks
// (branch, accounts, party, applications, reversal), branch-aware CV reversal
// and consolidated Income Statement / Balance Sheet scope.
// Local test database only. Fixture prefix UAT-MBB-. Tokens come from the app's
// own session signer (no /api/login calls).
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const FinancialStatementService = require("../services/financialStatementService");
const { coaByCodeSql } = require("../services/coaLookupService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "UAT-MBB-";
const ids = { companies: [], users: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
let supplierA, customerA, sharedSupplier;

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const get = (who, url) => request(app).get(url).set(as(who));
const post = (who, url, body) => request(app).post(url).set(as(who)).send(body);

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
async function party(companyId, type, code, branchId = null) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [companyId, `${P}${code}`, type, `${P}${code}`, branchId]);
  return r.insertId;
}
async function coa(code, title, cls, branchId = null) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2026-01-01', ?, ?, ?)", [code, title, cls, branchId]);
  return r.insertId;
}
async function apv(companyId, branchId, supplierId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MBB supplier', '2026-11-02', ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, supplierId, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : paid ? "Partially Paid" : "Unpaid", status]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_code, account_title, debit, credit) VALUES (?, 'UAT-MBB-6000', 'Expense', ?, 0), (?, 'UAT-MBB-2000', 'AP', 0, ?)", [r.insertId, amount, r.insertId, amount]);
  return r.insertId;
}
async function invoice(companyId, branchId, customerId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MBB customer', '2026-11-02', ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, customerId, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : paid ? "Partially Paid" : "Unpaid", status]
  );
  return r.insertId;
}
async function postedCv(companyId, branchId, no, amount) {
  const [r] = await pool.query("INSERT INTO cv_headers (company_id, branch_id, voucher_no, payee_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'UAT-MBB payee', '2026-11-03', ?, ?, 'Posted')", [companyId, branchId, `${P}${no}`, amount, amount]);
  await pool.query("INSERT INTO cv_lines (cv_id, account_code, account_title, debit, credit) VALUES (?, 'UAT-MBB-6000', 'Expense', ?, 0), (?, 'UAT-MBB-1000', 'Cash', 0, ?)", [r.insertId, amount, r.insertId, amount]);
  return r.insertId;
}
async function postedJv(companyId, branchId, no, code, amount) {
  const [r] = await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, '2026-11-05', ?, ?, 'Posted')", [companyId, branchId, `${P}${no}`, amount, amount]);
  await pool.query("INSERT INTO jv_lines (jv_id, account_code, account_title, debit, credit) VALUES (?, 'UAT-MBB-1000', 'Cash', ?, 0), (?, ?, 'Sales', 0, ?)", [r.insertId, amount, r.insertId, code, amount]);
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkCompany("A", [["A1"], ["A2"], ["A3", "INACTIVE"]]);
  await mkCompany("B", [["B1"]]);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br.A1, br.A3]);
  await mkUser("acctA2", "ACCOUNTANT", [co.A], [br.A2]);
  await mkUser("adminB", "ADMIN", [co.B]);
  for (const c of [co.A, co.B]) {
    await CurrencyService.createCurrency({ id: usr.adminA.id, roleCode: "SUPER_ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
      symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c,
    });
  }
  supplierA = await party(co.A, "SUPPLIER", "SUPP-A");
  customerA = await party(co.A, "CUSTOMER", "CUST-A");
  sharedSupplier = supplierA;
});

afterAll(async () => {
  try {
    const cos = ids.companies.concat(0);
    const [jvs] = await pool.query("SELECT id FROM jv_headers WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvs.map((r) => r.id).concat(0)]);
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id IN (?))", [cos]);
    await pool.query("DELETE FROM cv_lines WHERE cv_id IN (SELECT id FROM cv_headers WHERE company_id IN (?))", [cos]);
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, ids.users.concat(0), `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?) OR code LIKE ?", [cos, `${P}%`]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM currency_rates WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids.users.concat(0)]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("COA code uniqueness per branch", () => {
  const create = (who, code, cls, branchId) => post(who, "/api/coa", { code, title: `${code} title`, accountClass: cls, date: "2026-01-01", ...(branchId === undefined ? {} : { branchId }) });

  test("the same code may be used by two different branches (same class)", async () => {
    const a1 = await create("adminA", "UAT-MBB-1100", "ASSET", br.A1);
    const a2 = await create("adminA", "UAT-MBB-1100", "ASSET", br.A2);
    expect([a1.status, a2.status]).toEqual([200, 200]);
    const [rows] = await pool.query("SELECT branch_id FROM chart_of_accounts WHERE code = 'UAT-MBB-1100' ORDER BY branch_id");
    expect(rows.map((r) => r.branch_id)).toEqual([br.A1, br.A2]);
  });

  test("a duplicate code within the same branch is rejected", async () => {
    const dup = await create("adminA", "UAT-MBB-1100", "ASSET", br.A1);
    expect([dup.status, dup.body.message]).toEqual([400, "Account code already exists"]);
  });

  test("a reused branch code with a different class is rejected (consolidation keeps its meaning)", async () => {
    const bad = await create("adminA", "UAT-MBB-1100", "LIABILITY", br.A3);
    expect([bad.status, bad.body.code]).toEqual([409, "COA_CODE_CLASS_CONFLICT"]);
  });

  test("shared and branch accounts never share a code (either direction)", async () => {
    expect((await create("adminA", "UAT-MBB-1100", "ASSET", null)).body.code).toBe("COA_CODE_USED_BY_BRANCH");
    expect((await create("adminA", "UAT-MBB-1000", "ASSET", null)).status).toBe(200); // shared
    const clash = await create("adminA", "UAT-MBB-1000", "ASSET", br.A1);
    expect([clash.status, clash.body.code]).toEqual([409, "COA_CODE_SHARED_CONFLICT"]);
    const dupShared = await create("adminA", "UAT-MBB-1000", "ASSET", null);
    expect(dupShared.status).toBe(400);
  });

  test("editing an account keeps its own code; moving it into a clash is refused", async () => {
    const [[acc]] = await pool.query("SELECT id FROM chart_of_accounts WHERE code = 'UAT-MBB-1100' AND branch_id = ?", [br.A2]);
    const same = await request(app).put(`/api/coa/${acc.id}`).set(as("adminA")).send({ code: "UAT-MBB-1100", title: "Renamed AR", accountClass: "ASSET", date: "2026-01-01" });
    expect(same.status).toBe(200);
    const toShared = await request(app).put(`/api/coa/${acc.id}`).set(as("adminA")).send({ code: "UAT-MBB-1100", title: "x", accountClass: "ASSET", date: "2026-01-01", branchId: null });
    expect(toShared.body.code).toBe("COA_CODE_USED_BY_BRANCH");
  });

  test("shared accounts are visible to every branch; branch accounts only to their branch", async () => {
    const codes = async (who, branchId) => (await get(who, `/api/branch-scope/accounts?companyId=${co.A}&branchId=${branchId}`)).body.accounts.map((a) => `${a.code}@${a.branchId ?? "shared"}`);
    const a1 = await codes("acctA1", br.A1);
    expect(a1).toEqual(expect.arrayContaining(["UAT-MBB-1000@shared", `UAT-MBB-1100@${br.A1}`]));
    expect(a1).not.toContain(`UAT-MBB-1100@${br.A2}`);
    expect(await codes("acctA2", br.A2)).not.toContain(`UAT-MBB-1100@${br.A1}`);
    expect((await get("acctA1", `/api/branch-scope/accounts?companyId=${co.A}&branchId=${br.A2}`)).status).toBe(403);
    expect((await get("adminB", `/api/branch-scope/accounts?companyId=${co.A}&branchId=${br.A1}`)).status).toBe(403);
  });
});

// ===========================================================================
describe("reports never double a reused code; consolidated = one combined report", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES ('UAT-MBB-REV', 'REVENUE', 'INCOME', 'ACTIVE')");
    for (const b of [br.A1, br.A2]) {
      const id = await coa("UAT-MBB-4000", "Sales", "INCOME", b);
      await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'UAT-MBB-REV', 'REVENUE')", [id]);
    }
    await postedJv(co.A, br.A1, "JV-A1", "UAT-MBB-4000", 100000);
    await postedJv(co.A, br.A2, "JV-A2", "UAT-MBB-4000", 80000);
    await postedJv(co.B, br.B1, "JV-B1", "UAT-MBB-4000", 50000);
  });
  const sales = (rows) => rows.filter((r) => r.account_code === "UAT-MBB-4000").reduce((s, r) => s + Number(r.amount), 0);

  test("coaByCodeSql yields exactly one row per code (shared preferred)", async () => {
    const [rows] = await pool.query(`SELECT code, COUNT(*) n FROM ${coaByCodeSql()} x WHERE code LIKE 'UAT-MBB-%' GROUP BY code`);
    for (const r of rows) expect([r.code, Number(r.n)]).toEqual([r.code, 1]);
  });

  test("company Income Statement counts the reused code once (180,000, not 360,000)", async () => {
    const rows = await FinancialStatementService.getIncomeStatementRows({ companyId: co.A, from: "2026-11-01", to: "2026-11-30" });
    expect(sales(rows)).toBe(180000);
    expect(rows.filter((r) => r.account_code === "UAT-MBB-4000")).toHaveLength(1);
  });

  test("ADMIN: Branch A1, Branch A2 and All Branches (one combined line)", async () => {
    const url = (b) => `/api/branch-scope/reports/income-statement?companyId=${co.A}&branch=${b}&from=2026-11-01&to=2026-11-30`;
    expect(sales((await get("adminA", url(br.A1))).body.rows)).toBe(100000);
    expect(sales((await get("adminA", url(br.A2))).body.rows)).toBe(80000);
    const all = await get("adminA", url("ALL"));
    expect([all.status, all.body.scope.consolidated, sales(all.body.rows)]).toEqual([200, true, 180000]);
    expect(all.body.rows.filter((r) => r.account_code === "UAT-MBB-4000")).toHaveLength(1);
  });

  test("ACCOUNTANT cannot use All Branches; Balance Sheet follows the same scope rules; another company is refused", async () => {
    const all = await get("acctA1", `/api/branch-scope/reports/income-statement?companyId=${co.A}&branch=ALL&from=2026-11-01&to=2026-11-30`);
    expect([all.status, all.body.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
    expect((await get("acctA1", `/api/branch-scope/reports/balance-sheet?companyId=${co.A}&branch=ALL&to=2026-11-30`)).status).toBe(403);
    const bs = await get("adminA", `/api/branch-scope/reports/balance-sheet?companyId=${co.A}&branch=ALL&to=2026-11-30`);
    expect(bs.status).toBe(200);
    const earnings = bs.body.rows.find((r) => r.account_code === "CURRENT-EARNINGS");
    expect(Number(earnings.amount)).toBe(180000);
    expect((await get("adminB", `/api/branch-scope/reports/income-statement?companyId=${co.A}&branch=ALL&from=2026-11-01&to=2026-11-30`)).status).toBe(403);
  });
});

// ===========================================================================
describe("General Libraries: company-scoped codes, branch isolation", () => {
  test("the same party code may exist in two companies but not twice in one company", async () => {
    const a = await post("adminA", "/api/genlib", { companyId: co.A, code: "UAT-MBB-P1", name: "P1 A", type: "SUPPLIER" });
    const b = await post("adminB", "/api/genlib", { companyId: co.B, code: "UAT-MBB-P1", name: "P1 B", type: "SUPPLIER" });
    expect([a.status, b.status]).toEqual([200, 200]);
    const dup = await post("adminA", "/api/genlib", { companyId: co.A, code: "UAT-MBB-P1", name: "dup", type: "SUPPLIER", branchId: br.A1 });
    expect([dup.status, dup.body.message]).toEqual([400, "Code already exists"]);
    expect((await get("adminB", `/api/genlib?companyId=${co.B}`)).body.map((r) => r.id)).not.toContain(a.body.id);
  });

  test("branch party pickers: shared + own branch only; a forged branch is refused", async () => {
    const onlyA2 = await party(co.A, "SUPPLIER", "SUPP-A2ONLY", br.A2);
    const list = async (who, b) => (await get(who, `/api/branch-scope/parties?companyId=${co.A}&branchId=${b}&type=SUPPLIER`)).body.parties.map((p) => p.id);
    expect(await list("acctA2", br.A2)).toEqual(expect.arrayContaining([sharedSupplier, onlyA2]));
    expect(await list("acctA1", br.A1)).not.toContain(onlyA2);
    expect((await get("acctA1", `/api/branch-scope/parties?companyId=${co.A}&branchId=${br.A2}`)).status).toBe(403);
    expect((await get("adminA", `/api/branch-scope/parties?companyId=${co.A}&branchId=${br.B1}`)).body.code).toBe("BRANCH_COMPANY_MISMATCH");
  });
});

// ===========================================================================
describe("transaction-entry pre-checks", () => {
  test("branch validation: required, authorized, same company, active", async () => {
    const v = (who, body) => post(who, "/api/branch-scope/validate-transaction", { companyId: co.A, ...body });
    expect((await v("acctA1", {})).body.code).toBe("BRANCH_REQUIRED");
    expect((await v("acctA1", { branchId: br.A2 })).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await v("acctA1", { branchId: br.B1 })).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    expect((await v("acctA1", { branchId: br.A3 })).body.code).toBe("BRANCH_INACTIVE");
    expect((await v("acctA1", { branchId: br.A1 })).body).toMatchObject({ valid: true, branchId: br.A1 });
  });

  test("accounts and parties must be shared or the branch's own", async () => {
    const [[a1]] = await pool.query("SELECT id FROM chart_of_accounts WHERE code = 'UAT-MBB-1100' AND branch_id = ?", [br.A1]);
    const [[a2]] = await pool.query("SELECT id FROM chart_of_accounts WHERE code = 'UAT-MBB-1100' AND branch_id = ?", [br.A2]);
    const [[shared]] = await pool.query("SELECT id FROM chart_of_accounts WHERE code = 'UAT-MBB-1000'");
    const v = (body) => post("acctA1", "/api/branch-scope/validate-transaction", { companyId: co.A, branchId: br.A1, ...body });
    expect((await v({ accountIds: [a1.id, shared.id], partyId: supplierA })).body.valid).toBe(true);
    expect((await v({ accountIds: [a2.id] })).body.code).toBe("ACCOUNT_BRANCH_MISMATCH");
    const onlyA2 = (await pool.query("SELECT id FROM general_libraries WHERE code = 'UAT-MBB-SUPP-A2ONLY'"))[0][0].id;
    expect((await v({ partyId: onlyA2 })).body.code).toBe("PARTY_BRANCH_MISMATCH");
    const partyB = (await pool.query("SELECT id FROM general_libraries WHERE company_id = ? LIMIT 1", [co.B]))[0][0].id;
    expect((await v({ partyId: partyB })).status).toBe(404);
  });
});

// ===========================================================================
describe("payment application pre-check (CV -> APV, OR -> Invoice)", () => {
  let ok1, ok2, a2, legacy, draft, voided, reversed, paid, other, invOk, invDraft, invVoid, invA2;
  beforeAll(async () => {
    ok1 = await apv(co.A, br.A1, supplierA, "APV-OK1", 10000);
    ok2 = await apv(co.A, br.A1, supplierA, "APV-OK2", 15000);
    a2 = await apv(co.A, br.A2, supplierA, "APV-A2", 8000);
    legacy = await apv(co.A, null, supplierA, "APV-LEGACY", 5000);
    draft = await apv(co.A, br.A1, supplierA, "APV-DRAFT", 3000, { status: "Draft" });
    voided = await apv(co.A, br.A1, supplierA, "APV-VOID", 3000, { status: "Void" });
    reversed = await apv(co.A, br.A1, supplierA, "APV-REV", 4000);
    await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status, source_module, source_reference_id) VALUES (?, ?, ?, '2026-11-04', 4000, 4000, 'Posted', 'APV_REVERSAL', ?)", [co.A, br.A1, `${P}JV-REV`, reversed]);
    paid = await apv(co.A, br.A1, supplierA, "APV-PAID", 2000, { paid: 2000 });
    const bSupp = await party(co.B, "SUPPLIER", "SUPP-B");
    other = await apv(co.B, br.B1, bSupp, "APV-B", 7000);
    invOk = await invoice(co.A, br.A1, customerA, "INV-OK", 10000);
    invDraft = await invoice(co.A, br.A1, customerA, "INV-DRAFT", 2000, { status: "Draft" });
    invVoid = await invoice(co.A, br.A1, customerA, "INV-VOID", 2000, { status: "Void" });
    invA2 = await invoice(co.A, br.A2, customerA, "INV-A2", 9000);
  });
  const check = (who, paymentType, applications, extra = {}) =>
    post(who, "/api/branch-scope/applications/validate", { companyId: co.A, branchId: br.A1, paymentType, partyId: paymentType === "CV" ? supplierA : customerA, applications, ...extra });
  const codeOf = async (res) => res.body.items.map((i) => i.code || "OK");

  test("unpaid APV lookup is branch-aware and drops reversed APVs", async () => {
    const res = await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}&supplierId=${supplierA}`);
    expect(res.body.map((r) => r.id).sort()).toEqual([ok1, ok2].sort());
  });

  test("unpaid invoice lookup is branch-aware and Posted-only", async () => {
    const res = await get("acctA1", `/api/branch-scope/open-items/invoices?companyId=${co.A}&branchId=${br.A1}&customerId=${customerA}`);
    expect(res.body.map((r) => r.id)).toEqual([invOk]);
  });

  test("valid partial + multi-document application passes", async () => {
    const res = await check("acctA1", "CV", [{ sourceId: ok1, amount: 10000 }, { sourceId: ok2, amount: 10000 }]);
    expect(res.status).toBe(200);
    expect([res.body.valid, res.body.totalApplied]).toEqual([true, 20000]);
    expect(res.body.items[1]).toMatchObject({ voucherNo: `${P}APV-OK2`, balanceAmount: 15000, ok: true });
  });

  test("every ineligible APV is rejected with its own reason", async () => {
    const res = await check("acctA1", "CV", [
      { sourceId: a2, amount: 100 }, { sourceId: legacy, amount: 100 }, { sourceId: draft, amount: 100 },
      { sourceId: voided, amount: 100 }, { sourceId: reversed, amount: 100 }, { sourceId: paid, amount: 100 },
      { sourceId: other, amount: 100 }, { sourceId: ok1, amount: 0 },
    ]);
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toEqual(["BRANCH_MISMATCH", "BRANCH_UNRESOLVED", "NOT_POSTED", "NOT_POSTED", "REVERSED", "FULLY_PAID", "SOURCE_NOT_FOUND", "AMOUNT_INVALID"]);
  });

  test("over-application is rejected, including split across two lines of the same APV", async () => {
    expect(await codeOf(await check("acctA1", "CV", [{ sourceId: ok1, amount: 10000.01 }]))).toEqual(["OVER_APPLICATION"]);
    expect(await codeOf(await check("acctA1", "CV", [{ sourceId: ok1, amount: 6000 }, { sourceId: ok1, amount: 4001 }]))).toEqual(["OK", "OVER_APPLICATION"]);
  });

  test("OR -> Invoice: Posted invoice of the branch only", async () => {
    const res = await check("acctA1", "OR", [{ sourceId: invOk, amount: 6000 }, { sourceId: invDraft, amount: 1 }, { sourceId: invVoid, amount: 1 }, { sourceId: invA2, amount: 1 }]);
    expect(await codeOf(res)).toEqual(["OK", "NOT_POSTED", "NOT_POSTED", "BRANCH_MISMATCH"]);
  });

  test("the branch is resolved server-side: another branch or company is refused outright", async () => {
    expect((await check("acctA1", "CV", [{ sourceId: ok1, amount: 1 }], { branchId: br.A2 })).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await post("adminB", "/api/branch-scope/applications/validate", { companyId: co.A, branchId: br.A1, paymentType: "CV", applications: [{ sourceId: ok1, amount: 1 }] })).status).toBe(403);
  });

  test("the real apply path still refuses a cross-branch application", async () => {
    const [cv] = await pool.query("INSERT INTO cv_headers (company_id, branch_id, voucher_no, payee_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'x', '2026-11-03', 0, 0, 'Draft')", [co.A, br.A1, `${P}CV-APPLY`]);
    const res = await post("adminA", "/api/apply-payment", { companyId: co.A, sourceType: "APV", sourceId: a2, appliedType: "CV", appliedId: cv.insertId, amount: 100, applicationDate: "2026-11-03" });
    expect([res.status, res.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
  });
});

// ===========================================================================
describe("CV reversal stays in the original's branch", () => {
  let cvA2;
  beforeAll(async () => { cvA2 = await postedCv(co.A, br.A2, "CV-REV-A2", 1500); });

  test("pre-check: allowed for the branch's user, 403 for another branch", async () => {
    expect((await post("acctA2", "/api/branch-scope/reversals/check", { companyId: co.A, module: "CV", id: cvA2 })).body).toMatchObject({ allowed: true, branchId: br.A2 });
    expect((await post("acctA1", "/api/branch-scope/reversals/check", { companyId: co.A, module: "CV", id: cvA2 })).body.code).toBe("BRANCH_ACCESS_DENIED");
    expect((await post("adminA", "/api/branch-scope/reversals/check", { companyId: co.A, module: "JV", id: cvA2 })).body.code).toBe("REVERSAL_MODULE_INVALID");
  });

  test("a user of another branch cannot reverse; nothing is created", async () => {
    const res = await post("acctA1", `/api/cv/${cvA2}/reverse`, { companyId: co.A, reason: "UAT-MBB cross-branch" });
    expect([res.status, res.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const [jv] = await pool.query("SELECT id FROM jv_headers WHERE source_module = 'CV_REVERSAL' AND source_reference_id = ?", [cvA2]);
    expect(jv).toHaveLength(0);
  });

  test("the branch's user reverses it: JV inherits company + branch, original unchanged; a second reversal is refused", async () => {
    const before = (await pool.query("SELECT status, total_debit, total_credit, branch_id, updated_at FROM cv_headers WHERE id = ?", [cvA2]))[0][0];
    const res = await post("acctA2", `/api/cv/${cvA2}/reverse`, { companyId: co.A, reason: "UAT-MBB same-branch" });
    expect(res.status).toBe(200);
    const [[jv]] = await pool.query("SELECT company_id, branch_id, source_module FROM jv_headers WHERE id = ?", [res.body.reversalJvId]);
    expect(jv).toEqual({ company_id: co.A, branch_id: br.A2, source_module: "CV_REVERSAL" });
    expect((await pool.query("SELECT status, total_debit, total_credit, branch_id, updated_at FROM cv_headers WHERE id = ?", [cvA2]))[0][0]).toEqual(before);
    const again = await post("acctA2", `/api/cv/${cvA2}/reverse`, { companyId: co.A, reason: "UAT-MBB duplicate" });
    expect([again.status, again.body.code]).toEqual([409, "TRANSACTION_ALREADY_REVERSED"]);
    expect((await post("acctA2", "/api/branch-scope/reversals/check", { companyId: co.A, module: "CV", id: cvA2 })).body).toMatchObject({ allowed: false, code: "TRANSACTION_ALREADY_REVERSED" });
  });
});
