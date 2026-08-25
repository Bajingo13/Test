const request = require("supertest");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const COAImportService = require("../services/COAImportService");

// COA import reliability checkpoint: covers the fixes from the audit -
// atomic batch transaction, case-insensitive duplicate detection matching
// the DB's own utf8mb4_0900_ai_ci collation, .xls rejection (ExcelJS never
// actually supported the legacy binary format despite the old shared
// filter advertising it), field-length validation, the new
// preview-then-confirm split (parse/validate is read-only; only the
// confirm step writes), and improved error reporting on a rolled-back
// batch. chart_of_accounts has no company scoping (see the audit report -
// it's a deliberate, global, shared catalog), so every fixture here uses a
// distinctive TESTCOAIMP- code prefix instead of a company boundary.

jest.setTimeout(180000);

let adminToken, noPermToken;
let adminUserId, noPermUserId;
let companyId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeLoginUser(username, password, roleId, forCompanyId) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = result.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, forCompanyId]);
  return userId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

function csvBuffer(rows) {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
}

async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

async function countCoaByPrefix(prefix) {
  const [rows] = await pool.execute("SELECT COUNT(*) AS c FROM chart_of_accounts WHERE code LIKE ?", [`${prefix}%`]);
  return rows[0].c;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  await pool.execute("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%')");
  await pool.execute("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%')");
  await pool.execute("DELETE FROM bank_codes WHERE coa_code LIKE 'TESTCOAIMP%'");
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%'");

  companyId = await makeCompany("TEST COA Import Co");
  adminUserId = await makeLoginUser("test_coaimp_admin", "CoaImp!Pass1", 2, companyId); // ADMIN - has FILESETUP.COA.CREATE
  noPermUserId = await makeLoginUser("test_coaimp_noperm", "CoaImp!Pass2", 3, companyId); // ACCOUNTANT - no FILESETUP.COA permissions

  adminToken = await loginAs("test_coaimp_admin", "CoaImp!Pass1");
  noPermToken = await loginAs("test_coaimp_noperm", "CoaImp!Pass2");
});

afterAll(async () => {
  await pool.execute("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%')");
  await pool.execute("DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%')");
  await pool.execute("DELETE FROM bank_codes WHERE coa_code LIKE 'TESTCOAIMP%'");
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTCOAIMP%'");
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (?, ?)", [adminUserId, noPermUserId]);
  await pool.execute("DELETE FROM users WHERE id IN (?, ?)", [adminUserId, noPermUserId]);
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("1-2: valid CSV and XLSX import (via preview then confirm)", () => {
  test("a valid CSV file previews with zero writes, then confirms and imports", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-CSV1", "CSV Import Test 1", "ASSET"],
    ]);

    const before = await countCoaByPrefix("TESTCOAIMP-CSV1");
    expect(before).toBe(0);

    const previewRes = await request(app)
      .post("/api/coa/import/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buf, "coa-test.csv");

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.readyCount).toBe(1);
    expect(previewRes.body.totalRows).toBe(1);
    expect(previewRes.body.skipped).toEqual([]);

    // Preview must never write.
    expect(await countCoaByPrefix("TESTCOAIMP-CSV1")).toBe(0);

    const confirmRes = await request(app)
      .post("/api/coa/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buf, "coa-test.csv");

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.success).toBe(true);
    expect(confirmRes.body.imported).toBe(1);
    expect(await countCoaByPrefix("TESTCOAIMP-CSV1")).toBe(1);
  });

  test("a valid XLSX file imports correctly", async () => {
    const buf = await xlsxBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-XLSX1", "XLSX Import Test 1", "EXPENSE"],
    ]);

    const res = await request(app)
      .post("/api/coa/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", Buffer.from(buf), "coa-test.xlsx");

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const [rows] = await pool.execute("SELECT title, account_class AS accountClass FROM chart_of_accounts WHERE code = 'TESTCOAIMP-XLSX1'");
    expect(rows[0].title).toBe("XLSX Import Test 1");
    expect(rows[0].accountClass).toBe("EXPENSE");
  });
});

describe("3: unsupported .xls rejection", () => {
  test("uploading a .xls file is rejected with a clear, specific message", async () => {
    const res = await request(app)
      .post("/api/coa/import/preview")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", Buffer.from("irrelevant content"), "coa-test.xls");

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Legacy \.xls files are not supported/);
  });
});

