// Credential management policy (lib/credentialPolicy.js).
//   OFF (default - every deployment except ALAS): de8b06a behaviour exactly.
//   ON  (ADMIN_CREDENTIAL_MANAGEMENT=enabled - ALAS): SUPER_ADMIN + ADMIN manage
//       their own credentials; SUPER_ADMIN any other user's; ADMIN the Accountants
//       they manage (never a SUPER_ADMIN); ACCOUNTANT nothing.
// Real seeded roles, real /api/login, local test database only. Prefix uat-acm-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "uat-acm-";
const FLAG = "ADMIN_CREDENTIAL_MANAGEMENT";
const PW = {
  super: "UatAcmSuper!2026", super2: "UatAcmSuper2!2026", admin: "UatAcmAdmin!2026", admin2: "UatAcmAdmin2!2026",
  acct: "UatAcmAcct!2026", acct2: "UatAcmAcct2!2026", acctOther: "UatAcmOther!2026", acctLocked: "UatAcmLocked!2026",
};
const NEW = { a: "UatAcmNewPw#2027", b: "UatAcmNewPw#2028", c: "UatAcmNewPw#2029", d: "UatAcmNewPw#2030" };
const uid = {};
const uname = {};
const tok = {};
const co = {};
let branchA;
let invitationId;

const enable = () => { process.env[FLAG] = "enabled"; };
const disable = () => { delete process.env[FLAG]; };
// This suite signs in ~40 times; the real per-IP login limiter (20 / 15 min) is
// left in place, so each attempt comes from its own client address (the app
// trusts one proxy hop, as on Railway).
let loginSeq = 0;
const loginRaw = (username, password) => {
  loginSeq += 1;
  return request(app).post("/api/login").set("X-Forwarded-For", `10.231.${Math.floor(loginSeq / 250)}.${loginSeq % 250}`).send({ username, password });
};
async function login(tag, password = PW[tag]) {
  const res = await loginRaw(uname[tag], password);
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
  return res;
}
async function makeUser(tag, roleCode, companyId) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  uname[tag] = `${P}${tag}`;
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [uname[tag], await bcrypt.hash(PW[tag], 10), role.id, `${P}${tag}@example.test`]);
  uid[tag] = u.insertId;
  if (companyId) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [uid[tag], companyId]);
}
const post = (who, path, body = {}) => {
  const r = request(app).post(path);
  if (who) r.set({ Authorization: `Bearer ${tok[who]}` });
  return r.send(body);
};
const reset = (who, target, pw, confirm = pw) => post(who, `/api/users/${uid[target]}/reset-password`, { newPassword: pw, confirmPassword: confirm });
const rename = (who, target, newUsername) => post(who, `/api/users/${uid[target]}/change-username`, { newUsername });
const userRow = async (id) => (await pool.query(
  `SELECT u.id, u.username, u.password, u.role_id, u.status, u.token_version, u.failed_login_count, u.locked_until, u.email, u.full_name, r.code AS role_code
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]))[0][0];
const access = async (id) => ({
  companies: (await pool.query("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id", [id]))[0].map((r) => r.company_id),
  branches: (await pool.query("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id", [id]))[0].map((r) => r.branch_id),
  overrides: (await pool.query("SELECT permission_id, granted FROM user_permissions WHERE user_id = ? ORDER BY permission_id", [id]))[0],
});
const audits = async (action, entityId) => (await pool.query(
  `SELECT action, description, CAST(before_data AS CHAR) AS before_data, CAST(after_data AS CHAR) AS after_data, user_id, username, company_id
     FROM audit_logs WHERE action = ? AND entity_type = 'USER' AND entity_id = ? ORDER BY id`, [action, entityId]))[0];
const caps = async (who) => (await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${tok[who]}` })).body.credentialManagement;
const SECRETS = () => [...Object.values(PW), ...Object.values(NEW), ...Object.values(tok)];
const BCRYPT_RE = /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/;
const leaks = (text, extra = []) => [...SECRETS(), ...extra].filter((s) => s && String(text).includes(s));
// everything except the credential column(s) the operation is allowed to change
const identity = ({ password, token_version, username, ...rest }) => rest;

