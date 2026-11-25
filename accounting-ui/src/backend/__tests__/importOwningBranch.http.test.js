// Task 3 - branch-aware File Setup imports: "Owning Branch" column for the
// Chart of Accounts (system-wide) and General Libraries (per company).
// Blank / SHARED = shared record (unchanged default, never auto-assigned);
// a Branch Code = branch-only record. Unknown, other-company, inactive,
// unauthorized and ambiguous branches are refused per row; Phase B COA code
// rules apply; preview == confirm; legacy files are unchanged.
// Local test database only. Prefix TBO (codes), UAT-TBO- (companies/users).
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { signSessionToken } = require("../lib/sessionPolicy");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "UAT-TBO-";
const co = {};
const br = {};
const tok = {};
const usr = {};
const userIds = [];

async function roleId(code) {
  return (await pool.query("SELECT id FROM roles WHERE code = ?", [code]))[0][0].id;
}
async function mkUser(tag, roleCode, companies, branches = [], grants = []) {
  const [u] = await pool.query("INSERT INTO users (username, full_name, password, role_id, status) VALUES (?, ?, 'x', ?, 'ACTIVE')", [`${P}${tag}`, `${P}${tag}`, await roleId(roleCode)]);
  for (const c of companies) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const b of branches) await pool.query("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)", [u.insertId, b]);
  for (const [mod, action] of grants) {
    const [[p]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [mod, action]);
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 1, ?)", [u.insertId, p.id, `${P}fixture`]);
  }
  userIds.push(u.insertId);
  usr[tag] = { id: u.insertId, username: `${P}${tag}`, role: roleCode, roleCode, token_version: 0 };
  tok[tag] = signSessionToken(usr[tag]);
}
async function xlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Import");
  [headers, ...rows].forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const send = (who, path, buf, fields = {}) => {
  const r = request(app).post(path).set("Authorization", `Bearer ${tok[who]}`);
  for (const [k, v] of Object.entries(fields)) r.field(k, String(v));
  return r.attach("file", buf, "import.xlsx");
};
const getTemplate = (who, path) => request(app).get(path).set("Authorization", `Bearer ${tok[who]}`).buffer(true)
  .parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
const coaRows = async () => (await pool.query("SELECT code, branch_id, account_class FROM chart_of_accounts WHERE code LIKE 'TBO-%' ORDER BY code, branch_id"))[0];
const reasonOf = (res, row) => (res.body.skipped.find((s) => s.row === row) || {}).reason;

beforeAll(async () => {
  assertNotProductionDatabase();
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TBO-%'");
  const mkCo = async (tag, branches) => {
    const [c] = await pool.query("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}${tag}`]);
    co[tag] = c.insertId;
    for (const [code, status] of branches) {
      const [b] = await pool.query("INSERT INTO branches (company_id, name, code, status) VALUES (?, ?, ?, ?)", [c.insertId, `${tag} ${code} branch`, code, status]);
      br[`${tag}.${code}`] = b.insertId;
    }
  };
  await mkCo("A", [["TBO-AUD", "ACTIVE"], ["TBO-OUT", "ACTIVE"], ["TBO-OLD", "INACTIVE"], ["TBO-SAME", "ACTIVE"]]);
  await mkCo("B", [["TBO-BONLY", "ACTIVE"], ["TBO-SAME", "ACTIVE"]]);
  await mkCo("C", []); // zero branches
  await mkCo("D", [["TBO-D1", "ACTIVE"]]); // one branch
  await mkCo("Z", [["TBO-ZZ", "ACTIVE"]]); // nobody here belongs to Z
  await mkUser("adminAB", "ADMIN", [co.A, co.B]);
  await mkUser("adminC", "ADMIN", [co.C]);
  await mkUser("adminD", "ADMIN", [co.D]);
  // an accountant explicitly given import rights, assigned to AUD only
  await mkUser("acctAud", "ACCOUNTANT", [co.A], [br["A.TBO-AUD"]], [["FILESETUP.COA", "CREATE"], ["FILESETUP.GENLIB", "CREATE"], ["FILESETUP.GENLIB", "VIEW"], ["FILESETUP.COA", "VIEW"]]);
  // a pre-existing branch-only account and another company's party code
  await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class, branch_id) VALUES ('TBO-9000', '2026-01-01', 'Branch-only existing', 'ASSET', ?)", [br["A.TBO-AUD"]]);
  await pool.query("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TBO-P5', 'SUPPLIER', 'Company B supplier', 'ACTIVE')", [co.B]);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TBO-%')");
    await pool.query("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TBO-%')");
    await pool.query("DELETE FROM bank_codes WHERE coa_code LIKE 'TBO-%'");
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'TBO-%'");
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_branches WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    await pool.query("DELETE FROM branches WHERE company_id IN (?)", [cos]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
  } finally {
    await pool.end();
  }
});

