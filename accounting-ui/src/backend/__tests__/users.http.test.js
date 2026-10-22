// Administration -> Users: role hierarchy, company isolation, membership
// preservation, required company, status / unlock / revoke, and the
// ACCESS_UPDATED audit trail. Plus source checks for UserAccessDrawer.jsx
// and UserList.jsx (the UI mirrors the server rules; the server decides).
//
// Hierarchy (server-enforced in userService):
//   Super Admin manages Admin + Accountant (and other Super Admins' status,
//   never their role); Admin manages Accountant only; Accountant: no access.
//   Nobody changes their own role. Out-of-scope users get the same 404 as an
//   unknown id.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "usrt-"; // fixture prefix (usernames / emails / names)
const PASSWORD = "UsrtPass!1";
const UNKNOWN_ID = 2147483000;

const ids = {};
const tokens = {};

async function makeUser(tag, roleId, companyIds = [], branchIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email, full_name) VALUES (?, ?, ?, 'ACTIVE', ?, ?)",
    [`${P}${tag}`, hash, roleId, `${P}${tag}@example.test`, `USRT ${tag}`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  return u.insertId;
}

async function login(tag) {
  return request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
}

async function tokenFor(tag) {
  const res = await login(tag);
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  return res.body.token;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const patchUser = (who, id, body) => request(app).patch(`/api/users/${id}`).set(auth(who)).send(body);
const setStatus = (who, id, status) => request(app).patch(`/api/users/${id}/status`).set(auth(who)).send({ status });

async function snapshot(id) {
  const [[u]] = await pool.execute(
    "SELECT u.full_name, u.status, u.token_version, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
    [id]
  );
  const [cs] = await pool.execute("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id", [id]);
  const [bs] = await pool.execute("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id", [id]);
  return { ...u, companyIds: cs.map((r) => r.company_id), branchIds: bs.map((r) => r.branch_id) };
}

async function setMemberships(id, companyIds, branchIds) {
  await pool.execute("DELETE FROM user_companies WHERE user_id = ?", [id]);
  await pool.execute("DELETE FROM user_branches WHERE user_id = ?", [id]);
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [id, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [id, b]);
}

async function lastAudit(entityId, action) {
  const [rows] = await pool.execute(
    "SELECT * FROM audit_logs WHERE entity_type = 'USER' AND entity_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
    [entityId, action]
  );
  const row = rows[0];
  if (!row) return null;
  const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);
  return { ...row, before: parse(row.before_data), after: parse(row.after_data) };
}

const sorted = (arr) => [...arr].sort((a, b) => a - b);

beforeAll(async () => {
  assertNotProductionDatabase();

  const [roles] = await pool.execute("SELECT id, code FROM roles");
  for (const r of roles) ids[r.code] = r.id;

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('USRT Co A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('USRT Co B', 'Active')");
  ids.coA = ca.insertId;
  ids.coB = cb.insertId;
  const [ba] = await pool.execute("INSERT INTO branches (company_id, name, code, status) VALUES (?, 'USRT Branch A1', 'USRT-BA1', 'ACTIVE')", [ids.coA]);
  const [bb] = await pool.execute("INSERT INTO branches (company_id, name, code, status) VALUES (?, 'USRT Branch B1', 'USRT-BB1', 'ACTIVE')", [ids.coB]);
  ids.brA1 = ba.insertId;
  ids.brB1 = bb.insertId;

  ids.superAdmin = await makeUser("superadmin", ids.SUPER_ADMIN);
  ids.superAdmin2 = await makeUser("superadmin2", ids.SUPER_ADMIN);
  ids.adminA = await makeUser("admin_a", ids.ADMIN, [ids.coA], [ids.brA1]);
  ids.adminA2 = await makeUser("admin_a2", ids.ADMIN, [ids.coA]);
  ids.adminB = await makeUser("admin_b", ids.ADMIN, [ids.coB], [ids.brB1]);
  ids.acctA = await makeUser("acct_a", ids.ACCOUNTANT, [ids.coA], [ids.brA1]);
  ids.acctAB = await makeUser("acct_ab", ids.ACCOUNTANT, [ids.coA, ids.coB], [ids.brA1, ids.brB1]);
  ids.acctB = await makeUser("acct_b", ids.ACCOUNTANT, [ids.coB]);
  ids.acctStatus = await makeUser("acct_status", ids.ACCOUNTANT, [ids.coA]);
  ids.acctRole = await makeUser("acct_role", ids.ACCOUNTANT, [ids.coA]);

  for (const [who, tag] of [
    ["superAdmin", "superadmin"],
    ["adminA", "admin_a"],
    ["adminB", "admin_b"],
    ["acctA", "acct_a"],
  ]) {
    tokens[who] = await tokenFor(tag);
  }
});

afterAll(async () => {
  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [`${P}%`]);
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    for (const t of ["user_companies", "user_branches", "user_permissions"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]);
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM audit_logs WHERE entity_type = 'USER' AND entity_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }
  await pool.query("DELETE FROM branches WHERE id IN (?, ?)", [ids.brA1, ids.brB1]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [ids.coA, ids.coB]);
  await pool.end();
});

