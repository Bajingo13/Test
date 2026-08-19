// Checkpoint 4I section 42, strengthened by the Infrastructure Checkpoint
// (safe dev/test database separation): refuse to run destructive
// integration tests against a database that identifies itself as
// production, checked two independent ways.
//
// History: this project originally had no separate local/dev/test
// database - every test file (Checkpoints 3A-4H) ran against the same
// Railway-hosted database production uses, with only a NODE_ENV check as
// a best-effort net (see the Checkpoint 4I completion report). The
// Infrastructure Checkpoint adds a real, physically separate test
// database (config/database.js's resolveDatabaseConfig()) and a second,
// stronger guard here: even if NODE_ENV is somehow not "production" but
// the resolved connection still points at the known Railway host or
// database name, this throws before any test can open that connection.

const { resolveDatabaseConfig, isKnownProductionHost, isKnownProductionDatabaseName } = require("../config/database");

function assertNotProductionDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run integration tests: NODE_ENV=production. " +
      "These tests create/delete real rows and must never run against a production deployment."
    );
  }

  // Second, independent signal: resolve what connection this process
  // would actually open, and refuse if it lands on a known production
  // identifier regardless of what NODE_ENV claims to be. This is what
  // guards against a misconfigured TEST_DATABASE_URL/DEV_DATABASE_URL
  // that was accidentally set to the production values.
  let config;
  try {
    config = resolveDatabaseConfig();
  } catch (err) {
    // resolveDatabaseConfig() throwing here means the missing-var/
    // known-host guards inside it already did their job - surface that
    // error as-is rather than masking it.
    throw err;
  }

  if (isKnownProductionHost(config.host) || isKnownProductionDatabaseName(config.database)) {
    throw new Error(
      `Refusing to run integration tests against production Railway database (host: ${config.host}, database: ${config.database}).`
    );
  }
}

module.exports = { assertNotProductionDatabase };