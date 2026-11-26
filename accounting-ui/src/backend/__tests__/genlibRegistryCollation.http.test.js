// General Libraries code registry - collation safety.
// Live databases can have utf8mb4_general_ci columns under a utf8mb4_0900_ai_ci
// database default. A trigger's local variables take the DATABASE default, so
// a type comparison between a variable and a column would fail every insert
// ("Illegal mix of collations ... '<>'"). The migration must (1) create the
// registry columns with the LIVE columns' charset / collation and (2) compare
// party types in one explicit collation. Local test database only.
const fs = require("fs");
const path = require("path");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

const MIGRATION = path.join(__dirname, "../migrations/genlib_code_registry_migration.sql");
const sql = fs.readFileSync(MIGRATION, "utf8");

afterAll(async () => {
  await pool.end();
});

describe("genlib_code_registry_migration.sql - source", () => {
  test("registry columns copy general_libraries.code AND party_type charset / collation (create and existing table)", () => {
    expect(sql).toMatch(/SET @pco = \(SELECT COLLATION_NAME FROM information_schema\.COLUMNS WHERE[^;]*COLUMN_NAME = 'party_type'\)/);
    expect(sql).toContain("' branch_party_type VARCHAR(50) CHARACTER SET ', @pcs, ' COLLATE ', @pco, ' NULL,'");
    expect(sql).toContain("' MODIFY code VARCHAR(50) CHARACTER SET ', @cs, ' COLLATE ', @co, ' NOT NULL,'");
    expect(sql).toContain("' MODIFY branch_party_type VARCHAR(50) CHARACTER SET ', @pcs, ' COLLATE ', @pco, ' NULL'");
  });
  test("every party-type comparison in the triggers uses one explicit collation (never a bare variable vs column)", () => {
    expect(sql).not.toMatch(/UPPER\(v_type\) <> UPPER\(NEW\.party_type\)/);
    expect(sql).not.toMatch(/UPPER\(OLD\.party_type\) <> UPPER\(NEW\.party_type\)/);
    expect((sql.match(/COLLATE utf8mb4_bin <> CONVERT\(UPPER\(NEW\.party_type\) USING utf8mb4\) COLLATE utf8mb4_bin/g) || []).length).toBe(3);
  });
});

describe("migrated test database", () => {
  beforeAll(() => assertNotProductionDatabase());
  test("registry column collations equal the live general_libraries columns", async () => {
    const [rows] = await pool.query(
      `SELECT CONCAT(table_name, '.', column_name) AS col, collation_name AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND ((table_name = 'general_libraries' AND column_name IN ('code', 'party_type'))
           OR (table_name = 'general_library_code_registry' AND column_name IN ('code', 'branch_party_type')))`
    );
    const c = Object.fromEntries(rows.map((r) => [r.col, r.c]));
    expect(c["general_library_code_registry.code"]).toBe(c["general_libraries.code"]);
    expect(c["general_library_code_registry.branch_party_type"]).toBe(c["general_libraries.party_type"]);
  });
  test("the installed triggers are the collation-safe version", async () => {
    const [rows] = await pool.query("SELECT trigger_name AS n, action_statement AS s FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table = 'general_libraries'");
    const bi = rows.find((r) => r.n === "trg_genlib_code_bi");
    const bu = rows.find((r) => r.n === "trg_genlib_code_bu");
    expect(bi && bi.s).toMatch(/utf8mb4_bin/);
    expect(bu && bu.s).toMatch(/utf8mb4_bin/);
  });
});