beforeAll(async () => {
  assertNotProductionDatabase();
  disable();
  co.A = (await pool.query("INSERT INTO companies (name, tin, status) VALUES (?, '900-311-222-333', 'ACTIVE')", [`${P}CoA`]))[0].insertId;
  co.B = (await pool.query("INSERT INTO companies (name, tin, status) VALUES (?, '900-311-222-334', 'ACTIVE')", [`${P}CoB`]))[0].insertId;
  branchA = (await pool.query("INSERT INTO branches (company_id, name, code) VALUES (?, 'Acm Main', 'ACM1')", [co.A]))[0].insertId;
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("super2", "SUPER_ADMIN");
  await makeUser("admin", "ADMIN", co.A);
  await makeUser("admin2", "ADMIN", co.A);
  await makeUser("acct", "ACCOUNTANT", co.A);
  await makeUser("acct2", "ACCOUNTANT", co.A);
  await makeUser("acctOther", "ACCOUNTANT", co.B);
  await makeUser("acctLocked", "ACCOUNTANT", co.A);
  await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?), (?, ?)", [uid.acct, branchA, uid.admin, branchA]);
  for (const t of Object.keys(PW)) await login(t);
});

afterAll(async () => {
  disable();
  try {
    const [inv] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [`${P}%`]);
    const users = [...new Set([...Object.values(uid), ...inv.map((r) => r.id)])];
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR (entity_type = 'USER' AND entity_id IN (?)) OR username LIKE ? OR description LIKE ?", [users, users, `${P}%`, `%${P}%`]);
    if (invitationId) await pool.query("DELETE FROM audit_logs WHERE entity_type = 'INVITATION' AND entity_id = ?", [invitationId]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?) OR company_id IN (?)", [users, [co.A, co.B]]);
    await pool.query("DELETE FROM invitation_companies WHERE invitation_id IN (SELECT id FROM invitations WHERE email LIKE ?)", [`${P}%`]).catch(() => {});
    await pool.query("DELETE FROM invitation_branches WHERE invitation_id IN (SELECT id FROM invitations WHERE email LIKE ?)", [`${P}%`]).catch(() => {});
    await pool.query("DELETE FROM invitations WHERE email LIKE ?", [`${P}%`]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [[co.A, co.B]]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [[co.A, co.B]]);
  } finally {
    await pool.end();
  }
});

describe("policy OFF (default; ASTREABLUE INC. / Production / Demo) - de8b06a behaviour", () => {
  beforeAll(disable);
  test("capabilities: SUPER_ADMIN self-service + e-mail only; ADMIN and ACCOUNTANT nothing", async () => {
    expect(await caps("super")).toEqual({ changeOwnCredentials: true, manageUserCredentials: false, notificationEmail: true });
    expect(await caps("admin")).toEqual({ changeOwnCredentials: false, manageUserCredentials: false, notificationEmail: false });
    expect(await caps("acct")).toEqual({ changeOwnCredentials: false, manageUserCredentials: false, notificationEmail: false });
  });
  test.each([["/api/account/change-password"], ["/api/account/change-username"]])("%s: ADMIN 403, ACCOUNTANT 403, nothing changes", async (path) => {
    const before = { admin: await userRow(uid.admin), acct: await userRow(uid.acct) };
    const asAdmin = await post("admin", path, { currentPassword: PW.admin, newPassword: NEW.a, confirmPassword: NEW.a, newUsername: `${P}x1` });
    const asAcct = await post("acct", path, { currentPassword: PW.acct, newPassword: NEW.a, confirmPassword: NEW.a, newUsername: `${P}x2` });
    expect(asAdmin.status).toBe(403);
    expect(asAcct.status).toBe(403);
    expect(await userRow(uid.admin)).toEqual(before.admin);
    expect(await userRow(uid.acct)).toEqual(before.acct);
  });
  test("administrative endpoints do not exist (404) - even for SUPER_ADMIN and unauthenticated callers", async () => {
    const before = await userRow(uid.acct);
    for (const r of [await reset("super", "acct", NEW.a), await rename("super", "acct", `${P}x3`), await reset("admin", "acct", NEW.a), await post(null, `/api/users/${uid.acct}/reset-password`, { newPassword: NEW.a, confirmPassword: NEW.a })]) {
      expect(r.status).toBe(404);
    }
    expect(await userRow(uid.acct)).toEqual(before);
  });
});

