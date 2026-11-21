// Multi-Branch Foundation, Phase A (TC-MB-001 .. TC-MB-023).
// Data model, server-side branch resolution, branch-aware open items, same-branch
// payment application, branch-preserving reversal, consolidated report scope and
// branch-only COA / General Library records. Local test database only.
// Fixture prefix UAT-MB-. Tokens are signed with the app's own session signer
// (no /api/login calls, so the per-IP login limit is not involved).
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const CurrencyService = require("../services/currencyService");
const PaymentApplicationService = require("../services/paymentApplicationService");
const BranchResolution = require("../lib/branchResolution");
const { resolveDatabaseConfig } = require("../config/database");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "UAT-MB-";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const ids = { companies: [], branches: [], users: [], genlib: [], coa: [] };
const co = {};
const br = {};
const tok = {};
const usr = {};
let supplierA, customerA, supplierB, cashAcct;

const as = (who) => ({ Authorization: `Bearer ${tok[who]}` });
const get = (who, url) => request(app).get(url).set(as(who));

async function roleId(code) {
  const [[r]] = await pool.query("SELECT id FROM roles WHERE code = ?", [code]);
  return r.id;
}
async function mkCompany(tag, branchCodes) {
  const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
  co[tag] = c.insertId;
  ids.companies.push(c.insertId);
  for (const code of branchCodes) {
    const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, `${P}${code}`, `${P}${code}`]);
    br[code] = b.insertId;
    ids.branches.push(b.insertId);
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
async function party(companyId, type, name, branchId = null) {
  const [r] = await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, ?, ?, 'ACTIVE', ?)", [companyId, `${P}${name}`, type, `${P}${name}`, branchId]);
  ids.genlib.push(r.insertId);
  return r.insertId;
}
async function apv(companyId, branchId, supplierId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MB supplier', '2026-11-02', ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, supplierId, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : paid ? "Partially Paid" : "Unpaid", status]
  );
  await pool.query("INSERT INTO apv_lines (apv_id, account_code, account_title, debit, credit) VALUES (?, 'UAT-MB-6000', 'UAT-MB Expense', ?, 0), (?, 'UAT-MB-2000', 'UAT-MB AP', 0, ?)", [r.insertId, amount, r.insertId, amount]);
  return r.insertId;
}
async function invoice(companyId, branchId, customerId, no, amount, { status = "Posted", paid = 0 } = {}) {
  const [r] = await pool.query(
    `INSERT INTO invoice_headers (company_id, branch_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, ?, 'UAT-MB customer', '2026-11-02', ?, ?, ?, ?, ?, ?)`,
    [companyId, branchId, `${P}${no}`, customerId, amount, amount, paid, amount - paid, paid >= amount ? "Paid" : paid ? "Partially Paid" : "Unpaid", status]
  );
  return r.insertId;
}
async function cv(companyId, branchId, no) {
  const [r] = await pool.query("INSERT INTO cv_headers (company_id, branch_id, voucher_no, payee_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'UAT-MB payee', '2026-11-03', 0, 0, 'Draft')", [companyId, branchId, `${P}${no}`]);
  return r.insertId;
}
async function orDoc(companyId, branchId, no) {
  const [r] = await pool.query("INSERT INTO or_headers (company_id, branch_id, voucher_no, customer_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, 'UAT-MB customer', '2026-11-03', 0, 0, 'Draft')", [companyId, branchId, `${P}${no}`]);
  return r.insertId;
}
async function postedJv(companyId, branchId, no, code, amount) {
  const [r] = await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, ?, '2026-11-05', ?, ?, 'Posted')", [companyId, branchId, `${P}${no}`, amount, amount]);
  await pool.query("INSERT INTO jv_lines (jv_id, account_code, account_title, debit, credit) VALUES (?, 'UAT-MB-1000', 'UAT-MB Cash', ?, 0), (?, ?, 'UAT-MB Sales', 0, ?)", [r.insertId, amount, r.insertId, code, amount]);
  return r.insertId;
}
async function applyInTxn(fn, args) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    return await fn(conn, args);
  } finally {
    await conn.rollback();
    conn.release();
  }
}
const apvArgs = (cvId, apvId, amount, companyId) => ({
  appItem: { sourceId: apvId, sourceType: "APV", amount }, appliedType: "CV", appliedId: cvId,
  paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", fallbackDate: "2026-11-03", isPosting: false, companyId,
});
const invArgs = (orId, invId, amount, companyId) => ({
  appItem: { sourceId: invId, sourceType: "INV", amount }, appliedType: "OR", appliedId: orId,
  paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", fallbackDate: "2026-11-03", isPosting: false, companyId,
});

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkCompany("A", ["A1", "A2"]);
  await mkCompany("B", ["B1"]);
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br.A1]);
  await mkUser("acctA2", "ACCOUNTANT", [co.A], [br.A2]);
  await mkUser("adminB", "ADMIN", [co.B]);
  await mkUser("super", "SUPER_ADMIN", []);
  for (const c of [co.A, co.B]) {
    await CurrencyService.createCurrency({ id: usr.adminA.id, roleCode: "SUPER_ADMIN" }, {
      currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2,
      symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c,
    });
  }
  supplierA = await party(co.A, "SUPPLIER", "SUPP-A");
  customerA = await party(co.A, "CUSTOMER", "CUST-A");
  supplierB = await party(co.B, "SUPPLIER", "SUPP-B");
  const [acct] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('UAT-MB-1000', '2026-01-01', 'UAT-MB Cash', 'ASSET')");
  cashAcct = acct.insertId;
  ids.coa.push(acct.insertId);
});

