// Login identity model: FULL NAME (display) / USERNAME (login + greeting) /
// E-MAIL (delivery, alerts, alternative login). One identifier field signs in
// with either the username or the e-mail of the SAME account; every existing
// login security rule is unchanged. Invitations require a username and an
// e-mail, both unique case-insensitively across usernames, e-mails and pending
// invitations. Local test database only. Fixture prefix lid-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "lid-";
const PW = "LidPass!2026x";
const GENERIC = { success: false, message: "Invalid username or password" };
const ids = { users: [], companies: [] };
const u = {};
const tok = {};
let companyId, branchA, branchB;

async function role(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function mkUser(tag, { username, email, roleCode = "ACCOUNTANT", fullName = `${P}${tag} Full Name`, branches = [] }) {
  const [r] = await pool.query(
    "INSERT INTO users (username, email, full_name, password, role_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [username, email, fullName, await bcrypt.hash(PW, 10), await role(roleCode)]
  );
  if (roleCode !== "SUPER_ADMIN") await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [r.insertId, b]);
  ids.users.push(r.insertId);
  u[tag] = { id: r.insertId, username, email };
  tok[tag] = signSessionToken({ id: r.insertId, username, role: "user", token_version: 0 });
}
const login = (identifier, password = PW) => request(app).post("/api/login").send({ username: identifier, password });
const state = async (id) => (await pool.query("SELECT failed_login_count AS n, (locked_until IS NOT NULL AND locked_until > NOW()) AS locked FROM users WHERE id = ?", [id]))[0][0];
const as = (tag) => ({ Authorization: `Bearer ${tok[tag]}` });
const invite = (tag, body) => request(app).post("/api/invitations").set(as(tag)).send({ fullName: "Juan Dela Cruz", roleId: undefined, companyIds: [companyId], branchIds: [branchA], ...body });

beforeAll(async () => {
  assertNotProductionDatabase();
  companyId = (await pool.query("INSERT INTO companies (name, tin, status) VALUES (?, '900-555-666-777', 'ACTIVE')", [`${P}Co`]))[0].insertId;
  ids.companies.push(companyId);
  branchA = (await pool.query("INSERT INTO branches (company_id, name, code) VALUES (?, 'LID Audit', 'LIDAUD')", [companyId]))[0].insertId;
  branchB = (await pool.query("INSERT INTO branches (company_id, name, code) VALUES (?, 'LID Outsource', 'LIDOUT')", [companyId]))[0].insertId;
  await mkUser("super", { username: `${P}super`, email: `${P}super@example.test`, roleCode: "SUPER_ADMIN" });
  await mkUser("admin", { username: `${P}admin`, email: `${P}admin@example.test`, roleCode: "ADMIN" });
  await mkUser("juan", { username: `${P}juan.delacruz`, email: `${P}juan@example.test`, branches: [branchA] });
  await mkUser("locky", { username: `${P}locky`, email: `${P}locky@example.test`, branches: [branchA] });
  // a legacy account whose username IS its e-mail (accounts invited before the username field)
  await mkUser("legacy", { username: `${P}legacy@example.test`, email: `${P}legacy@example.test`, branches: [branchA] });
});

afterAll(async () => {
  try {
    const [inv] = await pool.query("SELECT accepted_user_id FROM invitations WHERE email LIKE ? AND accepted_user_id IS NOT NULL", [`${P}%`]);
    const users = [...ids.users, ...inv.map((r) => r.accepted_user_id), 0];
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR company_id IN (?) OR description LIKE ? OR username LIKE ?", [users, ids.companies.concat(0), `%${P}%`, `${P}%`]);
    await pool.query("DELETE FROM invitations WHERE email LIKE ? OR username LIKE ?", [`${P}%`, `${P}%`]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [users]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [ids.companies.concat(0)]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [ids.companies.concat(0)]);
  } finally {
    await pool.end();
  }
});

