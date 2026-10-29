// R8.2 migration (r82_bank_statement_import_migration.sql) on a FRESH
// throwaway database: every earlier migration from MIGRATION_ORDER, then
// pre-R8.2 Bank Reconciliation data (historical cross-session duplicate,
// identical rows in one statement, a legacy no-company session, a second
// company), then the R8.2 migration - twice. The backfill must match the
// application's own fingerprint function byte for byte and must never
// invent ownership. The database is dropped afterwards.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { resolveDatabaseConfig } = require("../config/database");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");
const Parser = require("../services/bankStatementParser");

jest.setTimeout(600000);

const FILE = "r82_bank_statement_import_migration.sql";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
let cfg;
let scratch;
let c;
const ids = {};

const q = async (sql, params) => (await c.query(sql, params))[0];
const apply = (file) => c.query(read(file));

beforeAll(async () => {
  assertNotProductionDatabase();
  const { environment, ...resolved } = resolveDatabaseConfig();
  cfg = resolved;
  scratch = `${cfg.database}_r82mig_${process.pid}`;
  const admin = await mysql.createConnection({ ...cfg, database: undefined });
  await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
  await admin.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();
  c = await mysql.createConnection({ ...cfg, database: scratch, multipleStatements: true });
  for (const file of MIGRATION_ORDER) {
    if (file === FILE) break;
    await apply(file);
  }

  // ---- pre-R8.2 data ----
  ids.coA = (await q("INSERT INTO companies (name) VALUES ('Mig Co A')")).insertId;
  ids.coB = (await q("INSERT INTO companies (name) VALUES ('Mig Co B')")).insertId;
  ids.bank = (await q("INSERT INTO bank_codes (bank_code, bank_name, status) VALUES ('MIG', 'Mig Bank', 'ACTIVE')")).insertId;
  const session = async (companyId) =>
    (await q("INSERT INTO bank_recon_sessions (company_id, bank_account_id, period_start, period_end) VALUES (?, ?, '2099-01-01', '2099-01-31')", [companyId, ids.bank])).insertId;
  ids.s1 = await session(ids.coA);
  ids.s2 = await session(ids.coA); // same statement re-imported (allowed before R8.2)
  ids.s3 = await session(ids.coB);
  ids.sNull = await session(null); // legacy, unassigned
  const STATEMENT = [
    ["2099-01-05", "Check paid", "", "001234", "980.00", "0.00"],
    ["2099-01-06", "Cash deposit", "", "", "0.00", "600.00"],
    ["2099-01-06", "Cash deposit", "", "", "0.00", "600.00"], // genuine twin
    ["2099-01-07", "Zeros", "00a", "000", "1.00", "0.00"],
    ["2099-01-08", "Café ünïcode", "Ref 007", "007", "0.00", "12.34"],
  ];
  const batch = async (sessionId) => {
    const b = (await q("INSERT INTO bank_recon_import_batches (session_id, file_name, file_type, row_count) VALUES (?, 'old.csv', 'CSV', ?)", [sessionId, STATEMENT.length])).insertId;
    const lineIds = [];
    for (const [d, desc, ref, chk, debit, credit] of STATEMENT) {
      lineIds.push((await q(
        "INSERT INTO bank_recon_statement_lines (batch_id, session_id, txn_date, description, reference_no, check_no, debit, credit) VALUES (?,?,?,?,?,?,?,?)",
        [b, sessionId, d, desc, ref, chk, debit, credit]
      )).insertId);
    }
    return { batchId: b, lineIds };
  };
  ids.b1 = await batch(ids.s1);
  ids.b2 = await batch(ids.s2);
  ids.b3 = await batch(ids.s3);
  ids.b4 = await batch(ids.sNull);
  ids.expected = Parser.fingerprintRows(STATEMENT.map(([txnDate, description, referenceNo, checkNo, debit, credit]) => {
    const out = Number(debit) > 0;
    return { txnDate, description, referenceNo, checkNo, direction: out ? "OUT" : "IN", amountCents: Math.round(Number(out ? debit : credit) * 100) };
  })).map((r) => r.fingerprint);

  await apply(FILE);
});

afterAll(async () => {
  if (c) await c.end();
  if (scratch) {
    const admin = await mysql.createConnection({ ...cfg, database: undefined });
    await admin.query(`DROP DATABASE IF EXISTS \`${scratch}\``);
    await admin.end();
  }
});

const linesOf = (b) => q("SELECT id, company_id, bank_account_id, check_no_normalized ck, reference_no_normalized rf, row_fingerprint fp FROM bank_recon_statement_lines WHERE batch_id = ? ORDER BY id", [b.batchId]);

test("1. applies on a fresh database after the full earlier chain", async () => {
  const [[col]] = await c.query("SELECT IS_NULLABLE n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND COLUMN_NAME = 'bank_account_id'");
  expect(col.n).toBe("NO");
  const keys = await q("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('uq_stmt_fingerprint', 'uq_recon_session_owner') GROUP BY INDEX_NAME ORDER BY INDEX_NAME");
  expect(keys.map((k) => k.INDEX_NAME)).toEqual(["uq_recon_session_owner", "uq_stmt_fingerprint"]);
});

test("5. ownership comes from each row's own session; a legacy session stays unassigned", async () => {
  const batches = await q("SELECT session_id, company_id, bank_account_id FROM bank_recon_import_batches ORDER BY id");
  expect(batches).toEqual([
    { session_id: ids.s1, company_id: ids.coA, bank_account_id: ids.bank },
    { session_id: ids.s2, company_id: ids.coA, bank_account_id: ids.bank },
    { session_id: ids.s3, company_id: ids.coB, bank_account_id: ids.bank },
    { session_id: ids.sNull, company_id: null, bank_account_id: ids.bank },
  ]);
  for (const [b, company] of [[ids.b1, ids.coA], [ids.b2, ids.coA], [ids.b3, ids.coB], [ids.b4, null]]) {
    for (const l of await linesOf(b)) expect([l.company_id, l.bank_account_id]).toEqual([company, ids.bank]);
  }
});

