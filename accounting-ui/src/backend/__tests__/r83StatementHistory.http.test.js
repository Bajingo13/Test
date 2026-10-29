// R8.3 - bank statement history, reconciliation queue and carry-forward.
//   * imported statement rows are the bank account's history (company + bank
//     account + batch); sessions read the rows of their period plus earlier
//     unresolved rows - never copies;
//   * book items stay outstanding until a session confirms them (January's
//     uncleared check is still there in February);
//   * the queue groups the deterministic engine's results for the accountant
//     and the AI assistant alike.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const MatchService = require("../services/bankReconMatchService");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "r83-";
const PW = "R83Pass!1";
const co = {};
const cur = {};
const acct = {};
const bank = {};
const tok = {};
const users = {};
const doc = {};
const s = {};
const sessions = [];
const convs = [];

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
const ln = (key, debit, credit) => ({ accountId: acct[key].id, accountCode: acct[key].code, accountTitle: acct[key].title, particulars: "", debit, credit });
async function voucher(kind, company, o) {
  const isCv = kind === "cv";
  const who = company === "A" ? "acctA" : "acctB";
  const res = await api(who, "post", `/api/${kind}`, {
    voucherNo: `${P}${o.no}`, [isCv ? "payeeName" : "customerName"]: "R83 Party", transactionDate: o.date,
    referenceNo: "", description: "R83", status: o.status || "Posted", paymentMethod: o.checkNo ? "Check" : "Cash",
    bankAccountId: o.bank ?? bank.BK, checkNo: o.checkNo || "", checkDate: o.date, totalDebit: o.amount, totalCredit: o.amount,
    lines: isCv ? [ln("EXP", o.amount, 0), ln(o.bankKey || "BANK", 0, o.amount)] : [ln(o.bankKey || "BANK", o.amount, 0), ln("AR", 0, o.amount)],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date },
  });
  if (res.status !== 200) throw new Error(`${kind} ${o.no}: ${res.status} ${res.body.message}`);
  return res.body.id;
}
async function newSession(who, start, end, o = {}) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: o.bank ?? bank.BK, periodStart: start, periodEnd: end,
    statementBeginningBalance: o.begin ?? 0, statementEndingBalance: o.end ?? 0,
  });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}
const importRows = (who, sid, rows) => request(app).post(`/api/bank-recon/sessions/${sid}/import`).set({ Authorization: `Bearer ${tok[who]}` })
  .attach("file", Buffer.from(["Date,Description,Reference,Check No,Debit,Credit", ...rows].join("\n")), "stmt.csv");
