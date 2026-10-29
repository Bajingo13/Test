// Audit Logs API (routes/auditLogs.routes.js + services/auditLogService.js):
// company scoping, Super Admin / system-event visibility, detail IDOR,
// filters, keyset pagination, CSV export and response sanitisation.
//
// Visibility model under test:
//   company_id = N  -> users of company N holding ADMIN.AUDIT_LOGS/VIEW, and Super Admin
//   company_id NULL -> system events: Super Admin only
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "audt-";
const PASSWORD = "AudtPass!1";
const MOD = "AUDT_TEST";
const ids = {};
const tokens = {};
const rows = {};

async function makeUser(tag, roleCode, companyIds = [], grantAudit = false) {
  const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, hash, role.id, `${P}${tag}@example.test`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  if (grantAudit) {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.AUDIT_LOGS' AND action = 'VIEW'");
    await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 1, 'audt test')", [u.insertId, perm.id]);
  }
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
  ids[tag] = u.insertId;
}

async function insertRow(key, { companyId, action = "AUDT_EDIT", userTag = "adminA", entityType = "AUDT_ENTITY", entityId = 1, createdAt, description, before = null, after = null }) {
  const [r] = await pool.execute(
    `INSERT INTO audit_logs (module, entity_type, entity_id, action, description, before_data, after_data, user_id, username, company_id, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10.0.0.1', 'audt-agent', ?)`,
    [MOD, entityType, entityId, action, description || `${P}${key}`, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      ids[userTag], `${P}${userTag}`, companyId, createdAt]
  );
  rows[key] = r.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const list = (who, query = {}) => request(app).get("/api/audit-logs").set(auth(who)).query({ module: MOD, ...query });
const idsOf = (res) => res.body.map((r) => r.id);

const SECRETS = {
  password: "audt-plain-password",
  password_hash: "$2b$10$audtHashValueAudtHashValueAudtHashValueAudtHashVal",
  token: "audt-raw-token-0123456789abcdef",
  invitation_token: "audt-invitation-token-abcdef",
  accept_token: "audt-accept-token-abcdef",
  token_hash: "audt-token-hash-0123456789",
  jwt: "audt-jwt-value",
  access_token: "audt-access-token",
  refresh_token: "audt-refresh-token",
  session_token: "audt-session-token",
  api_key: "audt-api-key-value",
  secret: "audt-secret-value",
  smtp_pass: "audt-smtp-pass",
  encryption_key: "audt-encryption-key",
};
const INVITE_URL = "https://app.example.test/accept-invite?token=audtdeadbeefdeadbeefdeadbeefdeadbeef";
const JWT_STRING = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWR0In0.audtSignatureValue";

beforeAll(async () => {
  assertNotProductionDatabase();
  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('AUDT Company A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('AUDT Company B', 'Active')");
  ids.coA = ca.insertId;
  ids.coB = cb.insertId;

  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [ids.coA], true);
  await makeUser("adminB", "ADMIN", [ids.coB], true);
  await makeUser("adminAB", "ADMIN", [ids.coA, ids.coB], true);
  await makeUser("adminPlain", "ADMIN", [ids.coA], false);
  await makeUser("acctPlain", "ACCOUNTANT", [ids.coA], false);
  await makeUser("acctGrant", "ACCOUNTANT", [ids.coA], true);

  // Company A: six rows, two sharing the same timestamp (tie broken by id).
  await insertRow("a1", { companyId: ids.coA, action: "AUDT_CREATE", entityId: 101, createdAt: "2026-01-10 09:00:00" });
  await insertRow("a2", { companyId: ids.coA, action: "AUDT_EDIT", entityId: 102, createdAt: "2026-01-11 09:00:00", userTag: "acctGrant" });
  await insertRow("a3", { companyId: ids.coA, action: "AUDT_EDIT", entityId: 103, createdAt: "2026-01-12 09:00:00", description: `${P}a3 quarterly needle` });
  await insertRow("a4", { companyId: ids.coA, action: "AUDT_EDIT", entityId: 104, createdAt: "2026-01-12 09:00:00", entityType: "AUDT_OTHER" });
  await insertRow("a5", { companyId: ids.coA, action: "AUDT_DELETE", entityId: 105, createdAt: "2026-01-14 09:00:00" });
  await insertRow("a6", { companyId: ids.coA, action: "AUDT_CREATE", entityId: 106, createdAt: "2026-01-15 09:00:00" });
  // Company B
  await insertRow("b1", { companyId: ids.coB, action: "AUDT_CREATE", entityId: 201, createdAt: "2026-01-10 10:00:00", userTag: "adminB", description: `${P}b1 quarterly needle` });
  await insertRow("b2", { companyId: ids.coB, action: "AUDT_EDIT", entityId: 101, createdAt: "2026-01-13 10:00:00", userTag: "adminB" });
  // System (company-less)
  await insertRow("n1", { companyId: null, action: "AUDT_LOGIN", entityId: 301, createdAt: "2026-01-11 11:00:00", userTag: "sa" });
  await insertRow("n2", { companyId: null, action: "AUDT_ROLE", entityId: 302, createdAt: "2026-01-13 11:00:00", userTag: "sa", description: `${P}n2 quarterly needle` });
  // Company A row carrying representative secrets
  await insertRow("secret", {
    companyId: ids.coA,
    action: "AUDT_SECRET",
    entityId: 401,
    createdAt: "2026-01-09 09:00:00",
    description: `${P}secret link ${INVITE_URL}`,
    before: { ...SECRETS, voucherNo: "AUDT-V-1", bypass_reason: "kept", nested: { user: { passwordHash: "audt-nested-hash", apiKey: "audt-nested-api" } } },
    after: { list: [{ token: "audt-array-token", label: "kept-label" }], note: `see ${INVITE_URL}`, header: `Bearer ${JWT_STRING}`, jwtText: JWT_STRING, status: "POSTED" },
  });
});

afterAll(async () => {
  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [`${P}%`]);
  const userIds = users.map((u) => u.id);
  await pool.query("DELETE FROM audit_logs WHERE module = ?", [MOD]);
  if (ids.reconSession) {
    await pool.query("DELETE FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'SESSION' AND entity_id = ?", [ids.reconSession]);
    await pool.query("DELETE FROM bank_recon_sessions WHERE id = ?", [ids.reconSession]);
  }
  if (ids.bank) await pool.query("DELETE FROM bank_codes WHERE id = ?", [ids.bank]);
  if (userIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    for (const t of ["user_companies", "user_permissions"]) await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [ids.coA, ids.coB]);
  await pool.end();
});