describe("4-6: duplicate detection", () => {
  test("a code already in the DB is skipped with a clear reason", async () => {
    await pool.execute(
      "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TESTCOAIMP-DUP1', CURDATE(), 'Existing Account', 'ASSET')"
    );

    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-DUP1", "Attempted Duplicate", "ASSET"],
    ]);

    const res = await request(app)
      .post("/api/coa/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buf, "coa-test.csv");

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/already exists/);
  });

  test("a case-variant of an existing DB code is caught by validation, not by a DB error", async () => {
    await pool.execute(
      "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TESTCOAIMP-CASE1', CURDATE(), 'Existing Cased Account', 'ASSET')"
    );

    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["testcoaimp-case1", "Lowercase Variant", "ASSET"],
    ]);

    const res = await request(app)
      .post("/api/coa/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buf, "coa-test.csv");

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/already exists/);

    // Only the original row exists - no case-variant duplicate was created.
    const [rows] = await pool.execute("SELECT code FROM chart_of_accounts WHERE UPPER(code) = 'TESTCOAIMP-CASE1'");
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("TESTCOAIMP-CASE1"); // original casing preserved, never rewritten
  });

  test("two case-variant codes within the SAME file: the first imports, the second is skipped as a file-internal duplicate", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-CASE2", "First Casing", "ASSET"],
      ["testcoaimp-case2", "Second Casing", "ASSET"],
    ]);

    const res = await request(app)
      .post("/api/coa/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", buf, "coa-test.csv");

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/duplicate of another row in this file/);

    const [rows] = await pool.execute("SELECT code FROM chart_of_accounts WHERE UPPER(code) = 'TESTCOAIMP-CASE2'");
    expect(rows).toHaveLength(1);
  });

  test("7: uploading the exact same file twice safely skips on the second attempt, no duplicates created", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-REUP1", "Re-upload Test", "ASSET"],
    ]);

    const first = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(first.body.imported).toBe(1);

    const second = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toHaveLength(1);
    expect(second.body.skipped[0].reason).toMatch(/already exists/);

    expect(await countCoaByPrefix("TESTCOAIMP-REUP1")).toBe(1);
  });
});

describe("8-13: validation", () => {
  test("a file missing recognizable Code/Title columns is rejected before any row is processed", async () => {
    const buf = csvBuffer([
      ["Foo", "Bar"],
      ["1", "2"],
    ]);

    const res = await request(app).post("/api/coa/import/preview").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Code and Title/);
  });

  test("an invalid account class is skipped with the list of valid options", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-BADCLASS", "Bad Class Account", "NOT_A_CLASS"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped[0].reason).toMatch(/Account Class must be one of/);
  });

  test("an unrecognized validation tag is a warning, not a skip - the row still imports", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class", "Validations"],
      ["TESTCOAIMP-BADTAG", "Bad Tag Account", "ASSET", "NOT_A_REAL_TAG"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(1);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0].message).toMatch(/Unrecognized validation/);
  });

  test("an unrecognized group code is a warning, not a skip - the row still imports", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class", "Group Codes"],
      ["TESTCOAIMP-BADGROUP", "Bad Group Account", "ASSET", "NOT_A_REAL_GROUP"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(1);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0].message).toMatch(/Unrecognized group code/);
  });

  test("an overlong account code (>50 chars) is skipped with a clear reason, never sent to the DB", async () => {
    const longCode = "TESTCOAIMP-" + "X".repeat(45); // > 50 chars total
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      [longCode, "Overlong Code Account", "ASSET"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped[0].reason).toMatch(/exceeds the maximum length of 50/);
  });

  test("an overlong account title (>255 chars) is skipped with a clear reason", async () => {
    const longTitle = "A".repeat(300);
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-LONGTITLE", longTitle, "ASSET"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped[0].reason).toMatch(/exceeds the maximum length of 255/);
  });
});

