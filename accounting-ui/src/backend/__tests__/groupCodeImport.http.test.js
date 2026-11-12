const request = require("supertest");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const GroupCodeImportService = require("../services/GroupCodeImportService");

// Group Codes Generate Template + Import (insert-only, partial import, one
// transaction). account_group_codes is a GLOBAL catalog (no company_id), so
// every fixture uses a distinctive TGCI- code prefix instead of a company
// boundary, and report_sections fixtures use the TGCI_ prefix.

jest.setTimeout(180000);

const PASS = "Tgci!Pass1";
let companyId;
let adminId, accountantId, viewOnlyId, viewOnlyRoleId;
let adminToken, accountantToken, viewOnlyToken;

const HEADERS = ["Group Code*", "Group Description*", "Account Class*", "Report Section", "Display Order", "Status"];

function csvBuffer(rows) {
  return Buffer.from(rows.map((r) => r.map((v) => (v === undefined ? "" : String(v))).join(",")).join("\n"), "utf8");
}
async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Group Codes");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function makeUser(username, roleId) {
  const hash = await bcrypt.hash(PASS, 10);
  const [r] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [username, hash, roleId]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function loginAs(username) {
  const res = await request(app).post("/api/login").send({ username, password: PASS });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.body.token;
}
const preview = (buf, name = "gc.csv", token = adminToken) =>
  request(app).post("/api/group-codes/import/preview").set("Authorization", `Bearer ${token}`).attach("file", buf, name);
const doImport = (buf, name = "gc.csv", token = adminToken) =>
  request(app).post("/api/group-codes/import").set("Authorization", `Bearer ${token}`).attach("file", buf, name);
async function countTgci() {
  const [r] = await pool.execute("SELECT COUNT(*) c FROM account_group_codes WHERE group_code LIKE 'TGCI%'");
  return Number(r[0].c);
}
async function getGroup(code) {
  const [r] = await pool.execute(
    "SELECT group_code, group_description, account_class, report_section, display_order, status, updated_at FROM account_group_codes WHERE group_code = ?",
    [code]
  );
  return r[0];
}
async function cleanup() {
  await pool.execute("DELETE FROM account_group_codes WHERE group_code LIKE 'TGCI%'");
  await pool.execute("DELETE FROM report_sections WHERE code LIKE 'TGCI_%'");
}
async function loadTemplate(token = adminToken) {
  const res = await request(app)
    .get("/api/group-codes/template")
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  return res;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanup();
  await pool.execute("DELETE FROM users WHERE username LIKE 'tgci_%'");
  await pool.query("DELETE FROM roles WHERE code = 'TGCI_VIEWONLY'");

  const [co] = await pool.execute("INSERT INTO companies (name, status) VALUES ('TGCI Group Code Import Co', 'Active')");
  companyId = co.insertId;

  const [role] = await pool.execute("INSERT INTO roles (code, name, is_system) VALUES ('TGCI_VIEWONLY', 'TGCI View Only', 0)");
  viewOnlyRoleId = role.insertId;
  await pool.execute(
    `INSERT INTO role_permissions (role_id, permission_id, granted)
     SELECT ?, p.id, 1 FROM permissions p WHERE p.module_key = 'FILESETUP.GROUP_CODES' AND p.action = 'VIEW'`,
    [viewOnlyRoleId]
  );

  adminId = await makeUser("tgci_admin", 2); // ADMIN - has FILESETUP.GROUP_CODES VIEW + CONFIGURE
  accountantId = await makeUser("tgci_accountant", 3); // ACCOUNTANT - no FILESETUP.GROUP_CODES
  viewOnlyId = await makeUser("tgci_viewonly", viewOnlyRoleId);
  adminToken = await loginAs("tgci_admin");
  accountantToken = await loginAs("tgci_accountant");
  viewOnlyToken = await loginAs("tgci_viewonly");

  // Live report_sections fixtures: one ACTIVE ASSET section, one INACTIVE.
  await pool.execute("INSERT INTO report_sections (code, name, account_class, display_order, status) VALUES ('TGCI_SEC_A', 'TGCI Live Asset Section', 'ASSET', 999, 'ACTIVE')");
  await pool.execute("INSERT INTO report_sections (code, name, account_class, display_order, status) VALUES ('TGCI_SEC_OFF', 'TGCI Inactive Section', 'ASSET', 998, 'INACTIVE')");
});

