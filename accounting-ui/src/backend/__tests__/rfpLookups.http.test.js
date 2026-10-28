// RFP (Request for Payment) R4: GET /api/rfp/lookups - the form's supplier
// / currency / branch / account choices for one explicitly selected
// company, filtered by the same rules the create/edit validation enforces.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "rfpr4-";
const PASSWORD = "RfpR4Pass!1";
const co = {};
const ids = {};
const users = {};
const tokens = {};

async function makeUser(tag, roleCode, companyIds = [], branchIds = [], overrides = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branchIds) await pool.execute("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  for (const [action, granted] of Object.entries(overrides)) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'rfp r4 test' FROM permissions WHERE module_key = 'TRANSACTIONS.RFP' AND action = ?`,
      [u.insertId, granted, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

const lookups = (who, query = {}) => request(app).get("/api/rfp/lookups").query(query).set("Authorization", `Bearer ${tokens[who]}`);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
  }
  const party = async (key, company, type, status) => {
    const [r] = await pool.execute(
      "INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, ?, ?, ?, ?)",
      [company, `${P}${key}`, type, `Party ${key}`, `TIN-${key}`, status]
    );
    ids[key] = r.insertId;
  };
  await party("supA", co.A, "SUPPLIER", "ACTIVE");
  await party("inactiveA", co.A, "SUPPLIER", "INACTIVE");
  await party("customerA", co.A, "CUSTOMER", "ACTIVE");
  await party("supB", co.B, "SUPPLIER", "ACTIVE");
  const currency = async (key, company, code, active) => {
    const [r] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_active) VALUES (?, ?, ?, '$', ?)",
      [company, code, `Currency ${key}`, active]
    );
    ids[key] = r.insertId;
  };
  await currency("phpA", co.A, "PHP", 1);
  await currency("usdA", co.A, "USD", 0);
  await currency("phpB", co.B, "PHP", 1);
  for (const [key, company] of [["brA1", co.A], ["brA2", co.A], ["brB1", co.B]]) {
    const [b] = await pool.execute("INSERT INTO branches (company_id, name) VALUES (?, ?)", [company, `${P}${key}`]);
    ids[key] = b.insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A], [ids.brA1]);
  await makeUser("multi", "ADMIN", [co.A, co.B], [ids.brA1, ids.brB1]);
  await makeUser("noViewA", "ACCOUNTANT", [co.A], [], { VIEW: 0 });
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [companies]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

test("an Accountant (no FILESETUP rights) gets the selectable options of their only company", async () => {
  const res = await lookups("acctA");
  expect(res.status).toBe(200);
  expect(res.body.companyId).toBe(co.A);
  expect(res.body.suppliers).toEqual([{ id: ids.supA, code: `${P}supA`, name: "Party supA", tin: "TIN-supA" }]);
  expect(res.body.currencies.map((c) => c.id)).toEqual([ids.phpA]);
  expect(res.body.branches.map((b) => b.id)).toEqual([ids.brA1]); // assigned branch only
  expect(Array.isArray(res.body.accounts)).toBe(true);
});

test("Super Admin must name the company and then sees every branch of it", async () => {
  expect((await lookups("super")).status).toBe(400);
  const res = await lookups("super", { companyId: co.A });
  expect(res.status).toBe(200);
  expect(res.body.branches.map((b) => b.id).sort()).toEqual([ids.brA1, ids.brA2].sort());
});

test("multi-company user must select; each company returns only its own options", async () => {
  expect((await lookups("multi")).status).toBe(400);
  const b = await lookups("multi", { companyId: co.B });
  expect(b.body.suppliers.map((s) => s.id)).toEqual([ids.supB]);
  expect(b.body.currencies.map((c) => c.id)).toEqual([ids.phpB]);
  expect(b.body.branches.map((x) => x.id)).toEqual([ids.brB1]);
});

test("inaccessible company 403, unknown 400, no VIEW 403", async () => {
  expect((await lookups("acctA", { companyId: co.B })).status).toBe(403);
  expect((await lookups("super", { companyId: 2147483000 })).status).toBe(400);
  expect((await lookups("noViewA")).status).toBe(403);
});