const COA_H = ["Code", "Title", "Account Class", "Owning Branch"];

describe("Chart of Accounts import with Owning Branch", () => {
  const rows = [
    ["TBO-1001", "Shared cash", "ASSET", ""], // 2 shared
    ["TBO-1002", "Shared bank", "ASSET", "shared"], // 3 SHARED keyword
    ["TBO-2001", "Fees AUD", "INCOME", "tbo-aud"], // 4 AUD (case-insensitive)
    ["TBO-2001", "Fees OUT", "INCOME", "TBO-OUT"], // 5 same code, other branch, same class - allowed
    ["TBO-2002", "Exp OUT", "EXPENSE", "TBO-OUT"], // 6
    ["TBO-2002", "Exp AUD", "ASSET", "TBO-AUD"], // 7 class conflict with row 6
    ["TBO-1001", "Branch reuse of shared", "ASSET", "TBO-AUD"], // 8 shared code reused by a branch
    ["TBO-3000", "Inactive", "ASSET", "TBO-OLD"], // 9 inactive branch
    ["TBO-3001", "Unknown", "ASSET", "TBO-ZZ"], // 10 a branch of a company the user is not in
    ["TBO-3002", "Ambiguous", "ASSET", "TBO-SAME"], // 11 same code in A and B
    ["TBO-3003", "Company B branch", "ASSET", "tbo-bonly"], // 12 system-wide COA: B's branch is fine
    ["TBO-9000", "Shared over branch code", "ASSET", ""], // 13 code owned by a branch account
    ["TBO-2001", "Fees AUD again", "INCOME", "TBO-AUD"], // 14 duplicate within AUD
  ];
  let buf;
  beforeAll(async () => { buf = await xlsx(COA_H, rows); });

  test("preview resolves every row and writes nothing", async () => {
    const before = await coaRows();
    const res = await send("adminAB", "/api/coa/import/preview", buf);
    expect(res.status).toBe(200);
    expect(res.body.readyCount).toBe(6);
    expect(res.body.ready.map((r) => [r.row, r.owningBranch])).toEqual([[2, "Shared"], [3, "Shared"], [4, "TBO-AUD"], [5, "TBO-OUT"], [6, "TBO-OUT"], [12, "TBO-BONLY"]]);
    expect(res.body.ownership).toEqual(expect.arrayContaining([{ owner: "Shared", count: 2 }, { owner: "TBO-AUD", count: 1 }, { owner: "TBO-OUT", count: 2 }, { owner: "TBO-BONLY", count: 1 }]));
    expect(reasonOf(res, 7)).toMatch(/different account class/);
    expect(reasonOf(res, 8)).toMatch(/is a shared account; a branch account cannot reuse it/);
    expect(reasonOf(res, 9)).toMatch(/"TBO-OLD" is INACTIVE/);
    expect(reasonOf(res, 10)).toMatch(/"TBO-ZZ" is not a branch of your companies/);
    expect(reasonOf(res, 11)).toMatch(/"TBO-SAME" is ambiguous/);
    expect(reasonOf(res, 13)).toMatch(/already used by a branch account; a shared account cannot reuse it/);
    expect(reasonOf(res, 14)).toMatch(/duplicate of another row in this file/);
    expect(await coaRows()).toEqual(before); // cancel = nothing saved
  });

  test("confirm saves exactly the previewed owners", async () => {
    const res = await send("adminAB", "/api/coa/import", buf);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(6);
    const saved = (await coaRows()).map((r) => [r.code, r.branch_id, r.account_class]);
    expect(saved).toEqual(expect.arrayContaining([
      ["TBO-1001", null, "ASSET"], ["TBO-1002", null, "ASSET"],
      ["TBO-2001", br["A.TBO-AUD"], "INCOME"], ["TBO-2001", br["A.TBO-OUT"], "INCOME"],
      ["TBO-2002", br["A.TBO-OUT"], "EXPENSE"], ["TBO-3003", br["B.TBO-BONLY"], "ASSET"],
    ]));
    expect(saved).toHaveLength(7); // + the pre-existing TBO-9000
  });

  test("an accountant may assign only their own branch", async () => {
    const res = await send("acctAud", "/api/coa/import/preview", await xlsx(COA_H, [["TBO-4001", "Mine", "ASSET", "TBO-AUD"], ["TBO-4002", "Not mine", "ASSET", "TBO-OUT"]]));
    expect(res.status).toBe(200);
    expect(res.body.ready.map((r) => r.owningBranch)).toEqual(["TBO-AUD"]);
    expect(reasonOf(res, 3)).toMatch(/not authorized to assign records to branch "TBO-OUT"/);
  });

  test("a legacy file (no Owning Branch column) behaves exactly as before: shared, no ownership fields", async () => {
    const res = await send("adminAB", "/api/coa/import/preview", await xlsx(["Code", "Title", "Account Class"], [["TBO-5001", "Legacy", "ASSET"]]));
    expect(res.body).toEqual({ success: true, totalRows: 1, readyCount: 1, skipped: [], warnings: [] });
  });
});

