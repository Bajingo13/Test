// Failed-login counter (lib/loginAttempts.js) + 3rd-failure security e-mail end
// to end through the REAL emailService into an in-process SMTP sink on 127.0.0.1
// (helpers/smtpTestSink.js - nothing is relayed, no real e-mail is sent).
//   - one counter per account for username AND e-mail identifiers
//   - 3rd failure -> exactly one alert e-mail; 5th -> 15-minute lockout
//   - expired lockout -> fresh streak (no immediate re-lock), alert again at 3
//   - simultaneous wrong passwords: no lost increments, exactly one alert/lock
//   - SMTP down: login answers promptly, lockout still enforced
// The login rate limit is 20 attempts / 15 min per IP per file: this file makes 19.
// Local test database only. Fixture prefix UAT-LFC-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const SecurityAlert = require("../services/securityAlertService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { startSmtpSink } = require("./helpers/smtpTestSink");

jest.setTimeout(120000);

const P = "UAT-LFC-";
const PW = "UatLfc!Correct-2026";
const WRONG = "Wrong-Password-x9";
const users = {};
let sink;

const mail = (tag) => `uat-lfc-${tag}@example.test`.toLowerCase();
async function makeUser(tag) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
  const [u] = await pool.query("INSERT INTO users (username, full_name, email, password, role_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `UAT Lfc ${tag}`, mail(tag), await bcrypt.hash(PW, 10), role.id]);
  users[tag] = { id: u.insertId, username: `${P}${tag}`, email: mail(tag) };
}
const login = (identifier, password) => request(app).post("/api/login").send({ username: identifier, password });
const state = async (id) => (await pool.query("SELECT failed_login_count AS n, (locked_until IS NOT NULL AND locked_until > NOW()) AS locked FROM users WHERE id = ?", [id]))[0][0];
const audits = async (id, action) => (await pool.query("SELECT action, after_data FROM audit_logs WHERE entity_id = ? AND action = ? ORDER BY id", [id, action]))[0];
const alertsTo = (address) => sink.to(address).filter((m) => /unsuccessful login attempts/.test(m.text));

beforeAll(async () => {
  assertNotProductionDatabase();
  sink = await startSmtpSink();
  sink.useEnv();
  for (const t of ["mixed", "expiry", "race", "smtpdown"]) await makeUser(t);
});

afterAll(async () => {
  try {
    await SecurityAlert.flush();
    await sink.close();
    const ids = Object.values(users).map((u) => u.id);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR entity_id IN (?) AND module = 'AUTH' OR description LIKE ?", [ids, ids, `%${P}%`]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids]);
  } finally {
    await pool.end();
  }
});

test("username and e-mail share ONE counter: 3rd failure -> one real alert e-mail, 5th -> lockout (6 logins)", async () => {
  const u = users.mixed;
  const ids = [u.username, u.email.toUpperCase(), u.username.toLowerCase()];
  for (const id of ids) expect((await login(id, WRONG)).status).toBe(401);
  await SecurityAlert.flush();
  expect(Number((await state(u.id)).n)).toBe(3);
  expect(alertsTo(u.email)).toHaveLength(1);
  expect(alertsTo(u.email)[0].text).not.toMatch(/password[^ ]*:|token|hash/i);
  expect(await audits(u.id, "SECURITY_ALERT_EMAIL_SENT")).toHaveLength(1);

  expect((await login(u.email, WRONG)).status).toBe(401);
  expect((await login(u.username, WRONG)).status).toBe(401);
  await SecurityAlert.flush();
  expect(await state(u.id)).toMatchObject({ n: 5, locked: 1 });
  expect(alertsTo(u.email)).toHaveLength(1); // no second alert in the same streak
  const blocked = await login(u.email, PW);
  expect(blocked.status).toBe(403);
  expect(blocked.body.message).toMatch(/temporarily locked/);
});

test("expired lockout: the stale count does not carry over - fresh streak, no instant re-lock, alert again at 3 (4 logins)", async () => {
  const u = users.expiry;
  // a lockout from an earlier streak that has run out (count left at 5)
  await pool.query("UPDATE users SET failed_login_count = 5, locked_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?", [u.id]);
  const first = await login(u.username, WRONG);
  expect(first.status).toBe(401); // NOT locked again by a single mistake
  expect(await state(u.id)).toMatchObject({ n: 1, locked: 0 });
  const [streak] = await pool.query("SELECT description FROM audit_logs WHERE user_id = ? AND action = 'LOGIN_FAILURE' ORDER BY id DESC LIMIT 1", [u.id]);
  expect(streak[0].description).toMatch(/previous lockout had expired, new attempt streak/);
  await login(u.email, WRONG);
  await login(u.username, WRONG);
  await SecurityAlert.flush();
  expect(Number((await state(u.id)).n)).toBe(3);
  expect(alertsTo(u.email)).toHaveLength(1); // the new streak alerts again
  const ok = await login(u.username, PW);
  expect(ok.status).toBe(200);
  expect(await state(u.id)).toMatchObject({ n: 0, locked: 0 }); // success resets (unchanged)
});

test("simultaneous wrong passwords: no lost increments - count exactly 5, locked, exactly one alert (7 logins)", async () => {
  const u = users.race;
  const results = await Promise.all(Array.from({ length: 7 }, (_, i) => login(i % 2 ? u.email : u.username, WRONG)));
  await SecurityAlert.flush();
  const codes = results.map((r) => r.status).sort();
  expect(codes.filter((c) => c === 401)).toHaveLength(5); // the 5 counted attempts
  expect(codes.filter((c) => c === 403)).toHaveLength(2); // the rest hit the lock
  expect(await state(u.id)).toMatchObject({ n: 5, locked: 1 });
  expect(await audits(u.id, "FAILED_LOGIN_THRESHOLD")).toHaveLength(1);
  expect(alertsTo(u.email)).toHaveLength(1);
});

test("SMTP not answering: the 3rd failure still answers promptly; the failure is audited; lockout still enforced (2 logins)", async () => {
  const u = users.smtpdown;
  sink.mode = "hang";
  sink.useEnv({ SMTP_CONNECTION_TIMEOUT_MS: "500", SMTP_GREETING_TIMEOUT_MS: "500", SMTP_SOCKET_TIMEOUT_MS: "1000", SMTP_SEND_TIMEOUT_MS: "1500" });
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await pool.query("UPDATE users SET failed_login_count = 2 WHERE id = ?", [u.id]);
    const t0 = Date.now();
    const third = await login(u.username, WRONG);
    expect(Date.now() - t0).toBeLessThan(1500); // the response never waits for SMTP
    expect(third.status).toBe(401);
    expect(third.body).toEqual({ success: false, message: "Invalid username or password" });
    await SecurityAlert.flush();
    const failed = await audits(u.id, "SECURITY_ALERT_EMAIL_FAILED");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0].after_data)).toMatch(/SEND_FAILED/);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("not delivered: SEND_FAILED"))).toBe(true);
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain(process.env.SMTP_PASS);
    // e-mail trouble never weakens the lockout
    await pool.query("UPDATE users SET failed_login_count = 4 WHERE id = ?", [u.id]);
    expect((await login(u.email, WRONG)).status).toBe(401);
    expect(await state(u.id)).toMatchObject({ n: 5, locked: 1 });
  } finally {
    errSpy.mockRestore();
    sink.mode = "accept";
    sink.useEnv();
  }
});
