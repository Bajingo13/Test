// SUPER_ADMIN notification e-mail with verification (Account Security) and SMTP
// reliability. Uses the REAL emailService against an in-process SMTP sink on
// 127.0.0.1 (helpers/smtpTestSink.js) - nothing is ever relayed, no real e-mail
// is sent. Local test database only. Fixture prefix UAT-AEV-.
// Rate limits respected per file: <= 5 e-mail change requests per account,
// < 30 verify calls, few logins.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const EmailService = require("../services/emailService");
const { SESSION_IDLE_SECONDS } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { startSmtpSink } = require("./helpers/smtpTestSink");

jest.setTimeout(120000);

const P = "UAT-AEV-";
const PW = "UatAev!Correct-2026";
const users = {};
let sink;

const mail = (tag) => `uat-aev-${tag}@example.test`.toLowerCase(); // addresses are stored lower-case (as invitations)
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function makeUser(tag, roleCode, email, username = `${P}${tag}`) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, full_name, email, password, role_id, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
    [username, `UAT Aev ${tag}`, email, await bcrypt.hash(PW, 10), role.id]);
  users[tag] = { id: u.insertId, username, email };
  return users[tag];
}
const tokenFor = (u) => jwt.sign({ id: u.id, username: u.username, role: "user", tv: 0 }, process.env.JWT_SECRET, { expiresIn: SESSION_IDLE_SECONDS });
const auth = (tag) => ({ Authorization: `Bearer ${tokenFor(users[tag])}` });
const requestChange = (tag, body) => request(app).post("/api/account/email/request").set(auth(tag)).send(body);
const verify = (token) => request(app).post("/api/account/email/verify").send({ token });
const status = (tag) => request(app).get("/api/account/email").set(auth(tag));
const userRow = async (id) => (await pool.query("SELECT id, username, email, role_id, status, token_version, password FROM users WHERE id = ?", [id]))[0][0];
const verifications = async (id) => (await pool.query("SELECT new_email, token_hash, status, used_at FROM account_email_verifications WHERE user_id = ? ORDER BY id", [id]))[0];
const linkTokenIn = (m) => (m.text.match(/\/verify-email\?token=([0-9a-f]{64})/) || [])[1];
const lastTokenTo = (address) => { const ms = sink.to(address); return ms.length ? linkTokenIn(ms[ms.length - 1]) : undefined; };
const audits = async (id, action) => (await pool.query("SELECT action, description, before_data, after_data FROM audit_logs WHERE entity_type = 'USER' AND entity_id = ? AND action = ? ORDER BY id", [id, action]))[0];
const access = async (id) => {
  const q = async (sql) => JSON.stringify((await pool.query(sql, [id]))[0]);
  return [await q("SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id"), await q("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id"), await q("SELECT COUNT(*) n FROM user_permissions WHERE user_id = ?")].join("|");
};

beforeAll(async () => {
  assertNotProductionDatabase();
  sink = await startSmtpSink();
  sink.useEnv();
  await makeUser("superA", "SUPER_ADMIN", null); // like the ALAS bootstrap SUPER_ADMIN: no e-mail
  await makeUser("superB", "SUPER_ADMIN", null);
  await makeUser("superC", "SUPER_ADMIN", null);
  await makeUser("superD", "SUPER_ADMIN", null);
  await makeUser("admin", "ADMIN", mail("admin"));
  await makeUser("other", "ACCOUNTANT", mail("other"));
  await makeUser("namedLikeMail", "ACCOUNTANT", mail("owner-x"), mail("username-taken"));
  await makeUser("noMail", "ACCOUNTANT", null);
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
  await pool.query(
    `INSERT INTO invitations (email, username, full_name, role_id, company_ids, branch_ids, token_hash, status, expires_at, invited_by)
     VALUES (?, ?, 'UAT Aev Invite', ?, '[]', '[]', ?, 'PENDING', DATE_ADD(NOW(), INTERVAL 7 DAY), ?)`,
    [mail("invited"), `${P}invited`, role.id, sha256(`${P}invite-token`), users.superA.id]
  );
});