test("6/8. backfilled fingerprints equal the application's; identical rows in one statement stay distinct", async () => {
  const first = await linesOf(ids.b1);
  expect(first.map((l) => l.fp)).toEqual(ids.expected);
  expect(first[1].fp).not.toBe(first[2].fp);
  // other company / legacy session: same statement, own fingerprints
  expect((await linesOf(ids.b3)).map((l) => l.fp)).toEqual(ids.expected);
  expect((await linesOf(ids.b4)).map((l) => l.fp)).toEqual(ids.expected);
});

test("historical duplicate copy in another session of the same company + bank keeps its rows but no fingerprint", async () => {
  const copy = await linesOf(ids.b2);
  expect(copy).toHaveLength(5);
  expect(copy.every((l) => l.fp === null)).toBe(true);
});

test("a legacy session given a company later: a re-run assigns its rows, releasing fingerprints the company already holds", async () => {
  await q("UPDATE bank_recon_sessions SET company_id = ? WHERE id = ?", [ids.coA, ids.sNull]);
  await apply(FILE);
  const rows = await linesOf(ids.b4);
  expect(rows.every((l) => l.company_id === ids.coA)).toBe(true);
  // the same statement is already held by company A (session 1): kept, no fingerprint
  expect(rows.every((l) => l.fp === null)).toBe(true);
  expect((await q("SELECT company_id FROM bank_recon_import_batches WHERE id = ?", [ids.b4.batchId]))[0].company_id).toBe(ids.coA);
});

test("normalized identifiers follow normalizeIdentifier()", async () => {
  const { normalizeIdentifier } = require("../services/ConfidenceScoringService");
  const first = await linesOf(ids.b1);
  expect(first.map((l) => l.ck)).toEqual(["001234", "", "", "000", "007"].map(normalizeIdentifier));
  expect(first.map((l) => l.rf)).toEqual(["", "", "", "00a", "Ref 007"].map(normalizeIdentifier));
});

test("2. re-running the migration changes nothing", async () => {
  const before = await q("SELECT * FROM bank_recon_statement_lines ORDER BY id");
  const beforeBatches = await q("SELECT * FROM bank_recon_import_batches ORDER BY id");
  await apply(FILE);
  await apply(FILE);
  expect(await q("SELECT * FROM bank_recon_statement_lines ORDER BY id")).toEqual(before);
  expect(await q("SELECT * FROM bank_recon_import_batches ORDER BY id")).toEqual(beforeBatches);
});

test("3/4. registered once, after its prerequisites; both copies identical", () => {
  expect(MIGRATION_ORDER.filter((f) => f === FILE)).toHaveLength(1);
  const at = MIGRATION_ORDER.indexOf(FILE);
  expect(at).toBeGreaterThan(MIGRATION_ORDER.indexOf("bank_reconciliation_migration.sql"));
  expect(at).toBeGreaterThan(MIGRATION_ORDER.indexOf("bank_recon_company_scope_migration.sql"));
  expect(fs.readFileSync(path.join(__dirname, "..", "migrations", FILE)).equals(fs.readFileSync(path.join(REPO_ROOT, FILE)))).toBe(true);
});

test("7. the database rejects a duplicate fingerprint for the same company + bank account", async () => {
  const [l] = await linesOf(ids.b1);
  await expect(q(
    "INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, debit, credit, row_fingerprint) VALUES (?, ?, ?, ?, '2099-01-05', 980, 0, ?)",
    [ids.b1.batchId, ids.s1, ids.coA, ids.bank, l.fp]
  )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
});

test("9. orphan or mismatched ownership cannot be stored", async () => {
  for (const [sessionId, companyId] of [[ids.s1, ids.coB], [ids.sNull + 999, ids.coA]]) {
    await expect(q(
      "INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, debit, credit) VALUES (?, ?, ?, ?, '2099-01-09', 1, 0)",
      [ids.b1.batchId, sessionId, companyId, ids.bank]
    )).rejects.toMatchObject({ code: expect.stringMatching(/ER_NO_REFERENCED_ROW/) });
  }
  await expect(q(
    "INSERT INTO bank_recon_import_batches (session_id, company_id, bank_account_id, file_name) VALUES (?, ?, ?, 'x')",
    [ids.s1, ids.coB, ids.bank]
  )).rejects.toMatchObject({ code: expect.stringMatching(/ER_NO_REFERENCED_ROW/) });
  await expect(q(
    "INSERT INTO bank_recon_import_batches (session_id, company_id, bank_account_id, file_name) VALUES (?, ?, NULL, 'x')",
    [ids.s1, ids.coA]
  )).rejects.toMatchObject({ code: "ER_BAD_NULL_ERROR" });
});

test("10. a company with reconciliations cannot be deleted (RESTRICT, repository convention); deleting a session cascades its statement", async () => {
  await expect(q("DELETE FROM companies WHERE id = ?", [ids.coB])).rejects.toMatchObject({ code: expect.stringMatching(/ER_ROW_IS_REFERENCED/) });
  await q("DELETE FROM bank_recon_sessions WHERE id = ?", [ids.s3]);
  expect(await q("SELECT id FROM bank_recon_statement_lines WHERE session_id = ?", [ids.s3])).toEqual([]);
  expect(await q("SELECT id FROM bank_recon_import_batches WHERE session_id = ?", [ids.s3])).toEqual([]);
});
