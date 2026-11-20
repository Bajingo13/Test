const request = require("supertest");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const GenLibImportService = require("../services/GenLibImportService");

// TC-FS-GENLIB-IMPORT-001 - General Libraries import: preview -> confirm.
// Preview writes nothing; confirm re-parses and re-validates against the
// current database, inserts every ready row in ONE transaction, and a
// duplicate created after validation rolls the whole batch back (409).
// general_libraries.code is UNIQUE across all companies, so every fixture
// uses the distinctive TGLI- code prefix.

jest.setTimeout(180000);

const PASS = "Tgli!Pass1";
let companyId, adminId, accountantId, adminToken, accountantToken;

const HEADER = ["Code", "Type", "Name", "Status", "TIN", "Telephone", "Address 1", "Notes"];
const csv = (rows) => Buffer.from(rows.map((r) => r.map((v) => (v === undefined ? "" : String(v))).join(",")).join("\n"), "utf8");
async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("General Libraries");
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
const preview = (buf, name = "gl.csv", token = adminToken) =>
  request(app).post("/api/genlib/import/preview").set("Authorization", `Bearer ${token}`).attach("file", buf, name);
const doImport = (buf, name = "gl.csv", token = adminToken) =>
  request(app).post("/api/genlib/import").set("Authorization", `Bearer ${token}`).attach("file", buf, name);
async function countTgli() {
  const [r] = await pool.execute("SELECT COUNT(*) c FROM general_libraries WHERE code LIKE 'TGLI-%'");
  return Number(r[0].c);
}
async function codesTgli() {
  const [r] = await pool.execute("SELECT code FROM general_libraries WHERE code LIKE 'TGLI-%' ORDER BY code");
  return r.map((x) => x.code);
}
async function cleanup() {
  await pool.execute("DELETE FROM general_libraries WHERE code LIKE 'TGLI-%'");
}
async function seedExisting(code, type = "CUSTOMER") {
  await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')", [companyId, code, type, `Existing ${code}`]);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanup();
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'tgli_%')");
  await pool.execute("DELETE FROM users WHERE username LIKE 'tgli_%'");
  const [co] = await pool.execute("INSERT INTO companies (name, status) VALUES ('TGLI General Libraries Import Co', 'Active')");
  companyId = co.insertId;
  adminId = await makeUser("tgli_admin", 2); // ADMIN - FILESETUP.GENLIB VIEW/CREATE/EDIT/DELETE
  accountantId = await makeUser("tgli_accountant", 3); // ACCOUNTANT - no FILESETUP.GENLIB permission
  adminToken = await loginAs("tgli_admin");
  accountantToken = await loginAs("tgli_accountant");
});

afterAll(async () => {
  jest.restoreAllMocks();
  await cleanup();
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (?, ?)", [adminId, accountantId]);
  await pool.execute("DELETE FROM users WHERE id IN (?, ?)", [adminId, accountantId]);
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await cleanup();
});