const GL_H = ["Code", "Type", "Name", "Branch Code", "Owning Branch"];

describe("General Libraries import with Owning Branch (per company)", () => {
  test("resolves within the selected company; BIR Branch Code stays a separate field", async () => {
    const buf = await xlsx(GL_H, [
      ["TBO-P1", "SUPPLIER", "Shared supplier", "000", ""], // 2 shared, BIR branch 000
      ["TBO-P2", "CUSTOMER", "AUD customer", "001", "TBO-AUD"], // 3
      ["TBO-P3", "SUPPLIER", "Wrong company", "", "TBO-BONLY"], // 4 company B's branch
      ["TBO-P4", "SUPPLIER", "Inactive", "", "TBO-OLD"], // 5
      ["TBO-P5", "SUPPLIER", "Code used only by company B", "", ""], // 6 fixed: allowed
    ]);
    const prev = await send("adminAB", "/api/genlib/import/preview", buf, { companyId: co.A });
    expect(prev.status).toBe(200);
    expect(prev.body.ready.map((r) => [r.code, r.owningBranch])).toEqual([["TBO-P1", "Shared"], ["TBO-P2", "TBO-AUD"], ["TBO-P5", "Shared"]]);
    expect(reasonOf(prev, 4)).toMatch(/"TBO-BONLY" is not a branch of the selected company/);
    expect(reasonOf(prev, 5)).toMatch(/"TBO-OLD" is INACTIVE/);
    const res = await send("adminAB", "/api/genlib/import", buf, { companyId: co.A });
    expect(res.body.imported).toBe(3);
    const [saved] = await pool.query("SELECT code, branch_id, branch_code FROM general_libraries WHERE company_id = ? ORDER BY code", [co.A]);
    expect(saved.map((r) => [r.code, r.branch_id, r.branch_code])).toEqual([
      ["TBO-P1", null, "000"], ["TBO-P2", br["A.TBO-AUD"], "001"], ["TBO-P5", null, ""],
    ]);
  });

  test("a company with ZERO branches imports shared records; a branch value is refused, never fabricated", async () => {
    const res = await send("adminC", "/api/genlib/import", await xlsx(GL_H, [["TBO-C1", "SUPPLIER", "Shared", "", ""], ["TBO-C2", "SUPPLIER", "Branch", "", "TBO-AUD"]]), { companyId: co.C });
    expect(res.body.imported).toBe(1);
    expect(reasonOf(res, 3)).toMatch(/not a branch of the selected company/);
    const [rows] = await pool.query("SELECT code, branch_id FROM general_libraries WHERE company_id = ?", [co.C]);
    expect(rows).toEqual([{ code: "TBO-C1", branch_id: null }]);
  });

  test("a company with ONE branch: blank stays shared (never auto-assigned); the branch code assigns it", async () => {
    const res = await send("adminD", "/api/genlib/import", await xlsx(GL_H, [["TBO-D1", "SUPPLIER", "Blank owner", "", ""], ["TBO-D2", "SUPPLIER", "Explicit", "", "TBO-D1"]]), { companyId: co.D });
    expect(res.body.imported).toBe(2);
    const [rows] = await pool.query("SELECT code, branch_id FROM general_libraries WHERE company_id = ? ORDER BY code", [co.D]);
    expect(rows).toEqual([{ code: "TBO-D1", branch_id: null }, { code: "TBO-D2", branch_id: br["D.TBO-D1"] }]);
  });

  test("an accountant may assign only their own branch", async () => {
    const res = await send("acctAud", "/api/genlib/import/preview", await xlsx(GL_H, [["TBO-Q1", "SUPPLIER", "Mine", "", "TBO-AUD"], ["TBO-Q2", "SUPPLIER", "Other", "", "TBO-OUT"]]), { companyId: co.A });
    expect(res.body.ready.map((r) => r.owningBranch)).toEqual(["TBO-AUD"]);
    expect(reasonOf(res, 3)).toMatch(/not authorized to assign records to branch "TBO-OUT"/);
  });

  test("a company the user does not belong to is refused outright (403), nothing written", async () => {
    const res = await send("adminC", "/api/genlib/import", await xlsx(GL_H, [["TBO-X1", "SUPPLIER", "Hijack", "", ""]]), { companyId: co.A });
    expect(res.status).toBe(403);
    const [[n]] = await pool.query("SELECT COUNT(*) c FROM general_libraries WHERE code = 'TBO-X1'");
    expect(Number(n.c)).toBe(0);
  });
});

