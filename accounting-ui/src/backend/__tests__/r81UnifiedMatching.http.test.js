// R8.1 - one authoritative Bank Reconciliation matching engine, shared by
// the workspace REST API and the AI assistant; the assistant is advisory.
// Every rule is exercised through both channels against the same data:
//   UI  = the REST routes the workspace calls
//   AI  = BankReconAgentActions (what both AI providers call), run as the
//         signed-in user via runAs()
// Suggestion rows are also tampered with directly in the database to prove
// a confirmation re-checks everything on the server, whatever suggestion
// row it is pointed at.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const MatchService = require("../services/bankReconMatchService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "r81-";
const PW = "R81Pass!1";
const co = {};
const cur = {};
const acct = {};
const bank = {};
const tok = {};
const users = {};
const doc = {};
const sessions = [];
const convs = [];

const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];
const api = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
// AI channel: the agent action, run as the signed-in user exactly as
// AIReconController.sendMessage runs it. Returns { status, body } like a
// response so both channels are asserted the same way.
async function ai(who, action, ...args) {
  try {
    const body = await AgentActions.runAs(users[who], () => AgentActions[action](...args));
    return { status: 200, body };
  } catch (err) {
    return { status: err.statusCode || 500, body: { message: err.message, code: err.code } };
  }
}

async function makeUser(tag, roleCode, companyIds = [], denies = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query(
    "INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id, `${P}${tag}@example.test`]
  );
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [moduleKey, action] of denies) {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = ? AND action = ?", [moduleKey, action]);
    await pool.query("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'r81 test')", [u.insertId, perm.id]);
  }
  users[tag] = { id: u.insertId, roleCode, username: `${P}${tag}` };
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
}

async function coaAccount(key, title, cls) {
  const [r] = await pool.query("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${key}`, title, cls]);
  acct[key] = { id: r.insertId, code: `${P}${key}`, title };
}
const ln = (key, debit, credit) => ({ accountId: acct[key].id, accountCode: acct[key].code, accountTitle: acct[key].title, particulars: "", debit, credit });

async function voucher(kind, who, company, o) {
  const isCv = kind === "cv";
  const res = await api(who, "post", `/api/${kind}`, {
    voucherNo: o.no, [isCv ? "payeeName" : "customerName"]: "R81 Party", transactionDate: o.date || "2099-03-10",
    referenceNo: "", description: "R81", status: o.status || "Posted", paymentMethod: o.checkNo ? "Check" : "Cash",
    bankAccountId: o.bank ?? bank.BK, checkNo: o.checkNo || "", checkDate: o.date || "2099-03-10",
    totalDebit: o.gross, totalCredit: o.gross, lines: o.lines,
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date || "2099-03-10" },
  });
  if (res.status !== 200) throw new Error(`${kind} ${o.no}: ${res.status} ${res.body.message}`);
  return res.body.id;
}

const STATEMENT_ROWS = [
  ["2099-03-10", "Check WHT", "", "R81-CHK-1", "980", ""],
  ["2099-03-10", "By reference", `${P}CV-REF`, "", "450", ""],
  ["2099-03-11", "Deposit 250", "", "", "", "250"],
  ["2099-03-12", "Tie", "", "R81-TIE", "300", ""],
  ["2099-03-13", "Deposit 600", `${P}OR-600`, "", "", "600"],
  ["2099-03-14", "Draft pay", "", "R81-DRAFT", "70", ""],
  ["2099-03-15", "Other bank", "", "R81-BK2", "90", ""],
  ["2099-03-16", "B check", "", "R81-CHK-B", "333", ""],
];
const sessionTag = new Map();
const statementFor = (tag) => ["Date,Description,Reference,Check No,Debit,Credit",
  ...STATEMENT_ROWS.map(([d, desc, ...rest]) => [d, `${desc} ${tag}`, ...rest].join(","))].join("\n");

