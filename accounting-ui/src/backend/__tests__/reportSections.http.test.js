const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase M.1 - Report Section master data. GET/POST/PUT/DELETE
// /api/report-sections manage the new report_sections table that now
// backs Group Code's Report Section dropdown/validation, replacing the
// old hard-coded groupCodeClassification.js/groupCodeSections.mjs arrays
// as the LIVE authority (those files still exist unchanged as a legacy/
// parity-tested reference - see groupCodeClassification.http.test.js).
// This suite covers: auth, FILESETUP.REPORT_SECTIONS permission
// enforcement, CRUD, duplicate-code / duplicate-name-within-class
// rejection, delete-in-use guard (mirrors Group Code's own Phase H.1
// pattern, just against account_group_codes.report_section instead of
// coa_groups.group_code), the seed data from
// report_sections_master_migration.sql, and end-to-end integration with
// Group Code create/update (a Group Code can be classified using a
// brand-new custom section the moment it's added here - no restart, no
// hard-coded allowlist).

jest.setTimeout(120000);

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATION_FILE = "report_sections_master_migration.sql";

let companyId, adminToken, noRoleToken, adminId, noRoleId;
const createdSectionIds = [];
const createdGroupIds = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('RS Co', 'Active')");
  companyId = c.insertId;

  const hash = await bcrypt.hash("RsPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('rs_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyId]);
  adminToken = await login("rs_admin", "RsPass!1");

  const hash2 = await bcrypt.hash("RsPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('rs_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("rs_norole", "RsPass!2");
});

afterAll(async () => {
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'RS-%'");
  if (createdSectionIds.length) {
    await pool.query(
      `DELETE FROM report_sections WHERE id IN (${createdSectionIds.map(() => "?").join(",")})`,
      createdSectionIds
    );
  }
  await pool.query("DELETE FROM report_sections WHERE code LIKE 'RS_TEST_%'");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe("migration - report_sections_master_migration.sql", () => {
  test("is registered in migrationOrder.js", () => {
    const order = fs.readFileSync(path.join(__dirname, "../scripts/migrationOrder.js"), "utf8");
    expect(order).toContain(`"${MIGRATION_FILE}"`);
  });

  test("root-level mirror copy exists and is byte-identical (the migration runner reads REPO_ROOT, not src/backend/migrations)", () => {
    const rootCopy = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), "utf8");
    const srcCopy = fs.readFileSync(path.join(__dirname, "..", "migrations", MIGRATION_FILE), "utf8");
    expect(rootCopy).toBe(srcCopy);
    const permRootCopy = fs.readFileSync(path.join(REPO_ROOT, "report_sections_permissions_migration.sql"), "utf8");
    const permSrcCopy = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "report_sections_permissions_migration.sql"),
      "utf8"
    );
    expect(permRootCopy).toBe(permSrcCopy);
  });

  test("table exists with the expected columns", async () => {
    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report_sections'`
    );
    const names = cols.map((c) => c.COLUMN_NAME).sort();
    expect(names).toEqual(
      ["account_class", "code", "created_at", "display_order", "id", "name", "status", "updated_at"].sort()
    );
  });

  test("seeded with the exact 11 sections groupCodeClassification.js/groupCodeSections.mjs already hard-coded - zero drift", async () => {
    const [rows] = await pool.execute("SELECT code, name, account_class FROM report_sections ORDER BY code");
    const GCC = require("../services/groupCodeClassification");
    const bySeed = Object.fromEntries(rows.map((r) => [r.code, { name: r.name, accountClass: r.account_class }]));
    for (const s of GCC.REPORT_SECTIONS) {
      expect(bySeed[s.code]).toBeDefined();
      expect(bySeed[s.code].name).toBe(s.label);
      expect(bySeed[s.code].accountClass).toBe(s.accountClass);
    }
    expect(rows.length).toBe(GCC.REPORT_SECTIONS.length);
  });
});

