// Authentication security (TC-SEC-001 .. TC-SEC-013):
//   A. 15-minute inactivity timeout, enforced server-side by the session token's
//      expiry (lib/sessionPolicy.js, middleware/authenticate.js), extended only by
//      POST /api/auth/keepalive.
//   B. 3 consecutive wrong passwords -> one security email (services/securityAlertService.js).
// Expired / near-expiry sessions are simulated with tokens signed by the server's own
// secret and a back-dated issue time (no 15-minute wait). Email is never sent for
// real: EmailService.sendSecurityAlertEmail is spied. NOTE: the login rate limit is
// 20 attempts / 15 min per IP for this file's app instance - this file stays under it.
// Local test database only. Fixture prefix UAT-SEC-.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const EmailService = require("../services/emailService");
const SecurityAlert = require("../services/securityAlertService");
const { SESSION_IDLE_SECONDS, SESSION_EXPIRED_MESSAGE } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "UAT-SEC-";
const PW = "UatSec!Correct-2026";
const WRONG = "Wrong-Password-x9";
const users = {};
let emailSpy;

async function makeUser(tag, roleCode, email) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, full_name, email, password, role_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `UAT Sec ${tag}`, email, await bcrypt.hash(PW, 10), role.id]);
  users[tag] = { id: u.insertId, username: `${P}${tag}`, email };
}
const login = (username, password) => request(app).post("/api/login").send({ username, password });
const now = () => Math.floor(Date.now() / 1000);
// a session token as the server issues it, but issued `ageSeconds` ago
const tokenAged = (u, ageSeconds) => jwt.sign({ id: u.id, username: u.username, role: "user", tv: 0, iat: now() - ageSeconds }, process.env.JWT_SECRET, { expiresIn: SESSION_IDLE_SECONDS });
const me = (token) => request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${token}` });
const failed = async (id) => Number((await pool.query("SELECT failed_login_count n FROM users WHERE id = ?", [id]))[0][0].n);
const auditRows = async (id, action) => (await pool.query("SELECT action, description, before_data, after_data FROM audit_logs WHERE user_id = ? AND action = ? ORDER BY id", [id, action]))[0];

beforeAll(async () => {
  assertNotProductionDatabase();
  await makeUser("acct", "ACCOUNTANT", "uat-sec-acct@example.test");
  await makeUser("super", "SUPER_ADMIN", "uat-sec-super@example.test");
  await makeUser("reset", "ADMIN", "uat-sec-reset@example.test");
  emailSpy = jest.spyOn(EmailService, "sendSecurityAlertEmail").mockResolvedValue({ delivered: true });
});

afterAll(async () => {
  emailSpy.mockRestore();
  try {
    await SecurityAlert.flush();
    const ids = Object.values(users).map((u) => u.id);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR description LIKE ?", [ids, `%${P}%`]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("A. inactivity timeout (server-side)", () => {
  test("the session token issued at login lives exactly the idle window (15 minutes)", async () => {
    expect(SESSION_IDLE_SECONDS).toBe(15 * 60);
    const res = await login(users.acct.username, PW); // login 1
    expect(res.status).toBe(200);
    const { iat, exp } = jwt.decode(res.body.token);
    expect([exp - iat, res.body.expiresInSeconds]).toEqual([900, 900]);
    expect((await me(res.body.token)).status).toBe(200);
  });

  test("TC-SEC-001 active within 15 minutes: a 14-minute-old session is still valid", async () => {
    expect((await me(tokenAged(users.acct, 14 * 60))).status).toBe(200);
  });

  test("TC-SEC-002 / TC-SEC-004 inactive for 15 minutes: every request gets 401 SESSION_EXPIRED with the inactivity message", async () => {
    const expired = tokenAged(users.acct, 15 * 60 + 5);
    for (const res of [
      await me(expired),
      await request(app).get("/api/company-branches").set({ Authorization: `Bearer ${expired}` }),
      await request(app).post("/api/company-branches").set({ Authorization: `Bearer ${expired}` }).send({ code: "X", name: "x" }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ message: SESSION_EXPIRED_MESSAGE, code: "SESSION_EXPIRED" });
    }
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session has expired due to inactivity. Please log in again.");
  });

  test("TC-SEC-003 activity before the timeout resets it: keepalive re-issues a fresh 15-minute token", async () => {
    const old = tokenAged(users.acct, 14 * 60); // 1 minute left
    const res = await request(app).post("/api/auth/keepalive").set({ Authorization: `Bearer ${old}` });
    expect(res.status).toBe(200);
    const fresh = jwt.decode(res.body.token);
    expect(fresh.exp - now()).toBeGreaterThan(14 * 60);
    expect(fresh.exp - jwt.decode(old).exp).toBeGreaterThan(13 * 60);
    expect([fresh.id, fresh.tv]).toEqual([users.acct.id, 0]);
    expect((await me(res.body.token)).status).toBe(200);
  });

  test("keepalive cannot revive an expired or revoked session; a missing token is refused", async () => {
    const expired = await request(app).post("/api/auth/keepalive").set({ Authorization: `Bearer ${tokenAged(users.acct, 16 * 60)}` });
    expect([expired.status, expired.body.code]).toEqual([401, "SESSION_EXPIRED"]);
    await pool.query("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [users.acct.id]);
    const revoked = await request(app).post("/api/auth/keepalive").set({ Authorization: `Bearer ${tokenAged(users.acct, 60)}` });
    expect(revoked.status).toBe(401);
    await pool.query("UPDATE users SET token_version = 0 WHERE id = ?", [users.acct.id]);
    expect((await request(app).post("/api/auth/keepalive")).status).toBe(401);
  });

  test("TC-SEC-005 (API side) a page reload after expiry: its first authenticated call is refused, so the app returns to Login", async () => {
    const res = await me(tokenAged(users.acct, 20 * 60));
    expect([res.status, res.body.code]).toEqual([401, "SESSION_EXPIRED"]);
  });
});

// ===========================================================================
describe("B. failed-login monitoring", () => {
  test("TC-SEC-006 one wrong password: rejected, no email, counter 1", async () => {
    const res = await login(users.acct.username, WRONG); // login 2
    expect([res.status, res.body.message]).toEqual([401, "Invalid username or password"]);
    await SecurityAlert.flush();
    expect(emailSpy).not.toHaveBeenCalled();
    expect(await failed(users.acct.id)).toBe(1);
  });

  test("TC-SEC-007 two wrong passwords: rejected, still no email", async () => {
    expect((await login(users.acct.username, WRONG)).status).toBe(401); // login 3
    await SecurityAlert.flush();
    expect(emailSpy).not.toHaveBeenCalled();
    expect(await failed(users.acct.id)).toBe(2);
  });

  test("TC-SEC-008 the third consecutive wrong password triggers exactly one security email to the registered address", async () => {
    const res = await login(users.acct.username, WRONG); // login 4
    expect([res.status, res.body.message]).toEqual([401, "Invalid username or password"]); // same generic answer
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    const arg = emailSpy.mock.calls[0][0];
    expect(arg).toMatchObject({ to: users.acct.email, attempts: 3 });
    expect(JSON.stringify(arg)).not.toContain(WRONG);
    expect(JSON.stringify(arg)).not.toContain(PW);
    expect((await auditRows(users.acct.id, "FAILED_LOGIN_THRESHOLD")).length).toBe(1);
    expect((await auditRows(users.acct.id, "SECURITY_ALERT_EMAIL_SENT")).length).toBe(1);
  });

  test("the email content says what happened and nothing sensitive", () => {
    const { subject, text } = EmailService.securityAlertContent({ fullName: "UAT Sec acct", attempts: 3, occurredAt: new Date("2026-11-20T08:00:00Z") });
    expect(subject).toBe("Security Alert: unsuccessful login attempts on your account");
    expect(text).toContain("Security Alert: We detected three unsuccessful login attempts on your account");
    expect(text).toContain("If this was not you, please secure your account");
    expect(text).not.toMatch(/password:|token|hash|\$2[aby]\$|127\.0\.0\.1|::1|ip address/i);
  });

  test("TC-SEC-010 further failures never send more emails; the existing 5-attempt lockout then refuses even the right password", async () => {
    expect((await login(users.acct.username, WRONG)).status).toBe(401); // login 5 (4th failure)
    expect((await login(users.acct.username, WRONG)).status).toBe(401); // login 6 (5th -> locked)
    const locked = await login(users.acct.username, PW); // login 7
    expect(locked.status).toBe(403);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect((await auditRows(users.acct.id, "FAILED_LOGIN_THRESHOLD")).length).toBe(1);
    expect(Number((await pool.query("SELECT locked_until > NOW() AS l FROM users WHERE id = ?", [users.acct.id]))[0][0].l)).toBe(1);
  });

  test("TC-SEC-009 a successful login resets the consecutive-failure counter (so a later single failure is just 1)", async () => {
    expect((await login(users.reset.username, WRONG)).status).toBe(401); // login 8
    expect((await login(users.reset.username, WRONG)).status).toBe(401); // login 9
    expect(await failed(users.reset.id)).toBe(2);
    expect((await login(users.reset.username, PW)).status).toBe(200); // login 10
    await new Promise((r) => setTimeout(r, 200)); // last_login / counter reset is written just after the response
    expect(await failed(users.reset.id)).toBe(0);
    expect((await login(users.reset.username, WRONG)).status).toBe(401); // login 11
    await SecurityAlert.flush();
    expect(await failed(users.reset.id)).toBe(1);
    expect(emailSpy).toHaveBeenCalledTimes(1); // still only the accountant's
  });

  test("TC-SEC-011 unknown username: the same generic answer as a wrong password, and never an email", async () => {
    const known = await login(users.reset.username, WRONG); // login 12
    const unknown = [];
    for (let i = 0; i < 3; i++) unknown.push(await login(`${P}nobody-${i}`, WRONG)); // logins 13-15
    for (const res of unknown) expect([res.status, res.body]).toEqual([known.status, known.body]);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  test("TC-SEC-012 email delivery failure: login stays refused and generic; the failure is audited and logged", async () => {
    emailSpy.mockResolvedValueOnce({ delivered: false, reason: "SEND_FAILED" });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let last;
    for (let i = 0; i < 3; i++) last = await login(users.super.username, WRONG); // logins 16-18 (SUPER_ADMIN)
    expect([last.status, last.body.message]).toEqual([401, "Invalid username or password"]);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(2);
    expect(emailSpy.mock.calls[1][0].to).toBe(users.super.email);
    const fail = await auditRows(users.super.id, "SECURITY_ALERT_EMAIL_FAILED");
    expect(fail.length).toBe(1);
    expect(fail[0].description).toMatch(/not delivered \(SEND_FAILED\)/);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("not delivered: SEND_FAILED"))).toBe(true);
    errSpy.mockRestore();
  });

  test("TC-SEC-013 the security events are recorded without any credential", async () => {
    const [rows] = await pool.query(
      "SELECT action, description, before_data, after_data FROM audit_logs WHERE (user_id IN (?, ?, ?) OR description LIKE ?) AND module = 'AUTH'",
      [users.acct.id, users.super.id, users.reset.id, `%${P}%`]
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["LOGIN_FAILURE", "FAILED_LOGIN_THRESHOLD", "SECURITY_ALERT_EMAIL_SENT", "SECURITY_ALERT_EMAIL_FAILED", "LOGIN_SUCCESS"]) expect(actions).toContain(a);
    const [[hash]] = await pool.query("SELECT password FROM users WHERE id = ?", [users.acct.id]);
    const blob = JSON.stringify(rows);
    for (const secret of [WRONG, PW, hash.password]) expect(blob).not.toContain(secret);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWT
  });
});