const statementLines = async (who, sid) => (await api(who, "get", `/api/bank-recon/sessions/${sid}/statement-lines`)).body;
const queueOf = async (who, sid) => (await api(who, "get", `/api/bank-recon/sessions/${sid}/queue`)).body;
const summaryOf = async (who, sid) => (await api(who, "get", `/api/bank-recon/sessions/${sid}/summary`)).body;
const lineByDesc = (lines, d) => lines.find((l) => l.description === d);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["BANK", "R83 Cash in Bank", "ASSET"], ["BANK2", "R83 Cash in Bank 2", "ASSET"], ["EXP", "R83 Expense", "EXPENSE"], ["AR", "R83 Receivable", "ASSET"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  for (const [k, coa] of [["BK", "BANK"], ["BK2", "BANK2"]]) {
    bank[k] = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R83', ?, ?, 'ACTIVE')",
      [`${P}${k}`, `R83 ${k}`, `000-${k}`, acct[coa].id, acct[coa].code])).insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);

  // January: two checks written, only #1001 clears in January.
  doc.cv1001 = await voucher("cv", "A", { no: "CV-1001", checkNo: "1001", amount: 500, date: "2096-01-10" });
  doc.cv1002 = await voucher("cv", "A", { no: "CV-1002", checkNo: "1002", amount: 300, date: "2096-01-20" });
  s.jan = await newSession("acctA", "2096-01-01", "2096-01-31", { begin: 0, end: -475 });
  expect((await importRows("acctA", s.jan, ["2096-01-15,Check 1001,,0001001,500.00,", "2096-01-31,Unknown deposit,,,,25.00"])).status).toBe(200);
  expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.jan}/run-matching`)).status).toBe(200);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users).map((u) => u.id);
    if (convs.length) {
      await pool.query("DELETE FROM ai_recon_messages WHERE conversation_id IN (?)", [convs]);
      await pool.query("DELETE FROM ai_recon_conversations WHERE id IN (?)", [convs]);
    }
    for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
      await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [sessions]);
    }
    await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    for (const t of ["or_headers", "cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
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
describe("carry-forward: January to February", () => {
  test("January: the check-number match is high-confidence and the explanation names the evidence", async () => {
    const queue = await queueOf("acctA", s.jan);
    expect(queue.highConfidence).toHaveLength(1);
    const h = queue.highConfidence[0];
    expect(h.line).toMatchObject({ description: "Check 1001", amount: 500, carriedForward: false });
    expect(h.candidate).toMatchObject({ bookSourceType: "CV", bookSourceId: doc.cv1001, matchLevel: "CHECK_NO", strictExact: true });
    expect(h.candidate.explanation).toBe(
      `Bank statement check 0001001 for ₱500.00 matches CV ${P}CV-1001 for ₱500.00: the check number and amount match exactly, and the CV is posted to this company and bank account. Strong evidence - can be confirmed.`
    );
    expect((await api("acctA", "post", `/api/bank-recon/matches/${h.candidate.matchId}/confirm`)).status).toBe(200);
    const jan = await summaryOf("acctA", s.jan);
    expect(jan.bookBalance).toBe(-800);
    expect(jan.outstandingChecks.map((t) => t.sourceId)).toEqual([doc.cv1002]);
  });

  test("February: the uncleared January check is still outstanding (carried); the cleared one is not", async () => {
    s.feb = await newSession("acctA", "2096-02-01", "2096-02-29", { begin: -475, end: -775 });
    const queue = await queueOf("acctA", s.feb);
    const book = queue.unmatchedBook.map((t) => [t.sourceId, t.carriedForward]);
    expect(book).toEqual([[doc.cv1002, true]]);
    const summary = await summaryOf("acctA", s.feb);
    expect(summary.carriedForward).toEqual({ count: 1, net: -300 });
    expect(summary.bookBalance).toBe(-775);
    // not reconciled until a session confirms it
    expect(summary.difference).toBe(-300);
    expect(await q("SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'", [s.feb])).toEqual([]);
  });

  test("February: January's unresolved bank row is carried; its matched row is not", async () => {
    const lines = await statementLines("acctA", s.feb);
    expect(lines.map((l) => [l.description, Number(l.carriedForward)])).toEqual([["Unknown deposit", 1]]);
    const queue = await queueOf("acctA", s.feb);
    expect(queue.unmatchedBank.map((u) => [u.line.description, u.line.carriedForward])).toEqual([["Unknown deposit", true]]);
  });

  test("February: the January check clears, is matched EXACT and confirmed through the assistant's shared service; February reconciles", async () => {
    expect((await importRows("acctA", s.feb, ["2096-02-03,Check 1002,,1002,300.00,"])).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.feb}/run-matching`)).status).toBe(200);
    const queue = await queueOf("acctA", s.feb);
    const h = queue.highConfidence.find((x) => x.line.description === "Check 1002");
    expect(h.candidate).toMatchObject({ bookSourceId: doc.cv1002, matchLevel: "CHECK_NO" });
    const spy = jest.spyOn(MatchService, "confirmMatch");
    const res = await ai("acctA", "confirmMatch", h.candidate.matchId);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ strict: true, channel: "AI_ASSISTANT" }));
    spy.mockRestore();
    expect(res.status).toBe(200);
    // the unexplained January deposit is still open - ignore it from February
    const deposit = lineByDesc(await statementLines("acctA", s.feb), "Unknown deposit");
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${deposit.id}/ignore`, { sessionId: s.feb })).status).toBe(200);
    const feb = await summaryOf("acctA", s.feb);
    expect(feb.outstandingChecks).toEqual([]);
    expect(feb.difference).toBe(0);
    // January, as of its own end, still shows the check outstanding
    expect((await summaryOf("acctA", s.jan)).outstandingChecks.map((t) => t.sourceId)).toEqual([doc.cv1002]);
  });

  test("a carried row can be handled from the later session even after its own session is finalized", async () => {
    s.jan2 = await newSession("acctA", "2096-01-01", "2096-01-31");
    const before = await q("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE company_id = ? AND bank_account_id = ?", [co.A, bank.BK]);
    // same history, no copies
    expect((await statementLines("acctA", s.jan2)).map((l) => l.description).sort()).toEqual(["Check 1001", "Unknown deposit"]);
    expect((await importRows("acctA", s.jan2, ["2096-01-15,Check 1001,,0001001,500.00,", "2096-01-31,Unknown deposit,,,,25.00"])).status).toBe(409);
    expect(await q("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE company_id = ? AND bank_account_id = ?", [co.A, bank.BK])).toEqual(before);

    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.jan}/finalize`, { overrideReason: "test" })).status).toBe(200);
    // February ignored the carried deposit (above): it is resolved, so it
    // has left February's history; un-ignoring belongs to its own period.
    const deposit = lineByDesc(await statementLines("acctA", s.jan), "Unknown deposit");
    expect(deposit.matchStatus).toBe("IGNORED");
    expect(lineByDesc(await statementLines("acctA", s.feb), "Unknown deposit")).toBeUndefined();
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${deposit.id}/ignore`, { sessionId: s.feb })).status).toBe(404);
    // January is finalized: refused there too, until January is reopened
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${deposit.id}/ignore`)).status).toBe(400);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.jan}/reopen`, { reason: "un-ignore deposit" })).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${deposit.id}/ignore`, { sessionId: s.jan })).status).toBe(200);
    // unresolved again, so it is carried into February again
    expect(lineByDesc(await statementLines("acctA", s.feb), "Unknown deposit")).toMatchObject({ matchStatus: "UNMATCHED", carriedForward: 1 });
    // put it back as it was for the rest of the suite
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${deposit.id}/ignore`, { sessionId: s.feb })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("history selection and isolation", () => {
  test("date range: a March session sees neither January's nor February's resolved rows", async () => {
    s.mar = await newSession("acctA", "2096-03-01", "2096-03-31");
    expect(await statementLines("acctA", s.mar)).toEqual([]);
    expect((await statementLines("acctA", s.jan)).map((l) => l.description).sort()).toEqual(["Check 1001", "Unknown deposit"]);
  });

  test("another bank account of the same company sees none of it", async () => {
    s.bk2 = await newSession("acctA", "2096-01-01", "2096-01-31", { bank: bank.BK2 });
    expect(await statementLines("acctA", s.bk2)).toEqual([]);
    expect((await queueOf("acctA", s.bk2)).unmatchedBook).toEqual([]);
  });

  test("another company on the same bank account sees none of it, and cannot open the queue", async () => {
    s.b = await newSession("acctB", "2096-01-01", "2096-01-31");
    expect(await statementLines("acctB", s.b)).toEqual([]);
    expect((await api("acctB", "get", `/api/bank-recon/sessions/${s.jan}/queue`)).status).toBe(404);
    expect((await ai("acctB", "getReconciliationQueue", s.jan)).status).toBe(404);
    expect((await api("acctB", "get", `/api/bank-recon/sessions/${s.jan}/statement-lines`)).status).toBe(404);
  });

  test("a row outside the working session's history cannot be matched from it", async () => {
    const janLine = lineByDesc(await statementLines("acctA", s.jan), "Unknown deposit");
    const res = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: janLine.id, bookSourceType: "CV", bookSourceId: doc.cv1002, sessionId: s.bk2 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("April queue: groups, check-number first, exceptions", () => {
  let queue;
  beforeAll(async () => {
    doc.cvRef = await voucher("cv", "A", { no: "CV-REF", amount: 450, date: "2096-04-05" });
    doc.cvAmt = await voucher("cv", "A", { no: "CV-AMT", checkNo: "7001", amount: 1000, date: "2096-04-06" });
    doc.orDir = await voucher("or", "A", { no: "OR-DIR", checkNo: "7002", amount: 200, date: "2096-04-07" });
    doc.cvOther = await voucher("cv", "A", { no: "CV-OTHER", checkNo: "7003", amount: 70, date: "2096-04-08", bank: bank.BK2, bankKey: "BANK2" });
    doc.cvDraft = await voucher("cv", "A", { no: "CV-DRAFT", checkNo: "7004", amount: 80, date: "2096-04-09", status: "Draft" });
    doc.cvT1 = await voucher("cv", "A", { no: "CV-T1", checkNo: "7005", amount: 300, date: "2096-04-11" });
    doc.cvT2 = await voucher("cv", "A", { no: "CV-T2", checkNo: "7005", amount: 300, date: "2096-04-11" });
    doc.or300 = await voucher("or", "A", { no: "OR-300", amount: 300, date: "2096-04-12" });
    doc.cvChk = await voucher("cv", "A", { no: "CV-CHK", checkNo: "7006", amount: 640, date: "2096-04-14" });
    doc.cvLonely = await voucher("cv", "A", { no: "CV-LONELY", amount: 55, date: "2096-04-20" });
    s.apr = await newSession("acctA", "2096-04-01", "2096-04-30");
    expect((await importRows("acctA", s.apr, [
      `2096-04-05,Ref pay,${P}CV-REF,,450.00,`,
      "2096-04-06,Amt check,,7001,990.00,",
      "2096-04-07,Dir check,,7002,200.00,",
      "2096-04-08,Other bank check,,7003,70.00,",
      "2096-04-09,Draft check,,7004,80.00,",
      "2096-04-10,Old check,,1001,500.00,",
      "2096-04-11,Tie check,,7005,300.00,",
      "2096-04-12,Deposit,,,,300.00",
      "2096-04-13,Mystery,,,12.34,",
      "2096-04-14,Check 7006,,7006,640.00,",
    ])).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.apr}/run-matching`)).status).toBe(200);
    queue = await queueOf("acctA", s.apr);
  });

  test("high confidence: check number first, then document / reference number", () => {
    expect(queue.highConfidence.map((h) => [h.line.description, h.candidate.matchLevel, h.candidate.bookSourceId])).toEqual([
      ["Check 7006", "CHECK_NO", doc.cvChk],
      ["Ref pay", "REFERENCE", doc.cvRef],
    ]);
  });

  test("needs review: ambiguous check number and amount/date only, with the engine's explanations", () => {
    const tie = queue.needsReview.find((r) => r.line.description === "Tie check");
    expect(tie.candidates.map((c) => c.matchType)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(tie.candidates[0].explanation).toMatch(/Ambiguous: several documents match this statement line - the accountant must choose in the workspace\./);
    const dep = queue.needsReview.find((r) => r.line.description === "Deposit");
    expect(dep.candidates[0]).toMatchObject({ matchType: "SUGGESTED", matchLevel: "AMOUNT_DATE", bookSourceId: doc.or300 });
    expect(dep.candidates[0].explanation).toMatch(/no check or document number confirms it\. Review before confirming\./);
  });

  test("exceptions explain why a named document cannot be matched", () => {
    const byLine = Object.fromEntries(queue.exceptions.filter((e) => e.document).map((e) => [e.line.description, e.type]));
    expect(byLine).toEqual({
      "Amt check": "AMOUNT_MISMATCH",
      "Dir check": "WRONG_DIRECTION",
      "Other bank check": "OTHER_BANK_ACCOUNT",
      "Draft check": "NOT_POSTED",
      "Old check": "ALREADY_RECONCILED",
    });
    expect(queue.exceptions.find((e) => e.type === "AMOUNT_MISMATCH").message).toBe(
      `Statement check 7001 is ₱990.00, but CV ${P}CV-AMT moved ₱1,000.00 through the bank (difference ₱10.00).`
    );
  });

  test("unmatched bank rows and outstanding book items", () => {
    expect(queue.unmatchedBank.map((u) => u.line.description)).toEqual(expect.arrayContaining(["Mystery", "Amt check", "Old check"]));
    const lonely = queue.unmatchedBook.find((t) => t.sourceId === doc.cvLonely && t.sourceType === "CV");
    expect(lonely).toMatchObject({ amount: 55, direction: "OUT", carriedForward: false });
    expect(queue.unmatchedBook.some((t) => t.sourceId === doc.cvOther)).toBe(false);
  });

  test("a historical duplicate row (no fingerprint) is flagged", async () => {
    const [b] = await q("SELECT batch_id FROM bank_recon_statement_lines WHERE session_id = ? LIMIT 1", [s.apr]);
    await pool.query(
      `INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, description, debit, credit, row_fingerprint)
       VALUES (?, ?, ?, ?, '2096-04-13', 'Mystery', 12.34, 0, NULL)`,
      [b.batch_id, s.apr, co.A, bank.BK]
    );
    const q2 = await queueOf("acctA", s.apr);
    expect(q2.exceptions.filter((e) => e.type === "POSSIBLE_DUPLICATE_IMPORT")).toHaveLength(1);
  });

  test("the queue never confirms anything", async () => {
    expect(await q("SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'", [s.apr])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("AI uses the same deterministic queue", () => {
  test("the assistant receives exactly the workspace's queue", async () => {
    const rest = await queueOf("acctA", s.apr);
    const viaAi = await ai("acctA", "getReconciliationQueue", s.apr);
    expect(viaAi.status).toBe(200);
    expect(JSON.parse(JSON.stringify(viaAi.body))).toEqual(rest);
  });

  test("the assistant cannot confirm a needs-review suggestion; nothing changes", async () => {
    const dep = (await queueOf("acctA", s.apr)).needsReview.find((r) => r.line.description === "Deposit");
    const res = await ai("acctA", "confirmMatch", dep.candidates[0].matchId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATCH_NOT_STRICT_EXACT");
    expect(await q("SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'", [s.apr])).toEqual([]);
  });

  test("'What needs my attention?' relays the queue and never claims a confirmation", async () => {
    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    await pool.query("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [s.apr, conv.body.id]);
    const res = await api("acctA", "post", `/api/ai/bank-recon/conversations/${conv.body.id}/messages`, { message: "What needs my attention?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/2 high-confidence match\(es\)/);
    expect(res.body.reply).toContain(`Bank statement check 7006 for ₱640.00 matches CV ${P}CV-CHK for ₱640.00`);
    expect(res.body.reply).toMatch(/Exception: Statement check 7001 is ₱990.00/);
    expect(res.body.reply).toMatch(/Nothing is confirmed until you confirm it/);
    expect(res.body.reply).not.toMatch(/\bConfirmed\b/);
    expect(await q("SELECT id FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'", [s.apr])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("index migration", () => {
  test("registered once after R8.2, both copies identical, index present", async () => {
    const FILE = "r83_bank_statement_history_index_migration.sql";
    expect(MIGRATION_ORDER.filter((f) => f === FILE)).toHaveLength(1);
    expect(MIGRATION_ORDER.indexOf(FILE)).toBeGreaterThan(MIGRATION_ORDER.indexOf("r82_bank_statement_import_migration.sql"));
    const root = path.join(__dirname, "..", "..", "..", "..");
    expect(fs.readFileSync(path.join(__dirname, "..", "migrations", FILE)).equals(fs.readFileSync(path.join(root, FILE)))).toBe(true);
    const cols = await q(
      `SELECT COLUMN_NAME c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bank_recon_statement_lines' AND INDEX_NAME = 'idx_stmt_owner_date' ORDER BY SEQ_IN_INDEX`
    );
    expect(cols.map((r) => r.c)).toEqual(["company_id", "bank_account_id", "txn_date", "match_status"]);
  });
});
