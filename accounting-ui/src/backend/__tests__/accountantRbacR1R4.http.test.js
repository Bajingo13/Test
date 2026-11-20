// TC-RBAC-001 .. TC-RBAC-005 - approved Accountant RBAC corrections (File Setup
// audit R1-R4, accountant_filesetup_view_bankrecon_approve_migration.sql):
//   R1 FILESETUP.COA / VIEW, R2 FILESETUP.GENLIB / VIEW, R3 FILESETUP.TAX_SETUP /
//   VIEW granted to ACCOUNTANT (read-only; every write stays ADMIN-only);
//   R4 ACCOUNTANT's REPORTS.BANK_RECONCILIATION / APPROVE = granted 0
//   (maker-checker: approve / reject / post / finalize / reopen are ADMIN steps).
// Uses the REAL seeded roles; the suite never changes role permissions. Every
// denied write is checked for 403, no database write and no data in the body.
// Local test database only. Fixture prefix UAT-RBAC-R1R4- (currency XRB).
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");

jest.setTimeout(240000);

const P = "UAT-RBAC-R1R4-";
const PW = "UatRbacR1R4!1";
const MIGRATION = "accountant_filesetup_view_bankrecon_approve_migration.sql";
const tok = {};
const users = [];
const ids = {};

async function makeUser(tag, roleCode, companyId) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id]);
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, companyId]);
  users.push(u.insertId);
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
  return u.insertId;
}
const call = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
const n = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);
function expectDenied(res) {
  expect(res.status).toBe(403);
  expect(Object.keys(res.body || {}).every((k) => ["message", "code", "error", "module", "action", "required"].includes(k))).toBe(true);
}
async function grantedActions(roleCode, moduleKey) {
  const [rows] = await pool.query(
    `SELECT p.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = ? AND p.module_key = ? AND rp.granted = 1 ORDER BY p.action`,
    [roleCode, moduleKey]
  );
  return rows.map((r) => r.action);
}
async function catalogActions(moduleKey) {
  const [rows] = await pool.query("SELECT action FROM permissions WHERE module_key = ? ORDER BY action", [moduleKey]);
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  ids.co = (await pool.query("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Company`]))[0].insertId;
  await makeUser("acct", "ACCOUNTANT", ids.co);
  ids.admin = await makeUser("admin", "ADMIN", ids.co);

  const coa = async (code, title, cls) =>
    (await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', ?, ?)", [`${P}${code}`, title, cls]))[0].insertId;
  ids.expense = await coa("6100", "UAT RBAC R1R4 Office Supplies", "EXPENSE");
  ids.bankGL = await coa("1010", "UAT RBAC R1R4 Cash in Bank", "ASSET");
  ids.chargeGL = await coa("6010", "UAT RBAC R1R4 Bank Charges", "EXPENSE");
  ids.bank = (await pool.query(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, 'UAT RBAC R1R4 Bank', '000-R1R4', 'R1R4 Current', ?, ?, 'ACTIVE')",
    [`${P}BK`, ids.bankGL, `${P}1010`]
  ))[0].insertId;
  for (const [code, type, name] of [["CUS", "CUSTOMER", "UAT RBAC R1R4 Customer"], ["SUP", "SUPPLIER", "UAT RBAC R1R4 Supplier"]]) {
    await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [ids.co, `${P}${code}`, type, name]);
  }
  ids.ewt = (await pool.query("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'UAT RBAC R1R4 2%', 2, 'EWT', 'ACTIVE')", [`${P}WC2`]))[0].insertId;
  const adminUser = { id: ids.admin, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(adminUser, { currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: ids.co });
  ids.xrb = (await CurrencyService.createCurrency(adminUser, { currencyCode: "XRB", currencyName: "UAT RBAC R1R4 currency", currencySymbol: "X", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: ids.co })).id;
  await CurrencyService.recordRate(adminUser, ids.xrb, { rateMode: "MANUAL", rate: 58.25, effectiveDate: "2096-05-01", reason: `${P}rate` });
});

afterAll(async () => {
  try {
    const sessionIds = ids.sessions || [];
    if (sessionIds.length) {
      for (const [type, sql] of [
        ["IMPORT_BATCH", "SELECT id FROM bank_recon_import_batches WHERE session_id IN (?)"],
        ["STATEMENT_LINE", "SELECT id FROM bank_recon_statement_lines WHERE session_id IN (?)"],
        ["MATCH", "SELECT id FROM bank_recon_matches WHERE session_id IN (?)"],
        ["ADJUSTMENT", "SELECT id FROM bank_recon_adjustments WHERE session_id IN (?)"],
      ]) {
        const [rows] = await pool.query(sql, [sessionIds]);
        if (rows.length) await pool.query("DELETE FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = ? AND entity_id IN (?)", [type, rows.map((r) => r.id)]);
      }
      await pool.query("DELETE FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'SESSION' AND entity_id IN (?)", [sessionIds]);
      await pool.query("DELETE FROM ai_recon_conversations WHERE session_id IN (?)", [sessionIds]);
      // the JV that ADMIN's "post" created for the approved adjustment
      const [adjJvs] = await pool.query("SELECT jv_id FROM bank_recon_adjustments WHERE session_id IN (?) AND jv_id IS NOT NULL", [sessionIds]);
      await pool.query("DELETE FROM bank_recon_adjustments WHERE session_id IN (?)", [sessionIds]);
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessionIds]);
      const jvIds = adjJvs.map((r) => r.jv_id);
      if (jvIds.length) {
        await pool.query("DELETE FROM audit_logs WHERE module = 'JV' AND entity_id IN (?)", [jvIds]);
        await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds]);
        await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds]);
      }
    }
    await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [ids.co]).catch(() => {});
    await pool.query("DELETE FROM currencies WHERE company_id = ?", [ids.co]).catch(() => {});
    await pool.query("DELETE FROM bank_codes WHERE bank_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM general_libraries WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM ewt_library WHERE atc_code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM vat_rate_codes WHERE code LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    if (users.length) {
      await pool.query("DELETE FROM ai_recon_conversations WHERE created_by IN (?)", [users]).catch(() => {});
      for (const t of ["user_companies", "user_branches", "user_permissions"]) await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [users]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [users]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    }
    if (ids.co) await pool.query("DELETE FROM companies WHERE id = ?", [ids.co]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("the role matrix after R1-R4", () => {
  test("the migration is registered, after user_access_control_migration.sql, and is data-only", () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("user_access_control_migration.sql"));
    const sql = fs.readFileSync(path.join(__dirname, "../migrations", MIGRATION), "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/INTO\s+permissions\b/i); // no catalog change
    expect(sql.match(/r\.code = '(\w+)'/g).every((m) => m.includes("ACCOUNTANT"))).toBe(true);
  });

  test("R1-R3: ACCOUNTANT holds exactly VIEW on COA, General Libraries and Tax Setup - no CREATE / EDIT / DELETE / CONFIGURE / IMPORT", async () => {
    expect(await grantedActions("ACCOUNTANT", "FILESETUP.COA")).toEqual(["VIEW"]);
    expect(await grantedActions("ACCOUNTANT", "FILESETUP.GENLIB")).toEqual(["VIEW"]);
    expect(await grantedActions("ACCOUNTANT", "FILESETUP.TAX_SETUP")).toEqual(["VIEW"]);
  });

  test("R4: ACCOUNTANT keeps every bank-reconciliation action except APPROVE (stored as an explicit granted = 0 row)", async () => {
    const all = await catalogActions("REPORTS.BANK_RECONCILIATION");
    expect(all).toContain("APPROVE");
    expect(await grantedActions("ACCOUNTANT", "REPORTS.BANK_RECONCILIATION")).toEqual(all.filter((a) => a !== "APPROVE"));
    expect(await n(
      `SELECT COUNT(*) n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.code = 'ACCOUNTANT' AND p.module_key = 'REPORTS.BANK_RECONCILIATION' AND p.action = 'APPROVE' AND rp.granted = 0`
    )).toBe(1);
  });

  test("ADMIN is unchanged: it still holds every action of the four modules, including APPROVE", async () => {
    for (const m of ["FILESETUP.COA", "FILESETUP.GENLIB", "FILESETUP.TAX_SETUP", "REPORTS.BANK_RECONCILIATION"]) {
      expect([m, await grantedActions("ADMIN", m)]).toEqual([m, await catalogActions(m)]);
    }
  });

  test("RFP APPROVE stays denied to ACCOUNTANT; the other ADMIN-only File Setup modules stay ungranted", async () => {
    expect(await grantedActions("ACCOUNTANT", "TRANSACTIONS.RFP")).not.toContain("APPROVE");
    for (const m of ["FILESETUP.GROUP_CODES", "FILESETUP.REPORT_SECTIONS", "FILESETUP.PREPAID_ACCOUNTS", "FILESETUP.FIXED_ASSETS", "FILESETUP.COMPANY_SETUP"]) {
      expect([m, await grantedActions("ACCOUNTANT", m)]).toEqual([m, []]);
    }
    expect(await grantedActions("ACCOUNTANT", "FILESETUP.CURRENCY_SETUP")).toEqual(["RATE_HISTORY", "VIEW", "VIEW_PROVIDER_STATUS"]);
    expect(await grantedActions("ACCOUNTANT", "FILESETUP.BANK_CODES")).toEqual(["VIEW"]);
  });
});