describe("policy ON (ALAS) - ACCOUNTANT", () => {
  beforeAll(enable);
  test("capabilities: none", async () => {
    expect(await caps("acct")).toEqual({ changeOwnCredentials: false, manageUserCredentials: false, notificationEmail: false });
  });
  test.each([["/api/account/change-password"], ["/api/account/change-username"], ["/api/account/email/request"]])("cannot change own credentials via %s (403, nothing changes)", async (path) => {
    const before = await userRow(uid.acct);
    const res = await post("acct", path, { currentPassword: PW.acct, newPassword: NEW.a, confirmPassword: NEW.a, newUsername: `${P}acct-new`, newEmail: `${P}n@example.test` });
    expect(res.status).toBe(403);
    expect(await userRow(uid.acct)).toEqual(before);
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
  });
  test("cannot change anyone's credentials - another Accountant, an Admin, a Super Admin, or self (403)", async () => {
    const before = await Promise.all(["acct", "acct2", "admin", "super"].map((t) => userRow(uid[t])));
    const results = [await reset("acct", "acct2", NEW.a), await rename("acct", "acct2", `${P}h1`), await reset("acct", "admin", NEW.a), await reset("acct", "super", NEW.a), await reset("acct", "acct", NEW.a), await rename("acct", "acct", `${P}h2`)];
    for (const r of results) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("CREDENTIAL_ADMIN_NOT_ALLOWED");
    }
    expect(await Promise.all(["acct", "acct2", "admin", "super"].map((t) => userRow(uid[t])))).toEqual(before);
  });
  test("even with a User Settings EDIT override, an Accountant is refused (role gate, not permission)", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.USER_SETTINGS' AND action = 'EDIT'");
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [uid.acct2, perm.id]);
    try {
      await login("acct2");
      const before = await userRow(uid.acct);
      const res = await reset("acct2", "acct", NEW.a);
      expect(res.status).toBe(403);
      expect(await userRow(uid.acct)).toEqual(before);
    } finally {
      await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [uid.acct2]);
    }
  });
  test("sign-in still works", async () => {
    expect((await loginRaw(uname.acct, PW.acct)).status).toBe(200);
  });
  test("first-time invitation setup still works (Accountant sets their password on acceptance)", async () => {
    const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const inv = await post("super", "/api/invitations", { email: `${P}invitee@example.test`, username: `${P}invitee`, fullName: "ACM Invitee", roleId: role.id, companyIds: [co.A] });
    expect(inv.status).toBe(201);
    invitationId = inv.body.id;
    const resend = await post("super", `/api/invitations/${invitationId}/resend`);
    const token = /token=([0-9a-f]{64})/.exec(resend.body.acceptUrl || "")?.[1];
    expect(token).toBeTruthy();
    const accepted = await request(app).post("/api/invitations/accept").send({ token, password: NEW.d, acceptedTerms: true });
    expect(accepted.status).toBe(201);
    expect((await loginRaw(`${P}invitee`, NEW.d)).status).toBe(200);
    const self = await loginRaw(`${P}invitee`, NEW.d);
    const own = await request(app).post("/api/account/change-password").set({ Authorization: `Bearer ${self.body.token}` }).send({ currentPassword: NEW.d, newPassword: NEW.a, confirmPassword: NEW.a });
    expect(own.status).toBe(403);
  });
});