async function sessionWithStatement(who, companyKey) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: bank.BK, periodStart: "2099-03-01", periodEnd: "2099-03-31", statementBeginningBalance: 0, statementEndingBalance: 0,
  });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  const imp = await request(app).post(`/api/bank-recon/sessions/${res.body.id}/import`).set({ Authorization: `Bearer ${tok[who]}` })
    .attach("file", Buffer.from(statementFor(companyKey)), `${companyKey}.csv`);
  if (imp.status !== 200) throw new Error(`import ${imp.status} ${imp.body.message}`);
  sessionTag.set(res.body.id, companyKey);
  return res.body.id;
}

const lineOf = (sessionId, description) =>
  one("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = ?", [sessionId, `${description} ${sessionTag.get(sessionId)}`]).then((r) => r.id);
const pending = (lineId) =>
  q(`SELECT id, book_source_type AS type, book_source_id AS docId, match_type AS matchType, confidence_score AS score,
            score_breakdown AS breakdown, amount
     FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING' ORDER BY confidence_score DESC, book_source_id`, [lineId]);
const confirmedFor = (type, id) => q("SELECT id, amount, session_id AS sessionId FROM bank_recon_matches WHERE book_source_type = ? AND book_source_id = ? AND status = 'CONFIRMED'", [type, id]);
// A PENDING suggestion row as if the engine had written it (strict CHECK_NO
// evidence) - used to point a confirmation at an ineligible document.
async function tamperedSuggestion(sessionId, lineId, type, docId, amount, breakdown = { matchLevel: "CHECK_NO" }, matchType = "EXACT") {
  const [r] = await pool.query(
    `INSERT INTO bank_recon_matches (session_id, statement_line_id, book_source_type, book_source_id, match_type, confidence_score, score_breakdown, status, amount)
     VALUES (?, ?, ?, ?, ?, 85, ?, 'PENDING', ?)`,
    [sessionId, lineId, type, docId, matchType, JSON.stringify(breakdown), amount]
  );
  return r.insertId;
}
async function reconSnapshot() {
  const ids = sessions.length ? sessions : [0];
  return one(
    `SELECT (SELECT COUNT(*) FROM bank_recon_matches WHERE session_id IN (?) AND status = 'CONFIRMED') confirmed,
            (SELECT GROUP_CONCAT(CONCAT(id, ':', match_status) ORDER BY id) FROM bank_recon_statement_lines WHERE session_id IN (?)) lineStatuses,
            (SELECT COUNT(*) FROM audit_logs WHERE module = 'BANK_RECON' AND action = 'MATCH' AND company_id IN (?)) matchAudits,
            (SELECT GROUP_CONCAT(CONCAT(id, ':', total_debit, ':', status) ORDER BY id) FROM cv_headers WHERE company_id IN (?)) cvs,
            (SELECT GROUP_CONCAT(CONCAT(id, ':', total_debit, ':', status) ORDER BY id) FROM or_headers WHERE company_id IN (?)) ors`,
    [ids, ids, Object.values(co), Object.values(co), Object.values(co)]
  );
}
const norm = (rows) => rows.map((r) => ({
  type: r.type, docId: r.docId, matchType: r.matchType, score: Number(r.score), amount: r.amount,
  level: (typeof r.breakdown === "string" ? JSON.parse(r.breakdown) : r.breakdown).matchLevel,
}));

