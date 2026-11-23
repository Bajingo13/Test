// SUPER_ADMIN-only credential management (POST /api/account/change-password,
// POST /api/account/change-username). Cases ACRED-01 .. ACRED-28 follow the
// specification's numbering. Real seeded roles, real /api/login, local test
// database only. Fixture prefix uat-acred-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "uat-acred-";
const PW = { super: "UatAcredSuper!2026", super2: "UatAcredSuper2!2026", super3: "UatAcredSuper3!2026", admin: "UatAcredAdmin!2026", acct: "UatAcredAcct!2026" };
const NEW_PW = "UatAcredNewPw#2027";
const uid = {};
const uname = {};
const tok = {};
let companyId, branchId;

const loginRaw = (username, password) => request(app).post("/api/login").send({ username, password });
async function login(tag, password = PW[tag]) {
  const res = await loginRaw(uname[tag], password);
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
  return res;
}
async function makeUser(tag, roleCode) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  uname[tag] = `${P}${tag}`;
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)", [uname[tag], await bcrypt.hash(PW[tag], 10), role.id, `${P}${tag}@example.test`]);
  uid[tag] = u.insertId;
}
const post = (who, path, body) => {
  const r = request(app).post(path);
  if (who) r.set({ Authorization: `Bearer ${tok[who]}` });
  return r.send(body);
};
const userRow = async (id) => (await pool.query(
  "SELECT u.id, u.username, u.password, u.role, u.role_id, u.status, u.token_version, u.failed_login_count, u.locked_until, u.email, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?", [id]))[0][0];
const access = async (id) => ({
  companies: (await pool.query("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id", [id]))[0].map((r) => r.company_id),
  branches: (await pool.query("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id", [id]))[0].map((r) => r.branch_id),
  overrides: (await pool.query("SELECT permission_id, granted FROM user_permissions WHERE user_id = ? ORDER BY permission_id", [id]))[0],
});
const auditRows = async (action) => (await pool.query(
  "SELECT id, module, entity_type, entity_id, action, description, CAST(before_data AS CHAR) AS before_data, CAST(after_data AS CHAR) AS after_data, user_id, username FROM audit_logs WHERE action = ? AND user_id IN (?) ORDER BY id", [action, Object.values(uid)]))[0];