describe("GET /api/report-sections", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/report-sections");
    expect(res.status).toBe(401);
  });

  test("2. enforces FILESETUP.REPORT_SECTIONS VIEW - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/report-sections").set(auth(noRoleToken));
    expect(res.status).toBe(403);
  });

  test("lists all sections including the seeded 11, in camelCase shape", async () => {
    const res = await request(app).get("/api/report-sections").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(11);
    const row = res.body.find((r) => r.code === "CURRENT_ASSET");
    expect(row).toMatchObject({ code: "CURRENT_ASSET", name: "Current Assets", accountClass: "ASSET" });
    expect(Object.keys(row).sort()).toEqual(["accountClass", "code", "displayOrder", "id", "name", "status"].sort());
  });

  test("?accountClass= filters correctly", async () => {
    const res = await request(app).get("/api/report-sections?accountClass=EQUITY").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.every((r) => r.accountClass === "EQUITY")).toBe(true);
    expect(res.body.some((r) => r.code === "EQUITY")).toBe(true);
  });
});

describe("POST /api/report-sections", () => {
  test("3. enforces FILESETUP.REPORT_SECTIONS CONFIGURE - a user with no role -> 403", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(noRoleToken))
      .send({ code: "RS_TEST_NOROLE", name: "x", accountClass: "ASSET" });
    expect(res.status).toBe(403);
  });

  test("creates a new report section", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "rs_test_bad_debts", name: "Bad Debts Expense", accountClass: "EXPENSE", displayOrder: 50 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    createdSectionIds.push(res.body.id);

    const list = await request(app).get("/api/report-sections").set(auth(adminToken));
    const row = list.body.find((r) => r.id === res.body.id);
    // code is normalized to uppercase server-side regardless of input case.
    expect(row.code).toBe("RS_TEST_BAD_DEBTS");
    expect(row.name).toBe("Bad Debts Expense");
    expect(row.accountClass).toBe("EXPENSE");
    expect(row.displayOrder).toBe(50);
    expect(row.status).toBe("ACTIVE");
  });

  test("rejects a duplicate code", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_BAD_DEBTS", name: "Different Name", accountClass: "EXPENSE" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DUPLICATE_CODE");
  });

  test("rejects a duplicate name within the same account class", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_BAD_DEBTS_2", name: "Bad Debts Expense", accountClass: "EXPENSE" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DUPLICATE_NAME");
  });

  test("the SAME name is allowed again under a DIFFERENT account class (composite uniqueness, not global)", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_BAD_DEBTS_ASSET", name: "Bad Debts Expense", accountClass: "ASSET" });
    expect(res.status).toBe(200);
    createdSectionIds.push(res.body.id);
  });

  test("rejects a missing code/name/accountClass", async () => {
    const r1 = await request(app).post("/api/report-sections").set(auth(adminToken)).send({ name: "x", accountClass: "ASSET" });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post("/api/report-sections").set(auth(adminToken)).send({ code: "RS_TEST_X", accountClass: "ASSET" });
    expect(r2.status).toBe(400);
    const r3 = await request(app).post("/api/report-sections").set(auth(adminToken)).send({ code: "RS_TEST_Y", name: "y", accountClass: "NOT_A_CLASS" });
    expect(r3.status).toBe(400);
  });

  test("rejects a non-integer display order", async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_BADORDER", name: "Bad Order", accountClass: "ASSET", displayOrder: "abc" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/report-sections/:id", () => {
  let sectionId;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_EDITME", name: "Edit Me", accountClass: "INCOME", displayOrder: 5 });
    sectionId = res.body.id;
    createdSectionIds.push(sectionId);
  });

  test("4. enforces FILESETUP.REPORT_SECTIONS CONFIGURE - a user with no role -> 403", async () => {
    const res = await request(app)
      .put(`/api/report-sections/${sectionId}`)
      .set(auth(noRoleToken))
      .send({ code: "RS_TEST_EDITME", name: "Edited", accountClass: "INCOME" });
    expect(res.status).toBe(403);
  });

  test("updates name/status/displayOrder", async () => {
    const res = await request(app)
      .put(`/api/report-sections/${sectionId}`)
      .set(auth(adminToken))
      .send({ code: "RS_TEST_EDITME", name: "Edited Name", accountClass: "INCOME", displayOrder: 15, status: "INACTIVE" });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/report-sections").set(auth(adminToken));
    const row = list.body.find((r) => r.id === sectionId);
    expect(row.name).toBe("Edited Name");
    expect(row.displayOrder).toBe(15);
    expect(row.status).toBe("INACTIVE");
  });

  test("an INACTIVE section is excluded from the ?accountClass filter's would-be active dropdown query used by Group Code (status=ACTIVE)", async () => {
    const res = await request(app)
      .get("/api/report-sections?accountClass=INCOME&status=ACTIVE")
      .set(auth(adminToken));
    expect(res.body.some((r) => r.id === sectionId)).toBe(false);
  });
});

