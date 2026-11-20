// Company Branch Management (ONE company -> MANY branches) - API, RBAC,
// company isolation and audit. TC-BRANCH-001 .. TC-BRANCH-004 plus the
// validation / isolation / audit matrix. Master data only: no transaction table
// or API is involved. Real seeded roles (ADMIN: all FILESETUP.BRANCHES actions,
// ACCOUNTANT: VIEW - branch_management_migration.sql). Branches are created
// through the API, never inserted directly. Local test database only.
// Fixture prefix UAT-BRANCH-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-BRANCH-";
const PW = "UatBranch!2026";
const tok = {};
const userIds = {};
const co = {};
const br = {};

async function makeUser(tag, roleCode, companyIds) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id]);
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  userIds[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
}
const call = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
const n = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);
const branchCount = () => n("SELECT COUNT(*) n FROM branches WHERE company_id IN (?)", [Object.values(co)]);
const branchAudits = (action) => n("SELECT COUNT(*) n FROM audit_logs WHERE module = 'FILESETUP.BRANCHES' AND company_id IN (?)" + (action ? " AND action = ?" : ""), action ? [Object.values(co), action] : [Object.values(co)]);
const snapshot = async (id) => (await pool.query("SELECT company_id, code, name, address, telephone, email, status FROM branches WHERE id = ?", [id]))[0][0];
const create = (who, body) => call(who, "post", "/api/company-branches", body);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const [k, status] of [["A", "ACTIVE"], ["B", "ACTIVE"], ["EMPTY", "ACTIVE"], ["INACTIVE", "ACTIVE"]]) {
    co[k] = (await pool.query("INSERT INTO companies (name, status) VALUES (?, ?)", [`${P}COMPANY-${k}`, status]))[0].insertId;
  }
  await makeUser("admin-a", "ADMIN", [co.A]);
  await makeUser("acct-a", "ACCOUNTANT", [co.A]);
  await makeUser("admin-b", "ADMIN", [co.B]);
  await makeUser("acct-b", "ACCOUNTANT", [co.B]);
  await makeUser("admin-ab", "ADMIN", [co.A, co.B]);
  await makeUser("admin-empty", "ADMIN", [co.EMPTY]);
  await makeUser("admin-inactive", "ADMIN", [co.INACTIVE]);
  await makeUser("super", "SUPER_ADMIN", []);
  // an accountant whose VIEW is revoked by a per-user override (unauthorized access)
  await makeUser("acct-noview", "ACCOUNTANT", [co.A]);
  const [[view]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'FILESETUP.BRANCHES' AND action = 'VIEW'");
  await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'UAT-BRANCH- no view')", [userIds["acct-noview"], view.id]);
});

