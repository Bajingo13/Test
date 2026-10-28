// RFP (Request for Payment) R1: schema + permission foundation.
// Applies rfp_schema_permissions_migration.sql directly (twice) against the
// local test database and checks the tables, constraints, permission
// catalog and default role grants. The full-chain re-run is covered by
// migrationChainIdempotency.test.js and the byte-identical copy by
// migrationsSync.test.js; both are also asserted narrowly here.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { resolveDatabaseConfig } = require("../config/database");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");
const PermissionService = require("../services/permissionService");

jest.setTimeout(120000);

const FILE = "rfp_schema_permissions_migration.sql";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const COPY = path.join(__dirname, "..", "migrations", FILE);
const ACTIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "SUBMIT", "APPROVE", "CONVERT", "PRINT"];
const P = "rfp-r1-";

const co = {};
const users = {};
let branchId;
let unrelatedBefore;

async function applyMigration() {
  const { environment, ...cfg } = resolveDatabaseConfig();
  const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
  try {
    await c.query(fs.readFileSync(path.join(REPO_ROOT, FILE), "utf8"));
  } finally {
    await c.end();
  }
}

// Every non-RFP permission and grant, for the "nothing unrelated changed" check.
async function unrelatedSnapshot() {
  const [perms] = await pool.query(
    "SELECT id, module_key, action, label FROM permissions WHERE module_key <> 'TRANSACTIONS.RFP' ORDER BY id"
  );
  const [grants] = await pool.query(
    `SELECT rp.role_id, rp.permission_id, rp.granted FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE p.module_key <> 'TRANSACTIONS.RFP' ORDER BY rp.role_id, rp.permission_id`
  );
  return { perms, grants };
}

async function column(table, name) {
  const [rows] = await pool.query(
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, name]
  );
  return rows[0];
}

async function grantedActions(roleCode) {
  const [rows] = await pool.query(
    `SELECT p.action FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = ? AND p.module_key = 'TRANSACTIONS.RFP' AND rp.granted = 1`,
    [roleCode]
  );
  return rows.map((r) => r.action).sort();
}

async function makeUser(tag, roleCode) {
  const hash = await bcrypt.hash("RfpR1Pass!1", 4);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  users[tag] = u.insertId;
}

async function insertRfp(companyId, rfpNo, extra = {}) {
  const [r] = await pool.execute(
    `INSERT INTO rfp_headers (company_id, branch_id, rfp_no, rfp_date, requester_user_id, converted_apv_id)
     VALUES (?, ?, ?, '2026-10-28', ?, ?)`,
    [companyId, extra.branchId ?? null, rfpNo, users.requester, extra.convertedApvId ?? null]
  );
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  unrelatedBefore = await unrelatedSnapshot();
  await applyMigration();
  await applyMigration();
  for (const tag of ["A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
  }
  const [b] = await pool.execute("INSERT INTO branches (company_id, name) VALUES (?, ?)", [co.A, `${P}Branch`]);
  branchId = b.insertId;
  await makeUser("requester", "ACCOUNTANT");
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("admin", "ADMIN");
  await makeUser("accountant", "ACCOUNTANT");
});

afterAll(async () => {
  try {
    const companies = Object.values(co);
    if (companies.length) {
      await pool.query(
        "DELETE h FROM rfp_status_history h JOIN rfp_headers r ON r.id = h.rfp_id WHERE r.company_id IN (?)",
        [companies]
      );
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
    }
    if (branchId) await pool.query("DELETE FROM branches WHERE id = ?", [branchId]);
    const userIds = Object.values(users);
    if (userIds.length) await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
  } finally {
    await pool.end();
  }
});

describe("migration file", () => {
  test("applies, and applies a second time without failure (done in beforeAll)", async () => {
    const [[{ n }]] = await pool.query(
      "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('rfp_headers', 'rfp_lines', 'rfp_status_history')"
    );
    expect(n).toBe(3);
  });

  test("both copies are byte-identical and it is registered exactly once, after its dependencies", () => {
    expect(fs.readFileSync(COPY, "utf8")).toBe(fs.readFileSync(path.join(REPO_ROOT, FILE), "utf8"));
    expect(MIGRATION_ORDER.filter((f) => f === FILE)).toHaveLength(1);
    const at = MIGRATION_ORDER.indexOf(FILE);
    for (const dep of ["user_access_control_migration.sql", "checkpoint5_accounting_period_closing_migration.sql"]) {
      expect(MIGRATION_ORDER.indexOf(dep)).toBeGreaterThanOrEqual(0);
      expect(MIGRATION_ORDER.indexOf(dep)).toBeLessThan(at);
    }
  });
});