describe("DELETE /api/report-sections/:id - integrity guard", () => {
  test("5. enforces FILESETUP.REPORT_SECTIONS CONFIGURE - a user with no role -> 403", async () => {
    const res = await request(app).delete("/api/report-sections/999999").set(auth(noRoleToken));
    expect(res.status).toBe(403);
  });

  test("an unreferenced report section deletes cleanly", async () => {
    const create = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_DELETEME", name: "Delete Me", accountClass: "LIABILITY" });
    const id = create.body.id;

    const del = await request(app).delete(`/api/report-sections/${id}`).set(auth(adminToken));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get("/api/report-sections").set(auth(adminToken));
    expect(list.body.some((r) => r.id === id)).toBe(false);
  });

  test("a report section referenced by a Group Code cannot be deleted (409 REPORT_SECTION_IN_USE)", async () => {
    const create = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_INUSE", name: "In Use Section", accountClass: "ASSET" });
    const sectionId = create.body.id;
    createdSectionIds.push(sectionId);

    const gc = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-INUSE-GC",
        groupDescription: "References RS_TEST_INUSE",
        accountClass: "ASSET",
        reportSection: "RS_TEST_INUSE",
        status: "ACTIVE",
      });
    expect(gc.status).toBe(200);
    createdGroupIds.push(gc.body.id);

    const del = await request(app).delete(`/api/report-sections/${sectionId}`).set(auth(adminToken));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("REPORT_SECTION_IN_USE");
    expect(del.body.references.groupCodes).toBeGreaterThanOrEqual(1);

    // the section survives, untouched.
    const list = await request(app).get("/api/report-sections").set(auth(adminToken));
    expect(list.body.some((r) => r.id === sectionId)).toBe(true);
  });

  test("deleting the seeded, currently-unused CURRENT_ASSET-style sections is blocked once ANY Group Code uses them (regression: existing 11 stay protected the same way)", async () => {
    const gc = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-EQUITY-GC",
        groupDescription: "References the seeded EQUITY section",
        accountClass: "EQUITY",
        reportSection: "EQUITY",
        status: "ACTIVE",
      });
    expect(gc.status).toBe(200);
    createdGroupIds.push(gc.body.id);

    const seeded = await request(app).get("/api/report-sections").set(auth(adminToken));
    const equityRow = seeded.body.find((r) => r.code === "EQUITY");

    const del = await request(app).delete(`/api/report-sections/${equityRow.id}`).set(auth(adminToken));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("REPORT_SECTION_IN_USE");
  });
});

