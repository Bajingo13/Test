// Bank Reconciliation company isolation (bank_recon_company_scope_migration.sql).
//
// Sessions are company-owned; every child (import batch, statement line,
// match, adjustment, AI conversation) is reached through its session. A user
// outside the owning company - or any non-Super-Admin for a legacy NULL
// session - gets the same 404 as an id that doesn't exist. Book items, the
// book balance and match candidates only ever contain the session company's
// documents, and an adjustment JV is posted into the session's company.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { resolveDatabaseConfig } = require("../config/database");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "brci-";
const PASSWORD = "BrciPass!1";
const ids = {};
const tokens = {};
const users = {};

async function makeUser(tag, roleCode, companyIds = []) {
  const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, hash, role.id, `${P}${tag}@example.test`]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
  users[tag] = { id: u.insertId, username: `${P}${tag}`, roleCode };
  return u.insertId;
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const api = (who, method, url, body) => {
  const r = request(app)[method](url).set(auth(who));
  return body === undefined ? r : r.send(body);
};

function csv(rows) {
  return Buffer.from(["Date,Description,Reference,Debit,Credit", ...rows].join("\n"));
}

async function importCsv(who, sessionId, rows) {
  return request(app)
    .post(`/api/bank-recon/sessions/${sessionId}/import`)
    .set(auth(who))
    .attach("file", csv(rows), "statement.csv");
}

async function firstId(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows[0]?.id;
}