afterAll(async () => {
  jest.restoreAllMocks();
  await cleanup();
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (?, ?, ?)", [adminId, accountantId, viewOnlyId]);
  await pool.execute("DELETE FROM users WHERE id IN (?, ?, ?)", [adminId, accountantId, viewOnlyId]);
  await pool.query("DELETE FROM role_permissions WHERE role_id = ?", [viewOnlyRoleId]);
  await pool.query("DELETE FROM roles WHERE id = ?", [viewOnlyRoleId]);
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

afterEach(() => jest.restoreAllMocks());

// --------------------------------------------------------------------------
describe("1-7: Generate Template", () => {
  let res, wb;
  beforeAll(async () => {
    res = await loadTemplate();
    wb = new ExcelJS.Workbook();
    if (res.status === 200) await wb.xlsx.load(res.body);
  });

  test("1. downloads successfully as an attachment", () => {
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers["content-disposition"]).toMatch(/Group_Codes_Template\.xlsx/);
  });

  test("2. is a valid .xlsx with the three sheets in order", () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Group Codes", "Report Sections", "Instructions"]);
  });

  test("3. Group Codes sheet has exactly the approved headers and no sample data row", () => {
    const ws = wb.getWorksheet("Group Codes");
    expect(ws.getRow(1).values.slice(1)).toEqual(HEADERS);
    expect(ws.getRow(2).values.filter((v) => v !== null && v !== undefined && v !== "")).toEqual([]);
  });

  test("4. Account Class dropdown lists exactly the five classes", () => {
    const dv = wb.getWorksheet("Group Codes").getCell("C2").dataValidation;
    expect(dv.type).toBe("list");
    expect(dv.formulae[0]).toBe('"ASSET,LIABILITY,EQUITY,INCOME,EXPENSE"');
  });

  test("5. Status dropdown lists ACTIVE / INACTIVE", () => {
    const dv = wb.getWorksheet("Group Codes").getCell("F2").dataValidation;
    expect(dv.type).toBe("list");
    expect(dv.formulae[0]).toBe('"ACTIVE,INACTIVE"');
  });

  test("6. Report Sections sheet is built from the LIVE report_sections table", async () => {
    const ws = wb.getWorksheet("Report Sections");
    expect(ws.getRow(1).values.slice(1)).toEqual(["Code", "Name", "Class", "Status"]);
    const rows = [];
    ws.eachRow((r, n) => n > 1 && rows.push(r.values.slice(1)));
    expect(rows).toContainEqual(["TGCI_SEC_A", "TGCI Live Asset Section", "ASSET", "ACTIVE"]);
    expect(rows).toContainEqual(["TGCI_SEC_OFF", "TGCI Inactive Section", "ASSET", "INACTIVE"]);
    const [db] = await pool.execute("SELECT COUNT(*) c FROM report_sections");
    expect(rows.length).toBe(Number(db[0].c));
  });

  test("7. Instructions sheet explains the rules, including global scope", () => {
    const ws = wb.getWorksheet("Instructions");
    const text = [];
    ws.eachRow((r) => text.push(String(r.getCell(1).value ?? "")));
    const all = text.join("\n");
    expect(all).toMatch(/Required: Group Code, Group Description, Account Class/);
    expect(all).toMatch(/Optional: Report Section, Display Order, Status/);
    expect(all).toMatch(/ASSET, LIABILITY, EQUITY, INCOME, EXPENSE/);
    expect(all).toMatch(/ACTIVE or INACTIVE/);
    expect(all).toMatch(/same Account Class/);
    expect(all).toMatch(/already exists.*skipped/i);
    expect(all).toMatch(/never updated/);
    expect(all).toMatch(/skipped and reported with their row number/);
    expect(all).toMatch(/shared by every company/);
  });

  test("the downloaded template, filled in, imports cleanly (round trip)", async () => {
    const ws = wb.getWorksheet("Group Codes");
    ws.getRow(2).values = ["TGCI-RT1", "Round trip", "ASSET", "TGCI_SEC_A", 5, "ACTIVE"];
    ws.getRow(2).commit();
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await doImport(buf, "Group_Codes_Template.xlsx");
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(1);
    expect(await getGroup("TGCI-RT1")).toMatchObject({ report_section: "TGCI_SEC_A", display_order: 5, status: "ACTIVE" });
  });
});