describe("integration: Group Code validates report_section against the LIVE report_sections table, not a hard-coded array", () => {
  test("a Group Code CAN be classified with a brand-new custom section the instant it is added here - no restart, no code change", async () => {
    const created = await request(app)
      .post("/api/report-sections")
      .set(auth(adminToken))
      .send({ code: "RS_TEST_CUSTOM_LIVE", name: "Custom Live Section", accountClass: "EXPENSE" });
    expect(created.status).toBe(200);
    createdSectionIds.push(created.body.id);

    const gc = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-LIVE-GC",
        groupDescription: "Uses a brand-new custom section",
        accountClass: "EXPENSE",
        reportSection: "RS_TEST_CUSTOM_LIVE",
        status: "ACTIVE",
      });
    expect(gc.status).toBe(200);
    createdGroupIds.push(gc.body.id);

    const list = await request(app).get("/api/group-codes").set(auth(adminToken));
    const row = list.body.find((r) => r.groupCode === "RS-LIVE-GC");
    expect(row.reportSection).toBe("RS_TEST_CUSTOM_LIVE");
  });

  test("a Group Code is still rejected for a section that does not exist at all", async () => {
    const gc = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-BADSECTION-GC",
        groupDescription: "x",
        accountClass: "EXPENSE",
        reportSection: "TOTALLY_MADE_UP_SECTION",
        status: "ACTIVE",
      });
    expect(gc.status).toBe(400);
  });

  test("a Group Code is still rejected for a real section that belongs to a DIFFERENT account class", async () => {
    const gc = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-WRONGCLASS-GC",
        groupDescription: "x",
        accountClass: "ASSET",
        reportSection: "REVENUE",
        status: "ACTIVE",
      });
    expect(gc.status).toBe(400);
    expect(gc.body.message).toMatch(/not valid for account class ASSET/i);
  });

  test("existing Group Codes classified against the original 11 seeded sections still load and validate on update - full backward compatibility", async () => {
    const create = await request(app)
      .post("/api/group-codes")
      .set(auth(adminToken))
      .send({
        groupCode: "RS-LEGACY-GC",
        groupDescription: "Legacy-style classification",
        accountClass: "ASSET",
        reportSection: "CURRENT_ASSET",
        status: "ACTIVE",
      });
    expect(create.status).toBe(200);
    createdGroupIds.push(create.body.id);

    const update = await request(app)
      .put(`/api/group-codes/${create.body.id}`)
      .set(auth(adminToken))
      .send({
        groupCode: "RS-LEGACY-GC",
        groupDescription: "Legacy-style classification, edited",
        accountClass: "ASSET",
        reportSection: "CURRENT_ASSET",
        status: "ACTIVE",
      });
    expect(update.status).toBe(200);

    const list = await request(app).get("/api/group-codes").set(auth(adminToken));
    const row = list.body.find((r) => r.groupCode === "RS-LEGACY-GC");
    expect(row.reportSection).toBe("CURRENT_ASSET");
    expect(row.groupDescription).toBe("Legacy-style classification, edited");
  });
});

// Strips `//` line comments before matching - the point of these two tests
// is "no query/code touches these tables", and this file's OWN explanatory
// comments legitimately name those same tables in prose (e.g. "no DB FK -
// consistent with how ... coa_groups ... already works") to explain why
// they're NOT queried. A bare word-match would flag its own documentation;
// stripping comments first checks only actual code, same fix pattern used
// throughout the L.x Books-of-Accounts phases for this exact class of bug.
function stripLineComments(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("read-only with respect to everything outside report_sections/account_group_codes.report_section", () => {
  test("the report-sections routes never touch chart_of_accounts, coa_groups, or any transaction table", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf("// ===================== REPORT SECTIONS API (Phase M.1) =====================");
    const end = serverSrc.indexOf("app.get(\"/api/arap-beginning-balances", start);
    const block = stripLineComments(serverSrc.slice(start, end));
    expect(block).not.toMatch(/chart_of_accounts|coa_groups|apv_|cv_|jv_|invoice_|or_|petty_cash_|memo_/i);
  });

  test("reportSectionService.js never queries any transaction/ledger table", () => {
    const src = stripLineComments(fs.readFileSync(path.join(__dirname, "../services/reportSectionService.js"), "utf8"));
    expect(src).not.toMatch(/chart_of_accounts|coa_groups|apv_|cv_|jv_|invoice_|or_|petty_cash_|memo_/i);
  });
});