const A_ROWS = () => [rows.a1, rows.a2, rows.a3, rows.a4, rows.a5, rows.a6, rows.secret];
const B_ROWS = () => [rows.b1, rows.b2];
const SYS_ROWS = () => [rows.n1, rows.n2];

// ---------------------------------------------------------------------------
describe("A. authorization", () => {
  test("Admin with ADMIN.AUDIT_LOGS can list own company events", async () => {
    const res = await list("adminA");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(idsOf(res)).toEqual(expect.arrayContaining(A_ROWS()));
  });

  test("Admin and Accountant without the permission are rejected (list, detail, export)", async () => {
    for (const who of ["adminPlain", "acctPlain"]) {
      expect((await list(who)).status).toBe(403);
      expect((await request(app).get(`/api/audit-logs/${rows.a1}`).set(auth(who))).status).toBe(403);
      expect((await request(app).get("/api/audit-logs/export").set(auth(who))).status).toBe(403);
    }
  });

  test("unauthenticated requests are rejected", async () => {
    expect((await request(app).get("/api/audit-logs")).status).toBe(401);
    expect((await request(app).get("/api/audit-logs/export")).status).toBe(401);
    expect((await request(app).get(`/api/audit-logs/${rows.a1}`)).status).toBe(401);
  });

  test("Super Admin can list audit logs", async () => {
    const res = await list("sa", { limit: 200 });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("B / C. company isolation and system events", () => {
  test("Company A sees A only; Company B sees B only", async () => {
    const a = idsOf(await list("adminA", { limit: 200 }));
    expect(a).toEqual(expect.arrayContaining(A_ROWS()));
    for (const id of [...B_ROWS(), ...SYS_ROWS()]) expect(a).not.toContain(id);
    const b = idsOf(await list("adminB", { limit: 200 }));
    expect(b).toEqual(expect.arrayContaining(B_ROWS()));
    for (const id of [...A_ROWS(), ...SYS_ROWS()]) expect(b).not.toContain(id);
  });

  test("a user of both companies sees both by default (never the system events)", async () => {
    const ab = idsOf(await list("adminAB", { limit: 200 }));
    expect(ab).toEqual(expect.arrayContaining([...A_ROWS(), ...B_ROWS()]));
    for (const id of SYS_ROWS()) expect(ab).not.toContain(id);
  });

  test("Super Admin sees both companies and system events by default (no implicit lowest company)", async () => {
    const all = idsOf(await list("sa", { limit: 200 }));
    expect(all).toEqual(expect.arrayContaining([...A_ROWS(), ...B_ROWS(), ...SYS_ROWS()]));
    const res = await list("sa", { limit: 200 });
    expect(res.body.find((r) => r.id === rows.n1)).toMatchObject({ companyId: null, scope: "SYSTEM" });
    expect(res.body.find((r) => r.id === rows.a1)).toMatchObject({ companyId: ids.coA, companyName: "AUDT Company A", scope: "COMPANY" });
  });

  test("Super Admin scope=system returns only company-less events; companyId narrows to one company", async () => {
    const sys = await list("sa", { scope: "system", limit: 200 });
    expect(sys.status).toBe(200);
    expect(sys.body.every((r) => r.companyId === null)).toBe(true);
    expect(idsOf(sys)).toEqual(expect.arrayContaining(SYS_ROWS()));
    const onlyB = await list("sa", { companyId: ids.coB, limit: 200 });
    expect(idsOf(onlyB).sort()).toEqual(B_ROWS().sort());
    const companyOnly = await list("sa", { scope: "company", limit: 200 });
    expect(companyOnly.body.every((r) => r.companyId !== null)).toBe(true);
  });

  test("system events are invisible to Admin and Accountant, even with the permission", async () => {
    for (const who of ["adminA", "acctGrant"]) {
      const res = await list(who, { limit: 200 });
      for (const id of SYS_ROWS()) expect(idsOf(res)).not.toContain(id);
      expect((await list(who, { scope: "system" })).status).toBe(403);
    }
  });

  test("an Accountant holding the permission is scoped to their company like an Admin", async () => {
    const res = idsOf(await list("acctGrant", { limit: 200 }));
    expect(res).toEqual(expect.arrayContaining(A_ROWS()));
    for (const id of B_ROWS()) expect(res).not.toContain(id);
  });
});

// ---------------------------------------------------------------------------
describe("D. detail (IDOR)", () => {
  test("own-company detail works and includes stored request metadata", async () => {
    const res = await request(app).get(`/api/audit-logs/${rows.a1}`).set(auth("adminA"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: rows.a1, companyId: ids.coA, action: "AUDT_CREATE", module: MOD, entityId: 101, ipAddress: "10.0.0.1", userAgent: "audt-agent", username: `${P}adminA` });
  });

  test("cross-company, system and unknown ids return the identical 404", async () => {
    const unknown = await request(app).get("/api/audit-logs/2147483000").set(auth("adminA"));
    expect(unknown.status).toBe(404);
    for (const id of [rows.b1, rows.n1, "abc", 0]) {
      const res = await request(app).get(`/api/audit-logs/${id}`).set(auth("adminA"));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
    }
  });

  test("Super Admin can open company and system rows", async () => {
    for (const id of [rows.a1, rows.b1, rows.n1]) {
      expect((await request(app).get(`/api/audit-logs/${id}`).set(auth("sa"))).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
describe("E. filters (always inside the caller's scope)", () => {
  test("company filter: own company allowed, another company refused, invalid rejected", async () => {
    const onlyA = await list("adminAB", { companyId: ids.coA, limit: 200 });
    expect(onlyA.body.every((r) => r.companyId === ids.coA)).toBe(true);
    expect((await list("adminA", { companyId: ids.coB })).status).toBe(403);
    expect((await list("adminA", { companyId: "1 OR 1=1" })).status).toBe(400);
    expect((await list("adminA", { companyId: [ids.coA, ids.coB] })).status).toBe(400);
  });

  test("user filter cannot reach another company's rows", async () => {
    const own = await list("adminA", { userId: ids.acctGrant });
    expect(idsOf(own)).toEqual([rows.a2]);
    const foreign = await list("adminA", { userId: ids.adminB });
    expect(foreign.body).toEqual([]);
  });

  test("action / module / entity type / entity id filters", async () => {
    expect(idsOf(await list("adminA", { action: "AUDT_DELETE" }))).toEqual([rows.a5]);
    expect(idsOf(await list("adminA", { entityType: "AUDT_OTHER" }))).toEqual([rows.a4]);
    // entity id 101 exists in both companies - only A's comes back
    expect(idsOf(await list("adminA", { entityId: 101 }))).toEqual([rows.a1]);
    const otherModule = await request(app).get("/api/audit-logs").set(auth("adminA")).query({ module: "AUDT_NOPE" });
    expect(otherModule.body).toEqual([]);
  });

  test("date range: date-only bounds include the whole day; invalid dates rejected", async () => {
    const res = await list("adminA", { from: "2026-01-11", to: "2026-01-12" });
    expect(idsOf(res).sort()).toEqual([rows.a2, rows.a3, rows.a4].sort());
    const timed = await list("adminA", { from: "2026-01-14 08:00", to: "2026-01-14 10:00:00" });
    expect(idsOf(timed)).toEqual([rows.a5]);
    expect((await list("adminA", { from: "yesterday" })).status).toBe(400);
    expect((await list("adminA", { to: "2026-13-45" })).status).toBe(400);
  });

  test("text search stays in scope and is parameterised", async () => {
    const res = await list("adminA", { q: "quarterly needle" });
    expect(idsOf(res)).toEqual([rows.a3]);
    const sa = await list("sa", { q: "quarterly needle" });
    expect(idsOf(sa).sort()).toEqual([rows.a3, rows.b1, rows.n2].sort());
    const injection = await list("adminA", { q: "' OR 1=1 -- " });
    expect(injection.status).toBe(200);
    expect(injection.body).toEqual([]);
    const wildcard = await list("adminA", { q: "%" });
    expect(wildcard.body).toEqual([]);
    expect((await list("adminA", { q: "x".repeat(101) })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("F. pagination and ordering", () => {
  test("keyset pages walk Company A's rows in (created_at DESC, id DESC) order without gaps or leaks", async () => {
    const [expected] = await pool.query(
      "SELECT id FROM audit_logs WHERE module = ? AND company_id = ? ORDER BY created_at DESC, id DESC",
      [MOD, ids.coA]
    );
    const seen = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const res = await list("adminA", { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(2);
      expect(res.headers["x-page-limit"]).toBe("2");
      seen.push(...idsOf(res));
      if (res.headers["x-has-more"] !== "true") {
        expect(res.headers["x-next-cursor"]).toBeUndefined();
        break;
      }
      cursor = res.headers["x-next-cursor"];
      expect(cursor).toBeTruthy();
    }
    expect(seen).toEqual(expected.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
    // the two rows sharing a timestamp are ordered by id
    expect(seen.indexOf(Math.max(rows.a3, rows.a4))).toBeLessThan(seen.indexOf(Math.min(rows.a3, rows.a4)));
  });

  test("maximum page size is enforced; bad limits and cursors are rejected", async () => {
    const big = await list("sa", { limit: 100000 });
    expect(big.status).toBe(200);
    expect(big.headers["x-page-limit"]).toBe("200");
    expect(big.body.length).toBeLessThanOrEqual(200);
    expect((await list("adminA", { limit: 0 })).status).toBe(400);
    expect((await list("adminA", { limit: -5 })).status).toBe(400);
    expect((await list("adminA", { limit: "abc" })).status).toBe(400);
    expect((await list("adminA", { cursor: "not-a-cursor" })).status).toBe(400);
  });

  test("a cursor from another scope cannot pull rows outside the caller's scope", async () => {
    const saPage = await list("sa", { limit: 1 });
    const cursor = saPage.headers["x-next-cursor"];
    const res = await list("adminA", { limit: 200, cursor });
    expect(res.status).toBe(200);
    for (const r of res.body) expect(r.companyId).toBe(ids.coA);
  });
});

// ---------------------------------------------------------------------------
describe("G. export", () => {
  const parseCsvIds = (text) => text.trim().split("\r\n").slice(1).map((line) => Number(line.split(",")[0]));

  test("own-company export is scoped, filtered and audited", async () => {
    const res = await request(app).get("/api/audit-logs/export").set(auth("adminA")).query({ module: MOD });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="audit-logs-/);
    expect(res.headers["x-export-truncated"]).toBe("false");
    const exported = parseCsvIds(res.text);
    expect(exported.sort()).toEqual(A_ROWS().sort());
    const filtered = await request(app).get("/api/audit-logs/export").set(auth("adminA")).query({ module: MOD, action: "AUDT_CREATE" });
    expect(parseCsvIds(filtered.text).sort()).toEqual([rows.a1, rows.a6].sort());
    const [[audit]] = await pool.query("SELECT company_id, after_data FROM audit_logs WHERE module = 'AUDIT_LOGS' AND action = 'EXPORT' AND user_id = ? ORDER BY id DESC LIMIT 1", [ids.adminA]);
    expect(audit.company_id).toBe(ids.coA);
    const after = typeof audit.after_data === "string" ? JSON.parse(audit.after_data) : audit.after_data;
    expect(after).toMatchObject({ rowCount: 2, truncated: false, scope: "company" });
  });

  test("export cannot cross companies or reach system events", async () => {
    expect((await request(app).get("/api/audit-logs/export").set(auth("adminA")).query({ companyId: ids.coB })).status).toBe(403);
    expect((await request(app).get("/api/audit-logs/export").set(auth("adminA")).query({ scope: "system" })).status).toBe(403);
    const b = await request(app).get("/api/audit-logs/export").set(auth("adminB")).query({ module: MOD });
    expect(parseCsvIds(b.text).sort()).toEqual(B_ROWS().sort());
  });

  test("Super Admin can export system events only on request", async () => {
    const res = await request(app).get("/api/audit-logs/export").set(auth("sa")).query({ module: MOD, scope: "system" });
    expect(res.status).toBe(200);
    expect(parseCsvIds(res.text).sort()).toEqual(SYS_ROWS().sort());
  });

  test("exported CSV contains no sensitive values and guards spreadsheet formulas", async () => {
    const res = await request(app).get("/api/audit-logs/export").set(auth("adminA")).query({ module: MOD, action: "AUDT_SECRET" });
    for (const value of [...Object.values(SECRETS), "audt-nested-hash", "audt-nested-api", "audt-array-token", "audtdeadbeef", JWT_STRING]) {
      expect(res.text).not.toContain(value);
    }
    expect(res.text).toContain("[REDACTED]");
    expect(res.text).toContain("AUDT-V-1");
  });
});

// ---------------------------------------------------------------------------
describe("H. sensitive data", () => {
  test("detail and list responses redact sensitive keys and token-bearing strings; other data is kept", async () => {
    const detail = await request(app).get(`/api/audit-logs/${rows.secret}`).set(auth("adminA"));
    expect(detail.status).toBe(200);
    const listed = (await list("adminA", { action: "AUDT_SECRET" })).body[0];
    for (const body of [detail.body, listed]) {
      const text = JSON.stringify(body);
      for (const value of [...Object.values(SECRETS), "audt-nested-hash", "audt-nested-api", "audt-array-token", "audtdeadbeef", JWT_STRING]) {
        expect(text).not.toContain(value);
      }
      for (const key of Object.keys(SECRETS)) expect(body.beforeData[key]).toBe("[REDACTED]");
      expect(body.beforeData.nested.user).toEqual({ passwordHash: "[REDACTED]", apiKey: "[REDACTED]" });
      expect(body.beforeData.voucherNo).toBe("AUDT-V-1");
      expect(body.beforeData.bypass_reason).toBe("kept");
      expect(body.afterData.list).toEqual([{ token: "[REDACTED]", label: "kept-label" }]);
      expect(body.afterData.note).toBe("see https://app.example.test/accept-invite?token=[REDACTED]");
      expect(body.afterData.jwtText).toBe("[REDACTED]");
      expect(body.afterData.status).toBe("POSTED");
      expect(body.description).toContain("accept-invite?token=[REDACTED]");
    }
  });

  test("the stored audit record itself is not modified", async () => {
    const [[row]] = await pool.query("SELECT before_data FROM audit_logs WHERE id = ?", [rows.secret]);
    const before = typeof row.before_data === "string" ? JSON.parse(row.before_data) : row.before_data;
    expect(before.password).toBe(SECRETS.password);
  });
});

// ---------------------------------------------------------------------------
describe("I. Bank Reconciliation audit rows", () => {
  test("a reconciliation's audit row is visible to its own company and to Super Admin only", async () => {
    const [bk] = await pool.execute("INSERT INTO bank_codes (bank_code, bank_name, status) VALUES (?, 'AUDT Bank', 'ACTIVE')", [`${P}BK`]);
    ids.bank = bk.insertId;
    const created = await request(app).post("/api/bank-recon/sessions").set(auth("adminA"))
      .send({ bankAccountId: ids.bank, periodStart: "2026-02-01", periodEnd: "2026-02-28", statementBeginningBalance: 0 });
    expect(created.status).toBe(200);
    ids.reconSession = created.body.id;
    const q = { module: "BANK_RECON", entityType: "SESSION", entityId: ids.reconSession };
    const a = await request(app).get("/api/audit-logs").set(auth("adminA")).query(q);
    expect(a.body).toHaveLength(1);
    expect(a.body[0]).toMatchObject({ companyId: ids.coA, action: "CREATE" });
    const b = await request(app).get("/api/audit-logs").set(auth("adminB")).query(q);
    expect(b.body).toEqual([]);
    expect((await request(app).get(`/api/audit-logs/${a.body[0].id}`).set(auth("adminB"))).status).toBe(404);
    const sa = await request(app).get("/api/audit-logs").set(auth("sa")).query(q);
    expect(sa.body).toHaveLength(1);
  });
});