const myPermissions = async (who) => {
  const res = await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${tok[who]}` });
  return res.body.permissions.map((p) => `${p.moduleKey}:${p.action}:${p.granted}`).sort();
};
const SECRETS = () => [...Object.values(PW), NEW_PW, "Wrong-Current-1", ...Object.values(tok)];
const BCRYPT_RE = /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/;
const leaks = (text, extra = []) => [...SECRETS(), ...extra].filter((s) => s && String(text).includes(s));

beforeAll(async () => {
  assertNotProductionDatabase();
  companyId = (await pool.query("INSERT INTO companies (name, tin, status) VALUES (?, '900-111-222-333', 'ACTIVE')", [`${P}Co`]))[0].insertId;
  branchId = (await pool.query("INSERT INTO branches (company_id, name, code) VALUES (?, 'Acred Main', 'ACRED1')", [companyId]))[0].insertId;
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("super2", "SUPER_ADMIN");
  await makeUser("super3", "SUPER_ADMIN");
  await makeUser("admin", "ADMIN");
  await makeUser("acct", "ACCOUNTANT");
  // a membership on the SUPER_ADMIN too, so "assignments unchanged" is a real check
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?), (?, ?), (?, ?)", [uid.super, companyId, uid.admin, companyId, uid.acct, companyId]);
  await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?), (?, ?)", [uid.super, branchId, uid.acct, branchId]);
  for (const t of ["super", "super2", "super3", "admin", "acct"]) await login(t);
});

afterAll(async () => {
  try {
    const users = Object.values(uid);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR (entity_type = 'USER' AND entity_id IN (?)) OR username LIKE ? OR description LIKE ?", [users, users, `${P}%`, `%${P}%`]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?) OR company_id = ?", [users, companyId]);
    await pool.query("DELETE FROM invitations WHERE email LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM branches WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  } finally {
    await pool.end();
  }
});

describe("authorization (both endpoints)", () => {
  test.each([["/api/account/change-password"], ["/api/account/change-username"]])("ACRED-05/06/07/17/18/19 %s: unauthenticated 401, ADMIN 403, ACCOUNTANT 403, nothing changes", async (path) => {
    const before = { admin: await userRow(uid.admin), acct: await userRow(uid.acct) };
    const body = { currentPassword: PW.admin, newPassword: NEW_PW, confirmPassword: NEW_PW, newUsername: `${P}hijack` };
    const anon = await post(null, path, body);
    const asAdmin = await post("admin", path, { ...body, currentPassword: PW.admin });
    const asAcct = await post("acct", path, { ...body, currentPassword: PW.acct });
    expect(anon.status).toBe(401);
    expect(asAdmin.status).toBe(403);
    expect(asAcct.status).toBe(403);
    expect(await userRow(uid.admin)).toEqual(before.admin);
    expect(await userRow(uid.acct)).toEqual(before.acct);
    for (const r of [anon, asAdmin, asAcct]) expect(leaks(JSON.stringify(r.body))).toEqual([]);
  });
  test("a forged/invalid token is rejected (401)", async () => {
    const res = await request(app).post("/api/account/change-password").set({ Authorization: "Bearer not-a-token" }).send({});
    expect(res.status).toBe(401);
  });
});

describe("change password - rejections", () => {
  test("ACRED-02 incorrect current password is rejected (400), audited without secrets, hash unchanged", async () => {
    const before = await userRow(uid.super);
    const res = await post("super", "/api/account/change-password", { currentPassword: "Wrong-Current-1", newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect((await userRow(uid.super)).password).toBe(before.password);
    const rows = await auditRows("PASSWORD_CHANGE_REJECTED");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(leaks(JSON.stringify(rows), [before.password])).toEqual([]);
  });
  test("ACRED-03 confirmation mismatch is rejected", async () => {
    const res = await post("super", "/api/account/change-password", { currentPassword: PW.super, newPassword: NEW_PW, confirmPassword: NEW_PW + "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_MISMATCH");
  });
  test.each([
    ["too short", "Ab1!xyz", "PASSWORD_TOO_SHORT"],
    ["empty", "", "PASSWORD_REQUIRED"],
    ["blank", "         ", "PASSWORD_INVALID"],
    ["over the bcrypt 72-byte limit", "A".repeat(73), "PASSWORD_TOO_LONG"],
    ["same as current", PW.super, "PASSWORD_UNCHANGED"],
  ])("ACRED-04 weak/invalid new password (%s) is rejected", async (_label, pw, code) => {
    const before = await userRow(uid.super);
    const res = await post("super", "/api/account/change-password", { currentPassword: PW.super, newPassword: pw, confirmPassword: pw });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(await userRow(uid.super)).toEqual(before);
  });
  test("ACRED-25 a target user id in the body is refused - another user's credentials can never be changed", async () => {
    const other = await userRow(uid.super);
    const self = await userRow(uid.super2);
    for (const field of ["userId", "id", "user_id", "targetUserId"]) {
      const res = await post("super2", "/api/account/change-password", { [field]: uid.super, currentPassword: PW.super2, newPassword: NEW_PW, confirmPassword: NEW_PW });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TARGET_USER_NOT_ALLOWED");
      const un = await post("super2", "/api/account/change-username", { [field]: uid.super, currentPassword: PW.super2, newUsername: `${P}stolen` });
      expect(un.status).toBe(400);
    }
    expect(await userRow(uid.super)).toEqual(other);
    expect(await userRow(uid.super2)).toEqual(self);
  });
});

describe("change password - success", () => {
  let before, beforeAccess, beforePerms, oldToken, res;
  beforeAll(async () => {
    await pool.query("UPDATE users SET failed_login_count = 3 WHERE id = ?", [uid.super]);
    before = await userRow(uid.super);
    beforeAccess = await access(uid.super);
    beforePerms = await myPermissions("super");
    oldToken = tok.super;
    res = await post("super", "/api/account/change-password", { currentPassword: PW.super, newPassword: NEW_PW, confirmPassword: NEW_PW, companyIds: [], branchIds: [], roleId: 3, status: "INACTIVE" });
  });
  test("ACRED-01 SUPER_ADMIN changes the password with the correct current password", () => {
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, reauthRequired: true, message: "Password changed successfully. Please log in again." });
  });
  test("ACRED-08/09 the hash changed, is a fresh bcrypt (cost 10) hash of the new password, and no plaintext is stored", async () => {
    const after = await userRow(uid.super);
    expect(after.password).not.toBe(before.password);
    expect(after.password).toMatch(BCRYPT_RE);
    expect(after.password).not.toContain(NEW_PW);
    expect(await bcrypt.compare(NEW_PW, after.password)).toBe(true);
    expect(await bcrypt.compare(PW.super, after.password)).toBe(false);
  });
  test("ACRED-10 every existing session is revoked (token_version + 1); the old token gets 401", async () => {
    const after = await userRow(uid.super);
    expect(after.token_version).toBe(before.token_version + 1);
    const reuse = await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${oldToken}` });
    expect(reuse.status).toBe(401);
    expect(reuse.body.message).toMatch(/revoked/i);
  });
  test("ACRED-11 the failed-login counter and any lock are reset", async () => {
    const after = await userRow(uid.super);
    expect(before.failed_login_count).toBe(3);
    expect(after.failed_login_count).toBe(0);
    expect(after.locked_until).toBeNull();
  });
  test("ACRED-26/27 id, role, role_id, status and every assignment are unchanged (extra body fields ignored)", async () => {
    const after = await userRow(uid.super);
    for (const k of ["id", "username", "role", "role_id", "status", "email", "role_code"]) expect(after[k]).toEqual(before[k]);
    expect(after.role_code).toBe("SUPER_ADMIN");
    expect(await access(uid.super)).toEqual(beforeAccess);
  });
  test("old password fails, new password logs in; permissions are unchanged (ACRED-21)", async () => {
    expect((await loginRaw(uname.super, PW.super)).status).toBe(401);
    await login("super", NEW_PW);
    expect(await myPermissions("super")).toEqual(beforePerms);
  });
  test("ACRED-12 PASSWORD_CHANGED audit event with no password, hash or token", async () => {
    const rows = (await auditRows("PASSWORD_CHANGED")).filter((r) => r.entity_id === uid.super);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "USERS", entity_type: "USER", user_id: uid.super });
    const after = await userRow(uid.super);
    expect(leaks(JSON.stringify(rows), [before.password, after.password, oldToken])).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/\$2[aby]\$|eyJ[A-Za-z0-9_-]{10,}\./);
    expect(leaks(JSON.stringify(res.body), [before.password, after.password])).toEqual([]);
  });
});