async function sessionSnapshot(sessionId) {
  const [[s]] = await pool.query("SELECT status, notes, statement_ending_balance, company_id FROM bank_recon_sessions WHERE id = ?", [sessionId]);
  const [[c]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM bank_recon_import_batches WHERE session_id = ?) batchCount,
            (SELECT COUNT(*) FROM bank_recon_statement_lines WHERE session_id = ?) lineCount,
            (SELECT GROUP_CONCAT(match_status ORDER BY id) FROM bank_recon_statement_lines WHERE session_id = ?) lineStatuses,
            (SELECT GROUP_CONCAT(CONCAT(id, ':', status) ORDER BY id) FROM bank_recon_matches WHERE session_id = ?) matches,
            (SELECT GROUP_CONCAT(CONCAT(id, ':', status) ORDER BY id) FROM bank_recon_adjustments WHERE session_id = ?) adjustments`,
    [sessionId, sessionId, sessionId, sessionId, sessionId]
  );
  return { ...s, ...c };
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('BRCI Company A', 'Active')");
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('BRCI Company B', 'Active')");
  ids.coA = ca.insertId;
  ids.coB = cb.insertId;

  // Global chart of accounts + one global bank code used by BOTH companies.
  const coa = async (code, title, cls) =>
    (await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [code, title, cls]))[0].insertId;
  ids.bankGL = await coa(`${P}1010`, "BRCI Cash in Bank", "ASSET");
  ids.chargeGL = await coa(`${P}6010`, "BRCI Bank Charges", "EXPENSE");
  const [bk] = await pool.execute(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, 'BRCI Shared Bank', '000-BRCI', 'BRCI Current', ?, ?, 'ACTIVE')",
    [`${P}BK`, ids.bankGL, `${P}1010`]
  );
  ids.bank = bk.insertId;

  // Posted book documents on the same bank account, one set per company.
  const cv = async (co, no, amt, date) =>
    (await pool.execute(
      "INSERT INTO cv_headers (company_id, voucher_no, payee_name, transaction_date, check_no, total_debit, total_credit, status, bank_account_id) VALUES (?, ?, 'BRCI Payee', ?, ?, ?, ?, 'Posted', ?)",
      [co, no, date, no, amt, amt, ids.bank]
    ))[0].insertId;
  const or = async (co, no, amt, date) =>
    (await pool.execute(
      "INSERT INTO or_headers (company_id, voucher_no, customer_name, transaction_date, total_debit, total_credit, status, bank_account_id) VALUES (?, ?, 'BRCI Customer', ?, ?, ?, 'Posted', ?)",
      [co, no, date, amt, amt, ids.bank]
    ))[0].insertId;
  const jv = async (co, no, debit, date) => {
    const [h] = await pool.execute(
      "INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status) VALUES (?, ?, ?, 'BRCI JV', ?, ?, 'Posted')",
      [co, no, date, debit, debit]
    );
    await pool.execute("INSERT INTO jv_lines (jv_id, account_id, debit, credit) VALUES (?, ?, ?, 0)", [h.insertId, ids.bankGL, debit]);
    return h.insertId;
  };
  ids.cvA = await cv(ids.coA, `${P}CV-A`, 100, "2026-07-05");
  ids.orA = await or(ids.coA, `${P}OR-A`, 50, "2026-07-10");
  ids.jvA = await jv(ids.coA, `${P}JV-A`, 30, "2026-07-15");
  ids.cvB = await cv(ids.coB, `${P}CV-B`, 999, "2026-07-05");
  ids.orB = await or(ids.coB, `${P}OR-B`, 777, "2026-07-10");
  ids.jvB = await jv(ids.coB, `${P}JV-B`, 300, "2026-07-15");

  await makeUser("sa", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [ids.coA]);
  await makeUser("adminB", "ADMIN", [ids.coB]);
  await makeUser("acctA", "ACCOUNTANT", [ids.coA]);
  await makeUser("acctB", "ACCOUNTANT", [ids.coB]);
  await makeUser("adminAB", "ADMIN", [ids.coA, ids.coB]);
  // View-only reconciler: the Accountant role's CREATE is overridden to deny.
  await makeUser("viewOnly", "ACCOUNTANT", [ids.coA]);
  const [[createPerm]] = await pool.execute("SELECT id FROM permissions WHERE module_key = 'REPORTS.BANK_RECONCILIATION' AND action = 'CREATE'");
  await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'brci view-only')", [users.viewOnly.id, createPerm.id]);

  // Sessions created through the API (company from the creator's single company).
  const sessionBody = { bankAccountId: ids.bank, periodStart: "2026-07-01", periodEnd: "2026-07-31", statementBeginningBalance: 0, statementEndingBalance: 0 };
  ids.sA = (await api("adminA", "post", "/api/bank-recon/sessions", sessionBody)).body.id;
  ids.sB = (await api("adminB", "post", "/api/bank-recon/sessions", sessionBody)).body.id;
  // Legacy session from before company isolation.
  ids.sNull = (await pool.execute(
    "INSERT INTO bank_recon_sessions (bank_account_id, period_start, period_end, status) VALUES (?, '2026-07-01', '2026-07-31', 'IN_PROGRESS')",
    [ids.bank]
  ))[0].insertId;

  // Company B's reconciliation, built by its own users through the API.
  expect((await importCsv("adminB", ids.sB, ["2026-07-05,Check,BRCI-CV-B,999,0", "2026-07-31,Service charge,,5,0", "2026-07-20,Deposit,,0,123"])).status).toBe(200);
  expect((await api("adminB", "post", `/api/bank-recon/sessions/${ids.sB}/run-matching`)).status).toBe(200);
  ids.batchB = await firstId("SELECT id FROM bank_recon_import_batches WHERE session_id = ?", [ids.sB]);
  ids.lineB = await firstId("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? ORDER BY id", [ids.sB]);
  ids.lineB2 = await firstId("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = 'Deposit'", [ids.sB]);
  ids.matchB = await firstId("SELECT id FROM bank_recon_matches WHERE session_id = ? ORDER BY id", [ids.sB]);
  ids.adjB = await firstId("SELECT id FROM bank_recon_adjustments WHERE session_id = ? ORDER BY id", [ids.sB]);
  // A confirmed match (for unmatch) and an approved adjustment (for post).
  expect((await api("adminB", "post", `/api/bank-recon/matches/${ids.matchB}/confirm`)).status).toBe(200);
  expect((await api("adminB", "post", `/api/bank-recon/adjustments/${ids.adjB}/approve`, { suggestedAccountId: ids.chargeGL })).status).toBe(200);
  ids.adjB2 = (await api("adminB", "post", `/api/bank-recon/sessions/${ids.sB}/adjustments`, { statementLineId: ids.lineB2, adjustmentType: "OTHER", amount: 123 })).body.id;
});

afterAll(async () => {
  const sessionIds = [ids.sA, ids.sB, ids.sNull, ids.sBackfill1, ids.sBackfill2, ids.sBackfill3].filter(Boolean);
  const [userRows] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [`${P}%`]);
  const userIds = userRows.map((u) => u.id);
  if (sessionIds.length) {
    const [adjJvs] = await pool.query("SELECT jv_id FROM bank_recon_adjustments WHERE session_id IN (?) AND jv_id IS NOT NULL", [sessionIds]);
    for (const [type, sql] of [
      ["IMPORT_BATCH", "SELECT id FROM bank_recon_import_batches WHERE session_id IN (?)"],
      ["STATEMENT_LINE", "SELECT id FROM bank_recon_statement_lines WHERE session_id IN (?)"],
      ["MATCH", "SELECT id FROM bank_recon_matches WHERE session_id IN (?)"],
      ["ADJUSTMENT", "SELECT id FROM bank_recon_adjustments WHERE session_id IN (?)"],
    ]) {
      const [rows] = await pool.query(sql, [sessionIds]);
      if (rows.length) await pool.query("DELETE FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = ? AND entity_id IN (?)", [type, rows.map((r) => r.id)]);
    }
    await pool.query("DELETE FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'SESSION' AND entity_id IN (?)", [sessionIds]);
    await pool.query("DELETE FROM ai_recon_conversations WHERE session_id IN (?)", [sessionIds]);
    await pool.query("DELETE FROM bank_recon_adjustments WHERE session_id IN (?)", [sessionIds]);
    await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessionIds]);
    const jvIds = adjJvs.map((r) => r.jv_id);
    if (jvIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE module = 'JV' AND entity_id IN (?)", [jvIds]);
      await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds]);
    }
  }
  if (userIds.length) {
    await pool.query("DELETE FROM ai_recon_conversations WHERE created_by IN (?)", [userIds]);
    for (const t of ["user_companies", "user_branches", "user_permissions"]) await pool.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM bank_codes WHERE id = ?", [ids.bank]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [ids.coA, ids.coB]);
  await pool.end();
});

// ---------------------------------------------------------------------------
describe("session list", () => {
  test("1-2 / 23. Company A users list only Company A sessions (no B, no legacy NULL)", async () => {
    for (const who of ["adminA", "acctA"]) {
      const res = await api(who, "get", "/api/bank-recon/sessions");
      expect(res.status).toBe(200);
      const listed = res.body.map((s) => s.id);
      expect(listed).toContain(ids.sA);
      expect(listed).not.toContain(ids.sB);
      expect(listed).not.toContain(ids.sNull);
      expect(res.body.find((s) => s.id === ids.sA)).toMatchObject({ companyId: ids.coA, companyName: "BRCI Company A" });
    }
  });

  test("21-22. Super Admin lists both companies and the legacy NULL session", async () => {
    const res = await api("sa", "get", "/api/bank-recon/sessions");
    const listed = res.body.map((s) => s.id);
    expect(listed).toEqual(expect.arrayContaining([ids.sA, ids.sB, ids.sNull]));
    for (const id of [ids.sA, ids.sB, ids.sNull]) {
      expect((await api("sa", "get", `/api/bank-recon/sessions/${id}`)).status).toBe(200);
      expect((await api("sa", "get", `/api/bank-recon/sessions/${id}/summary`)).status).toBe(200);
    }
  });

  test("a user of both companies sees both", async () => {
    const listed = (await api("adminAB", "get", "/api/bank-recon/sessions")).body.map((s) => s.id);
    expect(listed).toEqual(expect.arrayContaining([ids.sA, ids.sB]));
    expect(listed).not.toContain(ids.sNull);
  });
});

// ---------------------------------------------------------------------------
describe("cross-company access is a 404 (Admin and Accountant)", () => {
  const unknown = 2147483000;
  // [label, method, url builder, body builder, kind of id for the 404 twin]
  const CASES = [
    ["3. GET B session", "get", () => `/api/bank-recon/sessions/${ids.sB}`, null, "session"],
    ["4. read B statement lines", "get", () => `/api/bank-recon/sessions/${ids.sB}/statement-lines`, null, "session"],
    ["read B import batches", "get", () => `/api/bank-recon/sessions/${ids.sB}/import-batches`, null, "session"],
    ["read B book items", "get", () => `/api/bank-recon/sessions/${ids.sB}/book-items`, null, "session"],
    ["read B outstanding items", "get", () => `/api/bank-recon/sessions/${ids.sB}/outstanding-items`, null, "session"],
    ["read B summary", "get", () => `/api/bank-recon/sessions/${ids.sB}/summary`, null, "session"],
    ["read B report", "get", () => `/api/bank-recon/sessions/${ids.sB}/report`, null, "session"],
    ["5 / 19. read B matches (candidates)", "get", () => `/api/bank-recon/statement-lines/${ids.lineB}/candidates`, null, "line"],
    ["6. read B adjustments", "get", () => `/api/bank-recon/sessions/${ids.sB}/adjustments`, null, "session"],
    ["7. read B audit log", "get", () => `/api/bank-recon/sessions/${ids.sB}/audit-log`, null, "session"],
    ["8. modify B session", "patch", () => `/api/bank-recon/sessions/${ids.sB}`, () => ({ notes: "hijacked", statementEndingBalance: 1 }), "session"],
    ["delete B import batch", "delete", () => `/api/bank-recon/import-batches/${ids.batchB}`, null, "batch"],
    ["10. run matching on B", "post", () => `/api/bank-recon/sessions/${ids.sB}/run-matching`, null, "session"],
    ["10. confirm B match", "post", () => `/api/bank-recon/matches/${ids.matchB}/confirm`, null, "match"],
    ["10. bulk-confirm B", "post", () => "/api/bank-recon/matches/bulk-confirm", () => ({ sessionId: ids.sB }), "bodySession"],
    ["10. manual match on a B line", "post", () => "/api/bank-recon/matches", () => ({ statementLineId: ids.lineB, bookSourceType: "CV", bookSourceId: ids.cvA, amount: 1 }), "bodyLine"],
    ["11. unmatch B", "delete", () => `/api/bank-recon/matches/${ids.matchB}`, null, "match"],
    ["12. ignore B line", "post", () => `/api/bank-recon/statement-lines/${ids.lineB2}/ignore`, null, "line"],
    ["13. create adjustment on B", "post", () => `/api/bank-recon/sessions/${ids.sB}/adjustments`, () => ({ statementLineId: ids.lineB2, adjustmentType: "OTHER", amount: 1 }), "session"],
    ["14. approve B adjustment", "post", () => `/api/bank-recon/adjustments/${ids.adjB2}/approve`, () => ({ suggestedAccountId: ids.chargeGL }), "adjustment"],
    ["15. reject B adjustment", "post", () => `/api/bank-recon/adjustments/${ids.adjB2}/reject`, null, "adjustment"],
    ["18. post JV for B", "post", () => `/api/bank-recon/adjustments/${ids.adjB}/post`, null, "adjustment"],
    ["16. finalize B", "post", () => `/api/bank-recon/sessions/${ids.sB}/finalize`, () => ({ overrideReason: "x" }), "session"],
    ["17. reopen B", "post", () => `/api/bank-recon/sessions/${ids.sB}/reopen`, () => ({ reason: "x" }), "session"],
  ];
  const twin = (kind) => ({
    session: `/api/bank-recon/sessions/${unknown}`,
    bodySession: `/api/bank-recon/sessions/${unknown}`,
    line: `/api/bank-recon/statement-lines/${unknown}/candidates`,
    bodyLine: `/api/bank-recon/statement-lines/${unknown}/candidates`,
    batch: null,
    match: null,
    adjustment: null,
  })[kind];

  let before;
  beforeAll(async () => {
    before = await sessionSnapshot(ids.sB);
  });

  for (const who of ["adminA", "acctA"]) {
    test.each(CASES)(`${who === "adminA" ? "Company A Admin" : "20. Company A Accountant"}: %s -> 404`, async (label, method, url, body, kind) => {
      const res = await api(who, method, url(), body ? body() : undefined);
      expect(res.status).toBe(404);
      const unknownUrl = twin(kind);
      if (unknownUrl) {
        const u = await api(who, "get", unknownUrl);
        expect(res.body).toEqual(u.body); // 30. identical to an unknown id
      }
    });
  }

  test("9. import into B is refused before the upload is read, and nothing is created", async () => {
    for (const who of ["adminA", "acctA"]) {
      const res = await importCsv(who, ids.sB, ["2026-07-02,Injected,,1,0"]);
      expect(res.status).toBe(404);
    }
  });

  test("Company B's reconciliation is untouched by every attempt above", async () => {
    expect(await sessionSnapshot(ids.sB)).toEqual(before);
    const [jvs] = await pool.query("SELECT id FROM jv_headers WHERE source_module = 'BANK_RECON' AND source_reference_id = ?", [ids.adjB]);
    expect(jvs).toHaveLength(0);
  });

  test("13b. an adjustment on an own session cannot point at another session's statement line", async () => {
    const res = await api("adminA", "post", `/api/bank-recon/sessions/${ids.sA}/adjustments`, { statementLineId: ids.lineB2, adjustmentType: "OTHER", amount: 1 });
    expect(res.status).toBe(404);
  });

  test("23. non-Super-Admins cannot open a legacy NULL-company session", async () => {
    const unknownBody = (await api("adminA", "get", `/api/bank-recon/sessions/${unknown}`)).body;
    for (const who of ["adminA", "acctA", "adminB", "adminAB"]) {
      const res = await api(who, "get", `/api/bank-recon/sessions/${ids.sNull}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknownBody);
    }
  });

  test("30. child ids: out-of-scope and unknown ids give the same 404 body", async () => {
    for (const [scoped, unknownUrl] of [
      [`/api/bank-recon/matches/${ids.matchB}/confirm`, `/api/bank-recon/matches/${unknown}/confirm`],
      [`/api/bank-recon/adjustments/${ids.adjB}/approve`, `/api/bank-recon/adjustments/${unknown}/approve`],
      [`/api/bank-recon/statement-lines/${ids.lineB}/ignore`, `/api/bank-recon/statement-lines/${unknown}/ignore`],
    ]) {
      const a = await api("adminA", "post", scoped, {});
      const b = await api("adminA", "post", unknownUrl, {});
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      expect(a.body).toEqual(b.body);
    }
    const del = await api("adminA", "delete", `/api/bank-recon/import-batches/${ids.batchB}`);
    const delUnknown = await api("adminA", "delete", `/api/bank-recon/import-batches/${unknown}`);
    expect(del.body).toEqual(delUnknown.body);
  });
});

