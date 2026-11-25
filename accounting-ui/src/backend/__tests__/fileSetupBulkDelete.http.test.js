// Task 4 - controlled bulk deletion in File Setup (COA, General Libraries,
// Group Codes, Report Sections) + the General Library in-use guard.
// Same permission as the single DELETE; the same per-record rules
// (fileSetupDeleteService); every id reported; nothing cascades; audit rows
// written; financial records never touched.
// Local test database only. Prefix TBD (codes), UAT-TBD- (companies/users).
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-TBD-";
const co = {};
const br = {};
const tok = {};
const usr = {};
const userIds = [];
const id = {};

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function mkUser(tag, roleCode, companies, branches = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  userIds.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
const bulk = (who, path, ids, extra = {}) => request(app).post(path).set("Authorization", `Bearer ${tok[who]}`).send({ ids, ...extra });
const byId = (res) => Object.fromEntries(res.body.results.map((r) => [r.id, r]));
const exists = async (table, rowId) => Number((await pool.query(`SELECT COUNT(*) c FROM ${table} WHERE id = ?`, [rowId]))[0][0].c) === 1;

beforeAll(async () => {
  assertNotProductionDatabase();
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TBD-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'TBD-%'");
  await pool.query("DELETE FROM report_sections WHERE code LIKE 'TBD_%'");
  for (const [tag, branches] of [["A", ["TBD-A1", "TBD-A2"]], ["B", []]]) {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
    co[tag] = c.insertId;
    for (const b of branches) br[b] = (await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, 'ACTIVE')", [c.insertId, b, b]))[0].insertId;
  }
  await mkUser("adminA", "ADMIN", [co.A]);
  await mkUser("acctA1", "ACCOUNTANT", [co.A], [br["TBD-A1"]]);
  // a role with VIEW but no DELETE / CONFIGURE
  const coa = async (code, cls = "ASSET", branchId = null) => (await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES (?, '2026-01-01', ?, ?, ?)", [code, `${code} title`, cls, branchId]))[0].insertId;
  id.coaFree1 = await coa("TBD-1001");
  id.coaFree2 = await coa("TBD-1002");
  id.coaUsed = await coa("TBD-1003");
  id.coaA2Only = await coa("TBD-1004", "ASSET", br["TBD-A2"]); // branch-only (A2)
  const party = async (companyId, code, branchId = null) => (await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status, branch_id) VALUES (?, ?, 'SUPPLIER', ?, 'ACTIVE', ?)", [companyId, code, `${code} name`, branchId]))[0].insertId;
  id.pFree = await party(co.A, "TBD-P1");
  id.pUsedById = await party(co.A, "TBD-P2");
  id.pUsedByRef = await party(co.A, "TBD-P3");
  id.pUsedByBB = await party(co.A, "TBD-P4");
  id.pOtherCo = await party(co.B, "TBD-P5");
  // a posted APV that uses TBD-1003 and supplier TBD-P2; a JV line naming TBD-P3 by code
  const [apv] = await pool.query("INSERT INTO apv_headers (company_id, branch_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'TBD-APV-1', ?, 'TBD-P2 name', '2026-01-05', 50, 50, 'Posted')", [co.A, br["TBD-A1"], id.pUsedById]);
  id.apv = apv.insertId;
  await pool.query("INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, debit, credit) VALUES (?, ?, 'TBD-1003', 'x', 50, 0)", [id.apv, id.coaUsed]);
  const [jv] = await pool.query("INSERT INTO jv_headers (company_id, branch_id, voucher_no, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'TBD-JV-1', '2026-01-05', 10, 10, 'Draft')", [co.A, br["TBD-A1"]]);
  id.jv = jv.insertId;
  await pool.query("INSERT INTO jv_lines (jv_id, account_code, account_title, debit, credit, gen_ref) VALUES (?, 'X', 'x', 10, 0, 'TBD-P3')", [id.jv]);
  const [bbh] = await pool.query("INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status, branch_id) VALUES (?, 'AP', '2025-12-31', 'Posted', ?)", [co.A, br["TBD-A1"]]);
  id.bbh = bbh.insertId;
  await pool.query("INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_code, party_name, debit, credit) VALUES (?, ?, 'TBD-P4', 'x', 0, 5)", [id.bbh, id.pUsedByBB]);
  // group codes + report sections
  const gc = async (code) => (await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES (?, 'x', 'ASSET', 'ACTIVE')", [code]))[0].insertId;
  id.gcFree = await gc("TBD-G1");
  id.gcUsed = await gc("TBD-G2");
  await pool.query("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'TBD-G2', 'x')", [id.coaUsed]);
  const rs = async (code, name) => (await pool.query("INSERT INTO report_sections (code, name, account_class, status) VALUES (?, ?, 'ASSET', 'ACTIVE')", [code, name]))[0].insertId;
  id.rsFree = await rs("TBD_FREE", "TBD Free Section");
  id.rsUsed = await rs("TBD_USED", "TBD Used Section");
  await pool.query("UPDATE account_group_codes SET report_section = 'TBD_USED' WHERE id = ?", [id.gcFree]);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    await pool.query("DELETE FROM jv_lines WHERE jv_id = ?", [id.jv]);
    await pool.query("DELETE FROM jv_headers WHERE id = ?", [id.jv]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id = ?", [id.apv]);
    await pool.query("DELETE FROM apv_headers WHERE id = ?", [id.apv]);
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [id.bbh]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [id.bbh]);
    await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'TBD-%'");
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TBD-%'");
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'TBD-%'");
    await pool.query("DELETE FROM report_sections WHERE code LIKE 'TBD_%'");
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

describe("authorization and request validation", () => {
  test("an Accountant (no FILESETUP DELETE / CONFIGURE) is refused on every bulk route; nothing deleted", async () => {
    for (const path of ["/api/coa/bulk-delete", "/api/genlib/bulk-delete", "/api/group-codes/bulk-delete", "/api/report-sections/bulk-delete"]) {
      const res = await bulk("acctA1", path, [id.coaFree1, id.pFree, id.gcFree, id.rsFree]);
      expect([path, res.status]).toEqual([path, 403]);
    }
    for (const [t, rowId] of [["chart_of_accounts", id.coaFree1], ["general_libraries", id.pFree], ["account_group_codes", id.gcFree], ["report_sections", id.rsFree]]) {
      expect(await exists(t, rowId)).toBe(true);
    }
  });
  test.each([[[]], [null], [["x"]], [[0]], [Array.from({ length: 501 }, (_, i) => i + 1)]])("invalid id list %# -> 400, nothing deleted", async (ids) => {
    const res = await bulk("adminA", "/api/coa/bulk-delete", ids);
    expect(res.status).toBe(400);
    expect(await exists("chart_of_accounts", id.coaFree1)).toBe(true);
  });
});

describe("Chart of Accounts", () => {
  test("unused accounts are deleted, an in-use account is blocked, unknown ids skipped - each reported", async () => {
    const res = await bulk("adminA", "/api/coa/bulk-delete", [id.coaFree1, id.coaUsed, 999999999, id.coaFree1]);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ requested: 3, deleted: 1, blocked: 1, skipped: 1, failed: 0 });
    const r = byId(res);
    expect(r[id.coaFree1]).toMatchObject({ status: "deleted", label: "TBD-1001" });
    expect(r[id.coaUsed]).toMatchObject({ status: "blocked", code: "COA_IN_USE", references: expect.objectContaining({ apv_lines: 1 }) });
    expect(r[999999999].status).toBe("skipped");
    expect(await exists("chart_of_accounts", id.coaFree1)).toBe(false);
    expect(await exists("chart_of_accounts", id.coaUsed)).toBe(true);
    expect(Number((await pool.query("SELECT COUNT(*) c FROM apv_lines WHERE apv_id = ?", [id.apv]))[0][0].c)).toBe(1); // nothing cascaded
  });
  test("a branch-only account of a branch the user cannot see is skipped, not disclosed, not deleted", async () => {
    // give the accountant COA DELETE via override to isolate the branch rule
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'FILESETUP.COA' AND action = 'DELETE'");
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 1, 'UAT-TBD')", [usr.acctA1.id, perm.id]);
    try {
      const res = await bulk("acctA1", "/api/coa/bulk-delete", [id.coaA2Only, id.coaFree2]);
      expect(res.status).toBe(200);
      const r = byId(res);
      expect(r[id.coaA2Only]).toMatchObject({ status: "skipped" });
      expect(r[id.coaA2Only].label).toBeUndefined();
      expect(r[id.coaFree2].status).toBe("deleted");
      expect(await exists("chart_of_accounts", id.coaA2Only)).toBe(true);
    } finally {
      await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [usr.acctA1.id]);
    }
  });
  test("each deletion is audited with a before-image (module FILESETUP, action DELETED, bulk)", async () => {
    const [rows] = await pool.query("SELECT entity_type, action, description, CAST(before_data AS CHAR) b FROM audit_logs WHERE module = 'FILESETUP' AND entity_id IN (?, ?) AND entity_type = 'COA'", [id.coaFree1, id.coaFree2]);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("DELETED");
    expect(rows.map((r) => r.description).join(" ")).toMatch(/bulk delete/);
    expect(JSON.parse(rows.find((r) => r.b.includes("TBD-1001")).b)).toMatchObject({ code: "TBD-1001" });
  });
});

describe("General Libraries", () => {
  test("bulk: unused party deleted; parties used by a transaction header, a line's code reference or a beginning balance are blocked; another company's id skipped", async () => {
    const res = await bulk("adminA", "/api/genlib/bulk-delete", [id.pFree, id.pUsedById, id.pUsedByRef, id.pUsedByBB, id.pOtherCo], { companyId: co.A });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ requested: 5, deleted: 1, blocked: 3, skipped: 1, failed: 0 });
    const r = byId(res);
    expect(r[id.pUsedById]).toMatchObject({ status: "blocked", code: "GENLIB_IN_USE", references: { apv_headers: 1 } });
    expect(r[id.pUsedByRef].references).toEqual({ "jv_lines.gen_ref": 1 });
    expect(r[id.pUsedByBB].references).toEqual({ arap_beginning_balance_lines: 1 });
    expect(r[id.pOtherCo]).toMatchObject({ status: "skipped" });
    expect(await exists("general_libraries", id.pOtherCo)).toBe(true);
    expect(await exists("general_libraries", id.pFree)).toBe(false);
  });
  test("single DELETE now refuses a party in use (409 GENLIB_IN_USE) - before this fix it was deleted, orphaning the APV's supplier", async () => {
    const res = await request(app).delete(`/api/genlib/${id.pUsedById}?companyId=${co.A}`).set("Authorization", `Bearer ${tok.adminA}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GENLIB_IN_USE");
    expect(await exists("general_libraries", id.pUsedById)).toBe(true);
    const [[apv]] = await pool.query("SELECT supplier_id FROM apv_headers WHERE id = ?", [id.apv]);
    expect(apv.supplier_id).toBe(id.pUsedById);
  });
});

describe("Group Codes and Report Sections", () => {
  test("group codes: a group code assigned to a COA account is blocked with its reference count", async () => {
    const res = await bulk("adminA", "/api/group-codes/bulk-delete", [id.gcUsed]);
    expect(res.body.summary).toMatchObject({ deleted: 0, blocked: 1 });
    expect(byId(res)[id.gcUsed]).toMatchObject({ status: "blocked", code: "GROUP_CODE_IN_USE", references: { coaGroups: 1 } });
  });
  test("report sections: one used by a group code is blocked, an unused one deleted", async () => {
    const res = await bulk("adminA", "/api/report-sections/bulk-delete", [id.rsFree, id.rsUsed]);
    expect(res.body.summary).toMatchObject({ requested: 2, deleted: 1, blocked: 1 });
    const r = byId(res);
    expect(r[id.rsUsed]).toMatchObject({ status: "blocked", code: "REPORT_SECTION_IN_USE" });
    expect(await exists("report_sections", id.rsFree)).toBe(false);
    expect(await exists("report_sections", id.rsUsed)).toBe(true);
  });
  test("then the group code without COA use can be deleted (its section link goes with it, the section stays)", async () => {
    const res = await bulk("adminA", "/api/group-codes/bulk-delete", [id.gcFree]);
    expect(res.body.summary).toMatchObject({ deleted: 1 });
    expect(await exists("report_sections", id.rsUsed)).toBe(true);
  });
});
