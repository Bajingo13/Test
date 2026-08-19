// Prints exactly what database this process would connect to, for
// whatever NODE_ENV is currently set - without opening a connection.
// Infrastructure Checkpoint, section 26. Never prints a password or a
// full connection URL (config/database.js's describeSafely()).
//
// Usage:
//   node scripts/verifyEnv.js
//   NODE_ENV=test node scripts/verifyEnv.js
//   NODE_ENV=development node scripts/verifyEnv.js
// or: npm run db:verify-env

const path = require("path");
const dotenv = require("dotenv");

const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === "test" || nodeEnv === "development") {
  dotenv.config({ path: path.join(__dirname, "..", `.env.${nodeEnv}.local`) });
  dotenv.config({ path: path.join(__dirname, "..", `.env.${nodeEnv}`) });
} else {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
}

const { resolveDatabaseConfig, describeSafely } = require("../config/database");

try {
  const config = resolveDatabaseConfig();
  console.log("NODE_ENV:", JSON.stringify(nodeEnv));
  console.log("Resolved database:", describeSafely(config));
} catch (err) {
  console.log("NODE_ENV:", JSON.stringify(nodeEnv));
  console.error("Configuration error:", err.message);
  process.exit(1);
}