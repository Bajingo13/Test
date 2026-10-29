// R8.4-A - reconciliation-session integrity and opening-balance carry-forward.
//   * one company + bank account: no two sessions with overlapping periods
//     (exact duplicate / partial / contained / containing), enforced under a
//     bank-account lock, also for simultaneous requests and period edits;
//   * opening balance: CARRIED from the nearest earlier session when it is
//     finalized (its statement ending balance), otherwise MANUAL and
//     required - never another company / bank account / unfinalized session;
//   * provenance is stored and shown; carried balances cannot be edited;
//   * R8.3 carry-forward keeps working across the carried period.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");
const { resolveDatabaseConfig } = require("../config/database");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "r84-";
const PW = "R84Pass!1";
const MIGRATION = "r84_bank_recon_opening_balance_migration.sql";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const co = {};
const cur = {};
const acct = {};
const bank = {};
const tok = {};
const users = {};
const s = {};
const doc = {};

const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];
const api = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
async function ai(who, action, ...args) {
  try {
    return { status: 200, body: await AgentActions.runAs(users[who], () => AgentActions[action](...args)) };
  } catch (err) {
    return { status: err.statusCode || 500, body: { message: err.message, code: err.code } };
  }
}
async function makeUser(tag, roleCode, companyIds = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id, `${P}${tag}@example.test`]);
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = { id: u.insertId, roleCode };
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}`);
  tok[tag] = res.body.token;
}
const create = (who, body) => api(who, "post", "/api/bank-recon/sessions", body);
const body = (bankKey, start, end, extra = {}) => ({ bankAccountId: bank[bankKey], periodStart: start, periodEnd: end, ...extra });
const opening = (who, params) => api(who, "get", `/api/bank-recon/sessions/opening-balance?${new URLSearchParams(params)}`);
const sessionRow = async (who, id) => (await api(who, "get", `/api/bank-recon/sessions/${id}`)).body;
const finalize = (who, id) => api(who, "post", `/api/bank-recon/sessions/${id}/finalize`, { overrideReason: "test" });
const countSessions = async (companyId, bankId) =>
  (await one("SELECT COUNT(*) n FROM bank_recon_sessions WHERE company_id = ? AND bank_account_id = ?", [companyId, bankId])).n;

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["BANK", "R84 Cash in Bank", "ASSET"], ["BANK2", "R84 Cash in Bank 2", "ASSET"], ["BANK3", "R84 Cash in Bank 3", "ASSET"], ["EXP", "R84 Expense", "EXPENSE"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  for (const [k, coa] of [["BK", "BANK"], ["BK2", "BANK2"], ["BK3", "BANK3"]]) {
    bank[k] = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R84', ?, ?, 'ACTIVE')",
      [`${P}${k}`, `R84 ${k}`, `000-${k}`, acct[coa].id, acct[coa].code])).insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users).map((u) => u.id);
    const ids = (await q("SELECT id FROM bank_recon_sessions WHERE company_id IN (?) ORDER BY id DESC", [cos])).map((r) => r.id);
    if (ids.length) {
      for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
        await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [ids]);
      }
      await pool.query("UPDATE bank_recon_sessions SET opening_balance_source_session_id = NULL WHERE id IN (?)", [ids]);
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [ids]);
    }
    const cvs = (await q("SELECT id FROM cv_headers WHERE company_id IN (?)", [cos])).map((r) => r.id);
    if (cvs.length) await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'CV' AND applied_id IN (?)", [cvs]);
    for (const t of ["cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [Object.values(bank)]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("session overlap", () => {
  beforeAll(async () => {
    const res = await create("acctA", body("BK", "2095-01-01", "2095-01-31", { statementBeginningBalance: 0 }));
    expect(res.status).toBe(200);
    s.janA = res.body.id;
  });

  test("1. exact duplicate session -> 409 SESSION_DUPLICATE naming the existing session", async () => {
    const res = await create("acctA", body("BK", "2095-01-01", "2095-01-31", { statementBeginningBalance: 0 }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SESSION_DUPLICATE", conflictingSessionId: s.janA });
  });

  test.each([
    ["2. partial overlap", "2095-01-15", "2095-02-14"],
    ["3. fully contained period", "2095-01-10", "2095-01-20"],
    ["4. containing period", "2094-12-15", "2095-02-15"],
    ["single shared day", "2095-01-31", "2095-02-10"],
  ])("%s -> 409 SESSION_OVERLAP, nothing created", async (_n, start, end) => {
    const before = await countSessions(co.A, bank.BK);
    const res = await create("acctA", body("BK", start, end, { statementBeginningBalance: 0 }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SESSION_OVERLAP", conflictingSessionId: s.janA });
    expect(await countSessions(co.A, bank.BK)).toBe(before);
  });

  test("5/11. adjacent February is allowed; January is not finalized, so February needs a manual opening balance", async () => {
    const noBalance = await create("acctA", body("BK", "2095-02-01", "2095-02-28"));
    expect(noBalance.status).toBe(400);
    expect(noBalance.body).toMatchObject({ code: "OPENING_BALANCE_REQUIRED", opening: { reason: "PREVIOUS_NOT_FINALIZED", previousSession: { id: s.janA } } });
    const res = await create("acctA", body("BK", "2095-02-01", "2095-02-28", { statementBeginningBalance: 123.45 }));
    expect(res.status).toBe(200);
    s.febA = res.body.id;
    expect(res.body.opening).toMatchObject({ source: "MANUAL", amount: 123.45 });
  });

  test("6. a different bank account of the same company is allowed", async () => {
    const res = await create("acctA", body("BK2", "2095-01-01", "2095-01-31", { statementBeginningBalance: 1000, statementEndingBalance: 1500 }));
    expect(res.status).toBe(200);
    s.janA2 = res.body.id;
  });

  test("7. another company on the same bank account is allowed (and isolated)", async () => {
    const res = await create("acctB", body("BK", "2095-01-01", "2095-01-31", { statementBeginningBalance: 50, statementEndingBalance: 9999 }));
    expect(res.status).toBe(200);
    s.janB = res.body.id;
  });

  test("8. two simultaneous creations of the same period: exactly one succeeds", async () => {
    const reqBody = body("BK", "2095-03-01", "2095-03-31", { statementBeginningBalance: 0 });
    const results = await Promise.all([create("acctA", reqBody), create("acctA", reqBody)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await one("SELECT COUNT(*) n FROM bank_recon_sessions WHERE company_id = ? AND bank_account_id = ? AND period_start = '2095-03-01'", [co.A, bank.BK])).n).toBe(1);
    s.marA = results.find((r) => r.status === 200).body.id;
  });

  test("a period edit cannot create an overlap either", async () => {
    const res = await api("acctA", "patch", `/api/bank-recon/sessions/${s.febA}`, { periodStart: "2095-01-20" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_OVERLAP");
    expect((await sessionRow("acctA", s.febA)).periodStart).toBe("2095-02-01");
    // a non-overlapping edit still works
    expect((await api("acctA", "patch", `/api/bank-recon/sessions/${s.febA}`, { notes: "ok" })).status).toBe(200);
  });

  test("the assistant cannot create an overlapping session or invent an opening balance", async () => {
    const overlap = await ai("acctA", "findOrCreateSession", { bankAccountId: bank.BK, periodStart: "2095-01-10", periodEnd: "2095-02-05" });
    expect(overlap.body.code).toBe("SESSION_OVERLAP");
    const noBalance = await ai("acctA", "findOrCreateSession", { bankAccountId: bank.BK, month: 6, year: 2095 });
    expect(noBalance).toMatchObject({ status: 400, body: { code: "OPENING_BALANCE_REQUIRED" } });
    // an exact existing session is simply found
    const found = await ai("acctA", "findOrCreateSession", { bankAccountId: bank.BK, month: 1, year: 2095 });
    expect(found.body).toMatchObject({ created: false, session: { id: s.janA } });
  });
});

// ---------------------------------------------------------------------------
describe("opening balance", () => {
  test("9/16. first-ever session: opening balance required, stored and shown as MANUAL", async () => {
    const res = await opening("acctA", { bankAccountId: bank.BK3, periodStart: "2095-01-01" });
    expect(res.body).toMatchObject({ source: "MANUAL", reason: "FIRST_SESSION" });
    const row = await sessionRow("acctA", s.janA2);
    expect(row).toMatchObject({ openingBalanceSource: "MANUAL", openingBalanceSourceSessionId: null, statementBeginningBalance: "1000.00" });
  });

  test("10/15. the previous FINALIZED session's ending balance is carried, with its source", async () => {
    expect((await finalize("acctA", s.janA2)).status).toBe(200);
    const offer = await opening("acctA", { bankAccountId: bank.BK2, periodStart: "2095-02-01" });
    expect(offer.body).toMatchObject({ source: "CARRIED", amount: 1500, gapDays: 0, fromSession: { id: s.janA2, periodStart: "2095-01-01", periodEnd: "2095-01-31", endingBalance: 1500 } });
    // a different figure is refused; none (or the same) is accepted
    const wrong = await create("acctA", body("BK2", "2095-02-01", "2095-02-28", { statementBeginningBalance: 999 }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("OPENING_BALANCE_CARRIED");
    const res = await create("acctA", body("BK2", "2095-02-01", "2095-02-28", { statementEndingBalance: 1700 }));
    expect(res.status).toBe(200);
    s.febA2 = res.body.id;
    const row = await sessionRow("acctA", s.febA2);
    expect(row).toMatchObject({
      statementBeginningBalance: "1500.00", openingBalanceSource: "CARRIED", openingBalanceSourceSessionId: s.janA2,
      openingSourcePeriodStart: "2095-01-01", openingSourcePeriodEnd: "2095-01-31", openingSourceEndingBalance: "1500.00",
    });
    // a carried opening balance cannot be edited
    const edit = await api("acctA", "patch", `/api/bank-recon/sessions/${s.febA2}`, { statementBeginningBalance: 1 });
    expect(edit.status).toBe(400);
    expect(edit.body.code).toBe("OPENING_BALANCE_CARRIED");
  });

  test("14. a gap between periods carries explicitly, with the gap stated", async () => {
    expect((await finalize("acctA", s.febA2)).status).toBe(200);
    const offer = await opening("acctA", { bankAccountId: bank.BK2, periodStart: "2095-05-01" });
    expect(offer.body).toMatchObject({ source: "CARRIED", amount: 1700, gapDays: 61, fromSession: { id: s.febA2 } });
    const res = await create("acctA", body("BK2", "2095-05-01", "2095-05-31"));
    expect(res.status).toBe(200);
    expect((await sessionRow("acctA", res.body.id)).openingBalanceSourceSessionId).toBe(s.febA2);
  });

  test("12. another bank account's finalized balance is never used", async () => {
    // BK's nearest earlier session (March, in progress) decides - not BK2's
    const res = await opening("acctA", { bankAccountId: bank.BK, periodStart: "2095-04-01" });
    expect(res.body).toMatchObject({ source: "MANUAL", reason: "PREVIOUS_NOT_FINALIZED", previousSession: { id: s.marA } });
  });

  test("13. another company's finalized balance is never used", async () => {
    expect((await opening("acctB", { bankAccountId: bank.BK2, periodStart: "2095-02-01" })).body).toMatchObject({ source: "MANUAL", reason: "FIRST_SESSION" });
    expect((await opening("acctB", { bankAccountId: bank.BK, periodStart: "2095-02-01" })).body)
      .toMatchObject({ source: "MANUAL", reason: "PREVIOUS_NOT_FINALIZED", previousSession: { id: s.janB } });
  });
});

// ---------------------------------------------------------------------------
describe("carry-forward across a carried period", () => {
  test("17-20. January's unpresented check carries into February, clears there; January stays historical; no duplicate rows", async () => {
    const line = (k, debit, credit) => ({ accountId: acct[k].id, accountCode: acct[k].code, accountTitle: acct[k].title, particulars: "", debit, credit });
    const cv = await api("acctA", "post", "/api/cv", {
      voucherNo: `${P}CV-1002`, payeeName: "R84", transactionDate: "2095-01-20", status: "Posted", paymentMethod: "Check",
      bankAccountId: bank.BK3, checkNo: "1002", checkDate: "2095-01-20", totalDebit: 300, totalCredit: 300,
      lines: [line("EXP", 300, 0), line("BANK3", 0, 300)],
      currency: { companyId: co.A, currencyId: cur.A, exchangeRate: 1, rateDate: "2095-01-20" },
    });
    expect(cv.status).toBe(200);
    doc.cv1002 = cv.body.id;

    const jan = await create("acctA", body("BK3", "2095-01-01", "2095-01-31", { statementBeginningBalance: 0, statementEndingBalance: 0 }));
    s.jan3 = jan.body.id;
    const janSummary = (await api("acctA", "get", `/api/bank-recon/sessions/${s.jan3}/summary`)).body;
    expect(janSummary).toMatchObject({ bookBalance: -300, outstandingChecksTotal: 300, difference: 0 });
    const linesBefore = (await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE bank_account_id = ?", [bank.BK3])).n;
    expect((await finalize("acctA", s.jan3)).status).toBe(200);
    expect((await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE bank_account_id = ?", [bank.BK3])).n).toBe(linesBefore);

    // February opens with January's ending balance and still lists the check
    const feb = await create("acctA", body("BK3", "2095-02-01", "2095-02-28", { statementEndingBalance: -300 }));
    expect(feb.status).toBe(200);
    s.feb3 = feb.body.id;
    expect(feb.body.opening).toMatchObject({ source: "CARRIED", amount: 0, fromSession: { id: s.jan3 } });
    let queue = (await api("acctA", "get", `/api/bank-recon/sessions/${s.feb3}/queue`)).body;
    expect(queue.unmatchedBook.map((t) => [t.sourceId, t.carriedForward])).toEqual([[doc.cv1002, true]]);

    const imp = await request(app).post(`/api/bank-recon/sessions/${s.feb3}/import`).set({ Authorization: `Bearer ${tok.acctA}` })
      .attach("file", Buffer.from("Date,Description,Reference,Check No,Debit,Credit\n2095-02-04,Check 1002,,1002,300.00,"), "feb.csv");
    expect(imp.status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.feb3}/run-matching`)).status).toBe(200);
    queue = (await api("acctA", "get", `/api/bank-recon/sessions/${s.feb3}/queue`)).body;
    const h = queue.highConfidence[0];
    expect(h.candidate).toMatchObject({ bookSourceId: doc.cv1002, matchLevel: "CHECK_NO" });
    expect((await api("acctA", "post", `/api/bank-recon/matches/${h.candidate.matchId}/confirm`)).status).toBe(200);

    queue = (await api("acctA", "get", `/api/bank-recon/sessions/${s.feb3}/queue`)).body;
    expect(queue.unmatchedBook).toEqual([]);
    expect((await api("acctA", "get", `/api/bank-recon/sessions/${s.feb3}/summary`)).body).toMatchObject({ bookBalance: -300, outstandingChecksTotal: 0, difference: 0 });
    // January, as of its own end, unchanged
    expect((await api("acctA", "get", `/api/bank-recon/sessions/${s.jan3}/summary`)).body).toMatchObject({ outstandingChecksTotal: 300, difference: 0 });
    expect((await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE bank_account_id = ?", [bank.BK3])).n).toBe(linesBefore + 1);
  });

  test("a finalized session cannot be modified", async () => {
    expect((await api("acctA", "patch", `/api/bank-recon/sessions/${s.jan3}`, { notes: "x" })).status).toBe(400);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.jan3}/run-matching`)).status).toBe(400);
    const imp = await request(app).post(`/api/bank-recon/sessions/${s.jan3}/import`).set({ Authorization: `Bearer ${tok.acctA}` })
      .attach("file", Buffer.from("Date,Description,Debit,Credit\n2095-01-05,Late,1.00,"), "late.csv");
    expect(imp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("security", () => {
  test("21. an unauthorized company cannot be queried or used", async () => {
    expect((await opening("acctA", { bankAccountId: bank.BK, periodStart: "2095-06-01", companyId: co.B })).status).toBe(403);
    expect((await create("acctA", body("BK", "2095-06-01", "2095-06-30", { companyId: co.B, statementBeginningBalance: 0 }))).status).toBe(403);
  });

  test("22. an unknown bank account is 404", async () => {
    expect((await opening("acctA", { bankAccountId: 999999999, periodStart: "2095-06-01" })).status).toBe(404);
    expect((await create("acctA", { bankAccountId: 999999999, periodStart: "2095-06-01", periodEnd: "2095-06-30", statementBeginningBalance: 0 })).status).toBe(404);
  });

  test.each([
    [{ bankAccountId: "abc", periodStart: "2095-06-01" }, "INVALID_BANK_ACCOUNT"],
    [{ bankAccountId: "-3", periodStart: "2095-06-01" }, "INVALID_BANK_ACCOUNT"],
    [{ bankAccountId: "1", periodStart: "2095-02-30" }, "INVALID_PERIOD"],
    [{ bankAccountId: "1", periodStart: "June 2095" }, "INVALID_PERIOD"],
  ])("23. malformed %j -> 400 %s", async (params, code) => {
    const res = await opening("acctA", params);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect((await create("acctA", { ...params, periodEnd: "2095-06-30", statementBeginningBalance: 0 })).body.code).toBe(code);
  });

  test("23b. a malformed company id is refused", async () => {
    expect((await opening("acctA", { bankAccountId: bank.BK, periodStart: "2095-06-01", companyId: "abc" })).status).toBe(400);
  });

  test("24. Super Admin needs an explicit company; with it, only that company's history counts", async () => {
    const none = await opening("super", { bankAccountId: bank.BK2, periodStart: "2095-06-01" });
    expect(none.status).toBe(400);
    expect((await create("super", body("BK2", "2095-06-01", "2095-06-30", { statementBeginningBalance: 0 }))).status).toBe(400);
    expect((await opening("super", { bankAccountId: bank.BK2, periodStart: "2095-06-01", companyId: co.B })).body).toMatchObject({ source: "MANUAL", reason: "FIRST_SESSION" });
    expect((await opening("super", { bankAccountId: bank.BK2, periodStart: "2095-06-01", companyId: co.A })).body).toMatchObject({ source: "MANUAL", reason: "PREVIOUS_NOT_FINALIZED" });
  });
});

// ---------------------------------------------------------------------------
describe("migration", () => {
  test("registered once after its prerequisites, identical copies, columns present, idempotent, existing sessions MANUAL", async () => {
    expect(MIGRATION_ORDER.filter((f) => f === MIGRATION)).toHaveLength(1);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("bank_recon_company_scope_migration.sql"));
    expect(fs.readFileSync(path.join(__dirname, "..", "migrations", MIGRATION)).equals(fs.readFileSync(path.join(REPO_ROOT, MIGRATION)))).toBe(true);
    // a session written the pre-R8.4 way (no provenance) is backfilled MANUAL on re-run
    const legacy = (await q("INSERT INTO bank_recon_sessions (company_id, bank_account_id, period_start, period_end) VALUES (?, ?, '2090-01-01', '2090-01-31')", [co.A, bank.BK3])).insertId;
    const { environment, ...cfg } = resolveDatabaseConfig();
    const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
    try {
      await c.query(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), "utf8"));
      await c.query(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), "utf8"));
    } finally {
      await c.end();
    }
    expect(await one("SELECT opening_balance_source s, opening_balance_source_session_id sid FROM bank_recon_sessions WHERE id = ?", [legacy])).toEqual({ s: "MANUAL", sid: null });
    // provenance cannot point at a session that does not exist
    await expect(q("UPDATE bank_recon_sessions SET opening_balance_source_session_id = 999999999 WHERE id = ?", [legacy]))
      .rejects.toMatchObject({ code: expect.stringMatching(/ER_NO_REFERENCED_ROW/) });
  });
});
