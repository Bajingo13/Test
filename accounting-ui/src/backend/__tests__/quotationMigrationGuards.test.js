const fs = require("fs");
const path = require("path");

// Batch 8: the migration runner (scripts/migrate.js) keeps no
// applied-migrations ledger and re-runs the whole MIGRATION_ORDER on every
// invocation, so every DDL statement in a migration file MUST be
// idempotent. This suite pins that for the two quotation migrations whose
// bare `ALTER TABLE ... ADD COLUMN` used to throw ER_DUP_FIELDNAME on a
// no-reset rerun.

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const FILES = ["quotation_migration.sql", "quotation_account_migration.sql"];

describe("quotation migrations are idempotent (no bare ADD COLUMN)", () => {
  test.each(FILES)("%s: every ADD COLUMN is information_schema-guarded", (file) => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    // ignore SQL comment lines (-- ...)
    const code = sql
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

    const addColumnCount = (code.match(/ADD COLUMN/gi) || []).length;
    const guardCount = (code.match(/information_schema\.COLUMNS/gi) || []).length;
    const prepareCount = (code.match(/PREPARE\s+\w+\s+FROM/gi) || []).length;

    expect(addColumnCount).toBeGreaterThan(0);
    // one guard + one PREPARE per ADD COLUMN
    expect(guardCount).toBe(addColumnCount);
    expect(prepareCount).toBe(addColumnCount);

    // No ADD COLUMN outside an IF(@x = 0, 'ALTER ... ADD COLUMN ...', ...)
    // wrapper - i.e. no ADD COLUMN on a line that starts with ALTER TABLE.
    const bare = code
      .split("\n")
      .filter((l) => /^\s*ALTER\s+TABLE/i.test(l) && /ADD COLUMN/i.test(l));
    expect(bare).toEqual([]);
  });

  test.each(FILES)("%s: no destructive statements (DROP / MODIFY / CHANGE / DELETE / TRUNCATE)", (file) => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    expect(sql).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bMODIFY\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bCHANGE\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  test("quotation_migration.sql still creates both tables with IF NOT EXISTS", () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, "quotation_migration.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS quotation_headers/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS quotation_lines/i);
  });
});