afterAll(async () => {
  try {
    await sink.close();
    const ids = Object.values(users).map((u) => u.id);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?) OR (entity_type = 'USER' AND entity_id IN (?)) OR description LIKE ? OR description LIKE ?", [ids, ids, `%${P}%`, "%uat-aev-%"]);
    await pool.query("DELETE FROM invitations WHERE email LIKE ?", ["uat-aev-%"]);
    await pool.query("DELETE FROM account_email_verifications WHERE user_id IN (?)", [ids]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [ids]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("A. SMTP transport policy", () => {
  const saved = {};
  const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
  beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterAll(() => { for (const k of KEYS) process.env[k] = saved[k]; });

  test("port 587 requires STARTTLS; port 465 uses TLS from the start; TLS >= 1.2; timeouts set", () => {
    Object.assign(process.env, { SMTP_HOST: "smtp.provider.example", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p-secret" });
    const o587 = EmailService.transportOptions();
    expect(o587).toMatchObject({ port: 587, secure: false, requireTLS: true, tls: { minVersion: "TLSv1.2" }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
    process.env.SMTP_PORT = "465";
    expect(EmailService.transportOptions()).toMatchObject({ port: 465, secure: true, requireTLS: false });
    process.env.SMTP_PORT = "2525";
    expect(EmailService.transportOptions()).toMatchObject({ secure: false, requireTLS: true }); // any other port: STARTTLS required too
    delete process.env.SMTP_PORT;
    expect(EmailService.transportOptions()).toMatchObject({ port: 587, requireTLS: true });
  });

  test("only a loopback host (local test sink) may skip STARTTLS", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      Object.assign(process.env, { SMTP_HOST: host, SMTP_PORT: "1025" });
      expect(EmailService.transportOptions().requireTLS).toBe(false);
    }
    process.env.SMTP_HOST = "127.0.0.1.evil.example";
    expect(EmailService.transportOptions().requireTLS).toBe(true);
  });

  test("logged delivery errors never contain the SMTP password or username", () => {
    Object.assign(process.env, { SMTP_USER: "smtp-login-name", SMTP_PASS: "Sup3r-Secret-Pass" });
    const text = EmailService.safeErrorText(Object.assign(new Error("535 auth failed for smtp-login-name / Sup3r-Secret-Pass"), { code: "EAUTH", responseCode: 535 }));
    expect(text).toContain("EAUTH/535");
    expect(text).not.toContain("Sup3r-Secret-Pass");
    expect(text).not.toContain("smtp-login-name");
  });
});

// ===========================================================================
describe("B. SUPER_ADMIN notification e-mail: register and verify", () => {
  test("registration: confirmation link goes to the NEW address only; users.email unchanged until verified; token stored hashed", async () => {
    const before = await userRow(users.superA.id);
    const accessBefore = await access(users.superA.id);
    const res = await requestChange("superA", { currentPassword: PW, newEmail: mail("A1").toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, emailDelivered: true, pendingEmail: "u***@example.test" });
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    const raw = lastTokenTo(mail("A1"));
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.to(mail("A1"))[0].text).toMatch(/Confirm your notification email address/);
    // not active yet
    expect((await userRow(users.superA.id)).email).toBeNull();
    const rows = await verifications(users.superA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ new_email: mail("A1"), status: "PENDING", token_hash: sha256(raw) });
    expect(rows[0].token_hash).not.toBe(raw);
    const st = await status("superA");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ email: null, pending: { email: "u***@example.test" } });

    // verify (public endpoint - no session needed)
    const v = await verify(raw);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ success: true, email: mail("A1") });
    const after = await userRow(users.superA.id);
    expect(after.email).toBe(mail("A1"));
    // nothing else changed: username, role, status, password, sessions, company/branch access
    expect({ ...after, email: null }).toEqual({ ...before, email: null });
    expect(await access(users.superA.id)).toBe(accessBefore);
    expect((await verifications(users.superA.id))[0].status).toBe("USED");
    expect((await status("superA")).body).toMatchObject({ email: mail("A1"), pending: null });
    // audit: addresses only - never the token or its hash
    const changed = await audits(users.superA.id, "EMAIL_CHANGED");
    expect(changed).toHaveLength(1);
    const requested = await audits(users.superA.id, "EMAIL_CHANGE_REQUESTED");
    const allAudit = JSON.stringify([...changed, ...requested]);
    expect(allAudit).toContain(mail("A1"));
    expect(allAudit).not.toContain(raw);
    expect(allAudit).not.toContain(sha256(raw));
    expect(allAudit).not.toContain(PW);
  });

  test("a used token cannot be reused", async () => {
    const raw = lastTokenTo(mail("A1"));
    const again = await verify(raw);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("VERIFICATION_INVALID");
  });

  test("the verified address works as a login identifier (username login unchanged)", async () => {
    const byEmail = await request(app).post("/api/login").send({ username: mail("A1").toUpperCase(), password: PW });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.user.id).toBe(users.superA.id);
  });

  test("changing again: the previous address gets a courtesy notice after verification", async () => {
    const res = await requestChange("superA", { currentPassword: PW, newEmail: mail("A2") });
    expect(res.status).toBe(200);
    const v = await verify(lastTokenTo(mail("A2")));
    expect(v.status).toBe(200);
    expect((await userRow(users.superA.id)).email).toBe(mail("A2"));
    const notices = sink.to(mail("A1")).filter((m) => /was changed/.test(m.text));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).not.toMatch(/token=/);
  });
});

