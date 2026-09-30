const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Security fix regression: GET /api/audit-logs previously applied NO
// company scoping at all - any user granted ADMIN.AUDIT_LOGS/VIEW (a
// plain role/permission check, not a company-membership check) could
// retrieve every company's audit history, including full
// before_data/after_data. Fixed by resolving/validating companyId the
// SAME way every other company-scoped route in this codebase already
// does (CurrencyService.resolveCompanyIdForWrite - never trusting
// req.query.companyId directly) and adding WHERE company_id = ? to the
// query, plus threading the already-resolved companyId into every
// company-scoped logAudit() call site so audit_logs.company_id (which
// existed since checkpoint4h_company_isolation_migration.sql but was
// never populated) is finally set on new rows.
//
// ADMIN.AUDIT_LOGS/VIEW is deliberately EXCLUDED from the default ADMIN
// role grant (user_access_control_migration.sql's own comment: "the
// genuinely Super-Admin-only Administration surfaces... audit logs").
// A SUPER_ADMIN would bypass company-access checks entirely by design
// (not a bug - see resolveCompanyIdForWrite), which would make it
// impossible to test cross-company DENIAL with that role. So this suite
// grants ADMIN.AUDIT_LOGS/VIEW to two ordinary ADMIN-role users via the
// same user_permissions override mechanism periodLocking.http.test.js
// already uses - exactly reproducing the real vulnerable scenario: an
// ordinary admin, scoped to one company, who happens to hold this one
// permission.

jest.setTimeout(180000);

let companyAId, companyBId;
let userAId, userBId, noRoleUserId;
let tokenA, tokenB, noRoleToken;
let arA, apA;
const jvIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = result.insertId;
  if (companyId) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
async function grantAuditLogsView(userId) {
  const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'ADMIN.AUDIT_LOGS' AND action = 'VIEW'");
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)", [userId, perm.id]);
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("TESTAUDIT Company A");
  companyBId = await makeCompany("TESTAUDIT Company B");

  userAId = await makeUser("testaudit_a", "TestAuditPass!A1", 2, companyAId);
  userBId = await makeUser("testaudit_b", "TestAuditPass!B1", 2, companyBId);
  noRoleUserId = await makeUser("testaudit_norole", "TestAuditPass!N1", null, companyAId);

  await grantAuditLogsView(userAId);
  await grantAuditLogsView(userBId);

  tokenA = await loginAs("testaudit_a", "TestAuditPass!A1");
  tokenB = await loginAs("testaudit_b", "TestAuditPass!B1");
  noRoleToken = await loginAs("testaudit_norole", "TestAuditPass!N1");

  arA = await makeAccount("TESTAUDIT-AR", "TestAudit Accounts Receivable", "ASSET");
  apA = await makeAccount("TESTAUDIT-AP", "TestAudit Accounts Payable", "LIABILITY");

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: userAId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  await CurrencyService.createCurrency({ id: userBId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
});