// ===========================================================================
describe("TC-RBAC-001 COA VIEW", () => {
  test("ACCOUNTANT: GET COA and the account lookup (code / title / class) -> 200; template (VIEW) -> 200", async () => {
    const res = await call("acct", "get", "/api/coa");
    expect(res.status).toBe(200);
    expect(res.body.find((a) => a.id === ids.expense)).toMatchObject({ code: `${P}6100`, title: "UAT RBAC R1R4 Office Supplies", accountClass: "EXPENSE" });
    expect((await call("acct", "get", "/api/coa/template")).status).toBe(200);
  });

  test("ACCOUNTANT: CREATE / EDIT / DELETE / IMPORT -> 403 and nothing is written", async () => {
    const before = await n("SELECT COUNT(*) n FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
    expectDenied(await call("acct", "post", "/api/coa", { code: `${P}9999`, date: "2096-01-01", title: "x", accountClass: "ASSET" }));
    expectDenied(await call("acct", "put", `/api/coa/${ids.expense}`, { code: `${P}6100`, date: "2096-01-01", title: "renamed", accountClass: "EXPENSE" }));
    expectDenied(await call("acct", "delete", `/api/coa/${ids.expense}`));
    expectDenied(await request(app).post("/api/coa/import/preview").set({ Authorization: `Bearer ${tok.acct}` }).attach("file", Buffer.from("Code,Title\n"), "coa.csv"));
    expect(await n("SELECT COUNT(*) n FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`])).toBe(before);
    expect((await pool.query("SELECT title FROM chart_of_accounts WHERE id = ?", [ids.expense]))[0][0].title).toBe("UAT RBAC R1R4 Office Supplies");
  });
});

// ===========================================================================
describe("TC-RBAC-002 General Library VIEW", () => {
  test("ACCOUNTANT: GET General Libraries -> 200; customer and supplier lookups carry the type the forms filter on", async () => {
    const res = await call("acct", "get", "/api/genlib");
    expect(res.status).toBe(200);
    const mine = res.body.filter((p) => String(p.code).startsWith(P));
    expect(mine.filter((p) => p.type === "CUSTOMER").map((p) => p.code)).toEqual([`${P}CUS`]);
    expect(mine.filter((p) => p.type === "SUPPLIER").map((p) => p.code)).toEqual([`${P}SUP`]);
    expect((await call("acct", "get", "/api/genlib/template")).status).toBe(200);
  });

  test("ACCOUNTANT: CREATE (incl. quick-add) / EDIT / DELETE / IMPORT -> 403 and nothing is written", async () => {
    const before = await n("SELECT COUNT(*) n FROM general_libraries WHERE code LIKE ?", [`${P}%`]);
    const [[sup]] = await pool.query("SELECT id FROM general_libraries WHERE code = ?", [`${P}SUP`]);
    expectDenied(await call("acct", "post", "/api/genlib", { code: `${P}NEW`, name: "Quick add", type: "CUSTOMER" }));
    expectDenied(await call("acct", "put", `/api/genlib/${sup.id}`, { code: `${P}SUP`, name: "renamed", type: "SUPPLIER" }));
    expectDenied(await call("acct", "delete", `/api/genlib/${sup.id}`));
    expectDenied(await request(app).post("/api/genlib/import/preview").set({ Authorization: `Bearer ${tok.acct}` }).attach("file", Buffer.from("Code,Name\n"), "gl.csv"));
    expect(await n("SELECT COUNT(*) n FROM general_libraries WHERE code LIKE ?", [`${P}%`])).toBe(before);
    expect((await pool.query("SELECT name FROM general_libraries WHERE id = ?", [sup.id]))[0][0].name).toBe("UAT RBAC R1R4 Supplier");
  });
});

// ===========================================================================
describe("TC-RBAC-003 Tax VIEW", () => {
  test("ACCOUNTANT: VAT and EWT lookups -> 200", async () => {
    const vat = await call("acct", "get", "/api/vat-rate-codes");
    const ewt = await call("acct", "get", "/api/ewt-library");
    expect([vat.status, ewt.status]).toEqual([200, 200]);
    const rows = Array.isArray(ewt.body) ? ewt.body : ewt.body.rows;
    expect(rows.find((e) => (e.atcCode || e.atc_code) === `${P}WC2`)).toBeTruthy();
  });

  test("ACCOUNTANT: tax configuration (create / edit / deactivate / delete) -> 403 and nothing is written", async () => {
    const ewtBefore = await n("SELECT COUNT(*) n FROM ewt_library WHERE atc_code LIKE ?", [`${P}%`]);
    const vatBefore = await n("SELECT COUNT(*) n FROM vat_rate_codes");
    expectDenied(await call("acct", "post", "/api/ewt-library", { atcCode: `${P}WC9`, description: "x", rate: 9, taxType: "EWT" }));
    expectDenied(await call("acct", "put", `/api/ewt-library/${ids.ewt}`, { atcCode: `${P}WC2`, description: "x", rate: 99, taxType: "EWT" }));
    expectDenied(await call("acct", "delete", `/api/ewt-library/${ids.ewt}`));
    expectDenied(await call("acct", "post", "/api/vat-rate-codes", { code: `${P}V`, description: "x", rate: 12 }));
    const [[vatRow]] = await pool.query("SELECT id FROM vat_rate_codes ORDER BY id LIMIT 1");
    // the VAT page edits and (de)activates through the same PUT
    if (vatRow) {
      expectDenied(await call("acct", "put", `/api/vat-rate-codes/${vatRow.id}`, { code: "x", description: "x", rate: 0 }));
      expectDenied(await call("acct", "put", `/api/vat-rate-codes/${vatRow.id}`, { status: "INACTIVE" }));
    }
    expect(await n("SELECT COUNT(*) n FROM ewt_library WHERE atc_code LIKE ?", [`${P}%`])).toBe(ewtBefore);
    expect(await n("SELECT COUNT(*) n FROM vat_rate_codes")).toBe(vatBefore);
    expect(Number((await pool.query("SELECT rate FROM ewt_library WHERE id = ?", [ids.ewt]))[0][0].rate)).toBe(2);
  });
});

// ===========================================================================
describe("TC-RBAC-004 Bank reconciliation approval (maker-checker)", () => {
  test("ACCOUNTANT does the normal work: create a session, import a statement, list, raise an adjustment", async () => {
    const session = await call("acct", "post", "/api/bank-recon/sessions", { bankAccountId: ids.bank, periodStart: "2096-05-01", periodEnd: "2096-05-31", statementBeginningBalance: 0, statementEndingBalance: 0 });
    expect(session.status).toBe(200);
    ids.session = session.body.id;
    ids.sessions = [ids.session];
    const imp = await request(app).post(`/api/bank-recon/sessions/${ids.session}/import`).set({ Authorization: `Bearer ${tok.acct}` })
      .attach("file", Buffer.from(["Date,Description,Reference,Debit,Credit", "2096-05-31,Service charge,,25,0", "2096-05-31,Other charge,,7,0"].join("\n")), "statement.csv");
    expect(imp.status).toBe(200);
    expect((await call("acct", "get", "/api/bank-recon/sessions")).status).toBe(200);
    expect((await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/run-matching`)).status).toBe(200);
    const [lines] = await pool.query("SELECT id, description FROM bank_recon_statement_lines WHERE session_id = ? ORDER BY id", [ids.session]);
    for (const [key, desc, amount] of [["adj1", "Service charge", 25], ["adj2", "Other charge", 7]]) {
      const res = await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/adjustments`, { statementLineId: lines.find((l) => l.description === desc).id, adjustmentType: "OTHER", amount });
      expect(res.status).toBe(200);
      ids[key] = res.body.id;
    }
    expect((await call("acct", "get", `/api/bank-recon/sessions/${ids.session}/adjustments`)).status).toBe(200);
    expect((await call("acct", "get", `/api/bank-recon/sessions/${ids.session}/summary`)).status).toBe(200);
  });

  test("ACCOUNTANT: approve / reject / post / finalize / reopen -> 403; the adjustment and session are untouched", async () => {
    const snap = async () => (await pool.query(
      `SELECT (SELECT GROUP_CONCAT(CONCAT(id, ':', status, ':', IFNULL(jv_id, '-')) ORDER BY id) FROM bank_recon_adjustments WHERE session_id = ?) a,
              (SELECT status FROM bank_recon_sessions WHERE id = ?) s`, [ids.session, ids.session]))[0][0];
    const before = await snap();
    expectDenied(await call("acct", "post", `/api/bank-recon/adjustments/${ids.adj1}/approve`, { suggestedAccountId: ids.chargeGL }));
    expectDenied(await call("acct", "post", `/api/bank-recon/adjustments/${ids.adj1}/reject`, {}));
    expectDenied(await call("acct", "post", `/api/bank-recon/adjustments/${ids.adj1}/post`, {}));
    expectDenied(await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/finalize`, { overrideReason: "x" }));
    expectDenied(await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/reopen`, { reason: "x" }));
    expect(await snap()).toEqual(before);
  });

  test("ADMIN (the reviewer) approves and rejects the accountant's adjustments", async () => {
    expect((await call("admin", "post", `/api/bank-recon/adjustments/${ids.adj1}/approve`, { suggestedAccountId: ids.chargeGL })).status).toBe(200);
    expect((await call("admin", "post", `/api/bank-recon/adjustments/${ids.adj2}/reject`, { reason: `${P}reject` })).status).toBe(200);
    const [rows] = await pool.query("SELECT id, status FROM bank_recon_adjustments WHERE id IN (?, ?) ORDER BY id", [ids.adj1, ids.adj2]);
    expect(rows.map((r) => r.status)).toEqual(["APPROVED", "REJECTED"]);
  });

  test("ACCOUNTANT still cannot post the now-approved adjustment; ADMIN posts it (a JV is created)", async () => {
    expectDenied(await call("acct", "post", `/api/bank-recon/adjustments/${ids.adj1}/post`, {}));
    expect((await pool.query("SELECT jv_id FROM bank_recon_adjustments WHERE id = ?", [ids.adj1]))[0][0].jv_id).toBeNull();
    const res = await call("admin", "post", `/api/bank-recon/adjustments/${ids.adj1}/post`, {});
    expect(res.status).toBe(200);
    expect((await pool.query("SELECT jv_id FROM bank_recon_adjustments WHERE id = ?", [ids.adj1]))[0][0].jv_id).not.toBeNull();
  });

  test("finalize / reopen: ACCOUNTANT 403 at every step; ADMIN finalizes and reopens", async () => {
    const status = async () => (await pool.query("SELECT status FROM bank_recon_sessions WHERE id = ?", [ids.session]))[0][0].status;
    const open = await status();
    expectDenied(await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/finalize`, { overrideReason: `${P}finalize` }));
    expect(await status()).toBe(open);
    expect((await call("admin", "post", `/api/bank-recon/sessions/${ids.session}/finalize`, { overrideReason: `${P}finalize` })).status).toBe(200);
    const finalized = await status();
    expect(finalized).not.toBe(open);
    expectDenied(await call("acct", "post", `/api/bank-recon/sessions/${ids.session}/reopen`, { reason: `${P}reopen` }));
    expect(await status()).toBe(finalized);
    expect((await call("admin", "post", `/api/bank-recon/sessions/${ids.session}/reopen`, { reason: `${P}reopen` })).status).toBe(200);
    expect(await status()).not.toBe(finalized);
  });
});

// ===========================================================================
describe("TC-RBAC-005 transaction-form lookups", () => {
  test("ACCOUNTANT loads every lookup a transaction form uses without a permission error", async () => {
    const checks = {
      coa: await call("acct", "get", "/api/coa"),
      parties: await call("acct", "get", "/api/genlib"),
      vat: await call("acct", "get", "/api/vat-rate-codes"),
      ewt: await call("acct", "get", "/api/ewt-library"),
      bankCodes: await call("acct", "get", "/api/bank-codes"),
      currencies: await call("acct", "get", "/api/currencies").query({ companyId: ids.co }),
      rate: await call("acct", "post", "/api/exchange-rates/resolve", { currencyId: ids.xrb, transactionDate: "2096-05-15" }),
    };
    expect(Object.fromEntries(Object.entries(checks).map(([k, r]) => [k, r.status]))).toEqual({ coa: 200, parties: 200, vat: 200, ewt: 200, bankCodes: 200, currencies: 200, rate: 200 });
    expect(Number(checks.rate.body.rate)).toBe(58.25);
    const curs = Array.isArray(checks.currencies.body) ? checks.currencies.body : checks.currencies.body.currencies || checks.currencies.body.rows;
    expect(curs.some((c) => c.currencyCode === "XRB")).toBe(true);
  });

  test("the transaction forms read exactly these endpoints (source, read-only - transaction code is not changed)", () => {
    const SRC = path.join(__dirname, "../..");
    const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
    const layout = read("pages/TRANSACTIONS/TransactionFormLayout.jsx");
    expect(layout).toMatch(/\/api\/coa/);
    expect(layout).toMatch(/\/api\/genlib/);
    // both tax lookups are loaded by the shared layout and passed down to the VAT / EWT entry modals
    expect(layout).toMatch(/\/api\/vat-rate-codes/);
    expect(layout).toMatch(/\/api\/ewt-library/);
  });

  test("the lookups match the permissions the API enforces (VIEW only)", () => {
    const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    expect(server).toMatch(/app\.get\("\/api\/coa", authenticateToken, authorizePermission\("FILESETUP\.COA", "VIEW"\)/);
    expect(server).toMatch(/app\.get\("\/api\/genlib", authenticateToken, authorizePermission\("FILESETUP\.GENLIB", "VIEW"\)/);
    expect(server).toMatch(/app\.get\("\/api\/ewt-library", authenticateToken, authorizePermission\("FILESETUP\.TAX_SETUP", "VIEW"\)/);
    expect(server).toMatch(/app\.get\("\/api\/vat-rate-codes", authenticateToken, authorizePermission\("FILESETUP\.TAX_SETUP", "VIEW"\)/);
  });
});

// ===========================================================================
describe("TC-RBAC-006 security regression: every administrative action stays 403 for ACCOUNTANT, with no database write", () => {
  const TABLES = [
    "chart_of_accounts", "general_libraries", "ewt_library", "vat_rate_codes", "account_group_codes", "report_sections",
    "prepaid_accounts", "fixed_assets", "bank_codes", "currency_rates", "rfp_headers", "users", "user_permissions",
    "role_permissions", "companies", "invitations", "accounting_periods", "accounting_period_history",
  ];
  const checksums = async () => {
    const out = {};
    for (const t of TABLES) out[t] = String((await pool.query(`CHECKSUM TABLE ${t}`))[0][0].Checksum);
    return out;
  };

  test("File Setup administration, approvals and system administration -> 403; every table byte-identical", async () => {
    const [[acctRole]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const [[rate]] = await pool.query("SELECT id FROM currency_rates WHERE company_id = ? ORDER BY id LIMIT 1", [ids.co]);
    const csv = (header) => Buffer.from(`${header}\n`);
    const upload = (url, header) => request(app).post(url).set({ Authorization: `Bearer ${tok.acct}` }).attach("file", csv(header), "f.csv");
    const before = await checksums();
    const attempts = {
      "COA create": call("acct", "post", "/api/coa", { code: `${P}X`, date: "2096-01-01", title: "x", accountClass: "ASSET" }),
      "COA edit": call("acct", "put", `/api/coa/${ids.expense}`, { code: `${P}6100`, date: "2096-01-01", title: "x", accountClass: "EXPENSE" }),
      "COA delete": call("acct", "delete", `/api/coa/${ids.expense}`),
      "GenLib create": call("acct", "post", "/api/genlib", { code: `${P}X`, name: "x", type: "CUSTOMER" }),
      "GenLib edit": call("acct", "put", "/api/genlib/999999999", { code: `${P}X`, name: "x", type: "CUSTOMER" }),
      "GenLib delete": call("acct", "delete", "/api/genlib/999999999"),
      "EWT configure": call("acct", "post", "/api/ewt-library", { atcCode: `${P}X`, description: "x", rate: 1, taxType: "EWT" }),
      "VAT configure": call("acct", "post", "/api/vat-rate-codes", { code: `${P}X`, description: "x", rate: 12 }),
      "Group code create": call("acct", "post", "/api/group-codes", { groupCode: `${P}X`, groupDescription: "x", accountClass: "ASSET" }),
      "Group code edit": call("acct", "put", "/api/group-codes/999999999", { groupCode: `${P}X`, groupDescription: "x", accountClass: "ASSET" }),
      "Group code delete": call("acct", "delete", "/api/group-codes/999999999"),
      "Group code import": upload("/api/group-codes/import/preview", "Group Code,Group Description,Account Class"),
      "Report section create": call("acct", "post", "/api/report-sections", { code: "UAT_RBAC_R1R4_X", name: "x", accountClass: "ASSET", displayOrder: 1 }),
      "Report section edit": call("acct", "put", "/api/report-sections/999999999", { code: "UAT_RBAC_R1R4_X", name: "x" }),
      "Report section delete": call("acct", "delete", "/api/report-sections/999999999"),
      "Prepaid view": call("acct", "get", "/api/prepaid-accounts"),
      "Prepaid create": call("acct", "post", "/api/prepaid-accounts", { prepaidCode: `${P}X`, description: "x", accountCode: `${P}6100`, startDate: "2096-01-01", amount: 1, termMonths: 1 }),
      "Prepaid edit": call("acct", "put", "/api/prepaid-accounts/999999999", { prepaidCode: `${P}X` }),
      "Prepaid delete": call("acct", "delete", "/api/prepaid-accounts/999999999"),
      "Fixed asset view": call("acct", "get", "/api/fixed-assets"),
      "Fixed asset create": call("acct", "post", "/api/fixed-assets", { assetCode: `${P}X`, assetName: "x", acquisitionDate: "2096-01-01", acquisitionCost: 1, usefulLifeYears: 1 }),
      "Fixed asset edit": call("acct", "put", "/api/fixed-assets/999999999", { assetCode: `${P}X` }),
      "Fixed asset delete": call("acct", "delete", "/api/fixed-assets/999999999"),
      "Bank code create": call("acct", "post", "/api/bank-codes", { bankCode: `${P}X`, bankName: "x", accountNo: "1", accountName: "x", status: "ACTIVE" }),
      "Bank code sync": call("acct", "post", "/api/bank-codes/sync", {}),
      "Bank code edit": call("acct", "put", `/api/bank-codes/${ids.bank}`, { bankCode: `${P}BK`, bankName: "hijack" }),
      "Bank code delete": call("acct", "delete", `/api/bank-codes/${ids.bank}`),
      "Exchange-rate approval": call("acct", "patch", `/api/exchange-rates/${rate.id}/approve`, {}),
      "RFP approve": call("acct", "post", "/api/rfp/999999999/approve", {}),
      "RFP return": call("acct", "post", "/api/rfp/999999999/return", { reason: "x" }),
      "RFP reject": call("acct", "post", "/api/rfp/999999999/reject", { reason: "x" }),
      "Users list": call("acct", "get", "/api/users"),
      "User edit": call("acct", "patch", `/api/users/${ids.admin}/status`, { status: "INACTIVE" }),
      "User access": call("acct", "put", `/api/users/${ids.admin}/access`, { companyIds: [] }),
      "Roles: change permissions": call("acct", "put", `/api/roles/${acctRole.id}/permissions`, { permissions: [] }),
      "Audit logs": call("acct", "get", "/api/audit-logs"),
      "Company setup view": call("acct", "get", "/api/company-profile"),
      "Company setup save": call("acct", "put", "/api/company-profile", { payorName: "hijack" }),
      "Periods: generate": call("acct", "post", "/api/accounting-periods/generate-year", { year: 2096 }),
      "Periods: soft-close": call("acct", "post", "/api/accounting-periods/999999999/soft-close", {}),
      "Periods: close": call("acct", "post", "/api/accounting-periods/999999999/close", {}),
      "Periods: reopen": call("acct", "post", "/api/accounting-periods/999999999/reopen", { reason: "x" }),
      "Invitations": call("acct", "post", "/api/invitations", { email: "nobody@example.invalid" }),
      "Access restrictions list": call("acct", "get", "/api/access-restrictions"),
      "Access restrictions create": call("acct", "post", "/api/access-restrictions", { type: "IP", value: "10.0.0.1" }),
    };
    const statuses = {};
    for (const [label, req] of Object.entries(attempts)) {
      const res = await req;
      statuses[label] = res.status;
      // a refusal carries a message only - no records leak in the body
      if (res.status === 403) expect([label, Object.keys(res.body || {}).every((k) => ["message", "code", "error", "module", "action", "required"].includes(k))]).toEqual([label, true]);
    }
    expect(statuses).toEqual(Object.fromEntries(Object.keys(attempts).map((k) => [k, 403])));
    expect(await checksums()).toEqual(before);
  });
});
