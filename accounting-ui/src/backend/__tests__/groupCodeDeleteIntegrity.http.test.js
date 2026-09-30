const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase H.1 - DELETE /api/group-codes/:id integrity safeguard.
//
// account_group_codes has NO database foreign key pointing at it. A COA
// account's membership in a Group Code lives in coa_groups.group_code (a
// plain VARCHAR string equal to account_group_codes.group_code). So the
// database will happily delete an in-use Group Code and silently orphan the
// coa_groups rows. This suite proves the API now blocks that at the backend
// boundary with a controlled 409 GROUP_CODE_IN_USE, without cascading,
// reassigning, NULLing, or touching the COA / classification data.

jest.setTimeout(120000);

let companyId;
let adminId, noPermId;
let adminToken, noPermToken;
let coaId;
let usedId, freeId, otherId;

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeUser(username, password, roleId) {
  const hash = await bcrypt.hash(password, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, companyId]);
  return u.insertId;
}

async function createGroup(token, body) {
  const res = await request(app).post("/api/group-codes").set("Authorization", `Bearer ${token}`).send(body);
  if (res.status !== 200) throw new Error(`createGroup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function listGroups(token) {
  const res = await request(app).get("/api/group-codes").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function coaGroupCount(groupCode) {
  const [[row]] = await pool.execute("SELECT COUNT(*) AS n FROM coa_groups WHERE group_code = ?", [groupCode]);
  return Number(row.n);
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('HDEL Co', 'Active')");
  companyId = c.insertId;

  adminId = await makeUser("hdel_admin", "HdelPass!1", 2); // ADMIN - has FILESETUP.GROUP_CODES.CONFIGURE
  noPermId = await makeUser("hdel_noperm", "HdelPass!2", 3); // ACCOUNTANT - no FILESETUP config perms
  adminToken = await login("hdel_admin", "HdelPass!1");
  noPermToken = await login("hdel_noperm", "HdelPass!2");

  // a real COA account we can attach a group membership to
  const [coa] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class, description) VALUES (?, ?, ?, ?, ?)",
    ["HDEL-COA-1", "2026-01-01", "HDEL Test Account", "ASSET", "phase h.1 fixture"]
  );
  coaId = coa.insertId;

  usedId = await createGroup(adminToken, {
    groupCode: "HDEL-USED",
    groupDescription: "Used group (assigned to a COA account)",
    accountClass: "ASSET",
    reportSection: "CURRENT_ASSET",
    displayOrder: 10,
    status: "ACTIVE",
  });
  freeId = await createGroup(adminToken, {
    groupCode: "HDEL-FREE",
    groupDescription: "Unused group (deletable)",
    accountClass: "ASSET",
    reportSection: "NON_CURRENT_ASSET",
    displayOrder: 20,
    status: "ACTIVE",
  });
  otherId = await createGroup(adminToken, {
    groupCode: "HDEL-OTHER",
    groupDescription: "Unrelated group",
    accountClass: "INCOME",
    reportSection: "REVENUE",
    displayOrder: 30,
    status: "ACTIVE",
  });

  // the membership row that makes HDEL-USED "in use"
  await pool.execute(
    "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
    [coaId, "HDEL-USED", "Used group (assigned to a COA account)"]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'HDEL-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'HDEL-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'HDEL-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [adminId, noPermId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noPermId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

// ---------------------------------------------------------------- referenced

describe("a referenced Group Code cannot be deleted", () => {
  let res;
  beforeAll(async () => {
    res = await request(app).delete(`/api/group-codes/${usedId}`).set("Authorization", `Bearer ${adminToken}`);
  });

  test("1 + 2. deletion is rejected with HTTP 409", () => {
    expect(res.status).toBe(409);
  });

  test("3. stable machine code is GROUP_CODE_IN_USE", () => {
    expect(res.body.code).toBe("GROUP_CODE_IN_USE");
    expect(res.body.error).toBe("GROUP_CODE_IN_USE");
  });

  test("4. response carries the safe, user-facing message", () => {
    expect(res.body.message).toBe(
      "This Group Code cannot be deleted because it is assigned to one or more Chart of Accounts records."
    );
  });

  test("5. the referenced Group Code still exists afterward", async () => {
    const rows = await listGroups(adminToken);
    const row = rows.find((r) => r.id === usedId);
    expect(row).toBeTruthy();
    expect(row.groupCode).toBe("HDEL-USED");
  });

  test("6. the COA -> group membership row still exists afterward", async () => {
    expect(await coaGroupCount("HDEL-USED")).toBe(1);
  });

  test("7. no dependent data was deleted (coa_groups + chart_of_accounts intact)", async () => {
    const [[cg]] = await pool.execute(
      "SELECT coa_id, group_code, group_description FROM coa_groups WHERE group_code = 'HDEL-USED'"
    );
    expect(cg.coa_id).toBe(coaId);
    expect(cg.group_description).toBe("Used group (assigned to a COA account)");
    const [[coa]] = await pool.execute("SELECT id, code FROM chart_of_accounts WHERE id = ?", [coaId]);
    expect(coa.code).toBe("HDEL-COA-1");
  });

  test("11. no raw SQL / FK internals are leaked", () => {
    const blob = JSON.stringify(res.body);
    expect(/foreign key|constraint|errno|ER_ROW|ER_NO_REFERENCED|sqlMessage|sqlState|ECONNREFUSED|SELECT |DELETE FROM/i.test(blob)).toBe(false);
  });

  test("12. the blocked delete leaves report_section / display_order untouched", async () => {
    const rows = await listGroups(adminToken);
    const row = rows.find((r) => r.id === usedId);
    expect(row.reportSection).toBe("CURRENT_ASSET");
    expect(Number(row.displayOrder)).toBe(10);
    expect(row.accountClass).toBe("ASSET");
    expect(row.status).toBe("ACTIVE");
  });
});

// -------------------------------------------------------------------- unused

describe("an unused Group Code is still deletable (existing behaviour)", () => {
  test("8. DELETE of an unreferenced Group Code returns the existing success response and removes it", async () => {
    expect(await coaGroupCount("HDEL-FREE")).toBe(0);

    const res = await request(app)
      .delete(`/api/group-codes/${freeId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: "Group code deleted successfully" });

    const rows = await listGroups(adminToken);
    expect(rows.some((r) => r.id === freeId)).toBe(false);
  });
});

// ---------------------------------------------------------------- permissions

describe("delete stays permission protected", () => {
  test("9. a user without FILESETUP.GROUP_CODES.CONFIGURE gets 403 and deletes nothing", async () => {
    const res = await request(app)
      .delete(`/api/group-codes/${usedId}`)
      .set("Authorization", `Bearer ${noPermToken}`);

    expect(res.status).toBe(403);

    const rows = await listGroups(adminToken);
    expect(rows.some((r) => r.id === usedId)).toBe(true);
    expect(await coaGroupCount("HDEL-USED")).toBe(1);
  });
});

// ----------------------------------------------------------- unrelated safety

describe("unrelated Group Codes are unaffected", () => {
  test("10. HDEL-OTHER survives every operation above with its classification intact", async () => {
    const rows = await listGroups(adminToken);
    const row = rows.find((r) => r.id === otherId);
    expect(row).toBeTruthy();
    expect(row.groupCode).toBe("HDEL-OTHER");
    expect(row.accountClass).toBe("INCOME");
    expect(row.reportSection).toBe("REVENUE");
    expect(Number(row.displayOrder)).toBe(30);
  });

  test("HDEL-OTHER (unreferenced) can then be deleted normally", async () => {
    const res = await request(app)
      .delete(`/api/group-codes/${otherId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