// ===========================================================================
describe("C. rejected requests (nothing changes, nothing sent)", () => {
  test("incorrect current password: 400, audited, no e-mail", async () => {
    const sent = sink.messages.length;
    const res = await requestChange("superB", { currentPassword: "Wrong-Password-1", newEmail: mail("B1") });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect(sink.messages.length).toBe(sent);
    expect(await verifications(users.superB.id)).toHaveLength(0);
    expect(await audits(users.superB.id, "EMAIL_CHANGE_REJECTED")).toHaveLength(1);
  });

  test("invalid address: 400", async () => {
    const res = await requestChange("superB", { currentPassword: PW, newEmail: "not an email" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMAIL_INVALID");
  });

  test("duplicates (case-insensitive): another account's e-mail, another account's USERNAME, a pending invitation", async () => {
    const r1 = await requestChange("superB", { currentPassword: PW, newEmail: mail("other").toUpperCase() });
    const r2 = await requestChange("superB", { currentPassword: PW, newEmail: mail("username-taken") });
    const r3 = await requestChange("superB", { currentPassword: PW, newEmail: mail("invited") });
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("EMAIL_TAKEN");
    }
    expect(await verifications(users.superB.id)).toHaveLength(0);
    expect((await userRow(users.superB.id)).email).toBeNull();
  });

  test("the request may not name another account", async () => {
    const res = await request(app).post("/api/account/email/request").set(auth("superA")).send({ currentPassword: PW, newEmail: mail("C0"), userId: users.other.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TARGET_USER_NOT_ALLOWED");
  });

  test("non-SUPER_ADMIN 403, unauthenticated 401; the e-mail of a user without one is untouched", async () => {
    expect((await requestChange("admin", { currentPassword: PW, newEmail: mail("admin-new") })).status).toBe(403);
    expect((await request(app).post("/api/account/email/request").send({ currentPassword: PW, newEmail: mail("x") })).status).toBe(401);
    expect((await request(app).get("/api/account/email")).status).toBe(401);
    expect((await userRow(users.noMail.id)).email).toBeNull();
  });
});

// ===========================================================================
describe("D. token lifecycle", () => {
  test("expired token: 410, e-mail unchanged", async () => {
    const res = await requestChange("superC", { currentPassword: PW, newEmail: mail("C1") });
    expect(res.status).toBe(200);
    const raw = lastTokenTo(mail("C1"));
    await pool.query("UPDATE account_email_verifications SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE token_hash = ?", [sha256(raw)]);
    const v = await verify(raw);
    expect(v.status).toBe(410);
    expect(v.body.code).toBe("VERIFICATION_EXPIRED");
    expect((await userRow(users.superC.id)).email).toBeNull();
  });

  test("a newer request supersedes the older link; only the newest works", async () => {
    await requestChange("superC", { currentPassword: PW, newEmail: mail("C2") });
    const old = lastTokenTo(mail("C2"));
    await requestChange("superC", { currentPassword: PW, newEmail: mail("C3") });
    const fresh = lastTokenTo(mail("C3"));
    const vOld = await verify(old);
    expect(vOld.status).toBe(400);
    expect(vOld.body.code).toBe("VERIFICATION_INVALID");
    const vNew = await verify(fresh);
    expect(vNew.status).toBe(200);
    expect((await userRow(users.superC.id)).email).toBe(mail("C3"));
  });

  test("address taken by someone else before verification: 409 at confirm, link cancelled, e-mail unchanged", async () => {
    const res = await requestChange("superC", { currentPassword: PW, newEmail: mail("C4") });
    expect(res.status).toBe(200);
    const raw = lastTokenTo(mail("C4"));
    await makeUser("lateOwner", "ACCOUNTANT", mail("C4"));
    const v = await verify(raw);
    expect(v.status).toBe(409);
    expect(v.body.code).toBe("EMAIL_TAKEN");
    expect((await userRow(users.superC.id)).email).toBe(mail("C3"));
    expect((await verify(raw)).status).toBe(400); // cancelled, not reusable
  });

  test("same address as now: 400; malformed token: 400", async () => {
    const same = await requestChange("superC", { currentPassword: PW, newEmail: mail("C3").toUpperCase() });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe("EMAIL_UNCHANGED");
    expect((await verify("not-a-token")).status).toBe(400);
  });
});

// ===========================================================================
describe("E. SMTP failures: clear, safe, never hanging", () => {
  afterEach(() => { sink.mode = "accept"; sink.useEnv(); });

  test("SMTP not configured: 202, plain-language message, request void, e-mail unchanged", async () => {
    sink.clearEnv();
    const res = await requestChange("superD", { currentPassword: PW, newEmail: mail("D1") });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: false, emailDelivered: false });
    expect(res.body.message).toMatch(/not set up/);
    expect(res.body.message).not.toMatch(/SMTP|ECONN|535/);
    expect((await verifications(users.superD.id)).map((r) => r.status)).toEqual(["CANCELLED"]);
    expect((await status("superD")).body.pending).toBeNull();
  });

  test("server rejects the message: 202 'could not be delivered', logged without credentials", async () => {
    sink.mode = "reject";
    const errors = [];
    const spy = jest.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    const res = await requestChange("superD", { currentPassword: PW, newEmail: mail("D2") });
    spy.mockRestore();
    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/could not be delivered/);
    expect(errors.join("\n")).toMatch(/SEND EMAIL VERIFICATION EMAIL ERROR/);
    expect(errors.join("\n")).not.toContain(process.env.SMTP_PASS);
    expect((await userRow(users.superD.id)).email).toBeNull();
  });

  test("server never answers: the request still returns promptly (timeouts)", async () => {
    sink.mode = "hang";
    sink.useEnv({ SMTP_CONNECTION_TIMEOUT_MS: "500", SMTP_GREETING_TIMEOUT_MS: "500", SMTP_SOCKET_TIMEOUT_MS: "1000", SMTP_SEND_TIMEOUT_MS: "1500" });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const t0 = Date.now();
    const res = await requestChange("superD", { currentPassword: PW, newEmail: mail("D3") });
    const ms = Date.now() - t0;
    spy.mockRestore();
    expect(res.status).toBe(202);
    expect(ms).toBeLessThan(5000);
    expect((await userRow(users.superD.id)).email).toBeNull();
  });

  test("the raw token is never written to any log", async () => {
    const logged = [];
    const spies = ["log", "info", "warn", "error", "debug"].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logged.push(a.map(String).join(" "))));
    const res = await requestChange("superD", { currentPassword: PW, newEmail: mail("D4") });
    const raw = lastTokenTo(mail("D4"));
    const v = await verify(raw);
    spies.forEach((s) => s.mockRestore());
    expect(res.status).toBe(200);
    expect(v.status).toBe(200);
    expect(logged.join("\n")).not.toContain(raw);
    expect(logged.join("\n")).not.toMatch(/verify-email\?token=/);
  });
});