// --------------------------------------------------------------------------
describe("8-13: preview, file formats, required columns", () => {
  test("8. preview performs ZERO writes and reports what would import", async () => {
    const before = await countTgci();
    const res = await preview(csvBuffer([HEADERS, ["TGCI-PV1", "Preview one", "ASSET", "", "", ""], ["", "No code", "ASSET"]]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, totalRows: 2, readyCount: 1 });
    expect(res.body.ready[0]).toMatchObject({ row: 2, groupCode: "TGCI-PV1", status: "ACTIVE" });
    expect(res.body.skipped).toEqual([{ row: 3, groupCode: "", reason: "Group Code is required." }]);
    expect(await countTgci()).toBe(before);
    expect(await getGroup("TGCI-PV1")).toBeUndefined();
  });

  test("9. a valid CSV imports", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-CSV1", "Csv one", "LIABILITY", "CURRENT_LIABILITY", "3", "INACTIVE"]]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imported: 1, skipped: [] });
    expect(await getGroup("TGCI-CSV1")).toMatchObject({
      group_description: "Csv one", account_class: "LIABILITY", report_section: "CURRENT_LIABILITY", display_order: 3, status: "INACTIVE",
    });
  });

  test("10. a valid XLSX imports", async () => {
    const buf = await xlsxBuffer([HEADERS, ["TGCI-XLSX1", "Xlsx one", "EXPENSE", "OPERATING_EXPENSE", 20, "ACTIVE"]]);
    const res = await doImport(buf, "gc.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(await getGroup("TGCI-XLSX1")).toMatchObject({ account_class: "EXPENSE", report_section: "OPERATING_EXPENSE", display_order: 20 });
  });

  test("11. a legacy .xls file is rejected with a clear message", async () => {
    for (const send of [preview, doImport]) {
      const res = await send(Buffer.from("whatever"), "gc.xls");
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Legacy \.xls files are not supported/);
    }
  });

  test("12. an unsupported file type is rejected", async () => {
    const res = await doImport(Buffer.from("hello"), "gc.txt");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only \.csv or \.xlsx files are supported/);
  });

  test("13. a file missing required columns is rejected before any row is processed", async () => {
    const before = await countTgci();
    const res = await doImport(csvBuffer([["Group Code", "Status"], ["TGCI-NOCOL", "ACTIVE"]]));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Group Description, Account Class/);
    expect(res.body.missingColumns).toEqual(["Group Description", "Account Class"]);
    expect(await countTgci()).toBe(before);
  });

  test("an empty file is rejected", async () => {
    const res = await doImport(Buffer.from(""), "gc.csv");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/empty/);
  });

  test("no file at all is rejected", async () => {
    const res = await request(app).post("/api/group-codes/import").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/No file uploaded/);
  });
});