afterAll(async () => {
  try {
    const users = Object.values(userIds);
    const companies = Object.values(co);
    await pool.query("DELETE FROM audit_logs WHERE company_id IN (?) OR user_id IN (?)", [companies, users]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("permissions (seeded by the migration)", () => {
  const granted = async (role) => (await pool.query(
    `SELECT p.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = ? AND p.module_key = 'FILESETUP.BRANCHES' AND rp.granted = 1 ORDER BY p.action`, [role]))[0].map((r) => r.action);
  test("ADMIN: VIEW / CREATE / EDIT / ACTIVATE / DEACTIVATE; ACCOUNTANT: VIEW only; no DELETE action exists", async () => {
    expect(await granted("ADMIN")).toEqual(["ACTIVATE", "CREATE", "DEACTIVATE", "EDIT", "VIEW"]);
    expect(await granted("ACCOUNTANT")).toEqual(["VIEW"]);
    expect(await n("SELECT COUNT(*) n FROM permissions WHERE module_key = 'FILESETUP.BRANCHES' AND action = 'DELETE'")).toBe(0);
  });
});

// ===========================================================================
describe("TC-BRANCH-003 branch creation by ADMIN (+ multiple companies, same codes)", () => {
  test("ADMIN of Company A creates MAIN, BR-A, BR-B (code normalised to upper case); each is audited", async () => {
    for (const [code, name] of [["main", "Main Branch"], ["BR-A", "Branch A"], [" br-b ", "Branch B"]]) {
      const res = await create("admin-a", { code, name, address: "Cebu City", telephone: "032-123", email: "a@example.test" });
      expect(res.status).toBe(201);
      expect(res.body.branch).toMatchObject({ companyId: co.A, companyName: `${P}COMPANY-A`, code: code.trim().toUpperCase(), name, status: "ACTIVE" });
      br[`A_${code.trim().toUpperCase()}`] = res.body.branch.id;
    }
    expect(await branchAudits("CREATE")).toBe(3);
  });

  test("Company B may use the same code MAIN; its own BR-X", async () => {
    for (const [code, name] of [["MAIN", "Main Branch"], ["BR-X", "Branch X"]]) {
      const res = await create("admin-b", { code, name });
      expect(res.status).toBe(201);
      br[`B_${code}`] = res.body.branch.id;
    }
  });

  test("the new branch appears immediately in the company's list, and the ACCOUNTANT sees it", async () => {
    const res = await create("admin-a", { code: "BR-NEW", name: "Branch New" });
    br.A_NEW = res.body.branch.id;
    expect((await call("admin-a", "get", "/api/company-branches")).body.map((b) => b.code)).toContain("BR-NEW");
    expect((await call("acct-a", "get", "/api/company-branches")).body.map((b) => b.code)).toContain("BR-NEW");
  });

  test("a multi-company ADMIN must say which company; can then create in either", async () => {
    const res = await create("admin-ab", { code: "BR-AB", name: "x" });
    expect(res.status).toBe(400);
    const ok = await create("admin-ab", { code: "BR-AB", name: "Joint", companyId: co.B });
    expect([ok.status, ok.body.branch.companyId]).toEqual([201, co.B]);
    br.B_AB = ok.body.branch.id;
  });
});

// ===========================================================================
describe("validation (400, nothing saved, nothing audited)", () => {
  test.each([
    [{ code: "", name: "x" }, "BRANCH_CODE_REQUIRED"],
    [{ code: "   ", name: "x" }, "BRANCH_CODE_REQUIRED"],
    [{ code: "BR 1", name: "x" }, "BRANCH_CODE_INVALID"],
    [{ code: "-BR", name: "x" }, "BRANCH_CODE_INVALID"],
    [{ code: "X".repeat(51), name: "x" }, "BRANCH_CODE_TOO_LONG"],
    [{ code: "BR-V", name: "   " }, "BRANCH_NAME_REQUIRED"],
    [{ code: "BR-V" }, "BRANCH_NAME_REQUIRED"],
    [{ code: "BR-V", name: "N".repeat(256) }, "BRANCH_NAME_TOO_LONG"],
    [{ code: "BR-V", name: "x", email: "not-an-email" }, "BRANCH_EMAIL_INVALID"],
    [{ code: "BR-V", name: "x", telephone: "9".repeat(51) }, "BRANCH_TELEPHONE_TOO_LONG"],
    [{ code: "BR-V", name: "x", address: "A".repeat(256) }, "BRANCH_ADDRESS_TOO_LONG"],
    [{ code: "BR-V", name: "x", companyId: "abc" }, "BRANCH_COMPANY_INVALID"],
  ])("%j -> %s", async (body, code) => {
    const before = [await branchCount(), await branchAudits()];
    const res = await create("admin-a", body);
    expect([res.status, res.body.code]).toEqual([400, code]);
    expect([await branchCount(), await branchAudits()]).toEqual(before);
  });

  test("duplicate code in the same company (case-insensitive input) -> 400 BRANCH_CODE_DUPLICATE", async () => {
    const before = await branchCount();
    for (const code of ["MAIN", "main", " Br-A "]) {
      const res = await create("admin-a", { code, name: "dup" });
      expect([res.status, res.body.code]).toEqual([400, "BRANCH_CODE_DUPLICATE"]);
    }
    expect(await branchCount()).toBe(before);
  });

  test("the uniqueness rule is in the database, not only the API", async () => {
    await expect(pool.query("INSERT INTO branches (company_id, name, code) VALUES (?, 'raw', 'MAIN')", [co.A])).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  test("nonexistent company (Super Admin) -> 400 COMPANY_NOT_FOUND; inactive company -> 400 COMPANY_INACTIVE", async () => {
    const before = await branchCount();
    const missing = await create("super", { code: "BR-Z", name: "x", companyId: 999999999 });
    expect([missing.status, missing.body.code]).toEqual([400, "COMPANY_NOT_FOUND"]);
    await pool.query("UPDATE companies SET status = 'INACTIVE' WHERE id = ?", [co.INACTIVE]);
    const inactive = await create("admin-inactive", { code: "BR-Z", name: "x" });
    expect([inactive.status, inactive.body.code]).toEqual([400, "COMPANY_INACTIVE"]);
    await pool.query("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [co.INACTIVE]);
    expect(await branchCount()).toBe(before);
  });
});

// ===========================================================================
describe("edit", () => {
  test("valid edit: name / contact change, code renamed; audited with before and after", async () => {
    const res = await call("admin-a", "put", `/api/company-branches/${br.A_NEW}`, { code: "br-new2", name: "Branch New (renamed)", address: "Manila", telephone: "", email: "" });
    expect(res.status).toBe(200);
    expect(await snapshot(br.A_NEW)).toEqual({ company_id: co.A, code: "BR-NEW2", name: "Branch New (renamed)", address: "Manila", telephone: null, email: null, status: "ACTIVE" });
    const [[a]] = await pool.query("SELECT before_data, after_data, company_id FROM audit_logs WHERE module = 'FILESETUP.BRANCHES' AND action = 'EDIT' AND entity_id = ? ORDER BY id DESC LIMIT 1", [br.A_NEW]);
    const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
    expect([parse(a.before_data).code, parse(a.after_data).code, a.company_id]).toEqual(["BR-NEW", "BR-NEW2", co.A]);
  });

  test("rejected edits leave the branch unchanged: duplicate code, company change, status via edit, validation", async () => {
    const before = await snapshot(br.A_NEW);
    for (const [body, code] of [
      [{ code: "BR-A", name: "x" }, "BRANCH_CODE_DUPLICATE"],
      [{ code: "BR-NEW2", name: "x", companyId: co.B }, "BRANCH_COMPANY_READONLY"],
      [{ code: "BR-NEW2", name: "x", status: "INACTIVE" }, "BRANCH_STATUS_READONLY"],
      [{ code: "BR-NEW2", name: "" }, "BRANCH_NAME_REQUIRED"],
    ]) {
      const res = await call("admin-a", "put", `/api/company-branches/${br.A_NEW}`, body);
      expect([res.status, res.body.code]).toEqual([400, code]);
    }
    expect(await snapshot(br.A_NEW)).toEqual(before);
  });

  test("nonexistent branch -> 404; malformed id -> 404", async () => {
    expect((await call("admin-a", "put", "/api/company-branches/999999999", { code: "X", name: "x" })).status).toBe(404);
    expect((await call("admin-a", "get", "/api/company-branches/abc")).status).toBe(404);
  });

  test("a branch of an inactive company cannot be edited or activated (it can still be deactivated)", async () => {
    const made = await create("admin-inactive", { code: "BR-I", name: "Soon inactive" });
    br.I = made.body.branch.id;
    await pool.query("UPDATE companies SET status = 'INACTIVE' WHERE id = ?", [co.INACTIVE]);
    const edit = await call("admin-inactive", "put", `/api/company-branches/${br.I}`, { code: "BR-I", name: "changed" });
    expect([edit.status, edit.body.code]).toEqual([400, "COMPANY_INACTIVE"]);
    expect((await call("admin-inactive", "patch", `/api/company-branches/${br.I}/status`, { status: "INACTIVE" })).status).toBe(200);
    const act = await call("admin-inactive", "patch", `/api/company-branches/${br.I}/status`, { status: "ACTIVE" });
    expect([act.status, act.body.code]).toEqual([400, "COMPANY_INACTIVE"]);
    expect((await snapshot(br.I)).name).toBe("Soon inactive");
    await pool.query("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [co.INACTIVE]);
  });
});

// ===========================================================================
describe("TC-BRANCH-004 activation / deactivation", () => {
  test("ADMIN deactivates BR-B: stays in the list as INACTIVE, gone from the active list; audited", async () => {
    const res = await call("admin-a", "patch", `/api/company-branches/${br["A_BR-B"]}/status`, { status: "INACTIVE" });
    expect([res.status, res.body.branch.status, res.body.changed]).toEqual([200, "INACTIVE", true]);
    const all = (await call("acct-a", "get", "/api/company-branches")).body;
    expect(all.find((b) => b.id === br["A_BR-B"]).status).toBe("INACTIVE");
    const active = (await call("acct-a", "get", "/api/company-branches?status=ACTIVE")).body;
    expect(active.map((b) => b.id)).not.toContain(br["A_BR-B"]);
    expect(active.every((b) => b.status === "ACTIVE")).toBe(true);
    expect((await call("acct-a", "get", "/api/company-branches?status=INACTIVE")).body.map((b) => b.code)).toEqual(["BR-B"]);
    expect(await branchAudits("DEACTIVATE")).toBeGreaterThanOrEqual(1);
  });

  test("deactivating again is a no-op (changed: false, no extra audit); reactivating is audited", async () => {
    const audits = await branchAudits();
    const again = await call("admin-a", "patch", `/api/company-branches/${br["A_BR-B"]}/status`, { status: "INACTIVE" });
    expect([again.status, again.body.changed]).toEqual([200, false]);
    expect(await branchAudits()).toBe(audits);
    const act = await call("admin-a", "patch", `/api/company-branches/${br["A_BR-B"]}/status`, { status: "ACTIVE" });
    expect([act.status, act.body.branch.status]).toEqual([200, "ACTIVE"]);
    expect(await branchAudits("ACTIVATE")).toBe(1);
    await call("admin-a", "patch", `/api/company-branches/${br["A_BR-B"]}/status`, { status: "INACTIVE" });
  });

  test("an unknown status is a 400; nothing is deleted - there is no DELETE route", async () => {
    expect((await call("admin-a", "patch", `/api/company-branches/${br["A_BR-A"]}/status`, { status: "ARCHIVED" })).body.code).toBe("BRANCH_STATUS_INVALID");
    expect((await call("admin-a", "delete", `/api/company-branches/${br["A_BR-A"]}`)).status).toBe(404);
    expect(await n("SELECT COUNT(*) n FROM branches WHERE id = ?", [br["A_BR-A"]])).toBe(1);
  });
});

// ===========================================================================
describe("TC-BRANCH-001 the ACCOUNTANT views the company's branches", () => {
  test("sees exactly Company A's branches, with status (inactive identified), never Company B's", async () => {
    const res = await call("acct-a", "get", "/api/company-branches");
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.code).sort()).toEqual(["BR-A", "BR-B", "BR-NEW2", "MAIN"]);
    expect(res.body.every((b) => b.companyId === co.A && b.companyName === `${P}COMPANY-A`)).toBe(true);
    expect(res.body.find((b) => b.code === "BR-B").status).toBe("INACTIVE");
  });

  test("search by code, name or address (server-side), status filter", async () => {
    const byCode = (await call("acct-a", "get", "/api/company-branches?search=br-a")).body.map((b) => b.code);
    expect(byCode).toEqual(["BR-A"]);
    expect((await call("acct-a", "get", "/api/company-branches?search=Manila")).body.map((b) => b.code)).toEqual(["BR-NEW2"]);
    expect((await call("acct-a", "get", "/api/company-branches?search=Branch%20X")).body).toEqual([]);
    expect((await call("acct-a", "get", "/api/company-branches?status=bogus")).status).toBe(400);
  });

  test("cannot create, edit, activate or deactivate - 403, nothing written, no success audit", async () => {
    const before = [await branchCount(), await branchAudits(), await snapshot(br["A_BR-A"])];
    const denied = [
      await create("acct-a", { code: "BR-ACCT", name: "x" }),
      await call("acct-a", "put", `/api/company-branches/${br["A_BR-A"]}`, { code: "BR-A", name: "hijack" }),
      await call("acct-a", "patch", `/api/company-branches/${br["A_BR-A"]}/status`, { status: "INACTIVE" }),
      await call("acct-a", "patch", `/api/company-branches/${br["A_BR-B"]}/status`, { status: "ACTIVE" }),
    ];
    for (const res of denied) {
      expect(res.status).toBe(403);
      expect(Object.keys(res.body || {}).every((k) => ["message", "code", "error", "module", "action", "required"].includes(k))).toBe(true);
    }
    expect([await branchCount(), await branchAudits(), await snapshot(br["A_BR-A"])]).toEqual(before);
    // the refusals are recorded as ACCESS_DENIED, never as a branch change
    expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE user_id = ? AND action = 'ACCESS_DENIED'", [userIds["acct-a"]])).toBeGreaterThanOrEqual(4);
    expect(await n("SELECT COUNT(*) n FROM audit_logs WHERE user_id = ? AND module = 'FILESETUP.BRANCHES'", [userIds["acct-a"]])).toBe(0);
  });
});

// ===========================================================================
describe("TC-BRANCH-002 company isolation (server-side)", () => {
  test("Company A users cannot read, edit or (de)activate Company B's branch: 404, identical to an unknown id", async () => {
    const target = br.B_MAIN;
    const before = await snapshot(target);
    const unknown = await call("acct-a", "get", "/api/company-branches/999999999");
    for (const [who, method, url, body] of [
      ["acct-a", "get", `/api/company-branches/${target}`],
      ["admin-a", "get", `/api/company-branches/${target}`],
      ["admin-a", "put", `/api/company-branches/${target}`, { code: "MAIN", name: "hijack" }],
      ["admin-a", "patch", `/api/company-branches/${target}/status`, { status: "INACTIVE" }],
    ]) {
      const res = await call(who, method, url, body);
      expect([who, method, res.status, res.body]).toEqual([who, method, 404, unknown.body]);
    }
    expect(await snapshot(target)).toEqual(before);
  });

  test("cannot create a branch in Company B (403) or move an A branch to B (400); A's list never shows B", async () => {
    const before = await branchCount();
    expect((await create("admin-a", { code: "BR-SNEAK", name: "x", companyId: co.B })).status).toBe(403);
    expect((await call("admin-a", "put", `/api/company-branches/${br["A_BR-A"]}`, { code: "BR-A", name: "x", companyId: co.B })).body.code).toBe("BRANCH_COMPANY_READONLY");
    expect(await branchCount()).toBe(before);
    expect((await call("admin-a", "get", `/api/company-branches?companyId=${co.B}`)).status).toBe(403);
    const listA = (await call("admin-a", "get", "/api/company-branches")).body;
    expect(listA.some((b) => b.companyId === co.B)).toBe(false);
    expect((await call("acct-b", "get", "/api/company-branches")).body.map((b) => b.code).sort()).toEqual(["BR-AB", "BR-X", "MAIN"]);
  });

  test("a multi-company user sees both companies; Super Admin may filter by any company", async () => {
    const both = (await call("admin-ab", "get", "/api/company-branches")).body;
    expect(new Set(both.map((b) => b.companyId))).toEqual(new Set([co.A, co.B]));
    const onlyB = (await call("super", "get", `/api/company-branches?companyId=${co.B}`)).body;
    expect(onlyB.every((b) => b.companyId === co.B)).toBe(true);
  });
});

// ===========================================================================
describe("empty company and unauthorized access", () => {
  test("a company with no branches lists []", async () => {
    const res = await call("admin-empty", "get", "/api/company-branches");
    expect([res.status, res.body]).toEqual([200, []]);
  });

  test("no token -> 401; a user whose VIEW is revoked -> 403 on every route", async () => {
    expect((await request(app).get("/api/company-branches")).status).toBe(401);
    for (const [method, url] of [["get", "/api/company-branches"], ["get", `/api/company-branches/${br["A_BR-A"]}`], ["patch", `/api/company-branches/${br["A_BR-A"]}/status`]]) {
      expect((await call("acct-noview", method, url, method === "patch" ? { status: "INACTIVE" } : undefined)).status).toBe(403);
    }
  });

  test("the assignment picker list (GET /api/branches) is company-scoped: own companies' branches only", async () => {
    // Company Management: GET /api/branches feeds the user-access / invite pickers and
    // now lists every branch of the caller's companies (the same scope the server
    // enforces when assigning - lib/branchAssignment.js), not only the branches the
    // caller is personally assigned to.
    const res = await call("acct-a", "get", "/api/branches");
    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.code).sort()).toEqual(["BR-A", "BR-B", "BR-NEW2", "MAIN"]);
    expect(res.body.every((b) => Number(b.company_id) === co.A)).toBe(true);
  });
});