describe("templates", () => {
  test("COA template: import sheet first with Owning Branch, Branches reference = SHARED + active authorized branches, Instructions", async () => {
    const res = await getTemplate("adminAB", "/api/coa/template");
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Chart of Accounts", "Branches", "Instructions"]);
    expect(wb.worksheets[0].getRow(1).values.slice(1)).toContain("Owning Branch");
    const codes = [];
    wb.getWorksheet("Branches").eachRow((r, n) => { if (n > 1) codes.push(r.getCell(1).value); });
    expect(codes).toContain("SHARED");
    expect(codes).toEqual(expect.arrayContaining(["TBO-AUD", "TBO-OUT", "TBO-BONLY"]));
    expect(codes).not.toContain("TBO-OLD"); // inactive
    expect(codes).not.toContain("TBO-ZZ"); // another company
  });
  test("GenLib template for an accountant lists only their branch, and labels the BIR Branch Code", async () => {
    const res = await getTemplate("acctAud", `/api/genlib/template?companyId=${co.A}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const codes = [];
    wb.getWorksheet("Branches").eachRow((r, n) => { if (n > 1) codes.push(r.getCell(1).value); });
    expect(codes).toEqual(["SHARED", "TBO-AUD"]);
    const header = wb.worksheets[0].getRow(1);
    const bir = header.values.indexOf("Branch Code");
    expect(String(header.getCell(bir).note?.texts?.map((t) => t.text).join("") ?? header.getCell(bir).note)).toMatch(/BIR/);
  });
});
