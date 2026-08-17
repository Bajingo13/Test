// Checkpoint 4I section 42: refuse to run destructive integration tests
// against a database that identifies itself as production.
//
// Honest limitation, reported rather than hidden: this project has no
// separate local/dev/test database today - every test file in this
// codebase (all of Checkpoints 3A-4H) has always run against the same
// Railway-hosted database this guard checks. There is no second,
// distinguishable "test" database to point at instead. The one real,
// standard signal available is NODE_ENV - if the actual deployed Railway
// production service sets NODE_ENV=production (the conventional Node.js
// practice, and recommended here if it doesn't already), this guard stops
// the suite cold before any fixture is created. It is a best-effort net
// based on that convention, not a guarantee of a physically separate
// database - see the Checkpoint 4I completion report.
function assertNotProductionDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run integration tests: NODE_ENV=production. " +
      "These tests create/delete real rows and must never run against a production deployment."
    );
  }
}

module.exports = { assertNotProductionDatabase };