// --------------------------------------------------------------------------
describe("14-27: row validation (each invalid row is skipped with its row number)", () => {
  const cases = [
    ["14. missing Group Code", ["", "No code", "ASSET"], /^Group Code is required\.$/],
    ["15. missing Description", ["TGCI-V15", "", "ASSET"], /^Group Description is required\.$/],
    ["16. missing Account Class", ["TGCI-V16", "Desc", ""], /^Account Class is required\.$/],
    ["17. invalid Account Class", ["TGCI-V17", "Desc", "ASSETS"], /Account Class must be one of: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE/],
    ["18. Group Code over 50 characters", ["TGCI-" + "X".repeat(46), "Desc", "ASSET"], /Group Code exceeds the maximum length of 50/],
    ["19. Description over 255 characters", ["TGCI-V19", "D".repeat(256), "ASSET"], /Group Description exceeds the maximum length of 255/],
    ["23. unknown Report Section", ["TGCI-V23", "Desc", "ASSET", "NOT_A_SECTION"], /not valid for account class ASSET/],
    ["24. Report Section belonging to another class", ["TGCI-V24", "Desc", "ASSET", "REVENUE"], /not valid for account class ASSET/],
    ["inactive Report Section", ["TGCI-V24B", "Desc", "ASSET", "TGCI_SEC_OFF"], /not valid for account class ASSET/],
    ["25. non-integer Display Order", ["TGCI-V25", "Desc", "ASSET", "", "1.5"], /Display order must be a whole number/],
    ["25b. text Display Order", ["TGCI-V25B", "Desc", "ASSET", "", "first"], /Display order must be a whole number/],
    ["26. invalid Status", ["TGCI-V26", "Desc", "ASSET", "", "", "ARCHIVED"], /Status must be ACTIVE or INACTIVE/],
  ];

  test.each(cases)("%s is skipped with a row-numbered reason and nothing is written", async (_label, row, reason) => {
    const before = await countTgci();
    const res = await doImport(csvBuffer([HEADERS, row]));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].row).toBe(2);
    expect(res.body.skipped[0].reason).toMatch(reason);
    expect(await countTgci()).toBe(before);
  });

  test("exactly 50 / 255 characters is accepted (boundary)", async () => {
    const code = "TGCI-" + "Y".repeat(45);
    const res = await doImport(csvBuffer([HEADERS, [code, "E".repeat(255), "ASSET"]]));
    expect(res.body.imported).toBe(1);
    expect((await getGroup(code)).group_description).toHaveLength(255);
  });

  test("27. blank Status defaults to ACTIVE; blank Report Section / Display Order stay NULL", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-V27", "Blank status", "EQUITY", "", "", ""]]));
    expect(res.body.imported).toBe(1);
    expect(await getGroup("TGCI-V27")).toMatchObject({ status: "ACTIVE", report_section: null, display_order: null });
  });

  test("a file without the optional columns at all still imports (Status defaults to ACTIVE)", async () => {
    const res = await doImport(csvBuffer([["Group Code", "Group Description", "Account Class"], ["TGCI-MINCOL", "Minimal", "INCOME"]]));
    expect(res.body.imported).toBe(1);
    expect(await getGroup("TGCI-MINCOL")).toMatchObject({ status: "ACTIVE", report_section: null });
  });

  test("lower-case class / status / section are normalized to the canonical upper-case codes", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-LC", "Lower case", "asset", "tgci_sec_a", "", "inactive"]]));
    expect(res.body.imported).toBe(1);
    expect(await getGroup("TGCI-LC")).toMatchObject({ account_class: "ASSET", report_section: "TGCI_SEC_A", status: "INACTIVE" });
  });

  test("a live ACTIVE Report Section that belongs to the class is accepted", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-LIVESEC", "Live", "ASSET", "TGCI_SEC_A"]]));
    expect(res.body.imported).toBe(1);
  });
});

// --------------------------------------------------------------------------
describe("20-22, 28: duplicates and existing Group Codes", () => {
  beforeAll(async () => {
    await pool.execute(
      "INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status) VALUES ('TGCI-EXIST', 'Original description', 'ASSET', 'CURRENT_ASSET', 7, 'INACTIVE')"
    );
  });

  test("20. a Group Code that already exists is skipped", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-EXIST", "New description", "LIABILITY", "", "1", "ACTIVE"]]));
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toEqual([{ row: 2, groupCode: "TGCI-EXIST", reason: "Group Code already exists." }]);
  });

  test("21. a case-insensitive duplicate of an existing code is skipped", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["tgci-exist", "Lower", "ASSET"], ["  TGCI-Exist  ", "Padded", "ASSET"]]));
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped.map((s) => s.reason)).toEqual(["Group Code already exists.", "Group Code already exists."]);
  });

  test("22. a duplicate within the same file skips the second occurrence (case-insensitive)", async () => {
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-DUPF", "First", "ASSET"], ["tgci-dupf", "Second", "ASSET"]]));
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toEqual([{ row: 3, groupCode: "tgci-dupf", reason: "Group Code is a duplicate of an earlier row in this file." }]);
    expect((await getGroup("TGCI-DUPF")).group_description).toBe("First");
  });

  test("28. existing Group Codes are never modified (every column + updated_at unchanged)", async () => {
    const before = await getGroup("TGCI-EXIST");
    await doImport(csvBuffer([HEADERS, ["TGCI-EXIST", "Overwrite attempt", "EXPENSE", "OPERATING_EXPENSE", "99", "ACTIVE"]]));
    await doImport(await xlsxBuffer([HEADERS, ["tgci-exist", "Overwrite attempt 2", "INCOME", "", "", ""]]), "gc.xlsx");
    expect(await getGroup("TGCI-EXIST")).toEqual(before);
  });

  test("importing the same file twice is safe: second run skips everything", async () => {
    const buf = csvBuffer([HEADERS, ["TGCI-TWICE1", "Twice", "ASSET"], ["TGCI-TWICE2", "Twice", "ASSET"]]);
    expect((await doImport(buf)).body.imported).toBe(2);
    const second = await doImport(buf);
    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toHaveLength(2);
  });

  test("coa_groups is never touched by an import", async () => {
    const [[before]] = await pool.execute("SELECT COUNT(*) c FROM coa_groups");
    await doImport(csvBuffer([HEADERS, ["TGCI-NOCOA", "No coa", "ASSET"], ["TGCI-EXIST", "x", "ASSET"]]));
    const [[after]] = await pool.execute("SELECT COUNT(*) c FROM coa_groups");
    expect(after.c).toBe(before.c);
  });
});