describe("policy ON (ALAS) - ADMIN self-service", () => {
  beforeAll(enable);
  test("capabilities: own credentials + managed users; no notification e-mail", async () => {
    expect(await caps("admin")).toEqual({ changeOwnCredentials: true, manageUserCredentials: true, notificationEmail: false });
    expect(await caps("super")).toEqual({ changeOwnCredentials: true, manageUserCredentials: true, notificationEmail: true });
  });
  test("notification e-mail stays SUPER_ADMIN-only (403)", async () => {
    expect((await request(app).get("/api/account/email").set({ Authorization: `Bearer ${tok.admin}` })).status).toBe(403);
  });
  test("wrong current password is rejected and audited without secrets", async () => {
    const before = await userRow(uid.admin);
    const res = await post("admin", "/api/account/change-password", { currentPassword: "Wrong-Current-1", newPassword: NEW.a, confirmPassword: NEW.a });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect(await userRow(uid.admin)).toEqual(before);
    expect(leaks(JSON.stringify(await audits("PASSWORD_CHANGE_REJECTED", uid.admin)), [before.password, "Wrong-Current-1"])).toEqual([]);
  });
  test("username uniqueness: another user's username, another user's e-mail, a pending invitation (409)", async () => {
    const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const inv = await post("super", "/api/invitations", { email: `${P}pending@example.test`, username: `${P}pending`, fullName: "ACM Pending", roleId: role.id, companyIds: [co.A] });
    expect(inv.status).toBe(201);
    for (const taken of [uname.acct, `${P}acct2@example.test`, `${P}pending`, `${P}pending@example.test`, uname.acct.toUpperCase()]) {
      const res = await post("admin", "/api/account/change-username", { currentPassword: PW.admin, newUsername: taken });
      expect([taken, res.status, res.body.code]).toEqual([taken, 409, "USERNAME_TAKEN"]);
    }
    await post("super", `/api/invitations/${inv.body.id}/revoke`);
  });
  test("change own username: role, status, assignments preserved; session kept; audited", async () => {
    const before = await userRow(uid.admin);
    const beforeAccess = await access(uid.admin);
    const res = await post("admin", "/api/account/change-username", { currentPassword: PW.admin, newUsername: `${P}admin-renamed` });
    expect(res.status).toBe(200);
    uname.admin = `${P}admin-renamed`;
    const after = await userRow(uid.admin);
    expect(identity(after)).toEqual(identity(before));
    expect(after.token_version).toBe(before.token_version);
    expect(await access(uid.admin)).toEqual(beforeAccess);
    expect((await loginRaw(`${P}admin`, PW.admin)).status).toBe(401);
    await login("admin");
    const rows = await audits("USERNAME_CHANGED", uid.admin);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].after_data)).toEqual({ username: `${P}admin-renamed` });
  });
  test("change own password: bcrypt cost 10, every session revoked, new password signs in, identity preserved", async () => {
    const before = await userRow(uid.admin);
    const beforeAccess = await access(uid.admin);
    const oldToken = tok.admin;
    const res = await post("admin", "/api/account/change-password", { currentPassword: PW.admin, newPassword: NEW.a, confirmPassword: NEW.a });
    expect(res.status).toBe(200);
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
    const after = await userRow(uid.admin);
    expect(after.password).toMatch(BCRYPT_RE);
    expect(after.token_version).toBe(before.token_version + 1);
    expect(identity({ ...after, failed_login_count: 0, locked_until: null })).toEqual(identity({ ...before, failed_login_count: 0, locked_until: null }));
    expect(await access(uid.admin)).toEqual(beforeAccess);
    expect((await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${oldToken}` })).status).toBe(401);
    expect((await loginRaw(uname.admin, PW.admin)).status).toBe(401);
    PW.admin = NEW.a;
    await login("admin");
    const rows = await audits("PASSWORD_CHANGED", uid.admin);
    expect(rows.length).toBe(1);
    expect(leaks(JSON.stringify(rows), [before.password, after.password])).toEqual([]);
  });
});

describe("policy ON (ALAS) - ADMIN manages Accountants in their companies", () => {
  beforeAll(enable);
  test("reset an Accountant's password: sessions revoked, old password refused, new works, everything else preserved, audited without secrets", async () => {
    const before = await userRow(uid.acct);
    const beforeAccess = await access(uid.acct);
    const oldToken = tok.acct;
    const res = await reset("admin", "acct", NEW.b);
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(true);
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
    const after = await userRow(uid.acct);
    expect(after.password).toMatch(BCRYPT_RE);
    expect(await bcrypt.compare(NEW.b, after.password)).toBe(true);
    expect(after.token_version).toBe(before.token_version + 1);
    expect(identity(after)).toEqual(identity(before)); // role, status, lockout, e-mail, name unchanged
    expect(after.username).toBe(before.username);
    expect(await access(uid.acct)).toEqual(beforeAccess);
    expect((await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${oldToken}` })).status).toBe(401);
    expect((await loginRaw(uname.acct, PW.acct)).status).toBe(401);
    PW.acct = NEW.b;
    await login("acct");
    const rows = await audits("PASSWORD_RESET", uid.acct);
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(uid.admin);
    expect(rows[0].company_id).toBe(co.A);
    expect(leaks(JSON.stringify(rows), [before.password, after.password])).toEqual([]);
  });
  test("change an Accountant's username: new name signs in, old does not, sessions kept, audited before/after", async () => {
    const before = await userRow(uid.acct2);
    const res = await rename("admin", "acct2", `${P}acct2-renamed`);
    expect(res.status).toBe(200);
    const after = await userRow(uid.acct2);
    expect(identity(after)).toEqual(identity(before));
    expect(after.password).toBe(before.password);
    expect(after.token_version).toBe(before.token_version);
    expect((await loginRaw(uname.acct2, PW.acct2)).status).toBe(401);
    uname.acct2 = `${P}acct2-renamed`;
    await login("acct2");
    const rows = await audits("USERNAME_CHANGED", uid.acct2);
    expect(JSON.parse(rows[0].before_data)).toEqual({ username: `${P}acct2` });
    expect(JSON.parse(rows[0].after_data)).toEqual({ username: `${P}acct2-renamed` });
    expect(rows[0].user_id).toBe(uid.admin);
  });
  test("a locked Accountant stays locked after a reset (Unlock remains a separate, audited action)", async () => {
    await pool.query("UPDATE users SET failed_login_count = 5, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?", [uid.acctLocked]);
    const before = await userRow(uid.acctLocked);
    expect((await reset("admin", "acctLocked", NEW.c)).status).toBe(200);
    const after = await userRow(uid.acctLocked);
    expect(after.failed_login_count).toBe(5);
    expect(after.locked_until).toEqual(before.locked_until);
    expect((await loginRaw(uname.acctLocked, NEW.c)).status).toBe(403);
    expect((await post("admin", `/api/users/${uid.acctLocked}/unlock`)).status).toBe(200);
    expect((await loginRaw(uname.acctLocked, NEW.c)).status).toBe(200);
  });
  test("refused: a Super Admin (404), a fellow Admin (403), another company's Accountant (404), self (400), unknown id (404) - nothing changes", async () => {
    const tags = ["super", "admin2", "acctOther", "admin"];
    const before = await Promise.all(tags.map((t) => userRow(uid[t])));
    const cases = [
      [await reset("admin", "super", NEW.c), 404], [await rename("admin", "super", `${P}h3`), 404],
      [await reset("admin", "admin2", NEW.c), 403], [await rename("admin", "admin2", `${P}h4`), 403],
      [await reset("admin", "acctOther", NEW.c), 404], [await rename("admin", "acctOther", `${P}h5`), 404],
      [await reset("admin", "admin", NEW.c), 400], [await rename("admin", "admin", `${P}h6`), 400],
      [await post("admin", "/api/users/999999999/reset-password", { newPassword: NEW.c, confirmPassword: NEW.c }), 404],
    ];
    for (const [r, status] of cases) {
      expect(r.status).toBe(status);
      expect(leaks(JSON.stringify(r.body))).toEqual([]);
    }
    expect(await Promise.all(tags.map((t) => userRow(uid[t])))).toEqual(before);
  });
  test.each([
    ["too short", "Ab1!xyz", "Ab1!xyz", "PASSWORD_TOO_SHORT"],
    ["empty", "", "", "PASSWORD_REQUIRED"],
    ["blank", "         ", "         ", "PASSWORD_INVALID"],
    ["over 72 bytes", "A".repeat(73), "A".repeat(73), "PASSWORD_TOO_LONG"],
    ["mismatch", NEW.c, NEW.c + "x", "PASSWORD_MISMATCH"],
  ])("invalid new password (%s) is rejected and nothing changes", async (_l, pw, confirm, code) => {
    const before = await userRow(uid.acct);
    const res = await reset("admin", "acct", pw, confirm);
    expect([res.status, res.body.code]).toEqual([400, code]);
    expect(await userRow(uid.acct)).toEqual(before);
  });
  test.each([
    ["taken username", () => uname.super, 409, "USERNAME_TAKEN"],
    ["another user's e-mail", () => `${P}admin2@example.test`, 409, "USERNAME_TAKEN"],
    ["same as current", () => uname.acct, 400, "USERNAME_UNCHANGED"],
    ["spaces", () => "has space", 400, "USERNAME_INVALID"],
    ["too short", () => "ab", 400, "USERNAME_INVALID"],
    ["empty", () => "", 400, "USERNAME_REQUIRED"],
  ])("invalid new username (%s) is rejected and nothing changes", async (_l, value, status, code) => {
    const before = await userRow(uid.acct);
    const res = await rename("admin", "acct", value());
    expect([res.status, res.body.code]).toEqual([status, code]);
    expect(await userRow(uid.acct)).toEqual(before);
  });
  test("unauthenticated callers get 401; a forged token 401", async () => {
    expect((await post(null, `/api/users/${uid.acct}/reset-password`, { newPassword: NEW.c, confirmPassword: NEW.c })).status).toBe(401);
    expect((await request(app).post(`/api/users/${uid.acct}/change-username`).set({ Authorization: "Bearer not-a-token" }).send({ newUsername: `${P}h7` })).status).toBe(401);
  });
});

