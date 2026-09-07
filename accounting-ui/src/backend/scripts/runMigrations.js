// Production-capable migration runner (invoked automatically at server
// startup - see server.js).
//
// This is deliberately SEPARATE from migrate.js. migrate.js is the manual
// CLI for local test/development databases and refuses to run when
// NODE_ENV is not exactly "test"/"development" (Infrastructure Checkpoint
// sections 44/45, covered by migrationSafety.test.js). That refusal is
// intentional for a *casually-invoked* CLI. This file is the opposite
// case: a controlled, idempotent, ledger-tracked runner that the deploy
// is expected to run on every boot so the schema is never behind the
// code that was just shipped.
//
// Safety rails that make auto-running acceptable here:
//   1. A `schema_migrations` ledger table - every file in MIGRATION_ORDER
//      runs at most once, ever. Re-deploys with no new migration files
//      are a no-op (one SELECT, then done).
//   2. A MySQL advisory lock (GET_LOCK) - two instances booting at once,
//      or an overlapping deploy, cannot run migrations concurrently.
//   3. First-run tolerance - the very first boot against a database that
//      predates this ledger (i.e. production) finds ~all migrations
//      already physically applied. Their "already exists / duplicate"
//      errors are expected there and are recorded as applied rather than
//      aborting the boot. Once the ledger is populated, that tolerance is
//      gone: any later migration error is fatal and stops the deploy.
//   4. SKIP_STARTUP_MIGRATIONS=1 - escape hatch to boot without touching
//      the schema (checked by the caller in server.js).
//
// The migration SQL files themselves are already idempotent by
// convention (CREATE TABLE IF NOT EXISTS / INSERT IGNORE /
// information_schema-guarded ALTER) - see DATABASE_ENVIRONMENTS.md.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const { resolveDatabaseConfig, describeSafely } = require("../config/database");
const { MIGRATION_ORDER } = require("./migrationOrder");

// The migration .sql files live at the repo root (where migrate.js reads
// them for local dev/test), but the deployed backend is not guaranteed to
// include the repo root - only the accounting-ui/ subtree is certain to
// ship. So a co-located copy under src/backend/migrations/ is the
// authoritative source here, with the repo root kept as a fallback for a
// checkout where the copy is absent. migrationsSync.test.js asserts the
// two copies are byte-identical.
const CANDIDATE_DIRS = [
  path.join(__dirname, "..", "migrations"),
  path.join(__dirname, "..", "..", "..", ".."),
];

function resolveMigrationPath(filename) {
  for (const dir of CANDIDATE_DIRS) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const LOCK_NAME = "astrea_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 120;

// MySQL error numbers that mean "this schema change is already present".
// Only tolerated on the first run (empty ledger) - see file header.
const ALREADY_APPLIED_ERRNOS = new Set([
  1050, // ER_TABLE_EXISTS_ERROR      - CREATE TABLE of an existing table
  1060, // ER_DUP_FIELDNAME           - ADD COLUMN of an existing column
  1061, // ER_DUP_KEYNAME             - ADD INDEX/KEY that already exists
  1062, // ER_DUP_ENTRY               - INSERT of a row that already exists
  1091, // ER_CANT_DROP_FIELD_OR_KEY  - DROP/CHANGE of an already-gone column/key
  1146, // ER_NO_SUCH_TABLE           - RENAME of an already-renamed table
]);

function checksum(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function runMigrations({ logger = console } = {}) {
  const config = resolveDatabaseConfig();
  logger.log("[migrate] target:", JSON.stringify(describeSafely(config)));

  const { environment, ...connectionConfig } = config;
  const connection = await mysql.createConnection({
    ...connectionConfig,
    multipleStatements: true,
  });

  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK(?, ?) AS ok", [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (!lock || lock.ok !== 1) {
      throw new Error(
        `could not acquire the '${LOCK_NAME}' advisory lock within ${LOCK_TIMEOUT_SECONDS}s - another instance may be migrating`
      );
    }

    try {
      const [ledgerRows] = await connection.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'`
      );
      const ledgerExisted = ledgerRows[0].n > 0;

      await connection.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename   VARCHAR(255) NOT NULL PRIMARY KEY,
           checksum   CHAR(64)     NOT NULL,
           applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) ENGINE=InnoDB`
      );

      const [applied] = await connection.query("SELECT filename FROM schema_migrations");
      const done = new Set(applied.map((r) => r.filename));

      const tolerateAlreadyApplied = !ledgerExisted;
      if (tolerateAlreadyApplied) {
        logger.log(
          "[migrate] no schema_migrations ledger found - first run; 'already applied' errors will be recorded, not fatal"
        );
      }

      let ranCount = 0;
      let toleratedCount = 0;

      for (const filename of MIGRATION_ORDER) {
        if (done.has(filename)) continue;

        const filePath = resolveMigrationPath(filename);
        if (!filePath) {
          throw new Error(
            `migration file missing from the deployment: ${filename} (looked in ${CANDIDATE_DIRS.join(", ")})`
          );
        }
        const sql = fs.readFileSync(filePath, "utf8");

        logger.log(`[migrate] applying ${filename} ...`);
        try {
          await connection.query(sql);
          ranCount += 1;
        } catch (err) {
          if (tolerateAlreadyApplied && ALREADY_APPLIED_ERRNOS.has(err.errno)) {
            logger.warn(
              `[migrate] ${filename}: ${err.code} (errno ${err.errno}) - already present, recording as applied`
            );
            toleratedCount += 1;
          } else {
            throw new Error(`migration failed at ${filename}: ${err.message}`);
          }
        }

        await connection.query(
          `INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE checksum = VALUES(checksum)`,
          [filename, checksum(sql)]
        );
      }

      logger.log(
        `[migrate] done - ${ranCount} applied, ${toleratedCount} already present, ` +
          `${MIGRATION_ORDER.length - ranCount - toleratedCount} previously recorded`
      );
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    }
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error("\n[migrate] RUNNER ERROR:", err.message);
    process.exit(1);
  });
}

module.exports = { runMigrations };