describe("change username", () => {
  const NEW_NAME = `${P}renamed.super`;
  let before, beforeAccess, beforePerms, res;
  test("ACRED-14 incorrect current password is rejected and audited without secrets", async () => {
    const r = await post("super", "/api/account/change-username", { currentPassword: "Wrong-Current-1", newUsername: NEW_NAME });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect((await userRow(uid.super)).username).toBe(uname.super);
    const rows = await auditRows("USERNAME_CHANGE_REJECTED");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(leaks(JSON.stringify(rows))).toEqual([]);
  });
  test("ACRED-15 a username belonging to another user is rejected - including a case variant and another user's e-mail", async () => {
    for (const taken of [uname.super2, uname.super2.toUpperCase(), uname.acct, `${P}admin@example.test`]) {
      const r = await post("super", "/api/account/change-username", { currentPassword: NEW_PW, newUsername: taken });
      expect([taken, r.status, r.body.code]).toEqual([taken, 409, "USERNAME_TAKEN"]);
    }
  });
  test("a pending invitation's e-mail is reserved", async () => {
    const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    await pool.query("INSERT INTO invitations (email, full_name, role_id, company_ids, branch_ids, token_hash, status, expires_at, invited_by) VALUES (?, 'x', ?, '[]', '[]', REPEAT('a', 64), 'PENDING', DATE_ADD(NOW(), INTERVAL 1 DAY), ?)", [`${P}pending@example.test`, role.id, uid.super]);
    const r = await post("super", "/api/account/change-username", { currentPassword: NEW_PW, newUsername: `${P}pending@example.test` });
    expect(r.status).toBe(409);
  });
  test.each([["empty", "", "USERNAME_REQUIRED"], ["blank", "   ", "USERNAME_REQUIRED"], ["inner space", "uat acred", "USERNAME_INVALID"], ["too short", "ab", "USERNAME_INVALID"], ["too long", "a".repeat(101), "USERNAME_INVALID"], ["bad characters", "uat<acred>", "USERNAME_INVALID"], ["leading dot", ".uatacred", "USERNAME_INVALID"], ["unchanged", null, "USERNAME_UNCHANGED"]])(
    "ACRED-16 invalid username (%s) is rejected", async (_l, value, code) => {
      const r = await post("super2", "/api/account/change-username", { currentPassword: PW.super2, newUsername: value === null ? uname.super2 : value });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe(code);
      expect((await userRow(uid.super2)).username).toBe(uname.super2);
    }
  );
  test("ACRED-13 SUPER_ADMIN changes the username (surrounding whitespace trimmed); the session stays valid", async () => {
    before = await userRow(uid.super);
    beforeAccess = await access(uid.super);
    beforePerms = await myPermissions("super");
    res = await post("super", "/api/account/change-username", { currentPassword: NEW_PW, newUsername: `  ${NEW_NAME}  `, roleId: 3, companyIds: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, username: NEW_NAME, message: "Username changed successfully." });
    const me = await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${tok.super}` });
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(NEW_NAME);
  });
  test("ACRED-20/21/26/27 the record is updated in place: same id, role, role_id, status, token_version, hash, assignments, permissions", async () => {
    const after = await userRow(uid.super);
    expect(after.username).toBe(NEW_NAME);
    for (const k of ["id", "password", "role", "role_id", "status", "token_version", "email", "role_code"]) expect(after[k]).toEqual(before[k]);
    expect(after.role_code).toBe("SUPER_ADMIN");
    expect(await access(uid.super)).toEqual(beforeAccess);
    expect(await myPermissions("super")).toEqual(beforePerms);
    expect(Number((await pool.query("SELECT COUNT(*) n FROM users WHERE username IN (?, ?)", [NEW_NAME, uname.super]))[0][0].n)).toBe(1);
  });
  test("ACRED-23/24 the new username logs in; the old username no longer works", async () => {
    expect((await loginRaw(uname.super, NEW_PW)).status).toBe(401);
    const ok = await loginRaw(NEW_NAME, NEW_PW);
    expect(ok.status).toBe(200);
    uname.super = NEW_NAME;
    tok.super = ok.body.token;
  });
  test("ACRED-22 USERNAME_CHANGED audit event: old/new username only, no password, hash or token", async () => {
    const rows = (await auditRows("USERNAME_CHANGED")).filter((r) => r.entity_id === uid.super);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "USERS", entity_type: "USER", user_id: uid.super });
    expect(JSON.parse(rows[0].before_data)).toEqual({ username: `${P}super` });
    expect(JSON.parse(rows[0].after_data)).toEqual({ username: NEW_NAME });
    expect(leaks(JSON.stringify(rows), [before.password])).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/\$2[aby]\$|eyJ[A-Za-z0-9_-]{10,}\./);
  });
});

describe("brute-force protection", () => {
  test("failed credential-change attempts are limited per account: the 21st failure is refused (429) and nothing changes", async () => {
    const before = await userRow(uid.super3);
    for (let i = 0; i < 20; i++) {
      const r = await post("super3", "/api/account/change-password", { currentPassword: "Wrong-Current-1", newPassword: NEW_PW, confirmPassword: NEW_PW });
      expect(r.status).toBe(400);
    }
    const blocked = await post("super3", "/api/account/change-password", { currentPassword: PW.super3, newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
    expect(await userRow(uid.super3)).toEqual(before);
    // other accounts are not affected by super3's limit
    const other = await post("super2", "/api/account/change-password", { currentPassword: "Wrong-Current-1", newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect(other.status).toBe(400);
  });
});

describe("security regression", () => {
  test("ACRED-28 no response from these endpoints ever contains a password, hash or token", async () => {
    const hashes = (await pool.query("SELECT password FROM users WHERE id IN (?)", [Object.values(uid)]))[0].map((r) => r.password);
    const responses = [
      await post("super", "/api/account/change-password", { currentPassword: "Wrong-Current-1", newPassword: NEW_PW, confirmPassword: NEW_PW }),
      await post("super", "/api/account/change-username", { currentPassword: NEW_PW, newUsername: uname.super2 }),
      await post("admin", "/api/account/change-username", { currentPassword: PW.admin, newUsername: `${P}x` }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
      expect(leaks(text, hashes)).toEqual([]);
      expect(text).not.toMatch(/\$2[aby]\$/);
    }
  });
  test("ACRED-27 the system keeps its active SUPER_ADMINs; credential changes never alter roles", async () => {
    const [[row]] = await pool.query("SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND u.id IN (?)", [[uid.super, uid.super2, uid.super3]]);
    expect(Number(row.n)).toBe(3);
  });
  test("the second SUPER_ADMIN (and ADMIN / ACCOUNTANT) still log in with their unchanged passwords", async () => {
    for (const t of ["super2", "super3", "admin", "acct"]) expect((await loginRaw(uname[t], PW[t])).status).toBe(200);
  });
});