let sUI;
let sAI;
let sB;

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  await coaAccount("BANK", "R81 Cash in Bank", "ASSET");
  await coaAccount("BANK2", "R81 Cash in Bank 2", "ASSET");
  await coaAccount("EXP", "R81 Expense", "EXPENSE");
  await coaAccount("AR", "R81 Accounts Receivable", "ASSET");
  await coaAccount("WTP", "R81 Withholding Tax Payable", "LIABILITY");
  for (const [k, coa] of [["BK", "BANK"], ["BK2", "BANK2"]]) {
    bank[k] = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R81', ?, ?, 'ACTIVE')",
      [`${P}${k}`, `R81 Bank ${k}`, `000-${k}`, acct[coa].id, acct[coa].code])).insertId;
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("viewA", "ACCOUNTANT", [co.A], [["REPORTS.BANK_RECONCILIATION", "CREATE"]]);

  doc.cvWht = await voucher("cv", "acctA", "A", { no: `${P}CV-WHT`, checkNo: "R81-CHK-1", gross: 1000, lines: [ln("EXP", 1000, 0), ln("BANK", 0, 980), ln("WTP", 0, 20)] });
  doc.cvRef = await voucher("cv", "acctA", "A", { no: `${P}CV-REF`, gross: 450, lines: [ln("EXP", 450, 0), ln("BANK", 0, 450)] });
  doc.or250 = await voucher("or", "acctA", "A", { no: `${P}OR-250`, gross: 250, date: "2099-03-11", lines: [ln("BANK", 250, 0), ln("AR", 0, 250)] });
  doc.cvTieA = await voucher("cv", "acctA", "A", { no: `${P}CV-TIE-A`, checkNo: "R81-TIE", gross: 300, date: "2099-03-12", lines: [ln("EXP", 300, 0), ln("BANK", 0, 300)] });
  doc.cvTieB = await voucher("cv", "acctA", "A", { no: `${P}CV-TIE-B`, checkNo: "R81-TIE", gross: 300, date: "2099-03-12", lines: [ln("EXP", 300, 0), ln("BANK", 0, 300)] });
  doc.or600 = await voucher("or", "acctA", "A", { no: `${P}OR-600`, gross: 600, date: "2099-03-13", lines: [ln("BANK", 600, 0), ln("AR", 0, 600)] });
  doc.cvDraft = await voucher("cv", "acctA", "A", { no: `${P}CV-DRAFT`, checkNo: "R81-DRAFT", gross: 70, status: "Draft", date: "2099-03-14", lines: [ln("EXP", 70, 0), ln("BANK", 0, 70)] });
  doc.cvBk2 = await voucher("cv", "acctA", "A", { no: `${P}CV-BK2`, checkNo: "R81-BK2", gross: 90, bank: bank.BK2, date: "2099-03-15", lines: [ln("EXP", 90, 0), ln("BANK2", 0, 90)] });
  doc.cvB = await voucher("cv", "acctB", "B", { no: `${P}CV-B`, checkNo: "R81-CHK-B", gross: 333, date: "2099-03-16", lines: [ln("EXP", 333, 0), ln("BANK", 0, 333)] });

  // Two Company A sessions with the same statement on the same bank: one
  // matched through the workspace API, one through the assistant.
  sUI = await sessionWithStatement("acctA", "ui");
  sAI = await sessionWithStatement("acctA", "ai");
  sB = await sessionWithStatement("acctB", "b");
  expect((await api("acctA", "post", `/api/bank-recon/sessions/${sUI}/run-matching`)).status).toBe(200);
  expect((await ai("acctA", "runMatchingForSession", sAI)).status).toBe(200);
  expect((await api("acctB", "post", `/api/bank-recon/sessions/${sB}/run-matching`)).status).toBe(200);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users).map((u) => u.id);
    if (convs.length) {
      await pool.query("DELETE FROM ai_recon_messages WHERE conversation_id IN (?)", [convs]);
      await pool.query("DELETE FROM ai_recon_conversations WHERE id IN (?)", [convs]);
    }
    if (sessions.length) {
      for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
        await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [sessions]);
      }
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    }
    if (cos.length) {
      for (const t of ["or_headers", "cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) {
        await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
      }
    }
    if (us.length) {
      await pool.query("DELETE FROM ai_recon_conversations WHERE created_by IN (?)", [us]);
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    }
    await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [Object.values(bank)]);
    if (cos.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("one engine: the assistant and the workspace get identical suggestions", () => {
  test("15. matching run through the assistant writes exactly the workspace's suggestions", async () => {
    for (const d of ["Check WHT", "By reference", "Deposit 250", "Tie", "Deposit 600", "Draft pay", "Other bank", "B check"]) {
      expect(norm(await pending(await lineOf(sAI, d)))).toEqual(norm(await pending(await lineOf(sUI, d))));
    }
  });

  test("15. the assistant's candidate list is the workspace's candidate list", async () => {
    const line = await lineOf(sUI, "Tie");
    const rest = await api("acctA", "get", `/api/bank-recon/statement-lines/${line}/candidates`);
    const viaAi = await ai("acctA", "getMatchCandidates", line);
    expect(rest.status).toBe(200);
    expect(viaAi.status).toBe(200);
    expect(JSON.parse(JSON.stringify(viaAi.body.candidates))).toEqual(rest.body);
    expect(viaAi.body.statementLine).toMatchObject({ id: line, description: "Tie ui" });
  });

  test("no second implementation: controller and agent hold no matching, scoring or confirming code", () => {
    const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
    for (const src of [read("controllers", "BankReconController.js"), read("services", "BankReconAgentActions.js")]) {
      expect(src).not.toMatch(/INSERT INTO bank_recon_matches/);
      expect(src).not.toMatch(/SET status = .CONFIRMED./);
      expect(src).not.toMatch(/match_status = .MATCHED./);
      expect(src).not.toMatch(/scoreCandidate|classifyLineCandidates|lockEligibleBookItem|isStrictExactRow/);
    }
    // The agent writes no reconciliation match or statement-line rows at all.
    expect(read("services", "BankReconAgentActions.js")).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) bank_recon_(matches|statement_lines)/);
  });
});