describe("tables and columns", () => {
  test.each(["rfp_headers", "rfp_lines", "rfp_status_history"])("%s exists", async (table) => {
    const [rows] = await pool.query(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [table]
    );
    expect(rows).toHaveLength(1);
  });

  test("company_id is NOT NULL; branch_id and converted_apv_id are nullable", async () => {
    expect((await column("rfp_headers", "company_id")).IS_NULLABLE).toBe("NO");
    expect((await column("rfp_headers", "branch_id")).IS_NULLABLE).toBe("YES");
    expect((await column("rfp_headers", "converted_apv_id")).IS_NULLABLE).toBe("YES");
    await expect(
      pool.execute("INSERT INTO rfp_headers (company_id, rfp_no, rfp_date, requester_user_id) VALUES (NULL, ?, '2026-10-28', ?)", [`${P}null`, users.requester])
    ).rejects.toThrow();
  });

  test("an RFP without a branch is accepted; status defaults to DRAFT", async () => {
    const id = await insertRfp(co.A, `${P}NOBRANCH`);
    const [[row]] = await pool.query("SELECT branch_id, status FROM rfp_headers WHERE id = ?", [id]);
    expect(row).toEqual({ branch_id: null, status: "DRAFT" });
  });

  test("no PAID / CLOSED status or payment columns are stored on the RFP", async () => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rfp_headers'"
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    expect(names.filter((n) => /paid|payment_status|balance/i.test(n))).toEqual([]);
  });
});

