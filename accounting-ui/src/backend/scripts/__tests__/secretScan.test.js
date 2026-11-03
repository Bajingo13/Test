// SEC-1/2/3: the secret scanner finds and masks real-looking values, the
// repository stays clean, .gitignore covers secret-bearing files without
// hiding legitimate ones, and generateHash.js never holds or prints a password.
// Fake keys are built by concatenation so this file doesn't trigger the scanner.

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const bcrypt = require("bcryptjs");
const { mask, isSensitiveFile, scanLine, scanText, scanTree } = require("../secretScan");

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname, encoding: "utf8" }).trim();
const fill = (n) => "aB3dE6gH9k".repeat(Math.ceil(n / 10)).slice(0, n);

describe("value rules", () => {
  test.each([
    ["anthropic-key", `sk-${"ant-"}${fill(40)}`],
    ["openai-key", `sk-${fill(40)}`],
    ["google-key", `AI${"za"}${fill(35)}`],
    ["github-token", `gh${"p_"}${fill(36)}`],
    ["aws-access-key", `AK${"IA"}ABCDEFGHIJKLMNOP`],
    ["jwt", `ey${"J"}${fill(20)}.ey${"J"}${fill(20)}.${fill(20)}`],
    ["private-key", `-----BEGIN RSA ${"PRIVATE KEY"}-----`],
  ])("%s is found", (rule, value) => {
    expect(scanLine("src/config.js", `const v = "${value}";`).map((f) => f.rule)).toContain(rule);
  });

  test("findings never contain the secret", () => {
    const key = `sk-${"ant-"}${fill(40)}`;
    const [finding] = scanText("src/config.js", `\nconst v = "${key}";`);
    expect(finding.line).toBe(2);
    expect(JSON.stringify(finding)).not.toContain(key);
    expect(mask("abcdef")).toBe("ab****(len 6)");
  });

  test("hardcoded credentials are found in source, not in tests or placeholders", () => {
    const line = `  ${"password"}: "Str0ngValue!",`;
    expect(scanLine("src/backend/db.js", line).map((f) => f.rule)).toEqual(["hardcoded-credential"]);
    expect(scanLine("src/backend/__tests__/a.test.js", line)).toEqual([]);
    expect(scanLine("src/backend/db.js", `  ${"password"}: "changeme",`)).toEqual([]);
    expect(scanLine("src/backend/db.js", `  ${"password"}: process.env.MYSQL_PASSWORD,`)).toEqual([]);
  });

  test("a password in a connection URL is found unless it is a placeholder", () => {
    expect(scanLine("x.js", `mysql://root:Str0ngValue${"@"}db.host:3306/app`).map((f) => f.rule)).toEqual(["connection-url-password"]);
    expect(scanLine("x.js", `mysql://root:x${"@"}127.0.0.1:3306/app`)).toEqual([]);
    expect(scanLine("x.js", `mysql://USER:PASSWORD${"@"}127.0.0.1:3306/app`)).toEqual([]);
  });

  test("env files: filled-in secrets are found, blank and test-only values are not", () => {
    expect(scanLine("backend/.env.example", `${"API_KEY"}=Str0ngValue`).map((f) => f.rule)).toEqual(["env-secret-value"]);
    expect(scanLine("backend/.env.example", `${"JWT_SECRET"}=`)).toEqual([]);
    expect(scanLine("backend/.env.test.example", `${"JWT_SECRET"}=test-only-secret-not-for-production`)).toEqual([]);
  });

  test("a secret-named VITE_ variable is found, since the browser receives it", () => {
    expect(scanLine("accounting-ui/.env.production", `${"VITE_"}API_KEY=abc`).map((f) => f.rule)).toContain("frontend-secret-variable");
    expect(scanLine("accounting-ui/.env.production", `${"VITE_"}API_URL=http://localhost:8080`)).toEqual([]);
  });
});

describe("sensitive files", () => {
  test.each([".env", "a/b/.env.production", "x.pem", "a/server.key", "cert.p12", "gcp-credentials.json", "service-account.json", "id_rsa"])("%s is refused", (file) => {
    expect(isSensitiveFile(file)).toBe(true);
  });

  test.each([".env.example", "accounting-ui/src/backend/.env.test.example", "accounting-ui/.env.development", "accounting-ui/.env.production", "package.json", "keys.js"])("%s is allowed", (file) => {
    expect(isSensitiveFile(file)).toBe(false);
  });
});

describe("the repository", () => {
  test("no tracked or untracked (non-ignored) file holds a secret", () => {
    expect(scanTree(ROOT)).toEqual([]);
  });

  const ignored = (file) => spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: ROOT }).status === 0;

  test.each([
    ".env",
    "accounting-ui/.env",
    "accounting-ui/.env.local",
    "accounting-ui/src/.env.production.local",
    "accounting-ui/src/backend/.env",
    "accounting-ui/src/backend/.env.test.local",
    "server.pem",
    "accounting-ui/src/backend/private.key",
    "cert.p12",
    "gcp-credentials.json",
    "service-account.json",
    "backup.sql.gz",
    "accounting-ui/prod_dump.sql",
    "local.sqlite",
  ])(".gitignore covers %s", (file) => {
    expect(ignored(file)).toBe(true);
  });

  test.each([
    "accounting-ui/.env.development",
    "accounting-ui/.env.production",
    "accounting-ui/src/backend/.env.example",
    "accounting-ui/src/backend/.env.test.example",
    "accounting-ui/src/backend/.env.development.example",
    "r10_deposit_slips_migration.sql",
    "accounting-ui/src/backend/migrations/r10_deposit_slips_migration.sql",
  ])(".gitignore leaves %s alone", (file) => {
    expect(ignored(file)).toBe(false);
  });

  test("no tracked file is hidden by .gitignore", () => {
    const hidden = execFileSync("git", ["ls-files", "-ci", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
    expect(hidden.trim()).toBe("");
  });
});

describe("generateHash.js", () => {
  const SCRIPT = path.join(__dirname, "..", "..", "generateHash.js");
  const FAKE = "fake-only-for-this-test";
  const run = (options) => spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", ...options });
  const hashOf = (stdout) => stdout.replace("Hash:", "").trim();

  test("hashes a password from the environment without printing it", async () => {
    const r = run({ env: { ...process.env, GENERATE_HASH_PASSWORD: FAKE }, input: "" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(FAKE);
    expect(await bcrypt.compare(FAKE, hashOf(r.stdout))).toBe(true);
  });

  test("hashes a piped password without printing it", async () => {
    const env = { ...process.env };
    delete env.GENERATE_HASH_PASSWORD;
    const r = run({ env, input: `${FAKE}\n` });
    expect(r.stdout + r.stderr).not.toContain(FAKE);
    expect(await bcrypt.compare(FAKE, hashOf(r.stdout))).toBe(true);
  });

  test("refuses an empty password", () => {
    const env = { ...process.env };
    delete env.GENERATE_HASH_PASSWORD;
    const r = run({ env, input: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});