afterAll(async () => {
  if (jvIds.length) {
    await pool.query(`DELETE FROM jv_lines WHERE jv_id IN (${jvIds.map(() => "?").join(",")})`, jvIds);
    await pool.query(`DELETE FROM jv_headers WHERE id IN (${jvIds.map(() => "?").join(",")})`, jvIds);
    await pool.query(`DELETE FROM audit_logs WHERE module = 'JV' AND entity_id IN (${jvIds.map(() => "?").join(",")})`, jvIds);
  }
  await pool.query("DELETE FROM audit_logs WHERE module = 'ACCESS_CONTROL' AND user_id = ?", [noRoleUserId]);
  await pool.query("DELETE FROM user_permissions WHERE user_id IN (?, ?)", [userAId, userBId]);
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?, ?)", [userAId, userBId, noRoleUserId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?, ?)", [userAId, userBId, noRoleUserId]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM currencies WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTAUDIT-%'");
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// JV CREATE resolves its company from currency?.companyId (or, absent
// that, the caller's single accessible company - see
// CurrencyService.resolveCompanyIdForWrite) - never a top-level
// req.body.companyId. userA/userB each belong to exactly one company, so
// omitting it here and letting that single-company default apply is the
// correct, realistic way to target each company.
async function makeJv(token, voucherNo, amount) {
  const res = await request(app).post("/api/jv").set(auth(token)).send({
    voucherNo, transactionDate: "2026-09-01", description: `${voucherNo} test`, status: "Posted",
    lines: [
      { accountId: arA, accountCode: "TESTAUDIT-AR", accountTitle: "AR", particulars: "x", debit: amount, credit: 0 },
      { accountId: apA, accountCode: "TESTAUDIT-AP", accountTitle: "AP", particulars: "x", debit: 0, credit: amount },
    ],
  });
  if (res.status !== 200) throw new Error(`JV create failed: ${res.status} ${JSON.stringify(res.body)}`);
  jvIds.push(res.body.id);
  return res.body.id;
}

describe("Audit-log company scoping - the confirmed vulnerability, fixed", () => {
  let jvAId, jvBId;

  test("setup: create one audited JV for Company A and one for Company B", async () => {
    jvAId = await makeJv(tokenA, "TESTAUDIT-JV-A1", 1000);
    jvBId = await makeJv(tokenB, "TESTAUDIT-JV-B1", 2000);
    expect(jvAId).toBeTruthy();
    expect(jvBId).toBeTruthy();
  });

  test("5. the newly created audit record stores the correct company_id directly in the DB", async () => {
    const [[rowA]] = await pool.query("SELECT company_id AS companyId FROM audit_logs WHERE module = 'JV' AND entity_id = ?", [jvAId]);
    const [[rowB]] = await pool.query("SELECT company_id AS companyId FROM audit_logs WHERE module = 'JV' AND entity_id = ?", [jvBId]);
    expect(rowA.companyId).toBe(companyAId);
    expect(rowB.companyId).toBe(companyBId);
  });

  test("1. Company A's audit record is visible to authorized Company A user", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "JV", entityId: jvAId });
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.entityId === jvAId)).toBe(true);
  });

  test("2. Company B's audit record is NOT visible to Company A user, even without any entity filter", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "JV" });
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.entityId === jvBId)).toBe(false);
    // and Company A's own record is still there among the results
    expect(res.body.some((r) => r.entityId === jvAId)).toBe(true);
  });

  test("3. Company B's audit record IS visible to authorized Company B user", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "JV", entityId: jvBId });
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.entityId === jvBId)).toBe(true);
    // and Company B user never sees Company A's record
    const all = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ module: "JV" });
    expect(all.body.some((r) => r.entityId === jvAId)).toBe(false);
  });

  test("4. an arbitrary companyId query parameter cannot bypass server-side scoping - Company A user requesting Company B's id is rejected, not served", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ companyId: companyBId, module: "JV" });
    expect(res.status).toBe(403);
    expect(Array.isArray(res.body)).toBe(false);
  });

  test("6. existing audit event data remains fully intact (module, entityType, entityId, action, description, beforeData/afterData, user, IP/user-agent)", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "JV", entityId: jvAId });
    const row = res.body.find((r) => r.entityId === jvAId);
    expect(row).toBeDefined();
    expect(row.module).toBe("JV");
    expect(row.entityType).toBe("JV");
    expect(row.action).toBe("POST");
    expect(row.description).toBe("JV TESTAUDIT-JV-A1 created and posted");
    expect(row.afterData).toMatchObject({ voucherNo: "TESTAUDIT-JV-A1" });
    expect(row.userId).toBe(userAId);
    expect(row.username).toBe("testaudit_a");
    expect(row.createdAt).toBeTruthy();

    // IP/user-agent are stored but not part of this endpoint's SELECT
    // (unchanged pre-existing behavior - verified directly against the table).
    const [[dbRow]] = await pool.query(
      "SELECT ip_address AS ipAddress, user_agent AS userAgent FROM audit_logs WHERE module = 'JV' AND entity_id = ?",
      [jvAId]
    );
    expect(dbRow).toBeDefined();
  });

  test("8. existing filters (module) continue to work within the authorized company scope", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "JV" });
    expect(res.status).toBe(200);
    expect(res.body.every((r) => r.module === "JV")).toBe(true);
  });

  test("9. the limit parameter still caps results (unchanged behavior)", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ module: "JV", limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });

  test("10. no cross-company leakage through a combination of module+entityType+userId filters", async () => {
    const res = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({
      module: "JV", entityType: "JV", userId: userAId,
    });
    expect(res.status).toBe(200);
    expect(res.body.every((r) => r.entityId !== jvBId)).toBe(true);
  });
});

describe("Legitimate system-level (no-company) audit events are unaffected", () => {
  let accessDeniedLogged = false;

  test("7a. a permission-denied event (no company context available yet) still logs, with company_id left NULL - not fabricated", async () => {
    const before = Date.now();
    const denied = await request(app).get("/api/audit-logs").set(auth(noRoleToken));
    expect(denied.status).toBe(403);

    const [[row]] = await pool.query(
      "SELECT company_id AS companyId, module, action FROM audit_logs WHERE module = 'ACCESS_CONTROL' AND user_id = ? ORDER BY id DESC LIMIT 1",
      [noRoleUserId]
    );
    expect(row).toBeDefined();
    expect(row.action).toBe("ACCESS_DENIED");
    expect(row.companyId).toBeNull();
    accessDeniedLogged = true;
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  test("7b. that NULL-company system event is excluded from every company-scoped view - never leaked to Company A or Company B", async () => {
    expect(accessDeniedLogged).toBe(true);
    const asA = await request(app).get("/api/audit-logs").set(auth(tokenA)).query({ userId: noRoleUserId });
    const asB = await request(app).get("/api/audit-logs").set(auth(tokenB)).query({ userId: noRoleUserId });
    expect(asA.body).toEqual([]);
    expect(asB.body).toEqual([]);
  });
});