// NOTE: /api/login is rate-limited to 20 attempts / 15 min per client; this file
// makes exactly 20.
describe("login with username OR e-mail - one account", () => {
  test("LID-01/02/03 username and e-mail both sign in the SAME user; the session carries the username", async () => {
    const byName = await login(u.juan.username);
    const byMail = await login(u.juan.email);
    expect(byName.status).toBe(200);
    expect(byMail.status).toBe(200);
    expect(byName.body.user.id).toBe(u.juan.id);
    expect(byMail.body.user.id).toBe(u.juan.id);
    // the greeting identity is the username, also after an e-mail login
    expect(byName.body.user.username).toBe(u.juan.username);
    expect(byMail.body.user.username).toBe(u.juan.username);
    const me = await request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${byMail.body.token}` });
    expect(me.body.user).toMatchObject({ id: u.juan.id, username: u.juan.username, email: u.juan.email });
    expect(Number((await pool.query("SELECT COUNT(*) n FROM users WHERE id = ? OR username = ? OR email = ?", [u.juan.id, u.juan.username, u.juan.email]))[0][0].n)).toBe(1);
  });
  test("LID-04/05/06 wrong password, unknown username and unknown e-mail give the identical generic answer", async () => {
    const wrong = await login(u.juan.email, "Not-The-Password-1");
    const unknownName = await login(`${P}nobody`);
    const unknownMail = await login(`${P}nobody@example.test`);
    for (const r of [wrong, unknownName, unknownMail]) expect([r.status, r.body]).toEqual([401, GENERIC]);
  });
  test("LID-07/08 username and e-mail matching are case-insensitive (and surrounding spaces are ignored)", async () => {
    const upperName = await login(`  ${u.juan.username.toUpperCase()}  `);
    const upperMail = await login(u.juan.email.toUpperCase());
    expect([upperName.status, upperName.body.user?.id]).toEqual([200, u.juan.id]);
    expect([upperMail.status, upperMail.body.user?.id]).toEqual([200, u.juan.id]);
  });
  test("a legacy account whose username is its e-mail still signs in", async () => {
    const r = await login(u.legacy.email);
    expect([r.status, r.body.user?.id]).toEqual([200, u.legacy.id]);
  });
});

describe("existing login security applies per account, whichever identifier is used", () => {
  test("failures through the e-mail and the username share ONE counter; success resets it", async () => {
    await pool.query("UPDATE users SET failed_login_count = 0 WHERE id = ?", [u.juan.id]); // fixture reset (keeps this file within the login rate limit)
    await login(u.juan.email, "Wrong-1");
    await login(u.juan.username, "Wrong-2");
    expect(Number((await state(u.juan.id)).n)).toBe(2);
    await login(u.juan.email, "Wrong-3"); // third failure: the existing alert path
    expect(Number((await state(u.juan.id)).n)).toBe(3);
    const ok = await login(u.juan.email);
    expect(ok.status).toBe(200);
    expect(Number((await state(u.juan.id)).n)).toBe(0);
  });
  test("the fifth failure locks the account for both identifiers", async () => {
    for (const id of [u.locky.email, u.locky.username, u.locky.email, u.locky.username, u.locky.email]) await login(id, "Wrong-x");
    const s = await state(u.locky.id);
    expect([Number(s.n), Number(s.locked)]).toEqual([5, 1]);
    const blocked = await login(u.locky.username); // correct password, still locked
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/temporarily locked/);
  });
});

describe("invitations: username and e-mail are both required and unique", () => {
  let accountantRole;
  beforeAll(async () => { accountantRole = await role("ACCOUNTANT"); });
  const body = (extra) => ({ roleId: accountantRole, ...extra });

  test("LID-11/12 username and e-mail are required; the username follows the Account Security rule", async () => {
    const noUser = await invite("admin", body({ email: `${P}a@example.test` }));
    const blankUser = await invite("admin", body({ email: `${P}a@example.test`, username: "   " }));
    const badUser = await invite("admin", body({ email: `${P}a@example.test`, username: "juan dela cruz" }));
    const noMail = await invite("admin", body({ username: `${P}a.user` }));
    const badMail = await invite("admin", body({ username: `${P}a.user`, email: "not-an-email" }));
    expect([noUser.status, noUser.body.message]).toEqual([400, "Username is required."]);
    expect(blankUser.status).toBe(400);
    expect(badUser.status).toBe(400);
    expect(badUser.body.message).toMatch(/3-100 characters/);
    expect(noMail.status).toBe(400);
    expect(badMail.status).toBe(400);
    expect(Number((await pool.query("SELECT COUNT(*) n FROM invitations WHERE email LIKE ? OR username LIKE ?", [`${P}a%`, `${P}a.%`]))[0][0].n)).toBe(0);
  });
  test("LID-09/10 duplicates are rejected case-insensitively (usernames, e-mails, and across the two)", async () => {
    const cases = [
      [{ username: u.juan.username.toUpperCase(), email: `${P}new1@example.test` }, "username of another user (case variant)"],
      [{ username: u.juan.email, email: `${P}new2@example.test` }, "username = another user's e-mail"],
      [{ username: `${P}new3`, email: u.juan.email.toUpperCase() }, "e-mail of another user (case variant)"],
      [{ username: `${P}new4`, email: u.legacy.username }, "e-mail = another user's username"],
    ];
    for (const [ident, label] of cases) {
      const r = await invite("admin", body(ident));
      expect([label, r.status]).toEqual([label, 409]);
    }
    const first = await invite("admin", body({ username: `${P}pending.one`, email: `${P}pending1@example.test` }));
    expect(first.status).toBe(201);
    const samePendingName = await invite("admin", body({ username: `${P}PENDING.ONE`, email: `${P}pending2@example.test` }));
    expect(samePendingName.status).toBe(409);
    expect(samePendingName.body.message).toBe("That username is already in use.");
    // a SUPER_ADMIN rename may not take a pending invitation's username either
    const rename = await request(app).post("/api/account/change-username").set(as("super")).send({ currentPassword: PW, newUsername: `${P}pending.one` });
    expect(rename.status).toBe(409);
  });
  test("LID-13/14/15 acceptance creates exactly ONE user with the chosen username, e-mail, full name, company, branches and role; both identifiers sign in", async () => {
    const r = await invite("admin", body({ fullName: "Juan Dela Cruz", username: `${P}jdc`, email: `${P}JDC@Example.test`, branchIds: [branchA, branchB] }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: `${P}jdc@example.test`, username: `${P}jdc` });
    const raw = new URL(r.body.acceptUrl).searchParams.get("token");
    const [[inv]] = await pool.query("SELECT username, token_hash FROM invitations WHERE id = ?", [r.body.id]);
    expect(inv.username).toBe(`${P}jdc`);
    expect(inv.token_hash).not.toBe(raw); // only the hash is stored
    const v = await request(app).get(`/api/invitations/validate/${raw}`);
    expect(v.body).toMatchObject({ fullName: "Juan Dela Cruz", username: `${P}jdc`, email: `${P}jdc@example.test`, roleName: "Accountant" });
    const acc = await request(app).post("/api/invitations/accept").send({ token: raw, password: PW, acceptedTerms: true });
    expect(acc.status).toBe(201);
    expect(acc.body.user.username).toBe(`${P}jdc`);
    const [rows] = await pool.query("SELECT u.id, u.username, u.email, u.full_name, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ? OR u.email = ?", [`${P}jdc`, `${P}jdc@example.test`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: `${P}jdc`, email: `${P}jdc@example.test`, full_name: "Juan Dela Cruz", role: "ACCOUNTANT" });
    const access = (await pool.query("SELECT (SELECT GROUP_CONCAT(company_id) FROM user_companies WHERE user_id = ?) c, (SELECT GROUP_CONCAT(branch_id ORDER BY branch_id) FROM user_branches WHERE user_id = ?) b", [rows[0].id, rows[0].id]))[0][0];
    expect(access).toEqual({ c: String(companyId), b: [branchA, branchB].sort((x, y) => x - y).join(",") });
    const byName = await login(`${P}jdc`);
    const byMail = await login(`${P}jdc@example.test`);
    expect([byName.status, byName.body.user?.id]).toEqual([200, rows[0].id]);
    expect([byMail.status, byMail.body.user?.id, byMail.body.user?.username]).toEqual([200, rows[0].id, `${P}jdc`]);
    // branch authorization is unchanged for the invited accountant, whichever identifier signed in
    const t = byMail.body.token;
    const allBranches = await request(app).get(`/api/reports/trial-balance?companyId=${companyId}&from=2026-01-01&to=2026-12-31&branch=ALL`).set({ Authorization: `Bearer ${t}` });
    expect(allBranches.status).toBe(403);
  });
});

describe("Account Security stays SUPER_ADMIN-only", () => {
  test("LID-17/18/19 SUPER_ADMIN reaches it; ADMIN and ACCOUNTANT get 403", async () => {
    const sa = await request(app).post("/api/account/change-username").set(as("super")).send({ currentPassword: "wrong-on-purpose", newUsername: `${P}x.y` });
    expect(sa.status).toBe(400); // authorized; rejected only for the wrong current password
    for (const tag of ["admin", "juan"]) {
      const r = await request(app).post("/api/account/change-username").set(as(tag)).send({ currentPassword: PW, newUsername: `${P}hijack` });
      expect([tag, r.status]).toEqual([tag, 403]);
    }
    expect((await pool.query("SELECT username FROM users WHERE id = ?", [u.super.id]))[0][0].username).toBe(`${P}super`);
  });
});
