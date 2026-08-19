const mysql = require("mysql2/promise");
const path = require("path");
const dotenv = require("dotenv");
const { resolveDatabaseConfig, describeSafely } = require("./config/database");

// NODE_ENV-aware .env file loading (Infrastructure Checkpoint). The more
// specific "<env>.local" file is loaded first (dotenv never overrides an
// already-set process.env var), then the shared "<env>" file fills in
// anything not already set. An unset/production NODE_ENV keeps loading
// the original ".env" - unchanged from before this checkpoint, since
// Railway's deployed service has no .env file on disk at all (its vars
// are injected directly into process.env by the platform) and any local
// run with NODE_ENV unset must keep working exactly as it always has.
const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === "test" || nodeEnv === "development") {
  dotenv.config({ path: path.join(__dirname, `.env.${nodeEnv}.local`) });
  dotenv.config({ path: path.join(__dirname, `.env.${nodeEnv}`) });
} else {
  dotenv.config({ path: path.join(__dirname, ".env") });
}

const poolConfig = resolveDatabaseConfig();
const { environment, ...mysqlPoolConfig } = poolConfig;

// Section 33/34 - safe startup logging, never a password or full URL.
console.log("Database environment:", describeSafely(poolConfig));

const pool = mysql.createPool(mysqlPoolConfig);

module.exports = pool;