afterAll(async () => {
  try {
    const cos = ids.companies.length ? ids.companies : [0];
    const [jvs] = await pool.query("SELECT id FROM jv_headers WHERE company_id IN (?)", [cos]);
    const jvIds = jvs.map((r) => r.id).concat(0);
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds]);
    await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id IN (?)) OR applied_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [cos, cos]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id IN (?))", [cos]);
    for (const t of ["transaction_tax_entries", "transaction_currency_snapshots"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    for (const t of ["jv_headers", "apv_headers", "invoice_headers", "cv_headers", "or_headers", "arap_beginning_balance_headers"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?) OR description LIKE ?", [cos, ids.users.concat(0), `%${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?) OR code LIKE ?", [cos, `${P}%`]);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE ?)", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
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
describe("branch structure and authorization", () => {
  test("TC-MB-001 a company can have multiple branches", async () => {
    const res = await get("adminA", `/api/branch-scope/branches?companyId=${co.A}`);
    expect(res.status).toBe(200);
    expect(res.body.branches.map((b) => b.id)).toEqual([br.A1, br.A2]);
    expect(res.body.canConsolidate).toBe(true);
  });

  test("TC-MB-002 a branch belongs to exactly one company (another company's branch is refused)", async () => {
    const [[row]] = await pool.query("SELECT COUNT(DISTINCT company_id) n FROM branches WHERE id = ?", [br.A1]);
    expect(Number(row.n)).toBe(1);
    await expect(BranchResolution.resolveBranch(usr.super, co.B, br.A1)).rejects.toMatchObject({ statusCode: 403, code: "BRANCH_COMPANY_MISMATCH" });
  });

  test("TC-MB-003 a user cannot reach another company's branch", async () => {
    const res = await get("adminB", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}&supplierId=${supplierA}`);
    expect(res.status).toBe(403);
    const mixed = await get("adminB", `/api/branch-scope/open-items/apv?companyId=${co.B}&branchId=${br.A1}&supplierId=${supplierB}`);
    expect([mixed.status, mixed.body.code]).toEqual([403, "BRANCH_COMPANY_MISMATCH"]);
  });

  test("TC-MB-004 a user cannot reach an unauthorized branch of their own company", async () => {
    const res = await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A2}&supplierId=${supplierA}`);
    expect([res.status, res.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const mine = await get("acctA1", `/api/branch-scope/branches?companyId=${co.A}`);
    expect(mine.body.branches.map((b) => b.id)).toEqual([br.A1]);
    expect(mine.body.canConsolidate).toBe(false);
  });

  test("TC-MB-007 a branch-aware request needs a valid branch (missing, unknown and forged ids refused)", async () => {
    const base = `/api/branch-scope/open-items/apv?companyId=${co.A}&supplierId=${supplierA}`;
    expect((await get("adminA", base)).body.code).toBe("BRANCH_REQUIRED");
    expect((await get("adminA", `${base}&branchId=999999999`)).body.code).toBe("BRANCH_NOT_FOUND");
    expect((await get("adminA", `${base}&branchId=${br.B1}`)).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    expect((await get("adminA", `${base}&branchId=abc`)).status).toBe(400);
  });
});

// ===========================================================================
describe("historical backfill (migration)", () => {
  let single, multi, singleBranch, rows;
  beforeAll(async () => {
    await mkCompany("SINGLE", ["S1"]);
    await mkCompany("MULTI", ["M1", "M2"]);
    single = co.SINGLE; multi = co.MULTI; singleBranch = br.S1;
    rows = {
      singleApv: await apv(single, null, null, "HIST-S-APV", 500),
      singleJv: await postedJv(single, null, "HIST-S-JV", "UAT-MB-4000", 50),
      multiApv: await apv(multi, null, null, "HIST-M-APV", 700),
      multiJv: await postedJv(multi, null, "HIST-M-JV", "UAT-MB-4000", 70),
    };
    const before = await pool.query("SELECT id, total_credit, status, transaction_date, updated_at FROM apv_headers WHERE id IN (?, ?) ORDER BY id", [rows.singleApv, rows.multiApv]);
    rows.before = JSON.stringify(before[0]);
    const { environment, ...cfg } = resolveDatabaseConfig();
    const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
    try {
      const sql = fs.readFileSync(path.join(REPO_ROOT, "multi_branch_foundation_migration.sql"), "utf8");
      await c.query(sql);
      await c.query(sql); // idempotent
    } finally {
      await c.end();
    }
  });

  test("TC-MB-005 a single-branch company's history is backfilled to its only branch; amounts / status / dates / updated_at untouched", async () => {
    const [[a]] = await pool.query("SELECT branch_id FROM apv_headers WHERE id = ?", [rows.singleApv]);
    const [[j]] = await pool.query("SELECT branch_id FROM jv_headers WHERE id = ?", [rows.singleJv]);
    expect([a.branch_id, j.branch_id]).toEqual([singleBranch, singleBranch]);
    const after = await pool.query("SELECT id, total_credit, status, transaction_date, updated_at FROM apv_headers WHERE id IN (?, ?) ORDER BY id", [rows.singleApv, rows.multiApv]);
    expect(JSON.stringify(after[0])).toBe(rows.before);
  });

  test("TC-MB-006 a multi-branch company's history is NOT guessed - it stays NULL and is reported", async () => {
    const [[a]] = await pool.query("SELECT branch_id FROM apv_headers WHERE id = ?", [rows.multiApv]);
    const [[j]] = await pool.query("SELECT branch_id FROM jv_headers WHERE id = ?", [rows.multiJv]);
    expect([a.branch_id, j.branch_id]).toEqual([null, null]);
    await mkUser("adminM", "ADMIN", [multi]);
    const res = await get("adminM", `/api/branch-scope/unresolved?companyId=${multi}`);
    expect(res.status).toBe(200);
    expect(res.body.tables.find((t) => t.table === "apv_headers").unresolved).toBe(1);
    expect(res.body.tables.find((t) => t.table === "jv_headers").unresolved).toBe(1);
    expect(res.body.total).toBe(2);
    const auditSql = fs.readFileSync(path.join(__dirname, "..", "scripts", "multiBranchUnresolvedAudit.sql"), "utf8");
    const stmts = auditSql.replace(/^--.*$/gm, "").split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s).toMatch(/^SELECT /);
      expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT)\b/);
      await pool.query(s);
    }
  });

  test("migration is idempotent and only adds the branch structure (columns, indexes, FKs, permission)", async () => {
    const [[c]] = await pool.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'branch_id' AND TABLE_NAME IN ('apv_headers','invoice_headers','cv_headers','or_headers','jv_headers','memo_headers','petty_cash_headers','purchase_order_headers','quotation_headers','arap_beginning_balance_headers','gl_beginning_balance_headers','chart_of_accounts','general_libraries')");
    expect(Number(c.n)).toBe(13);
    const [[fk]] = await pool.query("SELECT COUNT(*) n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'branches' AND DELETE_RULE = 'RESTRICT' AND TABLE_NAME IN ('apv_headers','invoice_headers','cv_headers','or_headers','jv_headers','memo_headers','petty_cash_headers','purchase_order_headers','quotation_headers','arap_beginning_balance_headers','gl_beginning_balance_headers','chart_of_accounts','general_libraries')");
    expect(Number(fk.n)).toBe(13);
    const [grants] = await pool.query("SELECT r.code, rp.granted FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.module_key = 'REPORTS.ALL_BRANCHES' AND p.action = 'VIEW' ORDER BY r.code");
    expect(grants.map((g) => `${g.code}=${g.granted}`)).toEqual(["ACCOUNTANT=0", "ADMIN=1"]);
  });
});