describe("16: atomic batch transaction - mid-batch failure rolls back the entire import", () => {
  // Directly exercises insertCOARows() with a hand-built row list that
  // intentionally collides with an existing DB row partway through - the
  // realistic shape of "an unexpected DB error mid-batch" (e.g. a race
  // condition between preview and confirm), bypassing parseAndValidateRows'
  // own pre-checks on purpose to prove the INSERT layer itself is atomic,
  // not just that validation usually catches problems first.
  async function noopSyncBankCode() {}

  test("rows before AND after a mid-batch failure are all rolled back together", async () => {
    await pool.execute(
      "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TESTCOAIMP-ATOMIC-COLLIDE', CURDATE(), 'Pre-existing', 'ASSET')"
    );

    const rows = [
      { code: "TESTCOAIMP-ATOMIC-1", date: "2026-01-01", title: "Atomic 1", accountClass: "ASSET", description: "", validations: [], groups: [] },
      { code: "TESTCOAIMP-ATOMIC-2", date: "2026-01-01", title: "Atomic 2", accountClass: "ASSET", description: "", validations: [], groups: [] },
      { code: "TESTCOAIMP-ATOMIC-COLLIDE", date: "2026-01-01", title: "Should collide", accountClass: "ASSET", description: "", validations: [], groups: [] },
      { code: "TESTCOAIMP-ATOMIC-4", date: "2026-01-01", title: "Atomic 4", accountClass: "ASSET", description: "", validations: [], groups: [] },
    ];

    await expect(COAImportService.insertCOARows(rows, noopSyncBankCode)).rejects.toThrow();

    // Rows 1 and 2 (which would have succeeded on their own, before the
    // collision) must NOT be committed - the whole batch rolled back.
    const [check] = await pool.execute(
      "SELECT COUNT(*) AS c FROM chart_of_accounts WHERE code IN ('TESTCOAIMP-ATOMIC-1','TESTCOAIMP-ATOMIC-2','TESTCOAIMP-ATOMIC-4')"
    );
    expect(check[0].c).toBe(0);
  });

  test("the same failure surfaced through the real HTTP route returns a clear rollback message, not a raw DB error", async () => {
    // Craft rows the SAME way via the real endpoint by racing two identical
    // uploads - the second one's colliding code fails inside insertCOARows
    // after having already passed its own file-internal pre-validation
    // (each request validates independently against the DB state at the
    // start of ITS OWN request).
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-RACE-1", "Race Row 1", "ASSET"],
      ["TESTCOAIMP-RACE-2", "Race Row 2", "ASSET"],
    ]);

    const [firstRes, secondRes] = await Promise.all([
      request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv"),
      request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv"),
    ]);

    const outcomes = [firstRes, secondRes];
    const successes = outcomes.filter((r) => r.body.success && r.body.imported > 0);
    const failures = outcomes.filter((r) => !r.body.success);

    // Exactly one of the two concurrent identical uploads should succeed;
    // the other either cleanly skips (if it validated after the first
    // committed) or cleanly rolls back (if it raced past its own
    // validation before the first committed) - never a raw 500 with
    // library internals, and never a partial/duplicate result.
    expect(successes.length + outcomes.filter((r) => r.body.success && r.body.imported === 0).length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f.body.message).toMatch(/rolled back/i);
      expect(f.body.message).not.toMatch(/ER_DUP_ENTRY|SQLSTATE|at Object\./); // no raw internals leaked
    }

    const [finalCount] = await pool.execute("SELECT COUNT(*) AS c FROM chart_of_accounts WHERE code IN ('TESTCOAIMP-RACE-1','TESTCOAIMP-RACE-2')");
    expect(finalCount[0].c).toBe(2); // both committed exactly once, never zero, never duplicated
  });
});

describe("17: BANK / CASH synchronization still works through the real endpoint", () => {
  test("importing an account tagged BANK / CASH creates an active bank_codes row", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class", "Validations"],
      ["TESTCOAIMP-BANK1", "Bank Account Test", "ASSET", "BANK / CASH"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");
    expect(res.body.imported).toBe(1);

    const [bankRows] = await pool.execute(
      "SELECT status FROM bank_codes WHERE coa_code = 'TESTCOAIMP-BANK1'"
    );
    expect(bankRows).toHaveLength(1);
    expect(bankRows[0].status).toBe("ACTIVE");
  });
});

describe("18: authorization", () => {
  test("a user without FILESETUP.COA.CREATE gets 403, not a partial import", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-NOPERM", "Should Never Import", "ASSET"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${noPermToken}`).attach("file", buf, "coa-test.csv");
    expect(res.status).toBe(403);
    expect(await countCoaByPrefix("TESTCOAIMP-NOPERM")).toBe(0);
  });

  test("preview also requires FILESETUP.COA.CREATE", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-NOPERM2", "Should Never Preview", "ASSET"],
    ]);

    const res = await request(app).post("/api/coa/import/preview").set("Authorization", `Bearer ${noPermToken}`).attach("file", buf, "coa-test.csv");
    expect(res.status).toBe(403);
  });
});

describe("19: structured skipped-row reporting", () => {
  test("a mixed file reports correct row numbers and reasons for every category", async () => {
    const buf = csvBuffer([
      ["Code", "Title", "Account Class"],
      ["TESTCOAIMP-MIX-OK", "Valid Row", "ASSET"],
      ["", "Missing Code", "ASSET"],
      ["TESTCOAIMP-MIX-BADCLASS", "Bad Class Row", "NOT_REAL"],
    ]);

    const res = await request(app).post("/api/coa/import").set("Authorization", `Bearer ${adminToken}`).attach("file", buf, "coa-test.csv");

    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, reason: expect.stringMatching(/Missing required/) }),
        expect.objectContaining({ row: 4, reason: expect.stringMatching(/Account Class must be one of/) }),
      ])
    );
    expect(res.body.skipped).toHaveLength(2);
  });
});