// --------------------------------------------------------------------------
describe("TC-FS-GENLIB-IMPORT-001 preview (read-only)", () => {
  test("1. a valid file previews every row as ready and writes ZERO records", async () => {
    const before = await countTgli();
    const res = await preview(csv([HEADER, ["TGLI-C1", "CUSTOMER", "Acme Retail", "ACTIVE", "123-456-789-000", "(02) 8123-4567", "Makati City", "n"], ["TGLI-S1", "supplier", "Globe Supplies", "", "", "", "", ""]]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, totalRows: 2, readyCount: 2, skipped: [], warnings: [] });
    expect(res.body.ready).toEqual([
      { row: 2, code: "TGLI-C1", name: "Acme Retail", type: "CUSTOMER", status: "ACTIVE" },
      { row: 3, code: "TGLI-S1", name: "Globe Supplies", type: "SUPPLIER", status: "ACTIVE" },
    ]);
    expect(await countTgli()).toBe(before);
  });

  test("2. .xlsx files preview the same way", async () => {
    const res = await preview(await xlsx([HEADER, ["TGLI-X1", "EMPLOYEE", "Juan Dela Cruz", "INACTIVE"]]), "gl.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.ready).toEqual([{ row: 2, code: "TGLI-X1", name: "Juan Dela Cruz", type: "EMPLOYEE", status: "INACTIVE" }]);
    expect(await countTgli()).toBe(0);
  });

  test("3. an unsupported file type is refused by the upload filter (400)", async () => {
    const res = await preview(Buffer.from("hello"), "gl.txt");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only \.csv, \.xls, or \.xlsx/);
  });

  test("4. an unreadable spreadsheet is a clear 500 with no raw detail and no writes", async () => {
    const res = await preview(Buffer.from("not really a workbook"), "gl.xlsx");
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to read the file. Please check its format and try again.");
    expect(await countTgli()).toBe(0);
  });

  test("5. an empty file and a file without the required Code / Name columns are 400", async () => {
    expect((await preview(Buffer.from(""), "gl.csv")).status).toBe(400);
    const res = await preview(csv([["Code", "Type"], ["TGLI-N1", "CUSTOMER"]]));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Could not find required Code and Name columns in the file");
  });

  test("6. invalid party type, missing required value, existing and in-file duplicates are skipped row by row", async () => {
    await seedExisting("TGLI-EXIST");
    const res = await preview(csv([
      HEADER,
      ["TGLI-OK1", "CUSTOMER", "Good One"],
      ["TGLI-BADTYPE", "VENDOR", "Bad Type"],
      ["TGLI-NONAME", "SUPPLIER", ""],
      ["tgli-exist", "CUSTOMER", "Same code, other case"],
      ["TGLI-OK1", "SUPPLIER", "Repeated in file"],
      ["TGLI-WARN", "CUSTOMER", "Odd status", "SUSPENDED"],
    ]));
    expect(res.status).toBe(200);
    expect(res.body.readyCount).toBe(2);
    expect(res.body.ready.map((r) => r.code)).toEqual(["TGLI-OK1", "TGLI-WARN"]);
    expect(res.body.skipped).toEqual([
      { row: 3, code: "TGLI-BADTYPE", reason: "Type must be one of: CUSTOMER, SUPPLIER, EMPLOYEE, AFFILIATE, BRANCH, OTHER" },
      { row: 4, code: "TGLI-NONAME", reason: "Missing required code or name" },
      { row: 5, code: "tgli-exist", reason: 'Code "tgli-exist" already exists' },
      { row: 6, code: "TGLI-OK1", reason: 'Code "TGLI-OK1" is repeated in this file (first used on row 2)' },
    ]);
    expect(res.body.warnings).toEqual([{ row: 7, message: 'Unrecognized status "SUSPENDED" - defaulted to ACTIVE' }]);
    expect(await codesTgli()).toEqual(["TGLI-EXIST"]);
  });

  test("7. a long issue list reports every row with its real row number", async () => {
    const rows = [HEADER, ...Array.from({ length: 60 }, (_, i) => [`TGLI-L${i}`, "NOPE", `Row ${i}`])];
    const res = await preview(csv(rows));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toHaveLength(60);
    expect(res.body.skipped[0]).toMatchObject({ row: 2, code: "TGLI-L0" });
    expect(res.body.skipped[59]).toMatchObject({ row: 61, code: "TGLI-L59" });
  });
});

