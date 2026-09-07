// The startup migration runner (runMigrations.js) reads migration SQL
// from a copy co-located under src/backend/migrations/, because the
// deployed backend is not guaranteed to include the repo root. This test
// guarantees that copy never drifts from the repo-root originals that
// migrate.js (dev/test CLI) uses.
//
// If this fails after you add or edit a migration: re-copy every file in
// MIGRATION_ORDER from the repo root into src/backend/migrations/.

const fs = require("fs");
const path = require("path");
const { MIGRATION_ORDER } = require("../migrationOrder");

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");
const COPY_DIR = path.join(__dirname, "..", "..", "migrations");

describe("src/backend/migrations/ mirrors the repo-root migration files", () => {
  test.each(MIGRATION_ORDER)("%s is present and byte-identical", (filename) => {
    const original = path.join(REPO_ROOT, filename);
    const copy = path.join(COPY_DIR, filename);

    expect(fs.existsSync(original)).toBe(true);
    expect(fs.existsSync(copy)).toBe(true);
    expect(fs.readFileSync(copy, "utf8")).toBe(fs.readFileSync(original, "utf8"));
  });

  test("the copy directory has no stale extra .sql files", () => {
    const extras = fs
      .readdirSync(COPY_DIR)
      .filter((f) => f.endsWith(".sql") && !MIGRATION_ORDER.includes(f));
    expect(extras).toEqual([]);
  });
});
