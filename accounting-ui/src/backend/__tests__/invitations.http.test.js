// Administration -> Invitations: role hierarchy, company/branch scope,
// required company, resend/revoke ownership (cross-company isolation),
// email-delivery states, and the full validate -> accept -> user flow.
//
// Role hierarchy (server-enforced in invitationService.INVITABLE_ROLES_BY_INVITER):
//   Super Admin -> Admin, Accountant;  Admin -> Accountant;  Accountant -> none.
// Resend/revoke: only the original inviter or a Super Admin; anyone else
// gets 404 (existence not revealed) and never receives a new link.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const EmailService = require("../services/emailService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "invt-"; // fixture prefix (usernames / emails / names)
const MAIL = (tag) => `${P}${tag}@example.test`;
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const tokenOf = (acceptUrl) => new URL(acceptUrl).searchParams.get("token");

const ids = {};
const tokens = {};

async function makeUser(username, roleId, companyIds = [], branchIds = []) {
  const hash = await bcrypt.hash("InvtPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [username, hash, roleId, `${username}@example.test`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  return u.insertId;
}

async function login(username) {
  const res = await request(app).post("/api/login").send({ username, password: "InvtPass!1" });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
  return res.body.token;
}
const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

// Email is mocked per test so the delivered / not-delivered states are
// deterministic regardless of any SMTP settings on the machine.
function mockEmail(delivered) {
  return jest
    .spyOn(EmailService, "sendInvitationEmail")
    .mockResolvedValue(delivered ? { delivered: true } : { delivered: false, reason: "SMTP_NOT_CONFIGURED" });
}

async function invite(who, body) {
  return request(app).post("/api/invitations").set(auth(who)).send(body);
}

async function invitationRow(email) {
  const [rows] = await pool.execute("SELECT * FROM invitations WHERE email = ?", [email]);
  return rows[0];
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [roles] = await pool.execute("SELECT id, code FROM roles");
  for (const r of roles) ids[r.code] = r.id;

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('INVT Co A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('INVT Co B', 'Active')");
  ids.coA = ca.insertId;
  ids.coB = cb.insertId;
  const [ba] = await pool.execute("INSERT INTO branches (company_id, name, code, status) VALUES (?, 'INVT Branch A1', 'INVT-BA1', 'ACTIVE')", [ids.coA]);
  const [bb] = await pool.execute("INSERT INTO branches (company_id, name, code, status) VALUES (?, 'INVT Branch B1', 'INVT-BB1', 'ACTIVE')", [ids.coB]);
  ids.brA1 = ba.insertId;
  ids.brB1 = bb.insertId;

  ids.superAdmin = await makeUser(`${P}superadmin`, ids.SUPER_ADMIN);
  ids.adminA = await makeUser(`${P}admin_a`, ids.ADMIN, [ids.coA], [ids.brA1]);
  ids.adminB = await makeUser(`${P}admin_b`, ids.ADMIN, [ids.coB], [ids.brB1]);
  ids.accountantA = await makeUser(`${P}accountant_a`, ids.ACCOUNTANT, [ids.coA]);

  for (const who of ["superAdmin", "adminA", "adminB", "accountantA"]) {
    const name = { superAdmin: "superadmin", adminA: "admin_a", adminB: "admin_b", accountantA: "accountant_a" }[who];
    tokens[who] = await login(`${P}${name}`);
  }

  // Permission template with exactly one granted permission.
  const [t] = await pool.execute("INSERT INTO permission_templates (name, description, is_system) VALUES ('INVT Template', 'test', 0)");
  ids.template = t.insertId;
  const [[perm]] = await pool.execute("SELECT id FROM permissions WHERE module_key = 'REPORTS.FINANCIAL' AND action = 'VIEW'");
  ids.templatePerm = perm.id;
  await pool.execute("INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)", [ids.template, perm.id]);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE ? OR email LIKE ?", [`${P}%`, `${P}%`]);
  const userIds = users.map((u) => u.id);
  await pool.query("DELETE FROM invitations WHERE email LIKE ?", [`${P}%`]);
  if (userIds.length) {
    await pool.query("DELETE FROM invitations WHERE invited_by IN (?)", [userIds]);
    for (const t of ["user_companies", "user_branches", "user_permissions"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]);
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }
  await pool.query("DELETE FROM permission_templates WHERE id = ?", [ids.template]);
  await pool.query("DELETE FROM branches WHERE id IN (?, ?)", [ids.brA1, ids.brB1]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [ids.coA, ids.coB]);
  await pool.end();
});

// ---------------------------------------------------------------------------
describe("role hierarchy (server-enforced)", () => {
  test("Admin -> Accountant succeeds", async () => {
    mockEmail(false);
    const res = await invite("adminA", { email: MAIL("acct1"), fullName: "Acct One", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], branchIds: [ids.brA1], permissionTemplateId: ids.template });
    expect(res.status).toBe(201);
    const row = await invitationRow(MAIL("acct1"));
    expect(row.status).toBe("PENDING");
    expect(row.role_id).toBe(ids.ACCOUNTANT);
    expect(row.invited_by).toBe(ids.adminA);
    // Token stored only as a hash.
    const raw = tokenOf(res.body.acceptUrl);
    expect(row.token_hash).toBe(sha256(raw));
    expect(row.token_hash).not.toBe(raw);
  });

  test("Super Admin -> Admin succeeds", async () => {
    mockEmail(false);
    const res = await invite("superAdmin", { email: MAIL("sa-admin"), fullName: "SA Admin", roleId: ids.ADMIN, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
  });

  test("Super Admin -> Accountant succeeds", async () => {
    mockEmail(false);
    const res = await invite("superAdmin", { email: MAIL("sa-acct"), fullName: "SA Acct", roleId: ids.ACCOUNTANT, companyIds: [ids.coB] });
    expect(res.status).toBe(201);
  });

  test("Admin -> Admin is rejected (403), nothing created", async () => {
    const res = await invite("adminA", { email: MAIL("a-admin"), fullName: "X", roleId: ids.ADMIN, companyIds: [ids.coA] });
    expect(res.status).toBe(403);
    expect(await invitationRow(MAIL("a-admin"))).toBeUndefined();
  });

  test("Admin -> Super Admin is rejected (403), nothing created", async () => {
    const res = await invite("adminA", { email: MAIL("a-sa"), fullName: "X", roleId: ids.SUPER_ADMIN, companyIds: [ids.coA] });
    expect(res.status).toBe(403);
    expect(await invitationRow(MAIL("a-sa"))).toBeUndefined();
  });

  test("Accountant cannot invite anyone (403)", async () => {
    const res = await invite("accountantA", { email: MAIL("acct-acct"), fullName: "X", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(403);
    expect(await invitationRow(MAIL("acct-acct"))).toBeUndefined();
  });
});

describe("company / branch scope and required company", () => {
  test("a company the inviter cannot access is rejected (403)", async () => {
    const res = await invite("adminA", { email: MAIL("x-co"), fullName: "X", roleId: ids.ACCOUNTANT, companyIds: [ids.coB] });
    expect(res.status).toBe(403);
    expect(await invitationRow(MAIL("x-co"))).toBeUndefined();
  });

  test("a branch the inviter cannot access is rejected (403)", async () => {
    const res = await invite("adminA", { email: MAIL("x-br"), fullName: "X", roleId: ids.ACCOUNTANT, companyIds: [ids.coA], branchIds: [ids.brB1] });
    expect(res.status).toBe(403);
    expect(await invitationRow(MAIL("x-br"))).toBeUndefined();
  });

  test("an invitation with no company is rejected (400), nothing created", async () => {
    for (const companyIds of [[], undefined, [0]]) {
      const res = await invite("adminA", { email: MAIL("no-co"), fullName: "X", roleId: ids.ACCOUNTANT, companyIds });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least one company/i);
    }
    const sa = await invite("superAdmin", { email: MAIL("no-co"), fullName: "X", roleId: ids.ADMIN, companyIds: [] });
    expect(sa.status).toBe(400);
    expect(await invitationRow(MAIL("no-co"))).toBeUndefined();
  });

  test("a duplicate pending invitation is rejected (409)", async () => {
    const res = await invite("adminA", { email: MAIL("acct1"), fullName: "Again", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(409);
  });
});

describe("email delivery states", () => {
  test("delivered: 'sent' state, no manual link returned, status SENT", async () => {
    const spy = mockEmail(true);
    const res = await invite("adminA", { email: MAIL("mail-ok"), fullName: "Mail Ok", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.body.emailDelivered).toBe(true);
    expect(res.body.acceptUrl).toBeUndefined();
    expect((await invitationRow(MAIL("mail-ok"))).email_delivery_status).toBe("SENT");
  });

  test("not delivered: invitation still created, manual link returned, status NOT_SENT", async () => {
    mockEmail(false);
    const res = await invite("adminA", { email: MAIL("mail-fail"), fullName: "Mail Fail", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect(res.body.emailDelivered).toBe(false);
    expect(res.body.acceptUrl).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/);
    expect((await invitationRow(MAIL("mail-fail"))).email_delivery_status).toBe("NOT_SENT");
  });
});

describe("validate -> accept -> user", () => {
  let rawToken;

  test("validation returns display-only details", async () => {
    mockEmail(false);
    // Fresh link for the Admin -> Accountant invitation via the inviter's own resend.
    const row = await invitationRow(MAIL("acct1"));
    const resend = await request(app).post(`/api/invitations/${row.id}/resend`).set(auth("adminA"));
    rawToken = tokenOf(resend.body.acceptUrl);
    const res = await request(app).get(`/api/invitations/validate/${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: MAIL("acct1"),
      fullName: "Acct One",
      roleName: "Accountant",
      companyNames: ["INVT Co A"],
      expiresAt: expect.any(String),
    });
  });

  test("valid acceptance creates an ACTIVE user with role, company, branch and template permissions", async () => {
    const res = await request(app).post("/api/invitations/accept").send({ token: rawToken, password: "NewUser!123", acceptedTerms: true });
    expect(res.status).toBe(201);
    const userId = res.body.user.id;

    const [[u]] = await pool.execute("SELECT u.status, u.email, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?", [userId]);
    expect(u).toEqual({ status: "ACTIVE", email: MAIL("acct1"), role: "ACCOUNTANT" });

    const [cos] = await pool.execute("SELECT company_id FROM user_companies WHERE user_id = ?", [userId]);
    expect(cos.map((c) => c.company_id)).toEqual([ids.coA]);
    const [brs] = await pool.execute("SELECT branch_id FROM user_branches WHERE user_id = ?", [userId]);
    expect(brs.map((b) => b.branch_id)).toEqual([ids.brA1]);

    const [granted] = await pool.execute("SELECT permission_id FROM user_permissions WHERE user_id = ? AND granted = 1", [userId]);
    expect(granted.map((g) => g.permission_id)).toEqual([ids.templatePerm]);

    const inv = await invitationRow(MAIL("acct1"));
    expect(inv.status).toBe("ACCEPTED");
    expect(inv.accepted_user_id).toBe(userId);

    const loginRes = await request(app).post("/api/login").send({ username: MAIL("acct1"), password: "NewUser!123" });
    expect(loginRes.status).toBe(200);
  });

  test("an already-used invitation cannot be accepted again", async () => {
    const res = await request(app).post("/api/invitations/accept").send({ token: rawToken, password: "Another!123", acceptedTerms: true });
    expect(res.status).toBe(410);
  });

  test("an expired invitation is rejected on validate and accept", async () => {
    mockEmail(false);
    const res = await invite("adminA", { email: MAIL("expired"), fullName: "Expired", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    const raw = tokenOf(res.body.acceptUrl);
    await pool.execute("UPDATE invitations SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE email = ?", [MAIL("expired")]);
    expect((await request(app).get(`/api/invitations/validate/${raw}`)).status).toBe(410);
    const acc = await request(app).post("/api/invitations/accept").send({ token: raw, password: "NewUser!123", acceptedTerms: true });
    expect(acc.status).toBe(410);
    const [u] = await pool.execute("SELECT id FROM users WHERE email = ?", [MAIL("expired")]);
    expect(u).toHaveLength(0);
  });

  test("a revoked invitation is rejected on validate and accept", async () => {
    mockEmail(false);
    const res = await invite("adminA", { email: MAIL("revoked"), fullName: "Revoked", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    const raw = tokenOf(res.body.acceptUrl);
    const rv = await request(app).post(`/api/invitations/${res.body.id}/revoke`).set(auth("adminA"));
    expect(rv.status).toBe(200);
    expect((await request(app).get(`/api/invitations/validate/${raw}`)).status).toBe(410);
    const acc = await request(app).post("/api/invitations/accept").send({ token: raw, password: "NewUser!123", acceptedTerms: true });
    expect(acc.status).toBe(410);
  });
});

describe("resend / revoke ownership", () => {
  let targetId;

  beforeAll(async () => {
    const spy = jest.spyOn(EmailService, "sendInvitationEmail").mockResolvedValue({ delivered: false, reason: "SMTP_NOT_CONFIGURED" });
    const res = await invite("adminA", { email: MAIL("owned"), fullName: "Owned", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    targetId = res.body.id;
    spy.mockRestore();
  });

  test("a cross-company Admin cannot resend: 404, no new link, token unchanged", async () => {
    const before = await invitationRow(MAIL("owned"));
    const res = await request(app).post(`/api/invitations/${targetId}/resend`).set(auth("adminB"));
    expect(res.status).toBe(404);
    expect(res.body.acceptUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/token|accept-invite/i);
    const after = await invitationRow(MAIL("owned"));
    expect(after.token_hash).toBe(before.token_hash);
    expect(after.resend_count).toBe(before.resend_count);
  });

  test("a cross-company Admin cannot revoke: 404, invitation stays PENDING", async () => {
    const res = await request(app).post(`/api/invitations/${targetId}/revoke`).set(auth("adminB"));
    expect(res.status).toBe(404);
    expect((await invitationRow(MAIL("owned"))).status).toBe("PENDING");
  });

  test("the cross-company 404 is identical to a non-existent id (existence not revealed)", async () => {
    const real = await request(app).post(`/api/invitations/${targetId}/revoke`).set(auth("adminB"));
    const fake = await request(app).post("/api/invitations/999999999/revoke").set(auth("adminB"));
    expect([real.status, real.body]).toEqual([fake.status, fake.body]);
  });

  test("the original inviter can resend (new token, manual link when not delivered)", async () => {
    mockEmail(false);
    const before = await invitationRow(MAIL("owned"));
    const res = await request(app).post(`/api/invitations/${targetId}/resend`).set(auth("adminA"));
    expect(res.status).toBe(200);
    expect(res.body.acceptUrl).toMatch(/accept-invite\?token=/);
    const after = await invitationRow(MAIL("owned"));
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(after.resend_count).toBe(before.resend_count + 1);
  });

  test("a Super Admin can resend another user's invitation", async () => {
    mockEmail(false);
    const res = await request(app).post(`/api/invitations/${targetId}/resend`).set(auth("superAdmin"));
    expect(res.status).toBe(200);
  });

  test("a Super Admin can revoke another user's invitation", async () => {
    const res = await request(app).post(`/api/invitations/${targetId}/revoke`).set(auth("superAdmin"));
    expect(res.status).toBe(200);
    expect((await invitationRow(MAIL("owned"))).status).toBe("REVOKED");
  });

  test("the original inviter can revoke their own invitation", async () => {
    mockEmail(false);
    const res = await invite("adminA", { email: MAIL("owned2"), fullName: "Owned 2", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    const rv = await request(app).post(`/api/invitations/${res.body.id}/revoke`).set(auth("adminA"));
    expect(rv.status).toBe(200);
    expect((await invitationRow(MAIL("owned2"))).status).toBe("REVOKED");
  });

  test("the cross-company Admin's list still never shows another company's invitations", async () => {
    const res = await request(app).get("/api/invitations").set(auth("adminB"));
    expect(res.status).toBe(200);
    expect(res.body.some((i) => String(i.email).startsWith(`${P}owned`))).toBe(false);
  });
});

describe("InviteUserModal.jsx", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "components", "InviteUserModal.jsx"), "utf8");

  test("role options follow the same hierarchy as the server (Admin sees Accountant only)", () => {
    expect(src).toMatch(/SUPER_ADMIN: \["ADMIN", "ACCOUNTANT"\]/);
    expect(src).toMatch(/ADMIN: \["ACCOUNTANT"\]/);
    expect(src).toMatch(/invitableRoles\.map/);
    expect(src).not.toMatch(/\{roles\.map/);
  });

  test("submission requires at least one company", () => {
    expect(src).toMatch(/form\.companyIds\.length === 0/);
    expect(src).toMatch(/Select at least one company/);
  });

  test("result message distinguishes delivered vs. not delivered", () => {
    expect(src).toMatch(/Invitation created — email not sent\. Share the invitation link manually\./);
    expect(src).toMatch(/Invitation sent to <strong>\{result\.email\}<\/strong>\./);
    // 'sent' is only shown in the delivered branch
    const notDelivered = src.slice(src.indexOf("result.emailDelivered === false ?"), src.indexOf(") : (", src.indexOf("result.emailDelivered === false ?")));
    expect(notDelivered).not.toMatch(/Invitation sent to/);
  });

  test("lookup failures are handled: status + array checks, error with Retry, submit disabled", () => {
    expect(src).toMatch(/!res\.ok \|\| !Array\.isArray\(data\)/);
    expect(src).toMatch(/onClick=\{loadLookups\}/);
    expect(src).toMatch(/disabled=\{submitting \|\| !formReady\}/);
  });
});

// ---------------------------------------------------------------------------
// The accept-invite link carries the raw invitation token. It may be returned
// to the inviting admin (manual sharing) but must never reach the server log.
// These tests use the REAL emailService (no sendInvitationEmail mock) and
// capture every console channel.
describe("raw invitation token is never logged", () => {
  const nodemailer = require("nodemailer");
  const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
  const savedEnv = {};
  // One fake transport for the whole block: emailService caches the first
  // transporter it creates, so each test steers this object's sendMail.
  const fakeTransport = { sendMail: jest.fn() };
  let logged;

  function captureConsole() {
    logged = [];
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      jest.spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  }

  function assertNotLogged(acceptUrl) {
    const raw = tokenOf(acceptUrl);
    const all = logged.join("\n");
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(all).not.toContain(raw);
    expect(all).not.toContain(acceptUrl);
    expect(all).not.toMatch(/accept-invite\?token=/);
  }

  function useSmtp(configured) {
    for (const k of SMTP_KEYS) delete process.env[k];
    if (configured) {
      Object.assign(process.env, { SMTP_HOST: "smtp.invalid.test", SMTP_PORT: "587", SMTP_USER: "invt-smtp-user", SMTP_PASS: "invt-smtp-pass", SMTP_FROM: "noreply@example.test" });
    }
  }

  beforeAll(() => {
    for (const k of SMTP_KEYS) savedEnv[k] = process.env[k];
  });

  beforeEach(() => {
    jest.spyOn(nodemailer, "createTransport").mockReturnValue(fakeTransport);
    fakeTransport.sendMail.mockReset();
    captureConsole();
  });

  afterAll(() => {
    for (const k of SMTP_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("A. SMTP not configured: no throw, manual link returned, token not logged, stored value is the hash", async () => {
    useSmtp(false);
    const res = await invite("adminA", { email: MAIL("log-nosmtp"), fullName: "Log NoSmtp", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect(res.body.emailDelivered).toBe(false);
    expect(res.body.acceptUrl).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/);
    assertNotLogged(res.body.acceptUrl);
    expect(logged.join("\n")).toContain(`invitation email for ${MAIL("log-nosmtp")} not sent`);
    // D. integrity: stored value is the hash of the returned token, never the token
    const row = await invitationRow(MAIL("log-nosmtp"));
    const raw = tokenOf(res.body.acceptUrl);
    expect(row.token_hash).toBe(sha256(raw));
    expect(row.token_hash).not.toBe(raw);
    expect(row.email_delivery_status).not.toBe("SENT");
    // the returned link still works
    const v = await request(app).get(`/api/invitations/validate/${raw}`);
    expect(v.status).toBe(200);
  });

  test("A2. resend without SMTP: new manual link returned, not logged, old token replaced by the new hash", async () => {
    useSmtp(false);
    const created = await invite("adminA", { email: MAIL("log-resend"), fullName: "Log Resend", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    const before = await invitationRow(MAIL("log-resend"));
    captureConsole();
    const res = await request(app).post(`/api/invitations/${before.id}/resend`).set(auth("adminA"));
    expect(res.status).toBe(200);
    expect(res.body.acceptUrl).toMatch(/accept-invite\?token=/);
    assertNotLogged(res.body.acceptUrl);
    const after = await invitationRow(MAIL("log-resend"));
    expect(after.token_hash).toBe(sha256(tokenOf(res.body.acceptUrl)));
    expect(tokenOf(res.body.acceptUrl)).not.toBe(tokenOf(created.body.acceptUrl));
  });

  test("B. delivery failure: manual link returned, error message logged, token not logged", async () => {
    useSmtp(true);
    fakeTransport.sendMail.mockRejectedValue(new Error("connect ECONNREFUSED smtp.invalid.test:587"));
    const res = await invite("adminA", { email: MAIL("log-fail"), fullName: "Log Fail", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect(res.body.emailDelivered).toBe(false);
    expect(res.body.acceptUrl).toMatch(/accept-invite\?token=[0-9a-f]{64}$/);
    expect(fakeTransport.sendMail).toHaveBeenCalledTimes(1);
    assertNotLogged(res.body.acceptUrl);
    const all = logged.join("\n");
    expect(all).toContain("ECONNREFUSED");
    expect(all).toContain(`invitation email for ${MAIL("log-fail")} not sent`);
    expect(all).not.toContain("invt-smtp-pass");
    const row = await invitationRow(MAIL("log-fail"));
    expect(row.token_hash).toBe(sha256(tokenOf(res.body.acceptUrl)));
  });

  test("C. successful delivery: unchanged behaviour (link only in the email, not in the response or the log)", async () => {
    useSmtp(true);
    fakeTransport.sendMail.mockResolvedValue({ messageId: "invt-ok" });
    const res = await invite("adminA", { email: MAIL("log-ok"), fullName: "Log Ok", roleId: ids.ACCOUNTANT, companyIds: [ids.coA] });
    expect(res.status).toBe(201);
    expect(res.body.emailDelivered).toBe(true);
    expect(res.body.acceptUrl).toBeUndefined();
    expect(fakeTransport.sendMail).toHaveBeenCalledTimes(1);
    const mail = fakeTransport.sendMail.mock.calls[0][0];
    expect(mail.to).toBe(MAIL("log-ok"));
    const emailedUrl = mail.text.match(/https?:\/\/\S+accept-invite\?token=[0-9a-f]{64}/)[0];
    expect(mail.html).toContain(emailedUrl);
    assertNotLogged(emailedUrl);
    // D. the emailed token is the one whose hash is stored
    const row = await invitationRow(MAIL("log-ok"));
    expect(row.token_hash).toBe(sha256(tokenOf(emailedUrl)));
    expect(row.email_delivery_status).toBe("SENT");
  });

  test("emailService source no longer interpolates the accept URL into any log call", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services", "emailService.js"), "utf8");
    const logCalls = src.match(/console\.\w+\([^;]*\);/g) || [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) expect(call).not.toMatch(/acceptUrl|token/i);
  });
});