describe("policy ON (ALAS) - SUPER_ADMIN manages everyone", () => {
  beforeAll(enable);
  test("resets an Admin's password and renames another Super Admin; own account only via Account Security", async () => {
    const beforeAdmin2 = await userRow(uid.admin2);
    const r1 = await reset("super", "admin2", NEW.c);
    expect(r1.status).toBe(200);
    expect(identity(await userRow(uid.admin2))).toEqual(identity(beforeAdmin2));
    expect((await loginRaw(uname.admin2, NEW.c)).status).toBe(200);

    const r2 = await rename("super", "super2", `${P}super2-renamed`);
    expect(r2.status).toBe(200);
    expect((await loginRaw(`${P}super2-renamed`, PW.super2)).status).toBe(200);
    expect((await userRow(uid.super2)).role_code).toBe("SUPER_ADMIN");

    expect((await reset("super", "super", NEW.c)).status).toBe(400);
    expect((await reset("super", "acctOther", NEW.c)).status).toBe(200); // any company
  });
  test("audit rows never contain a password, a hash or a token", async () => {
    const [rows] = await pool.query("SELECT description, CAST(before_data AS CHAR) b, CAST(after_data AS CHAR) a FROM audit_logs WHERE entity_type = 'USER' AND entity_id IN (?)", [Object.values(uid)]);
    const [hashes] = await pool.query("SELECT password FROM users WHERE id IN (?)", [Object.values(uid)]);
    expect(leaks(JSON.stringify(rows), hashes.map((h) => h.password))).toEqual([]);
  });
});