// ---------------------------------------------------------------------------
describe("matching rules (both channels)", () => {
  test.each([["UI", () => sUI], ["AI", () => sAI]])("1/11. %s: check number + bank amount 980 (withholding CV) is EXACT CHECK_NO", async (_c, s) => {
    const [m] = norm(await pending(await lineOf(s(), "Check WHT")));
    expect(m).toMatchObject({ type: "CV", docId: doc.cvWht, matchType: "EXACT", level: "CHECK_NO", amount: "980.00" });
  });

  test.each([["UI", () => sUI], ["AI", () => sAI]])("2. %s: document number in the reference is EXACT REFERENCE", async (_c, s) => {
    const [m] = norm(await pending(await lineOf(s(), "By reference")));
    expect(m).toMatchObject({ docId: doc.cvRef, matchType: "EXACT", level: "REFERENCE" });
  });

  test.each([["UI", () => sUI], ["AI", () => sAI]])("3. %s: amount + date only is a suggestion", async (_c, s) => {
    const [m] = norm(await pending(await lineOf(s(), "Deposit 250")));
    expect(m).toMatchObject({ docId: doc.or250, matchType: "SUGGESTED", level: "AMOUNT_DATE" });
  });

  test.each([["UI", () => sUI], ["AI", () => sAI]])("4. %s: one check number on two documents is AMBIGUOUS", async (_c, s) => {
    const ms = norm(await pending(await lineOf(s(), "Tie")));
    expect(ms.map((m) => m.matchType)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
  });

  test.each([["UI", () => sUI], ["AI", () => sAI]])("12. %s: OR bank movement amount 600 by reference", async (_c, s) => {
    const [m] = norm(await pending(await lineOf(s(), "Deposit 600")));
    expect(m).toMatchObject({ type: "OR", docId: doc.or600, matchType: "EXACT", amount: "600.00" });
  });

  test.each([["UI", () => sUI], ["AI", () => sAI]])("7/8/6. %s: Draft, other-bank and other-company documents are never suggested", async (_c, s) => {
    for (const d of ["Draft pay", "Other bank", "B check"]) expect(await pending(await lineOf(s(), d))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("confirmation: the assistant goes through the same guard, strictly", () => {
  test("16. the assistant cannot confirm an AMBIGUOUS candidate; nothing changes", async () => {
    const before = await reconSnapshot();
    const [m] = await pending(await lineOf(sAI, "Tie"));
    const res = await ai("acctA", "confirmMatch", m.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATCH_NOT_STRICT_EXACT");
    expect(await reconSnapshot()).toEqual(before);
  });

  test("the assistant cannot confirm an amount/date suggestion either", async () => {
    const [m] = await pending(await lineOf(sAI, "Deposit 250"));
    const res = await ai("acctA", "confirmMatch", m.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATCH_NOT_STRICT_EXACT");
  });

  test("the accountant can still choose one AMBIGUOUS candidate in the workspace", async () => {
    const [m] = await pending(await lineOf(sUI, "Tie"));
    expect((await api("acctA", "post", `/api/bank-recon/matches/${m.id}/confirm`)).status).toBe(200);
  });

  test("21/22. assistant confirmation of a strict EXACT match uses the same service and the same audit event", async () => {
    const [uiM] = await pending(await lineOf(sUI, "Check WHT"));
    expect((await api("acctA", "post", `/api/bank-recon/matches/${uiM.id}/confirm`)).status).toBe(200);

    const [aiM] = await pending(await lineOf(sAI, "Deposit 600"));
    const spy = jest.spyOn(MatchService, "confirmMatch");
    const res = await ai("acctA", "confirmMatch", aiM.id);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ matchId: aiM.id, strict: true, channel: "AI_ASSISTANT" }));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "CONFIRMED", amount: 600 });

    const audit = (id) => one("SELECT module, entity_type, action, user_id, company_id, description, after_data FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'MATCH' AND entity_id = ? ORDER BY id DESC LIMIT 1", [id]);
    const uiA = await audit(uiM.id);
    const aiA = await audit(aiM.id);
    for (const a of [uiA, aiA]) {
      expect(a).toMatchObject({ module: "BANK_RECON", entity_type: "MATCH", action: "MATCH", user_id: users.acctA.id, company_id: co.A });
      expect(a.description).toMatch(/^Confirmed EXACT match: statement line #\d+ <-> (CV|OR) #\d+$/);
      expect(a.description).not.toMatch(/AI/);
    }
    const after = (a) => (typeof a.after_data === "string" ? JSON.parse(a.after_data) : a.after_data);
    expect(after(uiA)).toEqual({ status: "CONFIRMED", amount: 980 });
    expect(after(aiA)).toEqual({ status: "CONFIRMED", amount: 600, channel: "AI_ASSISTANT" });
  });

  test("18/9. the assistant cannot bypass already-confirmed protection", async () => {
    const before = await reconSnapshot();
    const [m] = await pending(await lineOf(sAI, "Check WHT"));
    const res = await ai("acctA", "confirmMatch", m.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_ALREADY_MATCHED");
    expect(await confirmedFor("CV", doc.cvWht)).toHaveLength(1);
    expect(await reconSnapshot()).toEqual(before);
  });

  test("10. an already-matched statement line cannot take another match (both channels)", async () => {
    const line = await lineOf(sAI, "Deposit 600");
    const extra = await tamperedSuggestion(sAI, line, "CV", doc.cvRef, 450);
    expect((await ai("acctA", "confirmMatch", extra)).status).toBe(409);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${extra}/confirm`)).status).toBe(409);
    const manual = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: line, bookSourceType: "CV", bookSourceId: doc.cvRef });
    expect(manual.status).toBe(409);
    expect(manual.body.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");
  });

  test.each([
    ["17/8. Draft document", "Draft pay", "CV", () => doc.cvDraft, 70, 409, "BOOK_DOCUMENT_NOT_POSTED"],
    ["7. another bank account", "Other bank", "CV", () => doc.cvBk2, 90, 409, "BOOK_DOCUMENT_OTHER_BANK"],
    ["19/6. another company's document", "B check", "CV", () => doc.cvB, 333, 404, undefined],
    ["5. wrong direction", "Deposit 250", "CV", () => doc.cvRef, 250, 400, "MATCH_DIRECTION_MISMATCH"],
  ])("%s: refused through the assistant and the workspace, nothing changes", async (_n, desc, type, id, amount, status, code) => {
    for (const s of [sAI, sUI]) {
      const line = await lineOf(s, desc);
      const m = await tamperedSuggestion(s, line, type, id(), amount);
      const before = await reconSnapshot();
      const viaAi = await ai("acctA", "confirmMatch", m);
      const viaUi = await api("acctA", "post", `/api/bank-recon/matches/${m}/confirm`);
      for (const r of [viaAi, viaUi]) {
        expect(r.status).toBe(status);
        if (code) expect(r.body.code).toBe(code);
      }
      expect(await reconSnapshot()).toEqual(before);
      await pool.query("DELETE FROM bank_recon_matches WHERE id = ?", [m]);
    }
  });

  test("20. the assistant cannot supply a matched amount; the server's bank amount is stored", async () => {
    const [m] = await pending(await lineOf(sAI, "By reference"));
    await pool.query("UPDATE bank_recon_matches SET amount = 1 WHERE id = ?", [m.id]);
    // There is no amount parameter: an extra argument is simply not used.
    const res = await ai("acctA", "confirmMatch", m.id, { amount: 1 });
    expect(res.status).toBe(200);
    expect((await confirmedFor("CV", doc.cvRef))[0].amount).toBe("450.00");
  });

  test("13. manual amount tampering through the workspace is refused", async () => {
    const line = await lineOf(sUI, "Deposit 250");
    const res = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: line, bookSourceType: "OR", bookSourceId: doc.or250, amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATCH_AMOUNT_INVALID");
  });

  test("14. concurrent workspace + assistant confirmations of one document: one succeeds", async () => {
    const or = await voucher("or", "acctA", "A", { no: `${P}OR-RACE`, gross: 777, date: "2099-03-20", lines: [ln("BANK", 777, 0), ln("AR", 0, 777)] });
    const s = await sessionWithStatement("acctA", "r1");
    const lineA = await lineOf(s, "Deposit 250");
    const lineB = await lineOf(s, "Deposit 600");
    await pool.query("UPDATE bank_recon_statement_lines SET credit = 777 WHERE id IN (?)", [[lineA, lineB]]);
    const m1 = await tamperedSuggestion(s, lineA, "OR", or, 777);
    const m2 = await tamperedSuggestion(s, lineB, "OR", or, 777);
    const results = await Promise.all([
      api("acctA", "post", `/api/bank-recon/matches/${m1}/confirm`),
      ai("acctA", "confirmMatch", m2),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await confirmedFor("OR", or)).toHaveLength(1);
  });

  test("assistant bulk confirmation confirms only strict single EXACT matches", async () => {
    const s = await sessionWithStatement("acctA", "b1");
    await ai("acctA", "runMatchingForSession", s);
    const res = await ai("acctA", "bulkConfirmExact", s);
    expect(res.status).toBe(200);
    // Check WHT / By reference / Deposit 600 are already reconciled in other
    // sessions. CV-TIE-A was chosen by the accountant, so "Tie" now has one
    // unique check-number match (CV-TIE-B) - the only strict EXACT left.
    // Deposit 250 (amount/date only) must stay unconfirmed.
    expect(res.body.confirmedCount).toBe(1);
    const confirmed = await q("SELECT book_source_type AS type, book_source_id AS docId FROM bank_recon_matches WHERE session_id = ? AND status = 'CONFIRMED'", [s]);
    expect(confirmed).toEqual([{ type: "CV", docId: doc.cvTieB }]);
    expect((await one("SELECT match_status FROM bank_recon_statement_lines WHERE id = ?", [await lineOf(s, "Deposit 250")])).match_status).not.toBe("MATCHED");
  });
});

// ---------------------------------------------------------------------------
describe("assistant permissions and company isolation", () => {
  test("Company A cannot inspect or confirm Company B candidates through the assistant", async () => {
    const lineB = await lineOf(sB, "B check");
    const [mB] = await pending(lineB);
    const before = await reconSnapshot();
    expect((await ai("acctA", "getMatchCandidates", lineB)).status).toBe(404);
    expect((await ai("acctA", "confirmMatch", mB.id)).status).toBe(404);
    expect((await ai("acctA", "bulkConfirmExact", sB)).status).toBe(404);
    expect((await ai("acctA", "runMatchingForSession", sB)).status).toBe(404);
    expect(await reconSnapshot()).toEqual(before);
  });

  test("the service itself enforces company and permission, whoever calls it", async () => {
    const [mB] = await pending(await lineOf(sB, "B check"));
    await expect(MatchService.confirmMatch({ matchId: mB.id, user: users.acctA })).rejects.toMatchObject({ statusCode: 404 });
    await expect(MatchService.listCandidates({ statementLineId: await lineOf(sB, "B check"), user: users.acctA })).rejects.toMatchObject({ statusCode: 404 });
    const [mA] = await pending(await lineOf(sUI, "Deposit 250"));
    await expect(MatchService.confirmMatch({ matchId: mA.id, user: users.viewA })).rejects.toMatchObject({ statusCode: 403 });
    await expect(MatchService.confirmMatch({ matchId: mA.id, user: null })).rejects.toMatchObject({ statusCode: 403 });
  });

  test("a view-only user can read candidates through the assistant but not confirm", async () => {
    const line = await lineOf(sUI, "Deposit 250");
    expect((await ai("viewA", "getMatchCandidates", line)).status).toBe(200);
    const [m] = await pending(line);
    expect((await ai("viewA", "confirmMatch", m.id)).status).toBe(403);
  });

  test("Super Admin: company always comes from the session; new sessions need an explicit, valid company", async () => {
    const [mB] = await pending(await lineOf(sB, "B check"));
    const res = await ai("super", "confirmMatch", mB.id);
    expect(res.status).toBe(200);
    const a = await one("SELECT company_id, user_id FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'MATCH' AND entity_id = ? ORDER BY id DESC LIMIT 1", [mB.id]);
    expect(a).toEqual({ company_id: co.B, user_id: users.super.id });

    const noCompany = await ai("super", "findOrCreateSession", { bankAccountId: bank.BK, month: 4, year: 2099 });
    expect(noCompany.status).toBe(400);
    expect((await ai("super", "findOrCreateSession", { bankAccountId: bank.BK, month: 4, year: 2099, companyId: "abc" })).status).toBe(400);
    expect((await ai("super", "findOrCreateSession", { bankAccountId: bank.BK, month: 4, year: 2099, companyId: 999999999 })).status).toBe(403);
    expect((await ai("acctA", "findOrCreateSession", { bankAccountId: bank.BK, month: 4, year: 2099, companyId: co.B })).status).toBe(403);
  });

  test("outside a signed-in assistant turn every action is refused", async () => {
    await expect(AgentActions.confirmMatch(1)).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ---------------------------------------------------------------------------
describe("assistant conversation (deterministic provider) end to end", () => {
  async function say(who, convId, message) {
    return api(who, "post", `/api/ai/bank-recon/conversations/${convId}/messages`, { message });
  }

  test("explains a statement line from the engine's own candidates", async () => {
    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    const line = await lineOf(sAI, "Tie");
    const res = await say("acctA", conv.body.id, `Explain the candidates for line ${line}`);
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/AMBIGUOUS CV/);
    expect(res.body.reply).toMatch(/the accountant must choose in the workspace/);
  });

  test("'confirm all exact' confirms nothing that is not strict, and says so", async () => {
    const s = await sessionWithStatement("acctA", "c1");
    await ai("acctA", "runMatchingForSession", s);
    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    await pool.query("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [s, conv.body.id]);
    const before = await reconSnapshot();
    const res = await say("acctA", conv.body.id, "Confirm all exact matches");
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/Confirmed 0 exact match/);
    const after = await reconSnapshot();
    expect(after.confirmed).toBe(before.confirmed);
  });

  test("another company's statement line cannot be explained through a conversation", async () => {
    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    const res = await say("acctA", conv.body.id, `Explain line ${await lineOf(sB, "B check")}`);
    expect(res.status).toBe(404);
  });
});
