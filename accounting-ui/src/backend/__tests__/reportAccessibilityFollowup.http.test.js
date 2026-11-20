// Report accessibility follow-up (integration audit), API side:
//   - Prepaid Subsidiary: the picker uses the REPORT endpoints
//     (/api/reports/prepaid-list + /api/reports/lapsed-prepayments,
//     REPORTS.FINANCIAL / VIEW), so an ACCOUNTANT can run the report without
//     FILESETUP.PREPAID_ACCOUNTS; Prepaid Account Setup stays ADMIN-only.
//   - Group Codes: the menu entry is gated by FILESETUP.GROUP_CODES / VIEW (the
//     permission GET /api/group-codes enforces); ACCOUNTANT has none, ADMIN has it.
// Real seeded roles; role permissions are never changed. Local test database
// only. Fixture prefix UAT-RPTFIX-.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-RPTFIX-";
const PW = "UatRptFix!2026";
const tok = {};
const users = [];
const ids = {};

async function makeUser(tag, roleCode, companyId) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id]);
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, companyId]);
  users.push(u.insertId);
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
}
const call = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
const n = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].n);
async function granted(roleCode, moduleKey) {
  const [rows] = await pool.query(
    `SELECT p.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = ? AND p.module_key = ? AND rp.granted = 1 ORDER BY p.action`, [roleCode, moduleKey]);
  return rows.map((r) => r.action);
}
// what the Prepaid Subsidiary page builds its picker from
async function pickerFor(who) {
  const lists = [];
  for (const url of ["/api/reports/prepaid-list", "/api/reports/lapsed-prepayments"]) {
    const res = await call(who, "get", url);
    expect([url, res.status]).toEqual([url, 200]);
    lists.push(...res.body);
  }
  return new Map(lists.map((p) => [p.id, p]));
}

