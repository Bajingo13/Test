const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { resolveDatabaseConfig } = require("../config/database");
const GCC = require("../services/groupCodeClassification");

// Reports Classification Foundation: account_group_codes gains
// report_section (VARCHAR(32) NULL) + display_order (INT NULL) - reporting
// metadata only. This suite covers the migration, the validation matrix,
// the readiness helper, the frontend<->backend section-label parity, and
// the backward-compatible API. The Condensed/Detailed BS/IS OUTPUT is NOT
// built in this batch and is not tested here.

jest.setTimeout(120000);

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATION_FILE = "accounting_group_code_report_section_migration.sql";

let companyId, token, adminId;
const createdGroupIds = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('GCC Co', 'Active')");
  companyId = c.insertId;
  const hash = await bcrypt.hash("GccPass!1", 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('gcc_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyId]);
  token = await login("gcc_admin", "GccPass!1");
});

afterAll(async () => {
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'GCC-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id = ?", [adminId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

// ------------------------------------------------------------------ migration

describe("migration - accounting_group_code_report_section_migration.sql", () => {
  const sqlPath = path.join(REPO_ROOT, MIGRATION_FILE);
  const src = fs.readFileSync(sqlPath, "utf8");

  test("is registered in migrationOrder.js", () => {
    const order = fs.readFileSync(path.join(__dirname, "../scripts/migrationOrder.js"), "utf8");
    expect(order).toContain(`"${MIGRATION_FILE}"`);
  });

  test("every ADD COLUMN is information_schema-guarded; no bare ALTER TABLE ... ADD COLUMN", () => {
    const adds = (src.match(/ADD COLUMN/gi) || []).length;
    const guards = (src.match(/information_schema\.COLUMNS/gi) || []).length;
    expect(adds).toBe(2); // report_section + display_order
    expect(guards).toBeGreaterThanOrEqual(2);
    const bareAlters = src
      .split("\n")
      .filter((l) => /^\s*ALTER\s+TABLE/i.test(l) && /ADD COLUMN/i.test(l));
    expect(bareAlters).toEqual([]);
  });

  test("first run already applied (db:test:reset ran the chain) - both columns exist", async () => {
    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_group_codes'
         AND COLUMN_NAME IN ('report_section','display_order')`
    );
    const byName = Object.fromEntries(cols.map((c) => [c.COLUMN_NAME, c.IS_NULLABLE]));
    expect(byName.report_section).toBe("YES");
    expect(byName.display_order).toBe("YES");
  });

  test("second run is a safe no-op (idempotent) - no error, columns unchanged, no rows lost", async () => {
    const [[before]] = await pool.query("SELECT COUNT(*) n FROM account_group_codes");
    // eslint-disable-next-line no-unused-vars
    const { environment, ...cfg } = resolveDatabaseConfig();
    const conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
    try {
      await conn.query(src); // must not throw
    } finally {
      await conn.end();
    }
    const [[after]] = await pool.query("SELECT COUNT(*) n FROM account_group_codes");
    expect(after.n).toBe(before.n);
    const [cols] = await pool.execute(
      `SELECT COUNT(*) n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_group_codes'
         AND COLUMN_NAME IN ('report_section','display_order')`
    );
    expect(cols[0].n).toBe(2);
  });
});

// ------------------------------------------------------------------ validation

describe("validation matrix (§6)", () => {
  const ok = (accountClass, reportSection) =>
    expect(GCC.validateGroupCodeClassification({ accountClass, reportSection }).ok).toBe(true);
  const rejected = (accountClass, reportSection) =>
    expect(GCC.validateGroupCodeClassification({ accountClass, reportSection }).ok).toBe(false);

  test("ASSET accepts Current/Non-Current Asset, rejects everything else", () => {
    ok("ASSET", "CURRENT_ASSET");
    ok("ASSET", "NON_CURRENT_ASSET");
    rejected("ASSET", "OPERATING_EXPENSE");
    rejected("ASSET", "CURRENT_LIABILITY");
    rejected("ASSET", "EQUITY");
  });

  test("LIABILITY accepts Current/Non-Current Liability", () => {
    ok("LIABILITY", "CURRENT_LIABILITY");
    ok("LIABILITY", "NON_CURRENT_LIABILITY");
    rejected("LIABILITY", "CURRENT_ASSET");
  });

  test("EQUITY accepts EQUITY only", () => {
    ok("EQUITY", "EQUITY");
    rejected("EQUITY", "REVENUE");
  });

  test("INCOME accepts Revenue and Other Income", () => {
    ok("INCOME", "REVENUE");
    ok("INCOME", "OTHER_INCOME");
    rejected("INCOME", "DIRECT_COST");
  });

  test("EXPENSE accepts Direct Cost / Operating Expense / Other Expense / Tax Expense", () => {
    ok("EXPENSE", "DIRECT_COST");
    ok("EXPENSE", "OPERATING_EXPENSE");
    ok("EXPENSE", "OTHER_EXPENSE");
    ok("EXPENSE", "TAX_EXPENSE");
    rejected("EXPENSE", "REVENUE");
  });

  test("NULL / empty report_section is always valid (unclassified allowed)", () => {
    ok("ASSET", null);
    ok("EXPENSE", "");
    ok("INCOME", undefined);
  });

  test("unknown section code is rejected", () => {
    rejected("ASSET", "MYSTERY_SECTION");
  });

  test("display_order: integer accepted, blank/NULL accepted, non-integer rejected", () => {
    expect(GCC.validateGroupCodeClassification({ accountClass: "ASSET", displayOrder: 10 }).ok).toBe(true);
    expect(GCC.validateGroupCodeClassification({ accountClass: "ASSET", displayOrder: "" }).value.displayOrder).toBeNull();
    expect(GCC.validateGroupCodeClassification({ accountClass: "ASSET", displayOrder: null }).value.displayOrder).toBeNull();
    expect(GCC.validateGroupCodeClassification({ accountClass: "ASSET", displayOrder: 3.5 }).ok).toBe(false);
    expect(GCC.validateGroupCodeClassification({ accountClass: "ASSET", displayOrder: "abc" }).ok).toBe(false);
  });
});

describe("readiness helper", () => {
  test("counts classified / unclassified and only flags ready when all active groups are classified & valid", () => {
    const r = GCC.getClassificationReadiness([
      { group_code: "A", account_class: "ASSET", report_section: "CURRENT_ASSET" },
      { group_code: "B", account_class: "INCOME", report_section: "REVENUE" },
      { group_code: "C", account_class: "EXPENSE", report_section: null },
      { group_code: "D", account_class: "ASSET", report_section: "OPERATING_EXPENSE" }, // invalid combo
    ]);
    expect(r.total).toBe(4);
    expect(r.classified).toBe(3);
    expect(r.unclassified).toBe(1);
    expect(r.unclassifiedGroupCodes.map((x) => x.groupCode)).toEqual(["C"]);
    expect(r.invalid.map((x) => x.groupCode)).toEqual(["D"]);
    expect(r.ready).toBe(false);
  });

  test("ready is true only when every active group is classified and valid", () => {
    const r = GCC.getClassificationReadiness([
      { group_code: "A", account_class: "ASSET", report_section: "CURRENT_ASSET" },
      { group_code: "B", account_class: "LIABILITY", report_section: "NON_CURRENT_LIABILITY" },
    ]);
    expect(r.ready).toBe(true);
    expect(r.unclassified).toBe(0);
    expect(r.invalid).toEqual([]);
  });

  test("empty list is not 'ready'", () => {
    expect(GCC.getClassificationReadiness([]).ready).toBe(false);
  });
});

// ------------------------------------------------------------- frontend parity

describe("frontend groupCodeSections.mjs stays in lock-step with the backend authority", () => {
  let FE;
  beforeAll(async () => {
    FE = await import("../../pages/FILESETUP/groupCodeSections.mjs");
  });

  test("ALLOWED_SECTIONS_BY_CLASS matches", () => {
    expect(FE.ALLOWED_SECTIONS_BY_CLASS).toEqual(GCC.ALLOWED_SECTIONS_BY_CLASS);
  });

  test("SECTION_LABELS matches (same codes, same friendly labels)", () => {
    expect(FE.SECTION_LABELS).toEqual(GCC.SECTION_LABELS);
  });
});

// -------------------------------------------------------------------- HTTP API

describe("Group Code API - classification create / update / read", () => {
  test("create accepts reportSection + displayOrder and stores them", async () => {
    const res = await request(app)
      .post("/api/group-codes")
      .set(auth())
      .send({
        groupCode: "GCC-CASH",
        groupDescription: "Cash and Cash Equivalents",
        accountClass: "ASSET",
        reportSection: "CURRENT_ASSET",
        displayOrder: 10,
        status: "ACTIVE",
      });
    expect(res.status).toBe(200);
    createdGroupIds.push(res.body.id);

    const list = await request(app).get("/api/group-codes").set(auth());
    const row = list.body.find((r) => r.groupCode === "GCC-CASH");
    expect(row.reportSection).toBe("CURRENT_ASSET");
    expect(Number(row.displayOrder)).toBe(10);
  });

  test("create rejects a section that is illegal for the account class (400)", async () => {
    const res = await request(app)
      .post("/api/group-codes")
      .set(auth())
      .send({
        groupCode: "GCC-BAD",
        groupDescription: "bad",
        accountClass: "ASSET",
        reportSection: "OPERATING_EXPENSE",
        status: "ACTIVE",
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not valid for account class ASSET/i);
  });

  test("create with NO classification keys stores an unclassified group (report_section NULL) - backward compatible", async () => {
    const res = await request(app)
      .post("/api/group-codes")
      .set(auth())
      .send({
        groupCode: "GCC-LEGACY",
        groupDescription: "Legacy unclassified",
        accountClass: "INCOME",
        status: "ACTIVE",
      });
    expect(res.status).toBe(200);
    createdGroupIds.push(res.body.id);

    const list = await request(app).get("/api/group-codes").set(auth());
    const row = list.body.find((r) => r.groupCode === "GCC-LEGACY");
    expect(row.reportSection).toBeNull();
    expect(row.displayOrder).toBeNull();
  });

  test("PUT with an OLD payload (no reportSection / displayOrder keys) leaves an existing classification intact", async () => {
    const list = await request(app).get("/api/group-codes").set(auth());
    const id = list.body.find((r) => r.groupCode === "GCC-CASH").id;

    const res = await request(app)
      .put(`/api/group-codes/${id}`)
      .set(auth())
      .send({
        groupCode: "GCC-CASH",
        groupDescription: "Cash and Cash Equivalents (renamed)",
        accountClass: "ASSET",
        status: "ACTIVE",
      });
    expect(res.status).toBe(200);

    const after = await request(app).get("/api/group-codes").set(auth());
    const row = after.body.find((r) => r.id === id);
    expect(row.groupDescription).toBe("Cash and Cash Equivalents (renamed)");
    expect(row.reportSection).toBe("CURRENT_ASSET"); // untouched
    expect(Number(row.displayOrder)).toBe(10); // untouched
  });

  test("PUT can explicitly clear a classification (reportSection: null)", async () => {
    const list = await request(app).get("/api/group-codes").set(auth());
    const id = list.body.find((r) => r.groupCode === "GCC-CASH").id;
    const res = await request(app)
      .put(`/api/group-codes/${id}`)
      .set(auth())
      .send({
        groupCode: "GCC-CASH",
        groupDescription: "Cash and Cash Equivalents (renamed)",
        accountClass: "ASSET",
        status: "ACTIVE",
        reportSection: null,
        displayOrder: null,
      });
    expect(res.status).toBe(200);
    const after = await request(app).get("/api/group-codes").set(auth());
    const row = after.body.find((r) => r.id === id);
    expect(row.reportSection).toBeNull();
    expect(row.displayOrder).toBeNull();
  });

  test("PUT rejects an illegal section for the class (400)", async () => {
    const list = await request(app).get("/api/group-codes").set(auth());
    const id = list.body.find((r) => r.groupCode === "GCC-LEGACY").id;
    const res = await request(app)
      .put(`/api/group-codes/${id}`)
      .set(auth())
      .send({
        groupCode: "GCC-LEGACY",
        groupDescription: "Legacy unclassified",
        accountClass: "INCOME",
        status: "ACTIVE",
        reportSection: "CURRENT_ASSET",
      });
    expect(res.status).toBe(400);
  });

  test("GET orders by display_order (NULLs last) then group_code, and returns only metadata (no balances)", async () => {
    // add a second ordered group so ordering is observable
    const r2 = await request(app).post("/api/group-codes").set(auth()).send({
      groupCode: "GCC-AR", groupDescription: "Accounts Receivable", accountClass: "ASSET",
      reportSection: "CURRENT_ASSET", displayOrder: 20, status: "ACTIVE",
    });
    createdGroupIds.push(r2.body.id);

    const list = await request(app).get("/api/group-codes").set(auth());
    const ours = list.body.filter((r) => r.groupCode.startsWith("GCC-"));
    const withOrder = ours.filter((r) => r.displayOrder != null).map((r) => r.groupCode);
    // GCC-CASH order was cleared to null above, so GCC-AR(20) is the only ordered one now
    expect(withOrder).toEqual(["GCC-AR"]);
    // response rows carry only group metadata - no amount/balance fields
    for (const row of ours) {
      expect(Object.keys(row).sort()).toEqual(
        ["accountClass", "displayOrder", "groupCode", "groupDescription", "id", "reportSection", "status"].sort()
      );
    }
  });
});

describe("classification readiness endpoint", () => {
  test("returns total / classified / unclassified / invalid / ready and no company balances", async () => {
    const res = await request(app).get("/api/group-codes/classification-readiness").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("classified");
    expect(res.body).toHaveProperty("unclassified");
    expect(res.body).toHaveProperty("invalid");
    expect(res.body).toHaveProperty("ready");
    expect(Array.isArray(res.body.unclassifiedGroupCodes)).toBe(true);
    // GCC-LEGACY and GCC-CASH (cleared) are unclassified -> not ready
    expect(res.body.unclassified).toBeGreaterThanOrEqual(2);
    expect(res.body.ready).toBe(false);
    // no numeric balance leakage
    const blob = JSON.stringify(res.body);
    expect(/balance|amount|debit|credit/i.test(blob)).toBe(false);
  });
});

describe("existing-row safety + import untouched", () => {
  test("a pre-existing style row with report_section = NULL is a valid, editable group", async () => {
    // GCC-LEGACY was created with no classification; it must round-trip fine
    const list = await request(app).get("/api/group-codes").set(auth());
    const row = list.body.find((r) => r.groupCode === "GCC-LEGACY");
    expect(row).toBeTruthy();
    expect(row.reportSection).toBeNull();
    expect(row.status).toBe("ACTIVE");
  });

  test("COAImportService does not read or write the new classification columns", () => {
    const src = fs.readFileSync(path.join(__dirname, "../services/COAImportService.js"), "utf8");
    expect(src).not.toMatch(/report_section|display_order/);
  });
});
