// Lightweight migration runner (Infrastructure Checkpoint, section 16).
// No migration runner existed before this checkpoint - every migration
// in this repo was applied by hand via an ad-hoc one-off script. This
// replaces that with one reusable, safe, ordered runner.
//
// Usage:
//   node scripts/migrate.js            (uses NODE_ENV as already set)
//   NODE_ENV=test node scripts/migrate.js
//   NODE_ENV=development node scripts/migrate.js
// or via npm:
//   npm run db:migrate:test
//   npm run db:migrate:dev
//
// Refuses to run unless NODE_ENV is exactly "test" or "development" -
// this is stricter than resolveDatabaseConfig() alone, which only
// distinguishes "test"/"development" from "everything else = production".
// A migration runner casually usable against production is exactly what
// section 45 forbids, so here NODE_ENV=production (or unset, or anything
// else) is refused outright before resolveDatabaseConfig() is even
// called.

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");

const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === "test" || nodeEnv === "development") {
  dotenv.config({ path: path.join(__dirname, "..", `.env.${nodeEnv}.local`) });
  dotenv.config({ path: path.join(__dirname, "..", `.env.${nodeEnv}`) });
}

const { resolveDatabaseConfig, describeSafely } = require("../config/database");
const { MIGRATION_ORDER } = require("./migrationOrder");

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

async function main() {
  if (nodeEnv !== "test" && nodeEnv !== "development") {
    throw new Error(
      `Refusing to run the migration runner: NODE_ENV must be exactly "test" or "development" (got ${JSON.stringify(nodeEnv)}). ` +
        `This tool never runs against production, even accidentally. Use: NODE_ENV=test node scripts/migrate.js`
    );
  }

  const config = resolveDatabaseConfig(); // throws if misconfigured or pointed at production
  console.log("Migration target:", describeSafely(config));

  const { environment, ...connectionConfig } = config;
  const connection = await mysql.createConnection({ ...connectionConfig, multipleStatements: true });

  console.log(`Running ${MIGRATION_ORDER.length} migrations against ${environment}...\n`);

  try {
    for (const filename of MIGRATION_ORDER) {
      const filePath = path.join(REPO_ROOT, filename);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Migration file not found: ${filename} (expected at ${filePath})`);
      }
      const sql = fs.readFileSync(filePath, "utf8");
      process.stdout.write(`  ${filename} ... `);
      try {
        await connection.query(sql);
        console.log("OK");
      } catch (err) {
        console.log("FAILED");
        throw new Error(`Migration failed at ${filename}: ${err.message}`);
      }
    }
    console.log(`\nAll ${MIGRATION_ORDER.length} migrations applied successfully.`);
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nMIGRATION RUNNER ERROR:", err.message);
    process.exit(1);
  });
}

module.exports = { main };