// TEST-ONLY database reset (Infrastructure Checkpoint, section 18).
//
// Usage: NODE_ENV=test node scripts/dbTestReset.js
//     or: npm run db:test:reset
//
// Behavior: verify NODE_ENV=test -> verify the resolved connection is not
// a known production identifier -> drop every existing table in the test
// database -> re-run every migration in MIGRATION_ORDER from empty ->
// done. No separate "seed baseline data" step: the migrations themselves
// are the baseline (permission catalog rows, role grants) - anything
// beyond that is genuinely test-specific and belongs in each test file's
// own fixtures (section 20/42), not a shared seed that tests would then
// depend on and fight over.
//
// This is dev database. There is no equivalent "npm run db:dev:reset" -
// section 19 explicitly forbids a casual destructive reset for
// development data.

const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");

const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === "test") {
  dotenv.config({ path: path.join(__dirname, "..", ".env.test.local") });
  dotenv.config({ path: path.join(__dirname, "..", ".env.test") });
}

const { resolveDatabaseConfig, describeSafely, isKnownProductionHost, isKnownProductionDatabaseName } = require("../config/database");

async function main() {
  if (nodeEnv !== "test") {
    throw new Error(
      `Refusing to reset: NODE_ENV must be exactly "test" (got ${JSON.stringify(nodeEnv)}). ` +
        `This command drops every table in the target database - it must never run against development or production. ` +
        `Use: NODE_ENV=test node scripts/dbTestReset.js`
    );
  }

  const config = resolveDatabaseConfig(); // throws if TEST_DATABASE_URL missing or misconfigured
  if (isKnownProductionHost(config.host) || isKnownProductionDatabaseName(config.database)) {
    // Belt and suspenders - resolveDatabaseConfig() already checks this,
    // but a reset script that drops tables gets its own explicit,
    // impossible-to-miss second check.
    throw new Error(`Refusing to reset a database that looks like production (host: ${config.host}, database: ${config.database}).`);
  }

  console.log("Resetting test database:", describeSafely(config));

  const { environment, ...connectionConfig } = config;
  const connection = await mysql.createConnection({ ...connectionConfig, multipleStatements: true });

  try {
    const [tables] = await connection.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [config.database]
    );

    if (tables.length) {
      console.log(`Dropping ${tables.length} existing table(s)...`);
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      for (const row of tables) {
        await connection.query(`DROP TABLE IF EXISTS \`${row.TABLE_NAME}\``);
      }
      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    } else {
      console.log("Test database is already empty.");
    }
  } finally {
    await connection.end();
  }

  console.log("Rebuilding schema via the migration runner...\n");

  // Reuse the exact same runner tests would otherwise run manually - one
  // code path, not two copies of "apply every migration in order" that
  // could drift apart. require() has no effect on its own here beyond
  // loading the function - it must be awaited explicitly, since
  // migrate.js's main() is async and does not self-invoke when imported
  // (only when run directly - see its require.main === module guard).
  const { main: runMigrations } = require("./migrate");
  await runMigrations();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nTEST DB RESET ERROR:", err.message);
    process.exit(1);
  });
}

module.exports = { main };