// --------------------------------------------------------------------------
describe("TC-FS-GENLIB-IMPORT-001 confirm (re-validate + transactional insert)", () => {
  test("8. confirm imports the valid rows into the user's company and skips the invalid ones", async () => {
    const file = csv([HEADER, ["TGLI-C1", "CUSTOMER", "Acme Retail", "ACTIVE", "123-456-789-000", "(02) 8123-4567", "Makati City", "note"], ["TGLI-BAD", "VENDOR", "Bad"], ["TGLI-S1", "SUPPLIER", "Globe"]]);
    expect((await preview(file)).body.readyCount).toBe(2);
    const res = await doImport(file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imported: 2 });
    expect(res.body.skipped).toEqual([{ row: 3, code: "TGLI-BAD", reason: expect.stringMatching(/^Type must be one of/) }]);
    expect(res.body.warnings).toEqual([]);
    const [rows] = await pool.execute("SELECT code, company_id, party_type, name, tin, telephone, address1, notes FROM general_libraries WHERE code LIKE 'TGLI-%' ORDER BY code");
    expect(rows).toEqual([
      { code: "TGLI-C1", company_id: companyId, party_type: "CUSTOMER", name: "Acme Retail", tin: "123-456-789-000", telephone: "(02) 8123-4567", address1: "Makati City", notes: "note" },
      { code: "TGLI-S1", company_id: companyId, party_type: "SUPPLIER", name: "Globe", tin: "", telephone: "", address1: "", notes: "" },
    ]);
  });

  test("9. confirm re-validates: a code created after the preview is skipped, the rest still import", async () => {
    const file = csv([HEADER, ["TGLI-A", "CUSTOMER", "A"], ["TGLI-B", "CUSTOMER", "B"]]);
    expect((await preview(file)).body.readyCount).toBe(2);
    await seedExisting("TGLI-B"); // another user, between preview and confirm
    const res = await doImport(file);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toEqual([{ row: 3, code: "TGLI-B", reason: 'Code "TGLI-B" already exists' }]);
    expect(await codesTgli()).toEqual(["TGLI-A", "TGLI-B"]);
  });

  test("10. a duplicate that appears between validation and INSERT rolls the whole batch back (409)", async () => {
    await seedExisting("TGLI-RACE");
    const real = GenLibImportService.parseAndValidateRows;
    jest.spyOn(GenLibImportService, "parseAndValidateRows").mockImplementation(async (...args) => {
      const parsed = await real(...args);
      // validation finished before the other user's row existed
      parsed.ready.push({ ...parsed.ready[0], row: 99, code: "TGLI-RACE", name: "Raced" });
      return parsed;
    });
    const res = await doImport(csv([HEADER, ["TGLI-FIRST", "CUSTOMER", "Inserted first, then rolled back"]]));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/rolled back and no records were imported/);
    expect(await codesTgli()).toEqual(["TGLI-RACE"]); // TGLI-FIRST was rolled back
  });

  test("11. any other database failure returns a clear rollback message, never the raw DB error", async () => {
    jest.spyOn(GenLibImportService, "insertGenLibRows").mockRejectedValue(Object.assign(new Error("ER_LOCK_DEADLOCK raw detail"), { code: "ER_LOCK_DEADLOCK" }));
    const res = await doImport(csv([HEADER, ["TGLI-D1", "CUSTOMER", "D1"]]));
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Import failed and was rolled back. No records were imported from this file. Please try again.");
    expect(JSON.stringify(res.body)).not.toMatch(/raw detail/);
    expect(await countTgli()).toBe(0);
  });

  test("12. a real mid-batch DB failure leaves zero rows from the batch (transaction)", async () => {
    // A name longer than the column can hold makes the 2nd INSERT fail after the 1st succeeded.
    const [[col]] = await pool.execute("SELECT CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'general_libraries' AND COLUMN_NAME = 'name'");
    const tooLong = "X".repeat(Number(col.len) + 10);
    const res = await doImport(csv([HEADER, ["TGLI-T1", "CUSTOMER", "Fine"], ["TGLI-T2", "CUSTOMER", tooLong]]));
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/rolled back/);
    expect(await countTgli()).toBe(0);
  });

  test("13. result carries Imported / Skipped / Warnings for the summary line", async () => {
    const res = await doImport(csv([HEADER, ["TGLI-R1", "CUSTOMER", "R1", "MAYBE"], ["TGLI-R2", "NOPE", "R2"]]));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.warnings).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
describe("TC-FS-GENLIB-IMPORT-001 permissions (server-side authority unchanged)", () => {
  test("14. ACCOUNTANT without FILESETUP.GENLIB CREATE gets 403 on preview and import; nothing written", async () => {
    const file = csv([HEADER, ["TGLI-P1", "CUSTOMER", "P1"]]);
    expect((await preview(file, "gl.csv", accountantToken)).status).toBe(403);
    expect((await doImport(file, "gl.csv", accountantToken)).status).toBe(403);
    expect(await countTgli()).toBe(0);
  });

  test("15. no token is 401", async () => {
    const res = await request(app).post("/api/genlib/import/preview").attach("file", csv([HEADER]), "gl.csv");
    expect(res.status).toBe(401);
  });
});