// --------------------------------------------------------------------------
describe("29-32: confirm re-validates, race safety, rollback, partial import", () => {
  test("29 + 30. a code created between preview and confirm is skipped on confirm (preview not trusted)", async () => {
    const buf = csvBuffer([HEADERS, ["TGCI-RACE", "Race", "ASSET"], ["TGCI-RACE-OK", "Race ok", "ASSET"]]);
    const pv = await preview(buf);
    expect(pv.body.readyCount).toBe(2);

    // another user creates TGCI-RACE through the normal API
    const created = await request(app)
      .post("/api/group-codes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ groupCode: "TGCI-RACE", groupDescription: "Created by someone else", accountClass: "ASSET", status: "ACTIVE" });
    expect(created.status).toBe(200);

    const res = await doImport(buf);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toEqual([{ row: 2, groupCode: "TGCI-RACE", reason: "Group Code already exists." }]);
    expect((await getGroup("TGCI-RACE")).group_description).toBe("Created by someone else");
    expect(await getGroup("TGCI-RACE-OK")).toBeDefined();
  });

  test("a report section deactivated between preview and confirm is caught on confirm", async () => {
    await pool.execute("INSERT INTO report_sections (code, name, account_class, status) VALUES ('TGCI_SEC_FLIP', 'TGCI Flip', 'ASSET', 'ACTIVE')");
    const buf = csvBuffer([HEADERS, ["TGCI-FLIP", "Flip", "ASSET", "TGCI_SEC_FLIP"]]);
    expect((await preview(buf)).body.readyCount).toBe(1);
    await pool.execute("UPDATE report_sections SET status = 'INACTIVE' WHERE code = 'TGCI_SEC_FLIP'");
    const res = await doImport(buf);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped[0].reason).toMatch(/not valid for account class ASSET/);
  });

  test("31. an unexpected DB failure mid-batch rolls back the ENTIRE batch (service level)", async () => {
    await pool.execute("INSERT INTO account_group_codes (group_code, group_description, account_class) VALUES ('TGCI-COLLIDE', 'Pre-existing', 'ASSET')");
    const row = (code) => ({ groupCode: code, groupDescription: "Atomic", accountClass: "ASSET", reportSection: null, displayOrder: null, status: "ACTIVE" });
    await expect(
      GroupCodeImportService.insertGroupCodeRows([row("TGCI-ATOM1"), row("TGCI-ATOM2"), row("TGCI-COLLIDE"), row("TGCI-ATOM4")])
    ).rejects.toThrow();
    const [r] = await pool.execute("SELECT COUNT(*) c FROM account_group_codes WHERE group_code IN ('TGCI-ATOM1','TGCI-ATOM2','TGCI-ATOM4')");
    expect(Number(r[0].c)).toBe(0);
  });

  test("31b. a concurrent duplicate surfacing at INSERT time returns 409, rolled back, nothing imported", async () => {
    const real = GroupCodeImportService.parseAndValidateRows;
    jest.spyOn(GroupCodeImportService, "parseAndValidateRows").mockImplementation(async (...args) => {
      const parsed = await real(...args);
      // simulate another user inserting the 2nd code after validation passed
      await pool.execute("INSERT INTO account_group_codes (group_code, group_description, account_class) VALUES ('TGCI-LATE2', 'Late', 'ASSET')");
      return parsed;
    });
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-LATE1", "Late 1", "ASSET"], ["TGCI-LATE2", "Late 2", "ASSET"]]));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/rolled back and no Group Codes were imported/);
    expect(await getGroup("TGCI-LATE1")).toBeUndefined();
    expect((await getGroup("TGCI-LATE2")).group_description).toBe("Late");
  });

  test("31c. any other DB failure returns a clear 500 rollback message, not a raw DB error", async () => {
    jest.spyOn(GroupCodeImportService, "insertGroupCodeRows").mockRejectedValue(Object.assign(new Error("ER_LOCK_DEADLOCK raw detail"), { code: "ER_LOCK_DEADLOCK" }));
    const res = await doImport(csvBuffer([HEADERS, ["TGCI-DEAD", "Dead", "ASSET"]]));
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Import failed and was rolled back. No Group Codes were imported from this file. Please try again.");
    expect(JSON.stringify(res.body)).not.toMatch(/ER_LOCK|raw detail/);
    expect(await getGroup("TGCI-DEAD")).toBeUndefined();
  });

  test("32. valid rows import while invalid rows are skipped, with correct row numbers (blank lines kept in numbering)", async () => {
    const csv = [
      HEADERS.join(","),
      "TGCI-MIX1,Mixed one,ASSET,,,",
      ",No code,ASSET,,,",
      "",
      "TGCI-MIX2,Mixed two,BOGUS,,,",
      "TGCI-MIX3,Mixed three,INCOME,REVENUE,2,",
      "TGCI-EXIST,Existing,ASSET,,,",
    ].join("\n");
    const res = await doImport(Buffer.from(csv));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped.map((s) => [s.row, s.groupCode])).toEqual([[3, ""], [5, "TGCI-MIX2"], [7, "TGCI-EXIST"]]);
    expect(await getGroup("TGCI-MIX1")).toBeDefined();
    expect(await getGroup("TGCI-MIX3")).toMatchObject({ report_section: "REVENUE", display_order: 2, status: "ACTIVE" });
  });

  test("XLSX row numbers are the real sheet row numbers even with a blank row in between", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Group Codes");
    ws.getRow(1).values = HEADERS;
    ws.getRow(2).values = ["TGCI-XR1", "Ok", "ASSET"];
    ws.getRow(4).values = ["TGCI-XR2", "Bad", "NOPE"];
    const res = await doImport(Buffer.from(await wb.xlsx.writeBuffer()), "gc.xlsx");
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toEqual([expect.objectContaining({ row: 4, groupCode: "TGCI-XR2" })]);
  });
});

