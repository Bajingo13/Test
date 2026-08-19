// Infrastructure Checkpoint, sections 44/45. Tests only the REFUSAL
// paths of migrate.js and dbTestReset.js - the ones that throw before
// any database connection is opened. There is deliberately no positive-
// path test here ("reset against a real test DB succeeds") because a
// dedicated automated test for it would just be re-running the same
// script under a different name - `npm run db:test:reset` itself is the
// positive-path proof (see DATABASE_ENVIRONMENTS.md).
//
// Now that a real .env.test.local/.env.development.local exist on this
// machine (see "Manual steps you must perform"), the "missing
// TEST_DATABASE_URL" tests below can no longer prove their point just by
// deleting process.env vars before require() - migrate.js/dbTestReset.js
// each call dotenv.config() against the real file path at require time,
// which refills any var left unset by our delete via the TEST_MYSQL_*
// fallback vars the real file also sets. Those two tests temporarily
// rename the real file out of the way for their duration instead (see
// withHiddenEnvFile below), which exercises the real
// "nothing configured" path end to end, restored in a finally block
// even if the test itself throws.

const fs = require("fs");
const path = require("path");

const ENV_KEYS = ["NODE_ENV", "TEST_DATABASE_URL", "DEV_DATABASE_URL", "MYSQLHOST", "MYSQL_URL"];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function withHiddenEnvFile(filename, fn) {
  const backendDir = path.join(__dirname, "..", "..");
  const realPath = path.join(backendDir, filename);
  const hiddenPath = path.join(backendDir, filename + ".hidden-for-test");
  const existed = fs.existsSync(realPath);
  if (existed) fs.renameSync(realPath, hiddenPath);
  try {
    await fn();
  } finally {
    if (existed) fs.renameSync(hiddenPath, realPath);
  }
}

describe("migrate.js refuses anything but test/development", () => {
  test("NODE_ENV=production is refused before any connection is attempted", async () => {
    process.env.NODE_ENV = "production";
    const { main } = require("../migrate");
    await expect(main()).rejects.toThrow(/NODE_ENV must be exactly "test" or "development"/);
  });

  test("an unset NODE_ENV is refused", async () => {
    delete process.env.NODE_ENV;
    const { main } = require("../migrate");
    await expect(main()).rejects.toThrow(/NODE_ENV must be exactly "test" or "development"/);
  });

  test("NODE_ENV=test with no TEST_DATABASE_URL is refused (never falls back to production)", async () => {
    await withHiddenEnvFile(".env.test.local", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_DATABASE_URL;
      delete process.env.TEST_MYSQL_HOST;
      delete process.env.TEST_MYSQL_DATABASE;
      const { main } = require("../migrate");
      await expect(main()).rejects.toThrow(/TEST_DATABASE_URL is required/);
    });
  });

  test("NODE_ENV=test with TEST_DATABASE_URL pointed at production is refused", async () => {
    process.env.NODE_ENV = "test";
    process.env.TEST_DATABASE_URL = "mysql://root:x@reseau.proxy.rlwy.net:24596/accounting_system";
    const { main } = require("../migrate");
    await expect(main()).rejects.toThrow(/Refusing to run test against production/);
  });
});

describe("dbTestReset.js refuses anything but test", () => {
  test("NODE_ENV=production is refused before any table is touched", async () => {
    process.env.NODE_ENV = "production";
    const { main } = require("../dbTestReset");
    await expect(main()).rejects.toThrow(/NODE_ENV must be exactly "test"/);
  });

  test("NODE_ENV=development is refused - reset is test-only, there is no dev equivalent", async () => {
    process.env.NODE_ENV = "development";
    const { main } = require("../dbTestReset");
    await expect(main()).rejects.toThrow(/NODE_ENV must be exactly "test"/);
  });

  test("NODE_ENV=test with no TEST_DATABASE_URL is refused (missing environment marker)", async () => {
    await withHiddenEnvFile(".env.test.local", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_DATABASE_URL;
      delete process.env.TEST_MYSQL_HOST;
      delete process.env.TEST_MYSQL_DATABASE;
      const { main } = require("../dbTestReset");
      await expect(main()).rejects.toThrow(/TEST_DATABASE_URL is required/);
    });
  });

  test("NODE_ENV=test with TEST_DATABASE_URL pointed at production is refused before dropping a single table", async () => {
    process.env.NODE_ENV = "test";
    process.env.TEST_DATABASE_URL = "mysql://root:x@reseau.proxy.rlwy.net:24596/accounting_system";
    const { main } = require("../dbTestReset");
    await expect(main()).rejects.toThrow(/production/i);
  });
});