// ===========================================================================
describe("payment application: open items + same-branch rule", () => {
  let apvA1, apvA1b, apvA1paid, apvA1draft, apvA1void, apvA2, invA1, invA1draft, invA1void, invA1paid, invA2, otherSuppApv;
  beforeAll(async () => {
    const supplierA2 = await party(co.A, "SUPPLIER", "SUPP-A-OTHER");
    apvA1 = await apv(co.A, br.A1, supplierA, "APV-A1-001", 10000);
    apvA1b = await apv(co.A, br.A1, supplierA, "APV-A1-002", 15000);
    apvA1paid = await apv(co.A, br.A1, supplierA, "APV-A1-PAID", 5000, { paid: 5000 });
    apvA1draft = await apv(co.A, br.A1, supplierA, "APV-A1-DRAFT", 3000, { status: "Draft" });
    apvA1void = await apv(co.A, br.A1, supplierA, "APV-A1-VOID", 3000, { status: "Void" });
    apvA2 = await apv(co.A, br.A2, supplierA, "APV-A2-001", 8000);
    otherSuppApv = await apv(co.A, br.A1, supplierA2, "APV-A1-OTHERSUPP", 4000);
    invA1 = await invoice(co.A, br.A1, customerA, "INV-A1-001", 10000);
    invA1paid = await invoice(co.A, br.A1, customerA, "INV-A1-PAID", 8500, { paid: 8500 });
    invA1draft = await invoice(co.A, br.A1, customerA, "INV-A1-DRAFT", 2000, { status: "Draft" });
    invA1void = await invoice(co.A, br.A1, customerA, "INV-A1-VOID", 2000, { status: "Void" });
    invA2 = await invoice(co.A, br.A2, customerA, "INV-A2-001", 9000);
  });

  test("TC-MB-008 Branch A1 sees only its own supplier's open APVs (no posting needed; Draft / Void / fully paid / other supplier / A2 excluded)", async () => {
    const res = await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}&supplierId=${supplierA}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id).sort()).toEqual([apvA1, apvA1b].sort());
    const one = res.body.find((r) => r.id === apvA1);
    expect([Number(one.totalAmount), Number(one.paidAmount), Number(one.balanceAmount), one.branchId]).toEqual([10000, 0, 10000, br.A1]);
    for (const hidden of [apvA1paid, apvA1draft, apvA1void, apvA2, otherSuppApv]) expect(res.body.map((r) => r.id)).not.toContain(hidden);
    const a2 = await get("acctA2", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A2}&supplierId=${supplierA}`);
    expect(a2.body.map((r) => r.id)).toEqual([apvA2]);
    expect((await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}`)).body.code).toBe("PARTY_REQUIRED");
  });

  test("TC-MB-009 Branch A1 sees only its own customer's open, POSTED invoices", async () => {
    const res = await get("acctA1", `/api/branch-scope/open-items/invoices?companyId=${co.A}&branchId=${br.A1}&customerId=${customerA}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual([invA1]);
    for (const hidden of [invA1paid, invA1draft, invA1void, invA2]) expect(res.body.map((r) => r.id)).not.toContain(hidden);
    expect((await get("acctA1", `/api/branch-scope/open-items/invoices?companyId=${co.A}&branchId=${br.A2}&customerId=${customerA}`)).status).toBe(403);
  });

  test("TC-MB-010 a CV cannot be applied to another branch's APV (service and legacy apply endpoint)", async () => {
    const cvA1 = await cv(co.A, br.A1, "CV-A1-001");
    await expect(applyInTxn(PaymentApplicationService.applyApvPayment, apvArgs(cvA1, apvA2, 1000, co.A))).rejects.toMatchObject({ code: "BRANCH_MISMATCH" });
    const res = await request(app).post("/api/apply-payment").set(as("adminA"))
      .send({ companyId: co.A, sourceType: "APV", sourceId: apvA2, appliedType: "CV", appliedId: cvA1, amount: 1000, applicationDate: "2026-11-03" });
    expect([res.status, res.body.code]).toEqual([400, "BRANCH_MISMATCH"]);
    const [[a2]] = await pool.query("SELECT paid_amount FROM apv_headers WHERE id = ?", [apvA2]);
    expect(Number(a2.paid_amount)).toBe(0);
    const cvNull = await cv(co.A, null, "CV-NULL-001");
    await expect(applyInTxn(PaymentApplicationService.applyApvPayment, apvArgs(cvNull, apvA1, 1000, co.A))).rejects.toMatchObject({ code: "BRANCH_UNRESOLVED" });
  });

  test("same-branch application still works: partial, full and multiple APVs; over-application refused", async () => {
    const cvA1 = await cv(co.A, br.A1, "CV-A1-PART");
    const partial = await request(app).post("/api/apply-payment").set(as("acctA1"))
      .send({ companyId: co.A, sourceType: "APV", sourceId: apvA1, appliedType: "CV", appliedId: cvA1, amount: 6000, applicationDate: "2026-11-03" });
    expect(partial.status).toBe(200);
    const left = (await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}&supplierId=${supplierA}`)).body.find((r) => r.id === apvA1);
    expect([Number(left.paidAmount), Number(left.balanceAmount)]).toEqual([6000, 4000]);
    const over = await request(app).post("/api/apply-payment").set(as("acctA1"))
      .send({ companyId: co.A, sourceType: "APV", sourceId: apvA1, appliedType: "CV", appliedId: cvA1, amount: 4000.01, applicationDate: "2026-11-03" });
    expect(over.status).toBe(400);
    const cvMulti = await cv(co.A, br.A1, "CV-A1-MULTI");
    for (const [id, amt] of [[apvA1, 4000], [apvA1b, 10000]]) {
      const r = await request(app).post("/api/apply-payment").set(as("acctA1"))
        .send({ companyId: co.A, sourceType: "APV", sourceId: id, appliedType: "CV", appliedId: cvMulti, amount: amt, applicationDate: "2026-11-03" });
      expect(r.status).toBe(200);
    }
    const open = (await get("acctA1", `/api/branch-scope/open-items/apv?companyId=${co.A}&branchId=${br.A1}&supplierId=${supplierA}`)).body;
    expect(open.map((r) => r.id)).toEqual([apvA1b]); // APV-001 fully paid -> gone
    expect(Number(open[0].balanceAmount)).toBe(5000);
  });

  test("TC-MB-011 an OR cannot be applied to another branch's invoice; same-branch partial payment works", async () => {
    const orA1 = await orDoc(co.A, br.A1, "OR-A1-001");
    await expect(applyInTxn(PaymentApplicationService.applyInvoicePayment, invArgs(orA1, invA2, 1000, co.A))).rejects.toMatchObject({ code: "BRANCH_MISMATCH" });
    const [[inv]] = await pool.query("SELECT paid_amount FROM invoice_headers WHERE id = ?", [invA2]);
    expect(Number(inv.paid_amount)).toBe(0);
    const res = await applyInTxn(async (conn, a) => {
      await PaymentApplicationService.applyInvoicePayment(conn, a);
      const [[row]] = await conn.query("SELECT paid_amount, balance_amount FROM invoice_headers WHERE id = ?", [invA1]);
      return row;
    }, invArgs(orA1, invA1, 6000, co.A));
    expect([Number(res.paid_amount), Number(res.balance_amount)]).toEqual([6000, 4000]);
  });

  test("TC-MB-012 cross-company payment application is rejected", async () => {
    const cvB = await cv(co.B, br.B1, "CV-B1-001");
    const res = await request(app).post("/api/apply-payment").set(as("adminB"))
      .send({ companyId: co.B, sourceType: "APV", sourceId: apvA1b, appliedType: "CV", appliedId: cvB, amount: 100, applicationDate: "2026-11-03" });
    expect(res.status).toBe(404);
    await expect(applyInTxn(PaymentApplicationService.applyApvPayment, apvArgs(cvB, apvA1b, 100, co.B))).rejects.toThrow();
    const [[a]] = await pool.query("SELECT paid_amount FROM apv_headers WHERE id = ?", [apvA1b]);
    expect(Number(a.paid_amount)).toBe(10000);
  });

  // Was a test.failing in Phase A documenting the gap (the legacy lookup offered
  // Draft / Void invoices that still carried a balance). Fixed in Phase C-1, so
  // it is now an ordinary test.
  test("Phase C-1 fix: legacy GET /api/invoices/unpaid excludes Draft / Void invoices", async () => {
    const res = await get("adminA", `/api/invoices/unpaid?companyId=${co.A}&customerId=${customerA}`);
    expect(res.status).toBe(200);
    const listed = res.body.map((r) => r.id);
    expect(listed).not.toContain(invA1draft);
    expect(listed).not.toContain(invA1void);
  });
});

