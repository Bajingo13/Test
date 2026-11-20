// Authentication security - role coverage and abuse limits (TC-SEC-010, TC-SEC-014).
// The same rules apply to ACCOUNTANT, ADMIN and SUPER_ADMIN (the accountant and Super
// Admin are covered in securityAuth.http.test.js; ADMIN here). A user without an email
// address gets no email but the event is still recorded. The per-IP login rate limit
// (20 / 15 min) stops a flood: the 21st attempt is refused with 429 and no email is sent.
// Email is spied, never sent. Local test database only. Fixture prefix UAT-SEC-R-.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const EmailService = require("../services/emailService");
const SecurityAlert = require("../services/securityAlertService");
const { SESSION_IDLE_SECONDS } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "UAT-SEC-R-";
const PW = "UatSecR!Correct-2026";
const WRONG = "Wrong-Password-r7";
const users = {};
let emailSpy;
let attempts = 0;

async function makeUser(tag, roleCode, email) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, full_name, email, password, role_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `UAT Sec R ${tag}`, email, await bcrypt.hash(PW, 10), role.id]);
  users[tag] = { id: u.insertId, username: `${P}${tag}` };
}
const login = (username, password) => { attempts++; return request(app).post("/api/login").send({ username, password }); };
const now = () => Math.floor(Date.now() / 1000);
const tokenAged = (u, age) => jwt.sign({ id: u.id, username: u.username, role: "user", tv: 0, iat: now() - age }, process.env.JWT_SECRET, { expiresIn: SESSION_IDLE_SECONDS });
const me = (token) => request(app).get("/api/me/permissions").set({ Authorization: `Bearer ${token}` });
const actions = async (id) => (await pool.query("SELECT action FROM audit_logs WHERE user_id = ? AND module = 'AUTH' ORDER BY id", [id]))[0].map((r) => r.action);

beforeAll(async () => {
  assertNotProductionDatabase();
  await makeUser("admin", "ADMIN", "uat-sec-r-admin@example.test");
  await makeUser("super", "SUPER_ADMIN", "uat-sec-r-super@example.test");
  await makeUser("acct", "ACCOUNTANT", "uat-sec-r-acct@example.test");
  await makeUser("noemail", "ACCOUNTANT", null);
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

describe("TC-SEC-014 the same rules for every role", () => {
  test("inactivity timeout: ACCOUNTANT, ADMIN and SUPER_ADMIN sessions all expire after 15 minutes and refresh while active", async () => {
    for (const tag of ["acct", "admin", "super"]) {
      expect([tag, (await me(tokenAged(users[tag], 14 * 60))).status]).toEqual([tag, 200]);
      const expired = await me(tokenAged(users[tag], 15 * 60 + 5));
      expect([tag, expired.status, expired.body.code]).toEqual([tag, 401, "SESSION_EXPIRED"]);
      const keep = await request(app).post("/api/auth/keepalive").set({ Authorization: `Bearer ${tokenAged(users[tag], 10 * 60)}` });
      expect([tag, keep.status]).toEqual([tag, 200]);
    }
  });

  test("an ADMIN's third consecutive failure sends one email, like an accountant's", async () => {
    for (let i = 0; i < 3; i++) expect((await login(users.admin.username, WRONG)).status).toBe(401);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0]).toMatchObject({ to: "uat-sec-r-admin@example.test", attempts: 3 });
    expect(await actions(users.admin.id)).toEqual(["LOGIN_FAILURE", "LOGIN_FAILURE", "LOGIN_FAILURE", "FAILED_LOGIN_THRESHOLD", "SECURITY_ALERT_EMAIL_SENT"]);
  });

  test("no email address on file: nothing is sent, the event is still recorded (and the login answer is unchanged)", async () => {
    let last;
    for (let i = 0; i < 3; i++) last = await login(users.noemail.username, WRONG);
    expect([last.status, last.body.message]).toEqual([401, "Invalid username or password"]);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(await actions(users.noemail.id)).toContain("SECURITY_ALERT_EMAIL_FAILED");
    const [[row]] = await pool.query("SELECT description FROM audit_logs WHERE user_id = ? AND action = 'SECURITY_ALERT_EMAIL_FAILED'", [users.noemail.id]);
    expect(row.description).toMatch(/NO_EMAIL_ON_FILE/);
  });
});

describe("TC-SEC-010 abuse limits", () => {
  test("a flood of attempts from one address is cut off by the login rate limit (429) without further emails", async () => {
    let res;
    while (attempts < 20) res = await login(`${P}flood`, WRONG);
    expect(res.status).toBe(401);
    res = await login(`${P}flood`, WRONG); // 21st attempt from this address in the window
    expect(res.status).toBe(429);
    expect(res.body.message).toBe("Too many login attempts. Please try again later.");
    const blocked = await login(users.admin.username, PW); // even a correct password is held back
    expect(blocked.status).toBe(429);
    await SecurityAlert.flush();
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });
});
