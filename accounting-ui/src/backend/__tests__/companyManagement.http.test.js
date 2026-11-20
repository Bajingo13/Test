// Company Management + branch-assignment security (TC-COMPANY-001 .. 021).
// Workflow under test:
//   SUPER_ADMIN creates Company B (POST /api/company-management)
//   -> SUPER_ADMIN assigns the initial ADMIN to Company B (PATCH /api/users/:id)
//   -> that ADMIN creates Company B's branches (Branch Management)
//   -> that ADMIN assigns an ACCOUNTANT to Company B and to Company B's branches.
// Real seeded roles; role permissions are never changed. Local test database only.
// Fixture prefix UAT-COMPANY-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const audit = require("../lib/audit");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-COMPANY-";
const PW = "UatCompany!2026";
const tok = {};
const uid = {};
const co = {};
const br = {};
const createdCompanies = [];

async function login(tag) {
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
}
async function makeUser(tag, roleCode, companyIds) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id]);
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  uid[tag] = u.insertId;
  await login(tag);
}
const call = (who, method, url, body) => {
  const r = request(app)[method](url);
  if (who) r.set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
const n = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);
const companyRows = () => n("SELECT COUNT(*) n FROM companies");
const currencyRows = () => n("SELECT COUNT(*) n FROM currencies");
const access = async (userId) => ({
  companies: (await pool.query("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id", [userId]))[0].map((r) => r.company_id),
  branches: (await pool.query("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id", [userId]))[0].map((r) => r.branch_id),
});
const VALID = (k) => ({ name: `${P}${k} Trading Corp.`, tin: `900-${String(k).length}00-123-${String(Date.now()).slice(-3)}`, address: "Cebu City", zip: "6000", telephone: "032-555-0101", email: "info@example.test", branchCode: "000" });
const TX_TABLES = ["invoice_headers", "or_headers", "apv_headers", "cv_headers", "jv_headers", "memo_headers", "petty_cash_headers", "purchase_order_headers", "quotation_headers", "rfp_headers", "recurring_transaction_templates", "bank_recon_sessions", "deposit_slips", "fx_revaluation_sessions"];

beforeAll(async () => {
  assertNotProductionDatabase();
  co.A = (await pool.query("INSERT INTO companies (name, tin, status) VALUES (?, '900-000-000-001', 'ACTIVE')", [`${P}A Holdings`]))[0].insertId;
  createdCompanies.push(co.A);
  await makeUser("super", "SUPER_ADMIN", []);
  await makeUser("admin-a", "ADMIN", [co.A]);
  await makeUser("acct-a", "ACCOUNTANT", [co.A]);
  await makeUser("admin-b", "ADMIN", [co.A]); // becomes Company B's admin
  await makeUser("acct-b", "ACCOUNTANT", [co.A]); // becomes Company B's accountant
  const mk = await call("admin-a", "post", "/api/company-branches", { code: "MAIN", name: "A Main Branch" });
  br.A_MAIN = mk.body.branch.id;
});