// ===========================================================================
describe("reversal stays in the original's branch", () => {
  let apvRev;
  beforeAll(async () => {
    apvRev = await apv(co.A, br.A2, supplierA, "APV-A2-REV", 1200);
  });

  test("TC-MB-014 a user outside the original's branch cannot reverse it (nothing is created)", async () => {
    const res = await request(app).post(`/api/apv/${apvRev}/reverse`).set(as("acctA1")).send({ companyId: co.A, reason: "UAT-MB cross-branch probe" });
    expect([res.status, res.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const [jv] = await pool.query("SELECT id FROM jv_headers WHERE source_module = 'APV_REVERSAL' AND source_reference_id = ?", [apvRev]);
    expect(jv.length).toBe(0);
    const other = await request(app).post(`/api/apv/${apvRev}/reverse`).set(as("adminB")).send({ companyId: co.B, reason: "UAT-MB cross-company probe" });
    expect(other.status).toBe(404);
  });

  test("TC-MB-013 a reversal inherits the original's company and branch; the original is unchanged and the action is audited", async () => {
    const before = (await pool.query("SELECT status, total_debit, total_credit, branch_id, updated_at FROM apv_headers WHERE id = ?", [apvRev]))[0][0];
    const res = await request(app).post(`/api/apv/${apvRev}/reverse`).set(as("acctA2")).send({ companyId: co.A, reason: "UAT-MB same-branch reversal" });
    expect(res.status).toBe(200);
    const [[jv]] = await pool.query("SELECT company_id, branch_id, status, source_module, source_reference_id FROM jv_headers WHERE id = ?", [res.body.reversalJvId]);
    expect(jv).toMatchObject({ company_id: co.A, branch_id: br.A2, status: "Posted", source_module: "APV_REVERSAL", source_reference_id: apvRev });
    const after = (await pool.query("SELECT status, total_debit, total_credit, branch_id, updated_at FROM apv_headers WHERE id = ?", [apvRev]))[0][0];
    expect(after).toEqual(before);
    const [audit] = await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'APV' AND entity_id = ? AND action = 'REVERSE'", [apvRev]);
    expect(audit.length).toBe(1);
  });

  test("TC-MB-015 a second reversal of the same APV is refused", async () => {
    const res = await request(app).post(`/api/apv/${apvRev}/reverse`).set(as("acctA2")).send({ companyId: co.A, reason: "UAT-MB duplicate" });
    expect([res.status, res.body.code]).toEqual([409, "TRANSACTION_ALREADY_REVERSED"]);
    const [jv] = await pool.query("SELECT id FROM jv_headers WHERE source_module = 'APV_REVERSAL' AND source_reference_id = ?", [apvRev]);
    expect(jv.length).toBe(1);
  });
});

// ===========================================================================
describe("consolidated report scope", () => {
  const url = (branch) => `/api/branch-scope/reports/account-totals?companyId=${co.A}&branch=${branch}&from=2026-11-01&to=2026-11-30`;
  const sales = (body) => Number(body.rows.find((r) => r.accountCode === "UAT-MB-4000")?.credit || 0);
  beforeAll(async () => {
    await postedJv(co.A, br.A1, "JV-A1-SALES", "UAT-MB-4000", 100000);
    await postedJv(co.A, br.A2, "JV-A2-SALES", "UAT-MB-4000", 80000);
    await postedJv(co.B, br.B1, "JV-B1-SALES", "UAT-MB-4000", 50000);
  });

  test("TC-MB-016 an ADMIN can request one branch", async () => {
    const res = await get("adminA", url(br.A1));
    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({ consolidated: false, branchIds: [br.A1], includeUnassigned: false });
    expect(sales(res.body)).toBe(100000);
    expect(sales((await get("adminA", url(br.A2))).body)).toBe(80000);
  });

  test("TC-MB-017 / TC-MB-018 ALL = one combined report over the authorized branches only (never another company)", async () => {
    const res = await get("adminA", url("ALL"));
    expect(res.status).toBe(200);
    expect(res.body.scope).toMatchObject({ consolidated: true, branchIds: [br.A1, br.A2] });
    expect(sales(res.body)).toBe(180000); // 100,000 + 80,000; Company B's 50,000 excluded
    expect(res.body.rows.filter((r) => r.accountCode === "UAT-MB-4000")).toHaveLength(1); // one line, not one per branch
  });

  test("TC-MB-019 an ACCOUNTANT cannot request a branch they are not assigned to", async () => {
    expect((await get("acctA1", url(br.A1))).status).toBe(200);
    const res = await get("acctA1", url(br.A2));
    expect([res.status, res.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
  });

  test("TC-MB-020 an ACCOUNTANT cannot request All Branches (REPORTS.ALL_BRANCHES explicitly 0)", async () => {
    const res = await get("acctA1", url("ALL"));
    expect([res.status, res.body.code]).toEqual([403, "CONSOLIDATED_NOT_ALLOWED"]);
  });

  test("no permission escalation: restricted operations stay 403 for the canonical accountant", async () => {
    expect((await get("acctA1", `/api/branch-scope/unresolved?companyId=${co.A}`)).status).toBe(403);
    const [[g]] = await pool.query("SELECT COUNT(*) n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE r.code = 'ACCOUNTANT' AND rp.granted = 1 AND p.module_key IN ('REPORTS.ALL_BRANCHES', 'FILESETUP.COMPANIES')");
    expect(Number(g.n)).toBe(0);
  });
});

// ===========================================================================
describe("branch-only COA and General Library records", () => {
  let coaA1, coaA2, partyA1, partyA2;
  test("TC-MB-021 a branch-only account is invisible to (and cannot be changed by) another branch", async () => {
    const create = (who, code, branchId) => request(app).post("/api/coa").set(as(who)).send({ code, title: `${code} Receivable`, accountClass: "ASSET", date: "2026-01-01", branchId });
    const r1 = await create("adminA", "UAT-MB-1100", br.A1);
    const r2 = await create("adminA", "UAT-MB-1200", br.A2);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    coaA1 = r1.body.id; coaA2 = r2.body.id;
    const forged = await create("acctA1", "UAT-MB-1300", br.A2);
    expect(forged.status).toBe(403); // ACCOUNTANT has no COA CREATE anyway
    const forgedAdmin = await create("adminB", "UAT-MB-1300", br.A1);
    expect([forgedAdmin.status, forgedAdmin.body.code]).toEqual([403, "BRANCH_ACCESS_DENIED"]);
    const codes = async (who, q = "") => (await get(who, `/api/coa${q}`)).body.map((a) => a.code);
    expect(await codes("acctA1")).toEqual(expect.arrayContaining(["UAT-MB-1100", "UAT-MB-1000"]));
    expect(await codes("acctA1")).not.toContain("UAT-MB-1200");
    expect(await codes("acctA2")).not.toContain("UAT-MB-1100");
    expect(await codes("adminB")).not.toEqual(expect.arrayContaining(["UAT-MB-1100"]));
    expect(await codes("adminB")).not.toContain("UAT-MB-1200");
    expect(await codes("adminA", `?branchId=${br.A1}`)).not.toContain("UAT-MB-1200");
    expect((await get("acctA1", `/api/coa?branchId=${br.A2}`)).status).toBe(403);
    const put = await request(app).put(`/api/coa/${coaA2}`).set(as("adminB")).send({ code: "UAT-MB-1200", title: "hijack", accountClass: "ASSET", date: "2026-01-01" });
    expect(put.status).toBe(404);
    const del = await request(app).delete(`/api/coa/${coaA1}`).set(as("adminB"));
    expect(del.status).toBe(404);
    const [[still]] = await pool.query("SELECT title, branch_id FROM chart_of_accounts WHERE id = ?", [coaA2]);
    expect(still).toEqual({ title: "UAT-MB-1200 Receivable", branch_id: br.A2 });
  });

  test("TC-MB-022 a branch-only General Library party is invisible to another branch and cannot be edited from it", async () => {
    const create = (who, code, branchId) => request(app).post("/api/genlib").set(as(who)).send({ companyId: co.A, code, name: code, type: "SUPPLIER", branchId });
    const r1 = await create("adminA", "UAT-MB-SUPP-A1ONLY", br.A1);
    const r2 = await create("adminA", "UAT-MB-SUPP-A2ONLY", br.A2);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    partyA1 = r1.body.id; partyA2 = r2.body.id;
    const list = async (who, q = "") => (await get(who, `/api/genlib?companyId=${co.A}${q}`)).body.map((r) => r.id);
    expect(await list("acctA1")).toEqual(expect.arrayContaining([partyA1, supplierA]));
    expect(await list("acctA1")).not.toContain(partyA2);
    expect(await list("acctA2")).not.toContain(partyA1);
    expect(await list("adminA", `&branchId=${br.A2}`)).not.toContain(partyA1);
    expect((await get("acctA1", `/api/genlib?companyId=${co.A}&branchId=${br.A2}`)).status).toBe(403);
    expect((await create("adminA", "UAT-MB-SUPP-FORGED", br.B1)).body.code).toBe("BRANCH_COMPANY_MISMATCH");
    // an ADMIN of Company A can still edit (all A branches); a company outsider cannot
    const put = await request(app).put(`/api/genlib/${partyA2}`).set(as("adminB")).send({ companyId: co.B, code: "x", name: "x", type: "SUPPLIER" });
    expect(put.status).toBe(404);
    // a branch-restricted user must not see / touch another branch's record even inside the company
    expect(await BranchResolution.assertSetupRecordVisible(usr.acctA1, br.A2).catch((e) => e.statusCode)).toBe(404);
    const [[row]] = await pool.query("SELECT name, branch_id FROM general_libraries WHERE id = ?", [partyA2]);
    expect(row).toEqual({ name: "UAT-MB-SUPP-A2ONLY", branch_id: br.A2 });
  });

  test("TC-MB-023 company-wide (shared) records stay available to every authorized branch of their company, and only there", async () => {
    for (const who of ["acctA1", "acctA2", "adminA"]) {
      expect((await get(who, `/api/genlib?companyId=${co.A}`)).body.map((r) => r.id)).toContain(supplierA);
      expect((await get(who, "/api/coa")).body.map((a) => a.id)).toContain(cashAcct);
    }
    expect((await get("adminB", `/api/genlib?companyId=${co.B}`)).body.map((r) => r.id)).not.toContain(supplierA);
    expect((await get("adminB", `/api/genlib?companyId=${co.A}`)).status).toBe(403);
    const shared = (await get("acctA1", `/api/genlib?companyId=${co.A}`)).body.find((r) => r.id === supplierA);
    expect(shared.branchId).toBeNull();
  });
});