// --------------------------------------------------------------------------
describe("33-35: permissions", () => {
  test("33. ACCOUNTANT gets 403 for preview and import, and nothing is written", async () => {
    const before = await countTgci();
    const buf = csvBuffer([HEADERS, ["TGCI-ACC", "Accountant", "ASSET"]]);
    expect((await preview(buf, "gc.csv", accountantToken)).status).toBe(403);
    expect((await doImport(buf, "gc.csv", accountantToken)).status).toBe(403);
    expect(await countTgci()).toBe(before);
  });

  test("ACCOUNTANT (no VIEW) also gets 403 for the template", async () => {
    expect((await loadTemplate(accountantToken)).status).toBe(403);
  });

  test("34. VIEW permission alone is sufficient to download the template", async () => {
    const res = await loadTemplate(viewOnlyToken);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml\.sheet/);
  });

  test("35. CONFIGURE is required for preview / import (VIEW-only gets 403)", async () => {
    const before = await countTgci();
    const buf = csvBuffer([HEADERS, ["TGCI-VO", "View only", "ASSET"]]);
    expect((await preview(buf, "gc.csv", viewOnlyToken)).status).toBe(403);
    expect((await doImport(buf, "gc.csv", viewOnlyToken)).status).toBe(403);
    expect(await countTgci()).toBe(before);
  });

  test("unauthenticated requests are rejected", async () => {
    expect((await request(app).get("/api/group-codes/template")).status).toBe(401);
    expect((await request(app).post("/api/group-codes/import").attach("file", csvBuffer([HEADERS]), "gc.csv")).status).toBe(401);
  });
});

// --------------------------------------------------------------------------
describe("existing Group Code routes are unaffected", () => {
  test("GET /api/group-codes still lists rows, including imported ones", async () => {
    const res = await request(app).get("/api/group-codes").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.groupCode === "TGCI-CSV1")).toBe(true);
  });

  test("36. delete integrity still applies to an imported Group Code assigned to an account", async () => {
    const [coa] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TGCI-COA-1', CURDATE(), 'TGCI account', 'ASSET')");
    await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, 'TGCI-CSV1', 'Csv one')", [coa.insertId]);
    const [[g]] = await pool.execute("SELECT id FROM account_group_codes WHERE group_code = 'TGCI-CSV1'");
    try {
      const res = await request(app).delete(`/api/group-codes/${g.id}`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("GROUP_CODE_IN_USE");
      expect(await getGroup("TGCI-CSV1")).toBeDefined();
    } finally {
      await pool.execute("DELETE FROM chart_of_accounts WHERE id = ?", [coa.insertId]);
    }
  });
});