afterAll(async () => {
  try {
    const users = Object.values(uid);
    const companies = createdCompanies;
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR company_id IN (?) OR (module = 'COMPANY' AND entity_id IN (?))", [users, companies, companies]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?) OR company_id IN (?)", [users, companies]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("permission model", () => {
  test("FILESETUP.COMPANIES / CREATE exists, explicitly denied to ADMIN and ACCOUNTANT (Super Admin only by bypass)", async () => {
    const [rows] = await pool.query(
      `SELECT r.code, rp.granted FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE p.module_key = 'FILESETUP.COMPANIES' AND p.action = 'CREATE' ORDER BY r.code`);
    expect(rows.map((r) => [r.code, Number(r.granted)])).toEqual([["ACCOUNTANT", 0], ["ADMIN", 0]]);
  });
});

// ===========================================================================
describe("company creation", () => {
  test("TC-COMPANY-001 SUPER_ADMIN can view companies (with status, branch / user counts, base currency)", async () => {
    const res = await call("super", "get", "/api/company-management");
    expect(res.status).toBe(200);
    expect(res.body.find((c) => c.id === co.A)).toMatchObject({ name: `${P}A Holdings`, status: "ACTIVE", branchCount: 1, userCount: 4 });
  });

  test("TC-COMPANY-002 SUPER_ADMIN creates a company: the row, its PHP base currency, nothing else; safe response", async () => {
    const before = [await companyRows(), await currencyRows()];
    const body = { ...VALID("B"), name: `  ${P}B Trading Corp.  ` };
    const res = await call("super", "post", "/api/company-management", body);
    expect(res.status).toBe(201);
    co.B = res.body.company.id;
    createdCompanies.push(co.B);
    expect(res.body.company).toMatchObject({ id: co.B, name: `${P}B Trading Corp.`, status: "ACTIVE", baseCurrency: "PHP", branchCount: 0, userCount: 0, vatRegistered: true, branchCode: "000" });
    expect(Object.keys(res.body.company).some((k) => /password|token|secret|hash/i.test(k))).toBe(false);
    expect([await companyRows(), await currencyRows()]).toEqual([before[0] + 1, before[1] + 1]);
    const [[cur]] = await pool.query("SELECT currency_code, is_base_currency, is_active, current_rate FROM currencies WHERE company_id = ?", [co.B]);
    expect([cur.currency_code, Number(cur.is_base_currency), Number(cur.is_active), Number(cur.current_rate)]).toEqual(["PHP", 1, 1, 1]);
    expect(await n("SELECT COUNT(*) n FROM branches WHERE company_id = ?", [co.B])).toBe(0); // no branch is required
  });

  test("TC-COMPANY-003 duplicate identifiers are rejected (name, case / space-insensitive; TIN + BIR branch code)", async () => {
    const before = await companyRows();
    const dupName = await call("super", "post", "/api/company-management", { ...VALID("X"), name: `${P}b trading CORP.` });
    expect([dupName.status, dupName.body.code]).toEqual([409, "COMPANY_NAME_DUPLICATE"]);
    const [[b]] = await pool.query("SELECT tin FROM companies WHERE id = ?", [co.B]);
    const dupTin = await call("super", "post", "/api/company-management", { ...VALID("Y"), tin: b.tin.replace(/-/g, " "), branchCode: "000" });
    expect([dupTin.status, dupTin.body.code]).toEqual([409, "COMPANY_TIN_DUPLICATE"]);
    expect(await companyRows()).toBe(before);
    // the same TIN under a different BIR branch code is a different registration
    const other = await call("super", "post", "/api/company-management", { ...VALID("Z"), tin: b.tin, branchCode: "001" });
    expect(other.status).toBe(201);
    createdCompanies.push(other.body.company.id);
  });

  test.each([
    [{ name: "" }, "COMPANY_NAME_REQUIRED"],
    [{ name: "   " }, "COMPANY_NAME_REQUIRED"],
    [{ tin: "" }, "COMPANY_TIN_REQUIRED"],
    [{ tin: "ABC-123" }, "COMPANY_TIN_INVALID"],
    [{ tin: "123-45" }, "COMPANY_TIN_INVALID"],
    [{ email: "not-an-email" }, "COMPANY_EMAIL_INVALID"],
    [{ branchCode: "MAIN" }, "COMPANY_BRANCH_CODE_INVALID"],
    [{ name: `${P}${"N".repeat(260)}` }, "COMPANY_NAME_TOO_LONG"],
    [{ address: "A".repeat(256) }, "COMPANY_ADDRESS_TOO_LONG"],
  ])("TC-COMPANY-004 invalid data %j -> 400 %s, nothing written", async (patch, code) => {
    const before = [await companyRows(), await currencyRows(), await n("SELECT COUNT(*) n FROM audit_logs WHERE module = 'COMPANY'")];
    const res = await call("super", "post", "/api/company-management", { ...VALID("V"), ...patch });
    expect([res.status, res.body.code]).toEqual([400, code]);
    expect([await companyRows(), await currencyRows(), await n("SELECT COUNT(*) n FROM audit_logs WHERE module = 'COMPANY'")]).toEqual(before);
  });

  test("TC-COMPANY-005 creation is atomic: a failure at the last step (audit) leaves no company and no currency", async () => {
    const before = [await companyRows(), await currencyRows()];
    const spy = jest.spyOn(audit, "logAudit").mockImplementationOnce(async () => { throw new Error("simulated audit failure"); });
    const res = await call("super", "post", "/api/company-management", VALID("ATOMIC"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect([await companyRows(), await currencyRows()]).toEqual(before);
    expect(await n("SELECT COUNT(*) n FROM companies WHERE name = ?", [`${P}ATOMIC Trading Corp.`])).toBe(0);
  });

  test("TC-COMPANY-006 creation is audited: COMPANY / CREATE with id, name, actor, time", async () => {
    const [[a]] = await pool.query("SELECT module, entity_type, entity_id, action, after_data, user_id, username, company_id, created_at FROM audit_logs WHERE module = 'COMPANY' AND entity_id = ?", [co.B]);
    const after = typeof a.after_data === "string" ? JSON.parse(a.after_data) : a.after_data;
    expect([a.entity_type, a.action, a.user_id, a.username, a.company_id]).toEqual(["COMPANY", "CREATE", uid.super, `${P}super`, co.B]);
    expect(after).toMatchObject({ id: co.B, name: `${P}B Trading Corp.`, status: "ACTIVE", baseCurrency: "PHP" });
    expect(a.created_at).toBeTruthy();
  });

  test("TC-COMPANY-007 / 008 / 021 ADMIN, ACCOUNTANT and anonymous cannot create or list companies: 403 / 401, no change, ACCESS_DENIED", async () => {
    const before = [await companyRows(), await currencyRows()];
    for (const who of ["admin-a", "acct-a"]) {
      for (const res of [await call(who, "post", "/api/company-management", VALID("DENIED")), await call(who, "get", "/api/company-management")]) {
        expect(res.status).toBe(403);
        expect(Object.keys(res.body)).toEqual(["message"]);
      }
      expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE user_id = ? AND action = 'ACCESS_DENIED' AND after_data LIKE '%FILESETUP.COMPANIES%'", [uid[who]])).toBeGreaterThanOrEqual(2);
    }
    expect((await call(null, "post", "/api/company-management", VALID("ANON"))).status).toBe(401);
    expect([await companyRows(), await currencyRows()]).toEqual(before);
    expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE module = 'COMPANY' AND user_id IN (?, ?)", [uid["admin-a"], uid["acct-a"]])).toBe(0);
  });

  test("TC-COMPANY-018 / 019 / 020 the new company starts empty: no transactions, nothing copied, one audit row", async () => {
    for (const t of TX_TABLES) expect([t, await n(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`, [co.B])]).toEqual([t, 0]);
    for (const t of ["general_libraries", "accounting_periods", "gl_beginning_balance_headers", "arap_beginning_balance_headers", "company_rate_policies", "company_fx_accounts", "document_print_templates", "branches", "user_companies"]) {
      expect([t, await n(`SELECT COUNT(*) n FROM ${t} WHERE company_id = ?`, [co.B])]).toEqual([t, 0]);
    }
    expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE company_id = ?", [co.B])).toBe(1);
  });
});

// ===========================================================================
describe("initial admin, then the company's own administration", () => {
  test("TC-COMPANY-010 an ADMIN of Company A cannot assign themselves (or anyone) to Company B", async () => {
    const before = await access(uid["admin-a"]);
    const self = await call("admin-a", "patch", `/api/users/${uid["admin-a"]}`, { companyIds: [co.A, co.B] });
    expect(self.status).toBe(403);
    const other = await call("admin-a", "patch", `/api/users/${uid["acct-a"]}`, { companyIds: [co.A, co.B] });
    expect(other.status).toBe(403);
    const invite = await call("admin-a", "post", "/api/invitations", { email: "uat-company-invite@example.test", fullName: "x", roleId: (await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'"))[0][0].id, companyIds: [co.B] });
    expect(invite.status).toBe(403);
    expect(await access(uid["admin-a"])).toEqual(before);
  });

  test("TC-COMPANY-012 SUPER_ADMIN assigns the initial ADMIN to Company B (audited)", async () => {
    const res = await call("super", "patch", `/api/users/${uid["admin-b"]}`, { companyIds: [co.A, co.B] });
    expect(res.status).toBe(200);
    expect((await access(uid["admin-b"])).companies).toEqual([co.A, co.B].sort((x, y) => x - y));
    expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE module = 'USERS' AND action = 'ACCESS_UPDATED' AND entity_id = ? AND user_id = ?", [uid["admin-b"], uid.super])).toBe(1);
    await login("admin-b"); // an access change signs the user out (token_version)
  });

  test("TC-COMPANY-013 / 014 Company B gets MAIN although Company A has MAIN; codes stay unique within B", async () => {
    for (const [code, name] of [["MAIN", "B Main Branch"], ["BR-A", "B Branch A"], ["BR-B", "B Branch B"]]) {
      const res = await call("admin-b", "post", "/api/company-branches", { code, name, companyId: co.B });
      expect([code, res.status, res.body.branch?.companyId]).toEqual([code, 201, co.B]);
      br[`B_${code}`] = res.body.branch.id;
    }
    const dup = await call("admin-b", "post", "/api/company-branches", { code: "main", name: "dup", companyId: co.B });
    expect([dup.status, dup.body.code]).toEqual([400, "BRANCH_CODE_DUPLICATE"]);
  });

  test("TC-COMPANY-009 the new ADMIN assigns an ACCOUNTANT to Company B and to Company B branches", async () => {
    const res = await call("admin-b", "patch", `/api/users/${uid["acct-b"]}`, { companyIds: [co.B], branchIds: [br.B_MAIN, br["B_BR-A"]] });
    expect(res.status).toBe(200);
    expect(await access(uid["acct-b"])).toEqual({ companies: [co.B], branches: [br.B_MAIN, br["B_BR-A"]].sort((x, y) => x - y) });
    await login("acct-b");
  });

  test("TC-COMPANY-016 / 017 Company B's accountant views B's branches only and cannot change them", async () => {
    const list = await call("acct-b", "get", "/api/company-branches");
    expect(list.body.map((b) => b.code).sort()).toEqual(["BR-A", "BR-B", "MAIN"]);
    expect(list.body.every((b) => b.companyId === co.B)).toBe(true);
    for (const res of [
      await call("acct-b", "post", "/api/company-branches", { code: "BR-X", name: "x" }),
      await call("acct-b", "put", `/api/company-branches/${br.B_MAIN}`, { code: "MAIN", name: "hijack" }),
      await call("acct-b", "patch", `/api/company-branches/${br.B_MAIN}/status`, { status: "INACTIVE" }),
    ]) expect(res.status).toBe(403);
    expect(await n("SELECT COUNT(*) n FROM branches WHERE company_id = ?", [co.B])).toBe(3);
  });

  test("the accountant cannot create companies or manage user / branch assignments", async () => {
    expect((await call("acct-b", "post", "/api/company-management", VALID("ACCT"))).status).toBe(403);
    expect((await call("acct-b", "patch", `/api/users/${uid["acct-b"]}`, { branchIds: [br.B_MAIN, br["B_BR-A"], br["B_BR-B"]] })).status).toBe(403);
    expect((await access(uid["acct-b"])).branches).toHaveLength(2);
  });
});

// ===========================================================================
describe("branch-assignment security (server-side)", () => {
  test("TC-COMPANY-011 an ADMIN of Company A cannot assign a Company B branch: 403, identical to an unknown branch", async () => {
    const before = await access(uid["acct-a"]);
    const foreign = await call("admin-a", "patch", `/api/users/${uid["acct-a"]}`, { branchIds: [br.B_MAIN] });
    const unknown = await call("admin-a", "patch", `/api/users/${uid["acct-a"]}`, { branchIds: [999999999] });
    expect([foreign.status, unknown.status]).toEqual([403, 403]);
    expect(foreign.body).toEqual(unknown.body);
    expect(await access(uid["acct-a"])).toEqual(before);
  });

  test("a user outside the ADMIN's companies is refused exactly like an unknown user (404)", async () => {
    const outside = await call("admin-a", "patch", `/api/users/${uid["acct-b"]}`, { branchIds: [br.A_MAIN] });
    const unknown = await call("admin-a", "patch", "/api/users/999999999", { branchIds: [br.A_MAIN] });
    expect([outside.status, unknown.status]).toEqual([404, 404]);
    expect(outside.body).toEqual(unknown.body);
    expect((await access(uid["acct-b"])).branches).not.toContain(br.A_MAIN);
  });

  test("a branch never crosses a company boundary - not even for a two-company ADMIN or the Super Admin", async () => {
    // admin-b may manage acct-a (shared Company A) and owns Company B's branches,
    // but acct-a does not belong to Company B
    const viaAdmin = await call("admin-b", "patch", `/api/users/${uid["acct-a"]}`, { branchIds: [br.B_MAIN] });
    expect(viaAdmin.status).toBe(400);
    const viaSuper = await call("super", "patch", `/api/users/${uid["acct-a"]}`, { branchIds: [br.B_MAIN] });
    expect(viaSuper.status).toBe(400);
    expect(viaSuper.body.message).toMatch(/belongs to that branch's company/);
    const invite = await call("super", "post", "/api/invitations", { email: "uat-company-x@example.test", fullName: "x", roleId: (await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'"))[0][0].id, companyIds: [co.A], branchIds: [br.B_MAIN] });
    expect(invite.status).toBe(400);
    expect((await access(uid["acct-a"])).branches).toEqual([]);
  });

  test("valid same-company assignments keep working (the ADMIN need not be assigned to the branch personally)", async () => {
    expect((await access(uid["admin-a"])).branches).toEqual([]);
    const res = await call("admin-a", "patch", `/api/users/${uid["acct-a"]}`, { branchIds: [br.A_MAIN] });
    expect(res.status).toBe(200);
    expect((await access(uid["acct-a"])).branches).toEqual([br.A_MAIN]);
    await login("acct-a");
  });

  test("the assignment pickers list the branches of the caller's companies (with status)", async () => {
    const a = await call("admin-a", "get", "/api/branches");
    expect(a.body.map((b) => b.id)).toContain(br.A_MAIN);
    expect(a.body.some((b) => [br.B_MAIN, br["B_BR-A"], br["B_BR-B"]].includes(b.id))).toBe(false);
    const b = await call("admin-b", "get", "/api/branches");
    expect([br.A_MAIN, br.B_MAIN, br["B_BR-A"], br["B_BR-B"]].every((id) => b.body.some((x) => x.id === id))).toBe(true);
    expect(b.body.every((x) => typeof x.status === "string")).toBe(true);
  });
});

// ===========================================================================
describe("company isolation", () => {
  test("TC-COMPANY-015 Company A cannot read Company B's branches", async () => {
    expect((await call("admin-a", "get", `/api/company-branches/${br.B_MAIN}`)).status).toBe(404);
    expect((await call("acct-a", "get", "/api/company-branches")).body.some((b) => b.companyId === co.B)).toBe(false);
    expect((await call("admin-a", "get", `/api/company-branches?companyId=${co.B}`)).status).toBe(403);
  });

  test("company profile: Company A's admin cannot open Company B's; Company B's admin can", async () => {
    expect((await call("admin-a", "get", `/api/company-profile?companyId=${co.B}`)).status).toBe(403);
    expect((await call("admin-a", "put", "/api/company-profile", { companyId: co.B, payorName: "hijack", payorTin: "1" })).status).toBe(403);
    const own = await call("admin-b", "get", `/api/company-profile?companyId=${co.B}`);
    expect([own.status, own.body.payorName]).toEqual([200, `${P}B Trading Corp.`]);
    expect((await pool.query("SELECT name FROM companies WHERE id = ?", [co.B]))[0][0].name).toBe(`${P}B Trading Corp.`);
  });

  test("users / assignments: Company A's admin does not see Company B's accountant", async () => {
    const list = await call("admin-a", "get", "/api/users");
    expect(list.status).toBe(200);
    const rows = Array.isArray(list.body) ? list.body : list.body.users || list.body.rows || [];
    expect(rows.some((u) => u.id === uid["acct-b"])).toBe(false);
    expect((await call("admin-a", "get", `/api/users/${uid["acct-b"]}`)).status).toBe(404);
  });

  test("General Libraries: a Company B party is invisible to Company A", async () => {
    const mk = await call("admin-b", "post", "/api/genlib", { code: `${P}SUP-B`, name: "UAT Company B Supplier", type: "SUPPLIER", companyId: co.B });
    expect(mk.status).toBe(200);
    expect((await call("admin-a", "get", "/api/genlib")).body.some((p) => p.code === `${P}SUP-B`)).toBe(false);
    expect((await call("acct-b", "get", "/api/genlib")).body.some((p) => p.code === `${P}SUP-B`)).toBe(true);
  });

  test("Company A is untouched by Company B's setup", async () => {
    expect(await n("SELECT COUNT(*) n FROM branches WHERE company_id = ?", [co.A])).toBe(1);
    expect(await n("SELECT COUNT(*) n FROM currencies WHERE company_id = ?", [co.A])).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM general_libraries WHERE company_id = ?", [co.A])).toBe(0);
  });
});
