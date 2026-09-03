const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
// require db first - it performs the NODE_ENV=test dotenv load that
// resolveDatabaseConfig() depends on (same as every other http test file,
// which get it transitively via require("../server")).
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { resolveDatabaseConfig } = require("../config/database");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");

// Batch 9 Part 2: the migrate.js runner keeps NO applied-migrations ledger
// and re-runs the entire MIGRATION_ORDER on every invocation, so every
// statement in every migration must be idempotent. `npm test` already runs
// the whole chain once from empty via db:test:reset; this suite runs it
// TWICE MORE against that already-migrated DB and proves the second and
// third runs succeed with ZERO schema/seed drift (no ER_DUP_FIELDNAME, no
// duplicate index/constraint, no duplicate permission/config seed).
//
// It does NOT drop tables - the destructive from-empty run is db:test:reset's
// job; this only exercises "re-run against a populated DB".

jest.setTimeout(300000);

let conn;

async function snapshot() {
  const [[t]] = await conn.query(
    "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
  );
  const [[c]] = await conn.query(
    "SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"
  );
  const [[i]] = await conn.query(
    "SELECT COUNT(DISTINCT TABLE_NAME, INDEX_NAME) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()"
  );
  const [[fk]] = await conn.query(
    "SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'"
  );
  const [[p]] = await conn.query("SELECT COUNT(*) n FROM permissions");
  const [[rp]] = await conn.query("SELECT COUNT(*) n FROM role_permissions");
  const [[r]] = await conn.query("SELECT COUNT(*) n FROM roles");
  const [dupCols] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COUNT(*) n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, COLUMN_NAME HAVING COUNT(*) > 1`
  );
  const [dupPerms] = await conn.query(
    `SELECT module_key, action, COUNT(*) n FROM permissions GROUP BY module_key, action HAVING COUNT(*) > 1`
  );
  const [dupRolePerms] = await conn.query(
    `SELECT role_id, permission_id, COUNT(*) n FROM role_permissions GROUP BY role_id, permission_id HAVING COUNT(*) > 1`
  );
  return {
    tables: t.n, columns: c.n, indexes: i.n, fks: fk.n,
    permissions: p.n, rolePermissions: rp.n, roles: r.n,
    dupCols, dupPerms, dupRolePerms,
  };
}

async function runChainOnce() {
  const { environment, ...cfg } = resolveDatabaseConfig();
  const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
  try {
    const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
    for (const file of MIGRATION_ORDER) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      await c.query(sql);
    }
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const { environment, ...cfg } = resolveDatabaseConfig();
  conn = await mysql.createConnection(cfg);
});

afterAll(async () => {
  if (conn) await conn.end();
});

describe("Batch 9 - full migration chain is idempotent (executed, not just inspected)", () => {
  test("cashcheck_migration.sql + the two quotation migrations are information_schema-guarded", () => {
    const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
    for (const f of ["cashcheck_migration.sql", "quotation_migration.sql", "quotation_account_migration.sql"]) {
      const code = fs
        .readFileSync(path.join(REPO_ROOT, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n");
      const adds = (code.match(/ADD COLUMN/gi) || []).length;
      const guards = (code.match(/information_schema\.COLUMNS/gi) || []).length;
      expect(adds).toBeGreaterThan(0);
      expect(guards).toBe(adds);
      expect(code.split("\n").filter((l) => /^\s*ALTER\s+TABLE/i.test(l) && /ADD COLUMN/i.test(l))).toEqual([]);
    }
  });

  test("re-running the entire chain twice against an already-migrated DB succeeds with zero drift", async () => {
    const before = await snapshot();
    expect(before.tables).toBeGreaterThan(50); // db:test:reset already migrated

    await runChainOnce(); // 2nd run
    const after2 = await snapshot();

    await runChainOnce(); // 3rd run
    const after3 = await snapshot();

    // both re-runs completed without throwing (implicit: await resolved)
    // and no schema object multiplied
    for (const s of [after2, after3]) {
      expect(s.tables).toBe(before.tables);
      expect(s.columns).toBe(before.columns);
      expect(s.indexes).toBe(before.indexes);
      expect(s.fks).toBe(before.fks);
      expect(s.dupCols).toEqual([]);
      expect(s.dupPerms).toEqual([]);
      expect(s.dupRolePerms).toEqual([]);
    }
    // INSERT IGNORE seeds do not accumulate
    expect(after3.permissions).toBe(before.permissions);
    expect(after3.rolePermissions).toBe(before.rolePermissions);
    expect(after3.roles).toBe(before.roles);
  });
});
