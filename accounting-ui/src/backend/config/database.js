// Centralized database configuration resolver (Infrastructure Checkpoint -
// safe dev/test database separation).
//
// One resolution point, not logic scattered across db.js,
// testDatabaseGuard.js, and ad-hoc scripts:
//
//   NODE_ENV=test        -> TEST_DATABASE_URL (or TEST_MYSQL_* vars) ONLY.
//                            Hard failure if missing, hard failure if it
//                            resolves to a known production identifier.
//   NODE_ENV=development -> DEV_DATABASE_URL (or DEV_MYSQL_* vars) ONLY.
//                            Same two hard-failure guarantees.
//   anything else (including production, and including an UNSET
//   NODE_ENV) -> production config, built byte-identically to how db.js
//   always resolved it (Railway-injected MYSQL_URL, or the MYSQLHOST/
//   MYSQL_HOST etc. fallback chain).
//
// Why an unset NODE_ENV defaults to production rather than development:
// this project has no way to confirm from here whether the deployed
// Railway service actually sets NODE_ENV=production today (no dashboard/
// CLI access - see DATABASE_ENVIRONMENTS.md). If it does not, and this
// resolver defaulted unset-NODE_ENV to "development", the next Railway
// deploy would silently try to connect using DEV_DATABASE_URL (which
// does not exist there) and the live app would fail to boot. Defaulting
// to production is the only choice that cannot break the currently-
// working deployment. Local development and test scripts are required to
// set NODE_ENV explicitly (npm scripts do this - see package.json).

const KNOWN_PRODUCTION_HOSTS = ["reseau.proxy.rlwy.net"];
const KNOWN_PRODUCTION_HOST_SUFFIXES = [".rlwy.net"];
const KNOWN_PRODUCTION_DATABASE_NAMES = ["accounting_system"];

function isKnownProductionHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  if (KNOWN_PRODUCTION_HOSTS.includes(h)) return true;
  return KNOWN_PRODUCTION_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

function isKnownProductionDatabaseName(database) {
  if (!database) return false;
  return KNOWN_PRODUCTION_DATABASE_NAMES.includes(String(database).toLowerCase());
}

function parseDatabaseUrl(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || undefined,
  };
}

function buildProductionConfig() {
  // Byte-identical to the original db.js logic (pre-Infrastructure-
  // Checkpoint) - Railway's production deployment must never notice this
  // refactor happened.
  const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;

  if (process.env.MYSQL_URL) {
    const parsed = parseDatabaseUrl(process.env.MYSQL_URL);
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      password: parsed.password,
      database: database || parsed.database,
      waitForConnections: true,
      connectionLimit: 10,
      environment: "production",
    };
  }

  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST,
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    environment: "production",
  };
}

// Shared by the "test" and "development" branches - same shape, same
// hard-failure rules, just a different variable prefix/label.
function buildNonProductionConfig(prefix, environment) {
  const urlVarName = `${prefix}_DATABASE_URL`;
  const urlValue = process.env[urlVarName];

  let parsed;
  if (urlValue) {
    parsed = parseDatabaseUrl(urlValue);
  } else {
    const host = process.env[`${prefix}_MYSQL_HOST`];
    const database = process.env[`${prefix}_MYSQL_DATABASE`];
    if (!host || !database) {
      throw new Error(
        `${urlVarName} is required when NODE_ENV=${environment}. Refusing to use production database. ` +
          `(Alternatively set ${prefix}_MYSQL_HOST and ${prefix}_MYSQL_DATABASE explicitly.)`
      );
    }
    parsed = {
      host,
      port: Number(process.env[`${prefix}_MYSQL_PORT`]) || 3306,
      user: process.env[`${prefix}_MYSQL_USER`],
      password: process.env[`${prefix}_MYSQL_PASSWORD`],
      database,
    };
  }

  if (isKnownProductionHost(parsed.host) || isKnownProductionDatabaseName(parsed.database)) {
    throw new Error(
      `${urlVarName} resolves to a known production database (host: ${parsed.host}, database: ${parsed.database}). ` +
        `Refusing to run ${environment} against production.`
    );
  }

  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    waitForConnections: true,
    connectionLimit: environment === "test" ? 5 : 10,
    environment,
  };
}

function resolveDatabaseConfig(nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv === "test") return buildNonProductionConfig("TEST", "test");
  if (nodeEnv === "development") return buildNonProductionConfig("DEV", "development");
  return buildProductionConfig();
}

// Section 33/34 - safe startup logging. Never returns a password or a
// full connection URL. Production additionally withholds the hostname,
// since that alone (reseau.proxy.rlwy.net) is enough to identify and
// reach the real database.
function describeSafely(config) {
  if (config.environment === "production") {
    return { environment: "production", database: "[redacted production identifier]" };
  }
  return { environment: config.environment, host: config.host, database: config.database };
}

module.exports = {
  resolveDatabaseConfig,
  describeSafely,
  isKnownProductionHost,
  isKnownProductionDatabaseName,
  KNOWN_PRODUCTION_HOSTS,
  KNOWN_PRODUCTION_HOST_SUFFIXES,
  KNOWN_PRODUCTION_DATABASE_NAMES,
};