// RFP branch scope (fix) + Active Branch narrowing.
// Before: RFPs were scoped by company only - an Accountant assigned to one
// branch could list and open another branch's RFPs. Now the Posting rule:
// SUPER_ADMIN / ADMIN act on every branch of their companies; anyone else sees
// company-level RFPs and those of their assigned branches. The active branch
// narrows the list further and never widens it.
// Local test database only. Prefix UAT-RFB-.
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(120000);

const P = "UAT-RFB-";
let co;
const br = {};
const tok = {};
const usr = {};
const rfp = {};
const userIds = [];

async function mkUser(tag, roleCode, branches = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, role.id]);
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, co]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  userIds.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
const get = (who, url, active) => {
  const r = request(app).get(url).set({ Authorization: `Bearer ${tok[who]}` });
  return active === undefined ? r : r.set("X-Active-Branch", String(active));
};
const listed = async (who, active) => {
  const res = await get(who, `/api/rfp?companyId=${co}`, active);
  return (Array.isArray(res.body) ? res.body : res.body.rfps || res.body.items || []).map((r) => r.rfpNo).filter((n) => String(n).startsWith(P)).sort();
};

beforeAll(async () => {
  assertNotProductionDatabase();
  co = (await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}Co`]))[0].insertId;
  for (const b of ["AUD", "OUT"]) br[b] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [co, b, `${P}${b}`]))[0].insertId;
  await mkUser("acctAud", "ACCOUNTANT", [br.AUD]);
  await mkUser("acctOut", "ACCOUNTANT", [br.OUT]);
  await mkUser("adminA", "ADMIN");
  for (const [key, branchId, owner] of [["AUD", br.AUD, "acctAud"], ["OUT", br.OUT, "acctOut"], ["CO", null, "adminA"]]) {
    const [r] = await pool.query(
      "INSERT INTO rfp_headers (company_id, branch_id, rfp_no, rfp_date, requester_user_id, purpose, status, total_amount) VALUES (?, ?, ?, '2096-06-01', ?, 'x', 'DRAFT', 0)",
      [co, branchId, `${P}${key}`, usr[owner].id]
    );
    rfp[key] = r.insertId;
  }
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM rfp_status_history WHERE rfp_id IN (?)", [Object.values(rfp)]).catch(() => {});
    await pool.query("DELETE FROM rfp_headers WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id = ?", [co]);
    await pool.query("DELETE FROM companies WHERE id = ?", [co]);
  } finally {
    await pool.end();
  }
});

describe("branch scope (fix)", () => {
  test("an AUDIT accountant lists AUDIT and company-level RFPs, never OUTSOURCE's", async () => {
    expect(await listed("acctAud")).toEqual([`${P}AUD`, `${P}CO`]);
    expect(await listed("acctOut")).toEqual([`${P}CO`, `${P}OUT`]);
  });
  test("another branch's RFP is 404 by id and history (same answer as an unknown id)", async () => {
    expect((await get("acctAud", `/api/rfp/${rfp.OUT}`)).status).toBe(404);
    expect((await get("acctAud", `/api/rfp/${rfp.OUT}/history`)).status).toBe(404);
    expect((await get("acctAud", `/api/rfp/${rfp.AUD}`)).status).toBe(200);
  });
  test("ADMIN still sees every branch of the company", async () => {
    expect(await listed("adminA")).toEqual([`${P}AUD`, `${P}CO`, `${P}OUT`]);
  });
});

describe("active branch narrowing", () => {
  test("ADMIN with OUTSOURCE active -> OUTSOURCE RFPs only; ALL -> everything", async () => {
    expect(await listed("adminA", br.OUT)).toEqual([`${P}OUT`]);
    expect(await listed("adminA", "ALL")).toEqual([`${P}AUD`, `${P}CO`, `${P}OUT`]);
  });
  test("an unassigned active branch never widens (AUDIT accountant, OUTSOURCE active -> nothing)", async () => {
    expect(await listed("acctAud", br.OUT)).toEqual([]);
  });
});