// ---------------------------------------------------------------------------
describe("matching and balances use only the session company's documents", () => {
  test("24. book items and outstanding items contain only Company A documents", async () => {
    const items = (await api("adminA", "get", `/api/bank-recon/sessions/${ids.sA}/book-items`)).body;
    const keys = items.map((t) => `${t.sourceType}:${t.sourceId}`).sort();
    expect(keys).toEqual([`CV:${ids.cvA}`, `JV:${ids.jvA}`, `OR:${ids.orA}`].sort());
    const outstanding = (await api("adminA", "get", `/api/bank-recon/sessions/${ids.sA}/outstanding-items`)).body;
    const all = [...outstanding.outstandingChecks, ...outstanding.depositsInTransit].map((t) => t.voucherNo);
    expect(all.some((v) => String(v).endsWith("-B"))).toBe(false);
  });

  test("25. book balance per session counts only its own company", async () => {
    const a = (await api("adminA", "get", `/api/bank-recon/sessions/${ids.sA}/summary`)).body;
    expect(a.bookBalance).toBe(0 - 100 + 50 + 30);
    const b = (await api("adminB", "get", `/api/bank-recon/sessions/${ids.sB}/summary`)).body;
    expect(b.bookBalance).toBe(0 - 999 + 777 + 300);
  });

  test("matching suggestions and candidates never reference another company's document", async () => {
    expect((await importCsv("adminA", ids.sA, ["2026-07-05,Check,BRCI-CV-A,100,0", "2026-07-05,Look-alike,BRCI-CV-B,999,0", "2026-07-31,Service charge,,10,0"])).status).toBe(200);
    expect((await api("adminA", "post", `/api/bank-recon/sessions/${ids.sA}/run-matching`)).status).toBe(200);
    const [rows] = await pool.query("SELECT book_source_type t, book_source_id id FROM bank_recon_matches WHERE session_id = ?", [ids.sA]);
    const bDocs = new Set([`CV:${ids.cvB}`, `OR:${ids.orB}`, `JV:${ids.jvB}`]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => bDocs.has(`${r.t}:${r.id}`))).toBe(false);
    ids.lineA = await firstId("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = 'Check'", [ids.sA]);
    const cands = (await api("adminA", "get", `/api/bank-recon/statement-lines/${ids.lineA}/candidates`)).body;
    expect(cands.every((c) => c.bookSourceId !== ids.cvB)).toBe(true);
  });

  test("a manual match to another company's document is refused", async () => {
    const lineLookAlike = await firstId("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = 'Look-alike'", [ids.sA]);
    const res = await api("adminA", "post", "/api/bank-recon/matches", { statementLineId: lineLookAlike, bookSourceType: "CV", bookSourceId: ids.cvB, amount: 999 });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Book document not found");
    const [[{ c }]] = await pool.query("SELECT COUNT(*) c FROM bank_recon_matches WHERE statement_line_id = ? AND book_source_id = ?", [lineLookAlike, ids.cvB]);
    expect(c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("existing Bank Reconciliation behaviour (own company)", () => {
  test("full flow on Company A's session still works end to end", async () => {
    const pending = await firstId("SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING' AND book_source_id = ? AND book_source_type = 'CV'", [ids.sA, ids.cvA]);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${pending}/confirm`)).status).toBe(200);
    expect((await api("acctA", "delete", `/api/bank-recon/matches/${pending}`)).status).toBe(200);
    const lookAlike = await firstId("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = 'Look-alike'", [ids.sA]);
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${lookAlike}/ignore`)).status).toBe(200);
    expect((await api("acctA", "patch", `/api/bank-recon/sessions/${ids.sA}`, { notes: "own session edit" })).status).toBe(200);
    expect((await api("acctA", "get", `/api/bank-recon/sessions/${ids.sA}/audit-log`)).status).toBe(200);
    expect((await api("acctA", "get", `/api/bank-recon/sessions/${ids.sA}/report`)).status).toBe(200);
  });

  test("26. JV posting uses the session's company (Admin A -> A; Super Admin on B -> B)", async () => {
    const adjA = await firstId("SELECT id FROM bank_recon_adjustments WHERE session_id = ? AND status = 'PENDING' ORDER BY id", [ids.sA]);
    expect((await api("adminA", "post", `/api/bank-recon/adjustments/${adjA}/approve`, { suggestedAccountId: ids.chargeGL })).status).toBe(200);
    const postA = await api("adminA", "post", `/api/bank-recon/adjustments/${adjA}/post`);
    expect(postA.status).toBe(200);
    const [[jvA]] = await pool.query("SELECT company_id FROM jv_headers WHERE id = ?", [postA.body.jvId]);
    expect(jvA.company_id).toBe(ids.coA);

    // Super Admin has no company of its own - the JV still lands in B.
    const postB = await api("sa", "post", `/api/bank-recon/adjustments/${ids.adjB}/post`);
    expect(postB.status).toBe(200);
    const [[jvB]] = await pool.query("SELECT company_id FROM jv_headers WHERE id = ?", [postB.body.jvId]);
    expect(jvB.company_id).toBe(ids.coB);
    ids.jvPostedA = postA.body.jvId;
    ids.jvPostedB = postB.body.jvId;
  });

  test("a legacy NULL session cannot post a JV until a Super Admin assigns its company", async () => {
    const [b] = await pool.execute("INSERT INTO bank_recon_import_batches (session_id, bank_account_id, file_name, file_type, row_count) VALUES (?, ?, 'legacy.csv', 'CSV', 1)", [ids.sNull, ids.bank]);
    const [l] = await pool.execute("INSERT INTO bank_recon_statement_lines (batch_id, session_id, bank_account_id, txn_date, description, debit, credit) VALUES (?, ?, ?, '2026-07-31', 'Legacy charge', 7, 0)", [b.insertId, ids.sNull, ids.bank]);
    const [a] = await pool.execute("INSERT INTO bank_recon_adjustments (session_id, statement_line_id, adjustment_type, suggested_account_id, amount, status) VALUES (?, ?, 'BANK_CHARGE', ?, 7, 'APPROVED')", [ids.sNull, l.insertId, ids.chargeGL]);
    const blocked = await api("sa", "post", `/api/bank-recon/adjustments/${a.insertId}/post`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/Assign a company/);
    // Only a Super Admin can assign it; afterwards Company A can see it.
    expect((await api("adminA", "patch", `/api/bank-recon/sessions/${ids.sNull}`, { companyId: ids.coA })).status).toBe(404);
    expect((await api("sa", "patch", `/api/bank-recon/sessions/${ids.sNull}`, { companyId: ids.coA })).status).toBe(200);
    expect((await api("adminA", "get", `/api/bank-recon/sessions/${ids.sNull}`)).status).toBe(200);
    // ...and an owned session's company can't be changed.
    expect((await api("sa", "patch", `/api/bank-recon/sessions/${ids.sNull}`, { companyId: ids.coB })).status).toBe(400);
    const posted = await api("sa", "post", `/api/bank-recon/adjustments/${a.insertId}/post`);
    expect(posted.status).toBe(200);
    const [[jv]] = await pool.query("SELECT company_id FROM jv_headers WHERE id = ?", [posted.body.jvId]);
    expect(jv.company_id).toBe(ids.coA);
  });

  test("finalize and reopen still work on an own session", async () => {
    expect((await api("adminA", "post", `/api/bank-recon/sessions/${ids.sA}/finalize`, { overrideReason: "brci test" })).status).toBe(200);
    expect((await api("adminA", "post", `/api/bank-recon/sessions/${ids.sA}/reopen`, { reason: "brci test" })).status).toBe(200);
  });

  test("session create needs an explicit, permitted company for multi-company users", async () => {
    const body = { bankAccountId: ids.bank, periodStart: "2026-08-01", periodEnd: "2026-08-31" };
    let res = await api("adminAB", "post", "/api/bank-recon/sessions", body);
    expect(res.status).toBe(400);
    res = await api("adminA", "post", "/api/bank-recon/sessions", { ...body, companyId: ids.coB });
    expect(res.status).toBe(403);
    res = await api("adminAB", "post", "/api/bank-recon/sessions", { ...body, companyId: ids.coB });
    expect(res.status).toBe(200);
    const [[row]] = await pool.query("SELECT company_id FROM bank_recon_sessions WHERE id = ?", [res.body.id]);
    expect(row.company_id).toBe(ids.coB);
    ids.sBackfill3 = res.body.id; // cleaned up with the others
  });
});

// ---------------------------------------------------------------------------
describe("audit", () => {
  test("27. every Bank Reconciliation audit row for these sessions carries the session company", async () => {
    const collect = async (sessionId) => {
      const [rows] = await pool.query(
        `SELECT company_id, action FROM audit_logs WHERE module = 'BANK_RECON' AND (
           (entity_type = 'SESSION' AND entity_id = ?)
           OR (entity_type = 'IMPORT_BATCH' AND entity_id IN (SELECT id FROM bank_recon_import_batches WHERE session_id = ?))
           OR (entity_type = 'STATEMENT_LINE' AND entity_id IN (SELECT id FROM bank_recon_statement_lines WHERE session_id = ?))
           OR (entity_type = 'MATCH' AND entity_id IN (SELECT id FROM bank_recon_matches WHERE session_id = ?))
           OR (entity_type = 'ADJUSTMENT' AND entity_id IN (SELECT id FROM bank_recon_adjustments WHERE session_id = ?)))`,
        [sessionId, sessionId, sessionId, sessionId, sessionId]
      );
      return rows;
    };
    const a = await collect(ids.sA);
    const b = await collect(ids.sB);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(b.length).toBeGreaterThanOrEqual(5);
    expect(a.every((r) => r.company_id === ids.coA)).toBe(true);
    expect(b.every((r) => r.company_id === ids.coB)).toBe(true);
    const actions = new Set(a.map((r) => r.action));
    for (const act of ["CREATE", "IMPORT", "MATCH", "UNMATCH", "IGNORE", "CONFIG_UPDATE", "APPROVE_ADJUSTMENT", "POST_JV", "FINALIZE", "REOPEN"]) {
      expect(actions).toContain(act);
    }
    const [[jvAudit]] = await pool.query("SELECT company_id FROM audit_logs WHERE module = 'JV' AND action = 'POST' AND entity_id = ?", [ids.jvPostedB]);
    expect(jvAudit.company_id).toBe(ids.coB);
  });
});

// ---------------------------------------------------------------------------
describe("AI reconciliation", () => {
  test("28. a conversation is private to its owner and cannot reach another company's session", async () => {
    const conv = (await api("adminA", "post", "/api/ai/bank-recon/conversations")).body.id;
    for (const who of ["adminB", "acctA"]) {
      expect((await api(who, "get", `/api/ai/bank-recon/conversations/${conv}`)).status).toBe(404);
      expect((await api(who, "post", `/api/ai/bank-recon/conversations/${conv}/messages`, { message: "show outstanding checks" })).status).toBe(404);
    }
    expect((await api("sa", "get", `/api/ai/bank-recon/conversations/${conv}`)).status).toBe(200);

    // Point A's own conversation at B's session: the link is dropped, no B data is used.
    await pool.execute("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [ids.sB, conv]);
    const got = (await api("adminA", "get", `/api/ai/bank-recon/conversations/${conv}`)).body;
    expect(got.sessionId).toBeNull();
    const reply = await api("adminA", "post", `/api/ai/bank-recon/conversations/${conv}/messages`, { message: "show outstanding checks" });
    expect(reply.status).toBe(200);
    expect(reply.body.reply).not.toMatch(/brci-CV-B|brci-OR-B|999|777/i);

    // Agent tools apply the same guard directly.
    await expect(AgentActions.runAs(users.adminA, () => AgentActions.getSessionSummary(ids.sB))).rejects.toMatchObject({ statusCode: 404 });
    await expect(AgentActions.runAs(users.acctA, () => AgentActions.runMatchingForSession(ids.sB))).rejects.toMatchObject({ statusCode: 404 });
    await expect(AgentActions.runAs(users.adminA, () => AgentActions.confirmMatch(ids.matchB))).rejects.toMatchObject({ statusCode: 404 });
    const own = await AgentActions.runAs(users.adminA, () => AgentActions.getSessionSummary(ids.sA));
    expect(own.session.id).toBe(ids.sA);
    // Outside a signed-in turn every action is refused.
    await expect(AgentActions.getSessionSummary(ids.sA)).rejects.toMatchObject({ statusCode: 403 });
  });

  test("29. VIEW-only permission cannot make the agent change anything", async () => {
    const before = await sessionSnapshot(ids.sA);
    await expect(AgentActions.runAs(users.viewOnly, () => AgentActions.runMatchingForSession(ids.sA))).rejects.toMatchObject({ statusCode: 403 });
    await expect(AgentActions.runAs(users.viewOnly, () => AgentActions.bulkConfirmExact(ids.sA))).rejects.toMatchObject({ statusCode: 403 });
    await expect(AgentActions.runAs(users.viewOnly, () => AgentActions.updateSessionTolerance(ids.sA, { dateToleranceDays: 9 }))).rejects.toMatchObject({ statusCode: 403 });
    const view = await AgentActions.runAs(users.viewOnly, () => AgentActions.getSessionSummary(ids.sA));
    expect(view.session.id).toBe(ids.sA);

    const conv = (await api("viewOnly", "post", "/api/ai/bank-recon/conversations")).body.id;
    await pool.execute("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [ids.sA, conv]);
    const res = await api("viewOnly", "post", `/api/ai/bank-recon/conversations/${conv}/messages`, { message: "confirm all exact matches" });
    expect(res.status).toBe(403);
    expect(await sessionSnapshot(ids.sA)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("migration backfill (several companies)", () => {
  test("assigns a company only when the evidence is unambiguous; ambiguous / no evidence stay NULL", async () => {
    const mk = async () => (await pool.execute(
      "INSERT INTO bank_recon_sessions (bank_account_id, period_start, period_end) VALUES (?, '2026-06-01', '2026-06-30')", [ids.bank]
    ))[0].insertId;
    const line = async (sid) => {
      const [b] = await pool.execute("INSERT INTO bank_recon_import_batches (session_id, bank_account_id, file_name, file_type, row_count) VALUES (?, ?, 'b.csv', 'CSV', 1)", [sid, ids.bank]);
      return (await pool.execute("INSERT INTO bank_recon_statement_lines (batch_id, session_id, bank_account_id, txn_date, debit, credit) VALUES (?, ?, ?, '2026-06-05', 1, 0)", [b.insertId, sid, ids.bank]))[0].insertId;
    };
    const matchTo = async (sid, type, docId) => {
      const l = await line(sid);
      await pool.execute("INSERT INTO bank_recon_matches (session_id, statement_line_id, book_source_type, book_source_id, match_type, status, amount) VALUES (?, ?, ?, ?, 'MANUAL', 'CONFIRMED', 1)", [sid, l, type, docId]);
    };
    ids.sBackfill1 = await mk(); // only Company A evidence
    await matchTo(ids.sBackfill1, "CV", ids.cvA);
    await matchTo(ids.sBackfill1, "OR", ids.orA);
    ids.sBackfill2 = await mk(); // evidence from both companies
    await matchTo(ids.sBackfill2, "CV", ids.cvA);
    await matchTo(ids.sBackfill2, "JV", ids.jvB);
    const noEvidence = await mk();

    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "bank_recon_company_scope_migration.sql"), "utf8");
    const cfg = resolveDatabaseConfig();
    const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, multipleStatements: true });
    try {
      await conn.query(sql); // idempotent re-run on an already-migrated schema
    } finally {
      await conn.end();
    }
    const [[r1]] = await pool.query("SELECT company_id FROM bank_recon_sessions WHERE id = ?", [ids.sBackfill1]);
    const [[r2]] = await pool.query("SELECT company_id FROM bank_recon_sessions WHERE id = ?", [ids.sBackfill2]);
    const [[r3]] = await pool.query("SELECT company_id FROM bank_recon_sessions WHERE id = ?", [noEvidence]);
    expect(r1.company_id).toBe(ids.coA);
    expect(r2.company_id).toBeNull();
    expect(r3.company_id).toBeNull();
    await pool.query("DELETE FROM bank_recon_sessions WHERE id = ?", [noEvidence]);
  });
});