describe("constraints", () => {
  test("company + RFP number is unique; the same number in another company is allowed", async () => {
    await insertRfp(co.A, `${P}0001`);
    await expect(insertRfp(co.A, `${P}0001`)).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await expect(insertRfp(co.B, `${P}0001`)).resolves.toBeGreaterThan(0);
  });

  test("converted_apv_id is unique, while many unconverted RFPs (NULL) coexist", async () => {
    await insertRfp(co.A, `${P}CONV1`, { convertedApvId: 2147480001 });
    await expect(insertRfp(co.B, `${P}CONV2`, { convertedApvId: 2147480001 })).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await insertRfp(co.A, `${P}NULL1`);
    await expect(insertRfp(co.A, `${P}NULL2`)).resolves.toBeGreaterThan(0);
  });

  test("company FK: an unknown company is rejected", async () => {
    await expect(insertRfp(2147480002, `${P}NOCO`)).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  });

  test("company deletion is restricted while RFPs exist", async () => {
    await expect(pool.execute("DELETE FROM companies WHERE id = ?", [co.B])).rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
  });

  test("branch FK: a known branch is accepted, an unknown branch rejected", async () => {
    await expect(insertRfp(co.A, `${P}BR1`, { branchId })).resolves.toBeGreaterThan(0);
    await expect(insertRfp(co.A, `${P}BR2`, { branchId: 2147480003 })).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  });

  test("requester FK: an unknown user is rejected", async () => {
    await expect(
      pool.execute("INSERT INTO rfp_headers (company_id, rfp_no, rfp_date, requester_user_id) VALUES (?, ?, '2026-10-28', 2147480004)", [co.A, `${P}NOUSER`])
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  });

  test("RFP lines require a valid RFP and are removed with their RFP", async () => {
    await expect(
      pool.execute("INSERT INTO rfp_lines (rfp_id, description, gross_amount) VALUES (2147480005, 'x', 1)")
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    const id = await insertRfp(co.A, `${P}LINES`);
    await pool.execute("INSERT INTO rfp_lines (rfp_id, description, gross_amount, vat_treatment) VALUES (?, 'Line', 1234.56, 'STANDARD')", [id]);
    const [[line]] = await pool.query("SELECT gross_amount FROM rfp_lines WHERE rfp_id = ?", [id]);
    expect(line.gross_amount).toBe("1234.56");
    await pool.execute("DELETE FROM rfp_headers WHERE id = ?", [id]);
    const [left] = await pool.query("SELECT id FROM rfp_lines WHERE rfp_id = ?", [id]);
    expect(left).toEqual([]);
  });

  test("status history requires a valid RFP, and an RFP with history cannot be hard-deleted", async () => {
    await expect(
      pool.execute("INSERT INTO rfp_status_history (rfp_id, new_status, action) VALUES (2147480006, 'SUBMITTED', 'SUBMIT')")
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    const id = await insertRfp(co.A, `${P}HIST`);
    await pool.execute(
      "INSERT INTO rfp_status_history (rfp_id, previous_status, new_status, action, user_id) VALUES (?, 'DRAFT', 'SUBMITTED', 'SUBMIT', ?)",
      [id, users.requester]
    );
    await expect(pool.execute("DELETE FROM rfp_headers WHERE id = ?", [id])).rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
  });
});

describe("permissions and default grants", () => {
  test("all eight TRANSACTIONS.RFP permissions exist exactly once", async () => {
    const [rows] = await pool.query("SELECT action FROM permissions WHERE module_key = 'TRANSACTIONS.RFP'");
    expect(rows.map((r) => r.action).sort()).toEqual([...ACTIONS].sort());
  });

  test("ADMIN receives all eight", async () => {
    expect(await grantedActions("ADMIN")).toEqual([...ACTIONS].sort());
  });

  test("ACCOUNTANT receives all except APPROVE", async () => {
    expect(await grantedActions("ACCOUNTANT")).toEqual(ACTIONS.filter((a) => a !== "APPROVE").sort());
  });

  test("SUPER_ADMIN has no seeded rows and is allowed everything through the PermissionService bypass", async () => {
    expect(await grantedActions("SUPER_ADMIN")).toEqual([]);
    for (const action of ACTIONS) {
      expect(await PermissionService.can(users.super, "TRANSACTIONS.RFP", action)).toBe(true);
    }
  });

  test("PermissionService resolves the defaults for Admin and Accountant users", async () => {
    for (const action of ACTIONS) {
      expect(await PermissionService.can(users.admin, "TRANSACTIONS.RFP", action)).toBe(true);
      expect(await PermissionService.can(users.accountant, "TRANSACTIONS.RFP", action)).toBe(action !== "APPROVE");
    }
  });

  describe("ACCOUNTANT APPROVE default row", () => {
    const accountantApprove = async () => {
      const [rows] = await pool.query(
        `SELECT rp.granted FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id AND r.code = 'ACCOUNTANT'
         JOIN permissions p ON p.id = rp.permission_id AND p.module_key = 'TRANSACTIONS.RFP' AND p.action = 'APPROVE'`
      );
      return rows.map((r) => r.granted);
    };
    const setAccountantApprove = (granted) =>
      pool.query(
        `UPDATE role_permissions rp
         JOIN roles r ON r.id = rp.role_id AND r.code = 'ACCOUNTANT'
         JOIN permissions p ON p.id = rp.permission_id AND p.module_key = 'TRANSACTIONS.RFP' AND p.action = 'APPROVE'
         SET rp.granted = ?`,
        [granted]
      );

    afterAll(() => setAccountantApprove(0));

    test("exists as an explicit granted = 0 row", async () => {
      expect(await accountantApprove()).toEqual([0]);
    });

    test("the TRANSACTIONS.% catch-all's INSERT IGNORE cannot grant it on a chain re-run", async () => {
      // What user_access_control_migration.sql's ACCOUNTANT catch-all runs
      // when migrate.js re-runs the whole chain.
      await pool.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id, granted)
         SELECT r.id, p.id, 1 FROM roles r
         JOIN permissions p ON p.module_key = 'TRANSACTIONS.RFP' AND p.action = 'APPROVE'
         WHERE r.code = 'ACCOUNTANT'`
      );
      expect(await accountantApprove()).toEqual([0]);
    });

    test("a re-run keeps an administrator's decision: 1 stays 1, 0 stays 0", async () => {
      await setAccountantApprove(1);
      await applyMigration();
      expect(await accountantApprove()).toEqual([1]);
      expect(await PermissionService.can(users.accountant, "TRANSACTIONS.RFP", "APPROVE")).toBe(true);

      await setAccountantApprove(0);
      await applyMigration();
      expect(await accountantApprove()).toEqual([0]);
      expect(await PermissionService.can(users.accountant, "TRANSACTIONS.RFP", "APPROVE")).toBe(false);
      expect(await grantedActions("ADMIN")).toContain("APPROVE");
    });
  });

  test("no unrelated permission or grant was modified", async () => {
    expect(await unrelatedSnapshot()).toEqual(unrelatedBefore);
  });
});
