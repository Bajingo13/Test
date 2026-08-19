// Infrastructure Checkpoint, section 43. Pure-logic tests for
// resolveDatabaseConfig() - deliberately do NOT require "../../db" or
// open any real connection, so this file runs safely regardless of
// whether TEST_DATABASE_URL is configured yet (unlike almost every other
// test in this repo, which is DB-driven and therefore now correctly
// refuses to run without a real test database - see
// DATABASE_ENVIRONMENTS.md). This is the one test file that must always
// be runnable, since it's what proves the safety mechanism itself works.

const { resolveDatabaseConfig, isKnownProductionHost, isKnownProductionDatabaseName } = require("../database");

const ENV_KEYS = [
  "MYSQL_URL", "MYSQLHOST", "MYSQLPORT", "MYSQLUSER", "MYSQLPASSWORD", "MYSQLDATABASE",
  "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE",
  "TEST_DATABASE_URL", "TEST_MYSQL_HOST", "TEST_MYSQL_PORT", "TEST_MYSQL_USER", "TEST_MYSQL_PASSWORD", "TEST_MYSQL_DATABASE",
  "DEV_DATABASE_URL", "DEV_MYSQL_HOST", "DEV_MYSQL_PORT", "DEV_MYSQL_USER", "DEV_MYSQL_PASSWORD", "DEV_MYSQL_DATABASE",
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("isKnownProductionHost / isKnownProductionDatabaseName", () => {
  test("recognizes the real Railway production host", () => {
    expect(isKnownProductionHost("reseau.proxy.rlwy.net")).toBe(true);
  });

  test("recognizes any *.rlwy.net host generically (Railway can reassign the specific subdomain)", () => {
    expect(isKnownProductionHost("some-other-name.rlwy.net")).toBe(true);
  });

  test("does not flag an unrelated local/dev host", () => {
    expect(isKnownProductionHost("127.0.0.1")).toBe(false);
    expect(isKnownProductionHost("localhost")).toBe(false);
    expect(isKnownProductionHost("astrea-dev-db.internal")).toBe(false);
  });

  test("recognizes the real production database name", () => {
    expect(isKnownProductionDatabaseName("accounting_system")).toBe(true);
  });

  test("does not flag a differently-named database", () => {
    expect(isKnownProductionDatabaseName("astrea_accounting_test")).toBe(false);
    expect(isKnownProductionDatabaseName("astrea_accounting_dev")).toBe(false);
  });
});

describe("resolveDatabaseConfig", () => {
  test("NODE_ENV=production selects production config from MYSQLHOST/MYSQLUSER/etc.", () => {
    process.env.MYSQLHOST = "reseau.proxy.rlwy.net";
    process.env.MYSQLPORT = "24596";
    process.env.MYSQLUSER = "root";
    process.env.MYSQLPASSWORD = "x";
    process.env.MYSQLDATABASE = "accounting_system";
    delete process.env.MYSQL_URL;

    const config = resolveDatabaseConfig("production");
    expect(config.environment).toBe("production");
    expect(config.host).toBe("reseau.proxy.rlwy.net");
    expect(config.database).toBe("accounting_system");
  });

  test("any nodeEnv other than test/development selects production config (the only safe default - see database.js's own comment)", () => {
    // Explicitly passes a value rather than relying on process.env.NODE_ENV
    // being unset, since this test suite itself always runs under
    // NODE_ENV=test (section 27) - resolveDatabaseConfig(undefined) in
    // that context would actually resolve to "test" via its own default
    // parameter reading process.env.NODE_ENV, not an unset environment.
    process.env.MYSQLHOST = "reseau.proxy.rlwy.net";
    process.env.MYSQLUSER = "root";
    process.env.MYSQLPASSWORD = "x";
    process.env.MYSQLDATABASE = "accounting_system";

    expect(resolveDatabaseConfig("").environment).toBe("production");
    expect(resolveDatabaseConfig("staging").environment).toBe("production");
  });

  test("NODE_ENV=test with TEST_DATABASE_URL set to a non-production URL selects test config", () => {
    process.env.TEST_DATABASE_URL = "mysql://root:x@127.0.0.1:3306/astrea_accounting_test";

    const config = resolveDatabaseConfig("test");
    expect(config.environment).toBe("test");
    expect(config.host).toBe("127.0.0.1");
    expect(config.database).toBe("astrea_accounting_test");
  });

  test("NODE_ENV=test with TEST_DATABASE_URL missing throws (never falls back to production vars)", () => {
    delete process.env.TEST_DATABASE_URL;
    delete process.env.TEST_MYSQL_HOST;
    process.env.MYSQLHOST = "reseau.proxy.rlwy.net"; // production vars present but must be ignored

    expect(() => resolveDatabaseConfig("test")).toThrow(/TEST_DATABASE_URL is required when NODE_ENV=test/);
  });

  test("NODE_ENV=test with TEST_DATABASE_URL pointed at the real production host throws", () => {
    process.env.TEST_DATABASE_URL = "mysql://root:x@reseau.proxy.rlwy.net:24596/accounting_system";

    expect(() => resolveDatabaseConfig("test")).toThrow(/Refusing to run test against production/);
  });

  test("NODE_ENV=test with TEST_DATABASE_URL pointed at the production database name (different host) throws", () => {
    process.env.TEST_DATABASE_URL = "mysql://root:x@some-other-host.example.com:3306/accounting_system";

    expect(() => resolveDatabaseConfig("test")).toThrow(/Refusing to run test against production/);
  });

  test("NODE_ENV=development with DEV_DATABASE_URL set to a non-production URL selects development config", () => {
    process.env.DEV_DATABASE_URL = "mysql://root:x@127.0.0.1:3306/astrea_accounting_dev";

    const config = resolveDatabaseConfig("development");
    expect(config.environment).toBe("development");
    expect(config.host).toBe("127.0.0.1");
    expect(config.database).toBe("astrea_accounting_dev");
  });

  test("NODE_ENV=development with DEV_DATABASE_URL missing throws (never silently uses production)", () => {
    delete process.env.DEV_DATABASE_URL;
    delete process.env.DEV_MYSQL_HOST;
    process.env.MYSQL_URL = "mysql://root:x@reseau.proxy.rlwy.net:24596/accounting_system";

    expect(() => resolveDatabaseConfig("development")).toThrow(/DEV_DATABASE_URL is required when NODE_ENV=development/);
  });

  test("NODE_ENV=development pointing at the known production database throws", () => {
    process.env.DEV_DATABASE_URL = "mysql://root:x@reseau.proxy.rlwy.net:24596/accounting_system";

    expect(() => resolveDatabaseConfig("development")).toThrow(/Refusing to run development against production/);
  });

  test("test/development accept individual TEST_MYSQL_*/DEV_MYSQL_* vars as an alternative to a URL", () => {
    delete process.env.TEST_DATABASE_URL;
    process.env.TEST_MYSQL_HOST = "127.0.0.1";
    process.env.TEST_MYSQL_PORT = "3306";
    process.env.TEST_MYSQL_USER = "root";
    process.env.TEST_MYSQL_DATABASE = "astrea_accounting_test";

    const config = resolveDatabaseConfig("test");
    expect(config.host).toBe("127.0.0.1");
    expect(config.database).toBe("astrea_accounting_test");
  });
});