beforeAll(async () => {
  assertNotProductionDatabase();
  ids.co = (await pool.query("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Company`]))[0].insertId;
  await makeUser("acct", "ACCOUNTANT", ids.co);
  await makeUser("admin", "ADMIN", ids.co);
  const prepaid = async (code, start, term, status) => (await pool.query(
    `INSERT INTO prepaid_accounts (prepaid_code, description, party_name, account_code, expense_account_code, start_date, amount, term_months, status)
     VALUES (?, ?, 'UAT RPTFIX Insurer', NULL, NULL, ?, 1200, ?, ?)`, [`${P}${code}`, `UAT RPTFIX ${code}`, start, term, status]))[0].insertId;
  const thisMonth = new Date().toISOString().slice(0, 7) + "-01";
  ids.active = await prepaid("ACTIVE", thisMonth, 12, "Active");     // amortizing now
  ids.lapsed = await prepaid("LAPSED", "2020-01-01", 12, "Active");  // fully amortized
  ids.cancelled = await prepaid("CANCELLED", thisMonth, 12, "Cancelled");
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM prepaid_accounts WHERE prepaid_code LIKE ?", [`${P}%`]);
    if (users.length) {
      for (const t of ["user_companies", "user_permissions"]) await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [users]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [users]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    }
    if (ids.co) await pool.query("DELETE FROM companies WHERE id = ?", [ids.co]);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("Prepaid Subsidiary uses the report endpoints", () => {
  test("ACCOUNTANT holds the report permission and NO Prepaid Account Setup permission (unchanged)", async () => {
    expect(await granted("ACCOUNTANT", "REPORTS.FINANCIAL")).toContain("VIEW");
    expect(await granted("ACCOUNTANT", "FILESETUP.PREPAID_ACCOUNTS")).toEqual([]);
  });

  test("ACCOUNTANT: the picker loads (active + lapsed), Cancelled is excluded as in every prepaid report", async () => {
    const picker = await pickerFor("acct");
    expect(picker.get(ids.active)).toMatchObject({ prepaidCode: `${P}ACTIVE`, description: `UAT RPTFIX ACTIVE` });
    expect(picker.get(ids.lapsed)).toMatchObject({ prepaidCode: `${P}LAPSED` });
    expect(picker.has(ids.cancelled)).toBe(false);
  });

  test("ACCOUNTANT: the report itself generates for a picked account (schedule rows)", async () => {
    const res = await call("acct", "get", `/api/reports/prepaid-subsidiary?prepaidId=${ids.active}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ prepaidCode: `${P}ACTIVE`, termMonths: 12 });
    expect(Array.isArray(res.body.schedule)).toBe(true);
    expect(res.body.schedule).toHaveLength(12);
    const lapsed = await call("acct", "get", `/api/reports/prepaid-subsidiary?prepaidId=${ids.lapsed}`);
    expect(lapsed.status).toBe(200);
  });

  test("ACCOUNTANT: Prepaid Account Setup stays closed - list and every mutation 403, nothing written", async () => {
    const before = await n("SELECT COUNT(*) n FROM prepaid_accounts WHERE prepaid_code LIKE ?", [`${P}%`]);
    const [[row]] = await pool.query("SELECT description, status FROM prepaid_accounts WHERE id = ?", [ids.active]);
    for (const res of [
      await call("acct", "get", "/api/prepaid-accounts"),
      await call("acct", "post", "/api/prepaid-accounts", { prepaidCode: `${P}NEW`, description: "x", startDate: "2026-01-01", amount: 1, termMonths: 1 }),
      await call("acct", "put", `/api/prepaid-accounts/${ids.active}`, { prepaidCode: `${P}ACTIVE`, description: "hijack", startDate: "2026-01-01", amount: 1, termMonths: 1, status: "Cancelled" }),
      await call("acct", "delete", `/api/prepaid-accounts/${ids.active}`),
    ]) {
      expect(res.status).toBe(403);
      expect(Object.keys(res.body || {}).every((k) => ["message", "code", "error", "module", "action", "required"].includes(k))).toBe(true);
    }
    expect(await n("SELECT COUNT(*) n FROM prepaid_accounts WHERE prepaid_code LIKE ?", [`${P}%`])).toBe(before);
    expect((await pool.query("SELECT description, status FROM prepaid_accounts WHERE id = ?", [ids.active]))[0][0]).toEqual(row);
  });

  test("ADMIN: same report picker and report; Prepaid Account Setup still available", async () => {
    const picker = await pickerFor("admin");
    expect([picker.has(ids.active), picker.has(ids.lapsed), picker.has(ids.cancelled)]).toEqual([true, true, false]);
    expect((await call("admin", "get", `/api/reports/prepaid-subsidiary?prepaidId=${ids.active}`)).status).toBe(200);
    const setup = await call("admin", "get", "/api/prepaid-accounts");
    expect(setup.status).toBe(200);
    expect(setup.body.some((p) => p.id === ids.cancelled)).toBe(true); // the setup screen still lists every status
  });
});

// ===========================================================================
describe("Group Codes menu is gated by the permission the API enforces", () => {
  const SRC = path.join(__dirname, "../..");
  const map = fs.readFileSync(path.join(SRC, "components/sidebar/pathPermissionMap.js"), "utf8");
  const entry = (p) => (map.match(new RegExp(`"${p.replace(/\//g, "\\/")}":\\s*\\["([^"]+)",\\s*"([^"]+)"\\]`)) || []).slice(1);

  test("both Group Codes routes map to FILESETUP.GROUP_CODES / VIEW, the same check as GET /api/group-codes", () => {
    expect(entry("/group-code")).toEqual(["FILESETUP.GROUP_CODES", "VIEW"]);
    expect(entry("/group-codes")).toEqual(["FILESETUP.GROUP_CODES", "VIEW"]);
    const menu = fs.readFileSync(path.join(SRC, "components/sidebar/fileSetupMenuConfig.js"), "utf8");
    expect(menu).toMatch(/id: "group-code", label: "Group Code", icon: Tags, path: "\/group-code"/);
    expect(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8")).toMatch(/app\.get\("\/api\/group-codes", authenticateToken, authorizePermission\("FILESETUP\.GROUP_CODES", "VIEW"\)/);
  });

  test("ACCOUNTANT: no Group Codes permission (menu hidden) and the API refuses; ADMIN: permission held and the API answers", async () => {
    expect(await granted("ACCOUNTANT", "FILESETUP.GROUP_CODES")).toEqual([]);
    expect(await granted("ADMIN", "FILESETUP.GROUP_CODES")).toContain("VIEW");
    expect((await call("acct", "get", "/api/group-codes")).status).toBe(403);
    expect((await call("admin", "get", "/api/group-codes")).status).toBe(200);
  });
});