// ---------------------------------------------------------------------------
describe("role hierarchy (server-enforced)", () => {
  test("Super Admin can change Accountant -> Admin and back", async () => {
    let res = await patchUser("superAdmin", ids.acctRole, { roleId: ids.ADMIN });
    expect(res.status).toBe(200);
    expect(res.body.role_code).toBe("ADMIN");
    res = await patchUser("superAdmin", ids.acctRole, { roleId: ids.ACCOUNTANT });
    expect(res.status).toBe(200);
    expect((await snapshot(ids.acctRole)).role_code).toBe("ACCOUNTANT");
  });

  test("Super Admin can manage an Admin (name, memberships, status)", async () => {
    const res = await patchUser("superAdmin", ids.adminA2, { fullName: "USRT admin_a2 renamed", companyIds: [ids.coA] });
    expect(res.status).toBe(200);
    expect((await snapshot(ids.adminA2)).full_name).toBe("USRT admin_a2 renamed");
  });

  test("Super Admin cannot change another Super Admin's role (to Admin or Accountant)", async () => {
    for (const roleId of [ids.ADMIN, ids.ACCOUNTANT]) {
      const res = await patchUser("superAdmin", ids.superAdmin2, { roleId });
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Super Admin's role cannot be changed/);
    }
    expect((await snapshot(ids.superAdmin2)).role_code).toBe("SUPER_ADMIN");
  });

  test("Super Admin is never assignable through Edit Access", async () => {
    const res = await patchUser("superAdmin", ids.acctRole, { roleId: ids.SUPER_ADMIN });
    expect(res.status).toBe(403);
    expect((await snapshot(ids.acctRole)).role_code).toBe("ACCOUNTANT");
  });

  test("Admin can manage an Accountant in their company", async () => {
    const res = await patchUser("adminA", ids.acctA, { fullName: "USRT acct_a by admin" });
    expect(res.status).toBe(200);
    expect((await snapshot(ids.acctA)).full_name).toBe("USRT acct_a by admin");
  });

  test("Admin cannot edit another Admin, change their role or their status", async () => {
    const before = await snapshot(ids.adminA2);
    let res = await patchUser("adminA", ids.adminA2, { fullName: "hijacked" });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Admins can only manage Accountant users.");
    res = await patchUser("adminA", ids.adminA2, { roleId: ids.ACCOUNTANT });
    expect(res.status).toBe(403);
    res = await setStatus("adminA", ids.adminA2, "INACTIVE");
    expect(res.status).toBe(403);
    res = await setStatus("adminA", ids.adminA2, "SUSPENDED");
    expect(res.status).toBe(403);
    res = await request(app).post(`/api/users/${ids.adminA2}/revoke-sessions`).set(auth("adminA"));
    expect(res.status).toBe(403);
    expect(await snapshot(ids.adminA2)).toEqual(before);
  });

  test("Admin cannot promote an Accountant to Admin (or Super Admin)", async () => {
    for (const roleId of [ids.ADMIN, ids.SUPER_ADMIN]) {
      const res = await patchUser("adminA", ids.acctRole, { roleId });
      expect(res.status).toBe(403);
    }
    expect((await snapshot(ids.acctRole)).role_code).toBe("ACCOUNTANT");
  });

  test("Admin cannot see or manage a Super Admin (404 like an unknown user)", async () => {
    const before = await snapshot(ids.superAdmin2);
    const unknown = await request(app).get(`/api/users/${UNKNOWN_ID}`).set(auth("adminA"));
    for (const res of [
      await request(app).get(`/api/users/${ids.superAdmin2}`).set(auth("adminA")),
      await patchUser("adminA", ids.superAdmin2, { fullName: "x" }),
      await setStatus("adminA", ids.superAdmin2, "INACTIVE"),
      await request(app).post(`/api/users/${ids.superAdmin2}/unlock`).set(auth("adminA")),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
    }
    const list = await request(app).get("/api/users").set(auth("adminA"));
    expect(list.body.some((u) => u.role_code === "SUPER_ADMIN")).toBe(false);
    expect(await snapshot(ids.superAdmin2)).toEqual(before);
  });

  test("Accountant has no access to Users", async () => {
    // The earlier edit of acct_a bumped its token_version - sign in again.
    tokens.acctA = await tokenFor("acct_a");
    const before = await snapshot(ids.acctRole);
    expect((await request(app).get("/api/users").set(auth("acctA"))).status).toBe(403);
    expect((await request(app).get(`/api/users/${ids.acctRole}`).set(auth("acctA"))).status).toBe(403);
    expect((await patchUser("acctA", ids.acctRole, { fullName: "x" })).status).toBe(403);
    expect((await setStatus("acctA", ids.acctRole, "INACTIVE")).status).toBe(403);
    expect(await snapshot(ids.acctRole)).toEqual(before);
  });

  test("nobody can change their own role", async () => {
    let res = await patchUser("superAdmin", ids.superAdmin, { roleId: ids.ADMIN });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You cannot change your own role.");
    res = await patchUser("adminA", ids.adminA, { roleId: ids.ACCOUNTANT });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You cannot change your own role.");
    expect((await snapshot(ids.superAdmin)).role_code).toBe("SUPER_ADMIN");
    expect((await snapshot(ids.adminA)).role_code).toBe("ADMIN");
  });

  test("own account: name can be edited, sending the unchanged role is fine", async () => {
    const res = await patchUser("adminA", ids.adminA, { fullName: "USRT admin_a self", roleId: ids.ADMIN, companyIds: [ids.coA], branchIds: [ids.brA1] });
    expect(res.status).toBe(200);
    expect((await snapshot(ids.adminA)).full_name).toBe("USRT admin_a self");
    // Editing yourself bumps token_version (as any access change does).
    tokens.adminA = await tokenFor("admin_a");
  });
});

// ---------------------------------------------------------------------------
describe("company isolation", () => {
  test("out-of-scope view returns the same 404 as an unknown user", async () => {
    const unknown = await request(app).get(`/api/users/${UNKNOWN_ID}`).set(auth("adminB"));
    const hidden = await request(app).get(`/api/users/${ids.acctA}`).set(auth("adminB"));
    expect(unknown.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(unknown.body);
    expect(hidden.body).toEqual({ message: "User not found" });
  });

  test("out-of-scope users are not listed", async () => {
    const list = await request(app).get("/api/users").set(auth("adminB"));
    expect(list.status).toBe(200);
    const listed = list.body.map((u) => u.id);
    expect(listed).not.toContain(ids.acctA);
    expect(listed).toContain(ids.acctB);
  });

  test("no out-of-scope edit, role change, status change, unlock or revoke", async () => {
    const before = await snapshot(ids.acctA);
    const unknown = await patchUser("adminB", UNKNOWN_ID, { fullName: "x" });
    for (const res of [
      await patchUser("adminB", ids.acctA, { fullName: "x" }),
      await patchUser("adminB", ids.acctA, { roleId: ids.ADMIN }),
      await setStatus("adminB", ids.acctA, "INACTIVE"),
      await setStatus("adminB", ids.acctA, "SUSPENDED"),
      await request(app).post(`/api/users/${ids.acctA}/unlock`).set(auth("adminB")),
      await request(app).post(`/api/users/${ids.acctA}/revoke-sessions`).set(auth("adminB")),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
    }
    expect(await snapshot(ids.acctA)).toEqual(before);
  });

  test("Admin cannot assign a company or branch outside their scope", async () => {
    const before = await snapshot(ids.acctA);
    let res = await patchUser("adminA", ids.acctA, { companyIds: [ids.coA, ids.coB] });
    expect(res.status).toBe(403);
    res = await patchUser("adminA", ids.acctA, { companyIds: [ids.coA], branchIds: [ids.brA1, ids.brB1] });
    expect(res.status).toBe(403);
    expect(await snapshot(ids.acctA)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("membership preservation", () => {
  beforeEach(async () => {
    await setMemberships(ids.acctAB, [ids.coA, ids.coB], [ids.brA1, ids.brB1]);
  });

  test("companies: Admin of A submits [A] for a user in [A, B] -> stays [A, B]", async () => {
    const res = await patchUser("adminA", ids.acctAB, { companyIds: [ids.coA] });
    expect(res.status).toBe(200);
    expect((await snapshot(ids.acctAB)).companyIds).toEqual(sorted([ids.coA, ids.coB]));
    expect(sorted(res.body.companies.map((c) => c.id))).toEqual(sorted([ids.coA, ids.coB]));
  });

  test("branches: Admin submits no branches -> only in-scope branch removed, out-of-scope kept", async () => {
    const res = await patchUser("adminA", ids.acctAB, { companyIds: [ids.coA], branchIds: [] });
    expect(res.status).toBe(200);
    const after = await snapshot(ids.acctAB);
    expect(after.branchIds).toEqual([ids.brB1]);
    expect(after.companyIds).toEqual(sorted([ids.coA, ids.coB]));
  });

  test("Admin removing the shared company succeeds (no 403 after save), out-of-scope company remains", async () => {
    const res = await patchUser("adminA", ids.acctAB, { companyIds: [], branchIds: [] });
    expect(res.status).toBe(200);
    const after = await snapshot(ids.acctAB);
    expect(after.companyIds).toEqual([ids.coB]);
    expect(after.branchIds).toEqual([ids.brB1]);
    // The user is now outside adminA's scope.
    expect((await request(app).get(`/api/users/${ids.acctAB}`).set(auth("adminA"))).status).toBe(404);
  });

  test("Super Admin's submission is the full list (no hidden scope)", async () => {
    const res = await patchUser("superAdmin", ids.acctAB, { companyIds: [ids.coB], branchIds: [ids.brB1] });
    expect(res.status).toBe(200);
    const after = await snapshot(ids.acctAB);
    expect(after.companyIds).toEqual([ids.coB]);
    expect(after.branchIds).toEqual([ids.brB1]);
  });
});

// ---------------------------------------------------------------------------
describe("validation (no partial save)", () => {
  test("empty company list -> 400 and nothing saved (Super Admin)", async () => {
    const before = await snapshot(ids.acctA);
    const res = await patchUser("superAdmin", ids.acctA, { fullName: "should not save", companyIds: [], branchIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Select at least one company for this user.");
    expect(await snapshot(ids.acctA)).toEqual(before);
  });

  test("empty company list -> 400 and nothing saved (Admin, previously 403-but-saved)", async () => {
    const before = await snapshot(ids.acctA);
    const res = await patchUser("adminA", ids.acctA, { fullName: "should not save", roleId: ids.ACCOUNTANT, companyIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Select at least one company for this user.");
    expect(await snapshot(ids.acctA)).toEqual(before);
  });

  test("missing companyIds leaves memberships unchanged", async () => {
    const before = await snapshot(ids.acctA);
    const res = await patchUser("adminA", ids.acctA, { fullName: before.full_name });
    expect(res.status).toBe(200);
    const after = await snapshot(ids.acctA);
    expect(after.companyIds).toEqual(before.companyIds);
    expect(after.branchIds).toEqual(before.branchIds);
  });

  test("invalid company -> 400 and nothing saved", async () => {
    const before = await snapshot(ids.acctA);
    for (const companyIds of [[UNKNOWN_ID], ["abc"], [ids.coA, -1], "not-a-list"]) {
      const res = await patchUser("superAdmin", ids.acctA, { fullName: "should not save", companyIds });
      expect(res.status).toBe(400);
    }
    expect(await snapshot(ids.acctA)).toEqual(before);
  });

  test("invalid branch -> 400, and the role change in the same request is not applied", async () => {
    const before = await snapshot(ids.acctRole);
    const res = await patchUser("superAdmin", ids.acctRole, { roleId: ids.ADMIN, companyIds: [ids.coA], branchIds: [UNKNOWN_ID] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Selected branch does not exist.");
    expect(await snapshot(ids.acctRole)).toEqual(before);
  });

  test("unknown role -> 400", async () => {
    const res = await patchUser("superAdmin", ids.acctRole, { roleId: UNKNOWN_ID });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("status, lock and sessions", () => {
  test("deactivate -> signed out and blocked at login; activate restores", async () => {
    const token = await tokenFor("acct_status");
    let res = await setStatus("adminA", ids.acctStatus, "INACTIVE");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("INACTIVE");
    expect((await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await login("acct_status")).status).toBe(403);
    expect((await lastAudit(ids.acctStatus, "USER_DEACTIVATED")).after).toEqual({ status: "INACTIVE" });

    res = await setStatus("adminA", ids.acctStatus, "ACTIVE");
    expect(res.status).toBe(200);
    expect((await login("acct_status")).status).toBe(200);
    expect(await lastAudit(ids.acctStatus, "USER_ACTIVATED")).not.toBeNull();
  });

  test("suspend is a separate status with its own audit action", async () => {
    let res = await setStatus("adminA", ids.acctStatus, "SUSPENDED");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUSPENDED");
    expect((await login("acct_status")).status).toBe(403);
    const audit = await lastAudit(ids.acctStatus, "USER_SUSPENDED");
    expect(audit.before).toEqual({ status: "ACTIVE" });
    expect(audit.after).toEqual({ status: "SUSPENDED" });
    res = await setStatus("adminA", ids.acctStatus, "ACTIVE");
    expect(res.status).toBe(200);
  });

  test("invalid status -> 400", async () => {
    expect((await setStatus("adminA", ids.acctStatus, "DELETED")).status).toBe(400);
  });

  test("cannot deactivate or suspend your own account", async () => {
    for (const [who, id] of [["adminA", ids.adminA], ["superAdmin", ids.superAdmin]]) {
      for (const status of ["INACTIVE", "SUSPENDED"]) {
        const res = await setStatus(who, id, status);
        expect(res.status).toBe(400);
      }
    }
    expect((await snapshot(ids.adminA)).status).toBe("ACTIVE");
    expect((await snapshot(ids.superAdmin)).status).toBe("ACTIVE");
  });

  test("Super Admin can deactivate and reactivate another Super Admin (not the last one)", async () => {
    let res = await setStatus("superAdmin", ids.superAdmin2, "INACTIVE");
    expect(res.status).toBe(200);
    res = await setStatus("superAdmin", ids.superAdmin2, "ACTIVE");
    expect(res.status).toBe(200);
  });

  test("locked user: is_locked reported, login refused, unlock clears it", async () => {
    await pool.execute(
      "UPDATE users SET failed_login_count = 5, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?",
      [ids.acctStatus]
    );
    let list = await request(app).get("/api/users").set(auth("adminA"));
    expect(Number(list.body.find((u) => u.id === ids.acctStatus).is_locked)).toBe(1);
    const blocked = await login("acct_status");
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/temporarily locked/);

    const res = await request(app).post(`/api/users/${ids.acctStatus}/unlock`).set(auth("adminA"));
    expect(res.status).toBe(200);
    expect(Number(res.body.is_locked)).toBe(0);
    const [[row]] = await pool.execute("SELECT failed_login_count, locked_until FROM users WHERE id = ?", [ids.acctStatus]);
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(await lastAudit(ids.acctStatus, "USER_UNLOCKED")).not.toBeNull();
    expect((await login("acct_status")).status).toBe(200);

    list = await request(app).get("/api/users").set(auth("adminA"));
    expect(Number(list.body.find((u) => u.id === ids.acctStatus).is_locked)).toBe(0);
  });

  test("revoke sessions signs the user out but keeps them active", async () => {
    const token = await tokenFor("acct_status");
    const res = await request(app).post(`/api/users/${ids.acctStatus}/revoke-sessions`).set(auth("adminA"));
    expect(res.status).toBe(200);
    expect((await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await snapshot(ids.acctStatus)).status).toBe("ACTIVE");
    expect(await lastAudit(ids.acctStatus, "SESSION_REVOKED")).not.toBeNull();
  });

  test("there is still no hard delete", async () => {
    const res = await request(app).delete(`/api/users/${ids.acctStatus}`).set(auth("superAdmin"));
    expect(res.status).toBe(404);
    expect((await snapshot(ids.acctStatus)).status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
describe("ACCESS_UPDATED audit", () => {
  test("records before/after role, companies and branches (final, merged values)", async () => {
    await setMemberships(ids.acctAB, [ids.coA, ids.coB], [ids.brA1, ids.brB1]);
    const res = await patchUser("adminA", ids.acctAB, { fullName: "USRT acct_ab audited", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], branchIds: [] });
    expect(res.status).toBe(200);
    const audit = await lastAudit(ids.acctAB, "ACCESS_UPDATED");
    expect(audit.user_id).toBe(ids.adminA);
    expect(audit.before).toEqual({
      fullName: "USRT acct_ab",
      roleCode: "ACCOUNTANT",
      companyIds: sorted([ids.coA, ids.coB]),
      branchIds: sorted([ids.brA1, ids.brB1]),
    });
    expect(audit.after).toEqual({
      fullName: "USRT acct_ab audited",
      roleCode: "ACCOUNTANT",
      companyIds: sorted([ids.coA, ids.coB]),
      branchIds: [ids.brB1],
    });
  });

  test("records a role change", async () => {
    const res = await patchUser("superAdmin", ids.acctRole, { roleId: ids.ADMIN, companyIds: [ids.coA] });
    expect(res.status).toBe(200);
    const audit = await lastAudit(ids.acctRole, "ACCESS_UPDATED");
    expect(audit.before.roleCode).toBe("ACCOUNTANT");
    expect(audit.after.roleCode).toBe("ADMIN");
    await patchUser("superAdmin", ids.acctRole, { roleId: ids.ACCOUNTANT });
  });

  test("rejected changes write no audit row", async () => {
    const [[{ c: before }]] = await pool.execute("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'USER' AND entity_id = ? AND action = 'ACCESS_UPDATED'", [ids.acctA]);
    await patchUser("adminA", ids.acctA, { companyIds: [] });
    await patchUser("adminB", ids.acctA, { fullName: "x" });
    const [[{ c: after }]] = await pool.execute("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type = 'USER' AND entity_id = ? AND action = 'ACCESS_UPDATED'", [ids.acctA]);
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Frontend source checks - the UI mirrors the server rules above.
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");

describe("UserAccessDrawer.jsx", () => {
  const src = read("components", "UserAccessDrawer.jsx");

  test("Admin is offered Accountant only; Super Admin is offered Admin + Accountant; Super Admin never assignable", () => {
    const map = src.match(/ASSIGNABLE_ROLES_BY_ACTOR = \{([\s\S]*?)\};/)[1];
    expect(map).toMatch(/SUPER_ADMIN: \["ADMIN", "ACCOUNTANT"\]/);
    expect(map).toMatch(/ADMIN: \["ACCOUNTANT"\]/);
    expect(map.replace(/SUPER_ADMIN:/, "")).not.toMatch(/"SUPER_ADMIN"/);
    expect(src).toMatch(/roles\.filter\(\(r\) => assignableCodes\.includes\(r\.code\)\)/);
  });

  test("own role and Super Admin roles are locked", () => {
    expect(src).toMatch(/!isSelf &&\s*user\.role_code !== "SUPER_ADMIN"/);
    expect(src).toMatch(/disabled=\{!canChangeRole\}/);
    expect(src).toMatch(/roleId: canChangeRole \? form\.roleId : user\.role_id/);
    expect(src).toContain("You are editing your own account.");
  });

  test("every lookup is checked; failure shows Retry and blocks saving", () => {
    expect(src).toMatch(/!res\.ok \|\| !Array\.isArray\(data\)/);
    expect(src).toMatch(/onClick=\{load\}[\s\S]{0,40}Retry/);
    expect(src).toMatch(/disabled=\{saving \|\| !formReady\}/);
    expect(src).toMatch(/const formReady = !loading && !loadError && !!user/);
  });

  test("only in-scope memberships are editable; out-of-scope notice shown", () => {
    expect(src).toMatch(/companyIds: userData\.companies\.map\(\(c\) => c\.id\)\.filter\(\(id\) => companyScope\.has\(id\)\)/);
    expect(src).toMatch(/branchIds: userData\.branches\.map\(\(b\) => b\.id\)\.filter\(\(id\) => branchScope\.has\(id\)\)/);
    expect(src).toContain("Access outside your management scope is preserved.");
  });

  test("no-company validation and empty-branch message", () => {
    expect(src).toContain("Select at least one company for this user.");
    expect(src).toMatch(/form\.companyIds\.length \+ outOfScopeCompanies\.length === 0/);
    expect(src).toContain("No branches available.");
  });
});

describe("UserList.jsx", () => {
  const src = read("pages", "ADMIN", "UserList.jsx");
  const css = read("pages", "ADMIN", "UserList.css");

  test("own row only offers Edit Access (no deactivate / suspend / revoke on yourself)", () => {
    const selfBlock = src.match(/if \(isSelf\) \{([\s\S]*?)\n    \}/)[1];
    expect(selfBlock).toContain("Edit Access");
    expect(selfBlock).not.toMatch(/Deactivate|Suspend|Revoke|Unlock/);
  });

  test("users the actor can't manage get no actions", () => {
    expect(src).toMatch(/if \(!manageableRoles\.includes\(u\.role_code\)\)/);
    expect(src).toContain("View only");
  });

  test("Locked badge and Unlock button use the existing unlock endpoint", () => {
    expect(src).toMatch(/!!u\.is_locked && \([\s\S]{0,200}Locked/);
    expect(src).toMatch(/`\$\{user\.id\}\/unlock`/);
  });

  test("full name falls back to username", () => {
    expect(src).toMatch(/\(u\.full_name \|\| ""\)\.trim\(\) \|\| u\.username/);
    expect(src).toMatch(/\{displayName\(u\)\}/);
  });

  test("Deactivate, Suspend and Revoke confirm in an in-app dialog; Unlock does not; no native confirm/alert", () => {
    expect(src).not.toMatch(/\bconfirm\(|\balert\(/);
    expect(src).toMatch(/onClick=\{\(\) => ask\("INACTIVE"\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => ask\("SUSPENDED"\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => ask\("REVOKE"\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => unlock\(u\)\}/);
    expect(src).toContain('role="alertdialog"');
  });

  test("Suspend and Deactivate carry explanatory tooltips", () => {
    expect(src).toMatch(/title=\{ACTION_HELP\.deactivate\}/);
    expect(src).toMatch(/title=\{ACTION_HELP\.suspend\}/);
  });

  test("table scrolls inside its own wrapper on mobile", () => {
    const wrap = css.match(/\.ul-table-wrap \{([\s\S]*?)\}/)[1];
    expect(wrap).toMatch(/overflow-x: auto/);
    expect(wrap).toMatch(/contain: inline-size/);
    expect(src).not.toMatch(/ul-link-btn/);
  });
});
