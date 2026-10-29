// R8.4-B - one bank deposit matched to several official receipts.
//   * the deterministic engine proposes combinations of ORs that add up to
//     the deposit exactly, inside explicit search limits;
//   * a combination is only a proposal: the accountant confirms it through
//     the one confirmation service, which re-checks every OR under lock and
//     confirms all of them or none;
//   * the assistant can explain a proposal but never confirm it.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { LIMITS, depositPool, findDepositCombinations, classifyCombinations } = require("../services/depositCombinationService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "r84b-";
const PW = "R84bPass!1";
const co = {};
const cur = {};
const acct = {};
const banks = [];
const tok = {};
const users = {};
const sessions = [];

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
// Each bank account has its own Cash in Bank GL account.
const bankCoa = {};
async function newBank(tag) {
  const code = `${P}BANK-${tag}`;
  const title = `R84B Cash in Bank ${tag}`;
  const coa = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, 'ASSET')", [code, title])).insertId, code, title };
  const id = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R84B', ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `R84B ${tag}`, `000-${tag}`, coa.id, coa.code])).insertId;
  banks.push(id);
  bankCoa[id] = coa;
  return id;
}
const ln = (a, debit, credit) => ({ accountId: a.id, accountCode: a.code, accountTitle: a.title, particulars: "", debit, credit });
async function voucher(kind, company, o) {
  const isCv = kind === "cv";
  const who = company === "A" ? "acctA" : "acctB";
  const res = await api(who, "post", `/api/${kind}`, {
    voucherNo: `${P}${o.no}`, [isCv ? "payeeName" : "customerName"]: o.party || "R84B Customer", transactionDate: o.date,
    referenceNo: o.ref || "", receiptNo: o.receiptNo || "", description: "R84B", status: o.status || "Posted",
    paymentMethod: o.checkNo ? "Check" : "Cash", bankAccountId: o.bank, checkNo: o.checkNo || "", checkDate: o.date,
    totalDebit: o.amount, totalCredit: o.amount,
    lines: isCv ? [ln(acct.EXP, o.amount, 0), ln(bankCoa[o.bank], 0, o.amount)] : [ln(bankCoa[o.bank], o.amount, 0), ln(acct.AR, 0, o.amount)],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date },
  });
  if (res.status !== 200) throw new Error(`${kind} ${o.no}: ${res.status} ${res.body.message}`);
  return res.body.id;
}
const or = (bank, no, amount, date, extra = {}) => voucher("or", extra.company || "A", { bank, no, amount, date, ...extra });
async function newSession(who, bank, start, end, o = {}) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: bank, periodStart: start, periodEnd: end, dateToleranceDays: 3,
    statementBeginningBalance: o.begin ?? 0, statementEndingBalance: o.end ?? 0, ...(o.companyId ? { companyId: o.companyId } : {}),
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
const run = (who, sid) => api(who, "post", `/api/bank-recon/sessions/${sid}/run-matching`);
const confirm = (who, matchId, expectedMatchIds) => api(who, "post", `/api/bank-recon/matches/${matchId}/confirm`, expectedMatchIds ? { expectedMatchIds } : {});
const groupRows = (sid) => q("SELECT id, statement_line_id AS lineId, book_source_id AS orId, match_group AS g, match_type AS t, status, amount FROM bank_recon_matches WHERE session_id = ? AND match_group IS NOT NULL ORDER BY id", [sid]);
// Every queue item (high confidence / needs review) for one statement row.
function itemFor(queue, description) {
  const h = queue.highConfidence.find((x) => x.line.description === description);
  if (h) return { bucket: "highConfidence", ...h, candidates: [h.candidate] };
  const r = queue.needsReview.find((x) => x.line.description === description);
  if (r) return { bucket: "needsReview", ...r };
  const u = queue.unmatchedBank.find((x) => x.line.description === description);
  return u ? { bucket: "unmatchedBank", ...u, candidates: [] } : null;
}
// Book-side accounting state of company A: vouchers, their lines and JVs.
async function accountingSnapshot() {
  const rows = {};
  for (const [k, sql] of [
    ["or", "SELECT id, status, total_debit, total_credit, tax_withheld_amount, bank_account_id, currency_id, updated_at FROM or_headers WHERE company_id = ? ORDER BY id"],
    ["orLines", "SELECT l.* FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id = ? ORDER BY l.id"],
    ["cv", "SELECT id, status, total_debit, total_credit, updated_at FROM cv_headers WHERE company_id = ? ORDER BY id"],
    ["jv", "SELECT COUNT(*) AS n FROM jv_headers WHERE company_id = ?"],
  ]) rows[k] = JSON.stringify(await q(sql, [co.A]));
  return rows;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  cur.USD = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'USD', 'US Dollar', '$', 0, 1)", [co.A])).insertId;
  for (const [k, t, c] of [["EXP", "R84B Expense", "EXPENSE"], ["AR", "R84B Receivable", "ASSET"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctA2", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users).map((u) => u.id);
    if (sessions.length) {
      for (const t of ["bank_recon_adjustments", "bank_recon_matches", "bank_recon_statement_lines", "bank_recon_import_batches"]) {
        await pool.query(`DELETE FROM ${t} WHERE session_id IN (?)`, [sessions]);
      }
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    }
    await pool.query("DELETE l FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id IN (?)", [cos]);
    await pool.query("DELETE l FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id IN (?)", [cos]);
    for (const t of ["or_headers", "cv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    if (banks.length) await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [banks]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("the search (pure, bounded)", () => {
  const session = { dateToleranceDays: 3 };
  const line = (credit, extra = {}) => ({ id: 1, txnDate: "2097-03-10", credit, debit: 0, description: "", ...extra });
  const item = (id, amount, date = "2097-03-09", extra = {}) => ({ sourceType: "OR", sourceId: id, lineId: null, direction: "IN", amount, date, voucherNo: `OR-${id}`, ...extra });

  test("limits are explicit", () => {
    expect(LIMITS).toEqual({ MAX_POOL: 25, MAX_SIZE: 4, MAX_COMBINATIONS: 20, MAX_STEPS: 50000, LOOKBACK_DAYS: 7, MAX_CONFIDENT_SIZE: 3, CLOSE_DAYS: 3 });
  });

  test("finds the exact 2-, 3- and 4-OR combinations; never 5", () => {
    const pool5 = [item(1, 1000), item(2, 2000), item(3, 3000), item(4, 4000), item(5, 5000)];
    expect(findDepositCombinations(line(3000), pool5, session).combos.map((c) => c.members.map((m) => m.sourceId))).toEqual([[1, 2]]);
    expect(findDepositCombinations(line(15000), pool5, session).combos).toEqual([]); // needs all five
    const four = findDepositCombinations(line(14000), pool5, session).combos.map((c) => c.members.map((m) => m.sourceId).sort());
    expect(four).toEqual([[2, 3, 4, 5]]);
  });

  test("never mixes in money out, foreign currency or reconciled ORs", () => {
    const all = [
      item(1, 1000), item(2, 2000),
      item(3, 2000, "2097-03-09", { direction: "OUT" }),
      item(4, 2000, "2097-03-09", { foreignCurrency: true }),
      item(5, 2000, "2097-03-09", { sourceType: "CV" }),
      item(6, 2000),
    ];
    const eligible = depositPool(all, new Set(["OR:6:"]));
    expect(eligible.map((t) => t.sourceId)).toEqual([1, 2]);
  });

  test("no combinatorial explosion: worst cases stay within the step and time limits", () => {
    // 60 receipts of the same amount: C(25,4) exact combinations exist
    const same = Array.from({ length: 60 }, (_, i) => item(i + 1, 100));
    let t0 = process.hrtime.bigint();
    const r1 = findDepositCombinations(line(400), same, session);
    const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r1.poolTruncated).toBe(true);
    expect(r1.considered).toBe(LIMITS.MAX_POOL);
    expect(r1.limitReached).toBe(true);
    expect(r1.combos).toHaveLength(LIMITS.MAX_COMBINATIONS);
    expect(classifyCombinations(r1).every((c) => c.matchType === "AMBIGUOUS" && /search limit/.test(c.ambiguous))).toBe(true);
    // 25 distinct amounts, a target no combination reaches
    const distinct = Array.from({ length: 25 }, (_, i) => item(i + 1, 1000 + i * 37.13));
    t0 = process.hrtime.bigint();
    const r2 = findDepositCombinations(line(3999.99), distinct, session);
    const ms2 = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r2.combos).toEqual([]);
    expect(r2.steps).toBeLessThanOrEqual(LIMITS.MAX_STEPS + 1);
    expect(ms1).toBeLessThan(500);
    expect(ms2).toBeLessThan(500);
    // eslint-disable-next-line no-console
    console.log(`R8.4-B search timing: 60 identical ORs ${ms1.toFixed(2)} ms (${r1.steps} steps); 25 distinct ORs ${ms2.toFixed(2)} ms (${r2.steps} steps)`);
  });

  test("a combination is strong only with full references, close dates and at most 3 ORs", () => {
    const named = line(3000, { description: "dep OR-1 OR-2" });
    expect(classifyCombinations(findDepositCombinations(named, [item(1, 1000), item(2, 2000)], session))[0].matchType).toBe("EXACT");
    expect(classifyCombinations(findDepositCombinations(line(3000), [item(1, 1000), item(2, 2000)], session))[0].matchType).toBe("SUGGESTED");
    const far = [item(1, 1000, "2097-03-04"), item(2, 2000)];
    expect(classifyCombinations(findDepositCombinations(named, far, session))[0]).toMatchObject({ matchType: "SUGGESTED", weakDates: true });
    const extra = line(3000, { description: "dep OR-1 OR-2 OR-9" });
    expect(classifyCombinations(findDepositCombinations(extra, [item(1, 1000), item(2, 2000), item(9, 50)], session))[0])
      .toMatchObject({ matchType: "SUGGESTED", inconsistentReference: true });
    const fourNamed = line(10000, { description: "OR-1 OR-2 OR-3 OR-4" });
    const four = [item(1, 1000), item(2, 2000), item(3, 3000), item(4, 4000)];
    expect(classifyCombinations(findDepositCombinations(fourNamed, four, session))[0].matchType).toBe("SUGGESTED");
  });
});

// ---------------------------------------------------------------------------
describe("one deposit, several ORs (HTTP)", () => {
  const ctx = {};

  test("one-to-one still wins: a single OR with the exact amount is proposed, no combination", async () => {
    const bank = await newBank("W1");
    ctx.w1Single = await or(bank, "W1-15000", 15000, "2097-03-09");
    await or(bank, "W1-5000", 5000, "2097-03-09");
    await or(bank, "W1-10000", 10000, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Deposit,,,,15000.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    expect(await groupRows(sid)).toEqual([]);
    const it = itemFor(await queueOf("acctA", sid), "Deposit");
    expect(it.candidates.every((c) => !c.group)).toBe(true);
    expect(it.candidates[0]).toMatchObject({ bookSourceId: ctx.w1Single, amount: 15000 });
  });

  test("3 ORs: OR-001 + OR-002 + OR-003 = deposit; one strong combination is high confidence with members, total and zero difference", async () => {
    const bank = await newBank("T3");
    ctx.t3Bank = bank;
    ctx.t3 = {
      a: await or(bank, "OR-001", 5000, "2097-03-08", { party: "Alpha Trading" }),
      b: await or(bank, "OR-002", 6000, "2097-03-09", { party: "Beta Foods" }),
      c: await or(bank, "OR-003", 4000, "2097-03-09", { party: "Gamma Corp" }),
    };
    ctx.t3Sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", ctx.t3Sid, [`2097-03-10,Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003,DEP-77,,,15000.00`])).status).toBe(200);
    expect((await run("acctA", ctx.t3Sid)).status).toBe(200);
    const rows = await groupRows(ctx.t3Sid);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.g)).size).toBe(1);
    expect(rows.every((r) => r.t === "EXACT" && r.status === "PENDING")).toBe(true);

    const queue = await queueOf("acctA", ctx.t3Sid);
    const it = itemFor(queue, `Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`);
    expect(it.bucket).toBe("highConfidence");
    const g = it.candidate;
    expect(g).toMatchObject({ group: true, total: 15000, depositAmount: 15000, difference: 0, strictExact: false, matchLevel: "GROUP_REFERENCE" });
    expect(g.members.map((m) => [m.voucherNo, m.txnDate, m.partyName, m.amount])).toEqual([
      [`${P}OR-001`, "2097-03-08", "Alpha Trading", 5000],
      [`${P}OR-002`, "2097-03-09", "Beta Foods", 6000],
      [`${P}OR-003`, "2097-03-09", "Gamma Corp", 4000],
    ]);
    expect(g.explanation).toBe(
      `Bank deposit ₱15,000.00 has a deterministic candidate consisting of ${P}OR-001, ${P}OR-002 and ${P}OR-003 totaling ₱15,000.00. The bank statement names every one of these receipts. Review and confirm the proposed match.`
    );
    expect(it.line).toMatchObject({ txnDate: "2097-03-10", amount: 15000, referenceNo: "DEP-77" });
    ctx.t3Group = g;
  });

  test("the assistant relays the same explanation, but cannot confirm the combination (strict) and bulk confirm skips it", async () => {
    const queue = await ai("acctA", "getReconciliationQueue", ctx.t3Sid);
    expect(queue.status).toBe(200);
    expect(queue.body.highConfidence[0].candidate.explanation).toBe(ctx.t3Group.explanation);
    const cands = await ai("acctA", "getMatchCandidates", queue.body.highConfidence[0].line.id);
    expect(cands.body.candidates[0]).toMatchObject({ group: true, explanation: ctx.t3Group.explanation });

    const res = await ai("acctA", "confirmMatch", ctx.t3Group.matchId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATCH_NOT_STRICT_EXACT");
    const bulk = await ai("acctA", "bulkConfirmExact", ctx.t3Sid);
    expect(bulk.body.confirmedCount).toBe(0);
    const http = await api("acctA", "post", "/api/bank-recon/matches/bulk-confirm", { sessionId: ctx.t3Sid });
    expect(http.body.confirmedCount).toBe(0);
    expect((await groupRows(ctx.t3Sid)).every((r) => r.status === "PENDING")).toBe(true);
  });

  test("malformed and unauthorized requests are refused without changing anything", async () => {
    expect((await confirm("acctA", ctx.t3Group.matchId, ["abc"])).status).toBe(400);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${ctx.t3Group.matchId}/confirm`, { expectedMatchIds: "1,2" })).status).toBe(400);
    expect([400, 404]).toContain((await confirm("acctA", "abc")).status);
    expect([403, 404]).toContain((await confirm("acctB", ctx.t3Group.matchId, ctx.t3Group.matchIds)).status);
    expect([403, 404]).toContain((await api("acctB", "get", `/api/bank-recon/sessions/${ctx.t3Sid}/queue`)).status);
    expect((await groupRows(ctx.t3Sid)).every((r) => r.status === "PENDING")).toBe(true);
  });

  test("a proposal that changed since review is refused (409) and nothing is confirmed", async () => {
    const stale = await confirm("acctA", ctx.t3Group.matchId, ctx.t3Group.matchIds.slice(0, 2));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("GROUP_PROPOSAL_CHANGED");
    expect((await groupRows(ctx.t3Sid)).every((r) => r.status === "PENDING")).toBe(true);
  });

  test("two accountants confirm the same combination at once: one succeeds, the other gets 409; every OR confirmed exactly once", async () => {
    const before = await accountingSnapshot();
    const [r1, r2] = await Promise.all([
      confirm("acctA", ctx.t3Group.matchId, ctx.t3Group.matchIds),
      confirm("acctA2", ctx.t3Group.matchIds[2], ctx.t3Group.matchIds),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const rows = await groupRows(ctx.t3Sid);
    expect(rows.map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
    expect(rows.map((r) => Number(r.amount))).toEqual([5000, 6000, 4000]);
    const line = (await statementLines("acctA", ctx.t3Sid))[0];
    expect(line).toMatchObject({ matchStatus: "MATCHED", confirmedMatchCount: 3 });
    // exactly one audit event, listing every OR
    const audits = await q("SELECT description, after_data FROM audit_logs WHERE module = 'BANK_RECON' AND entity_type = 'MATCH' AND entity_id IN (?) AND action = 'MATCH'", [ctx.t3Group.matchIds]);
    expect(audits).toHaveLength(1);
    expect(audits[0].description).toMatch(/one-to-many match.*OR-001.*OR-002.*OR-003/);
    // no accounting side effects - only the reconciliation tables changed
    expect(await accountingSnapshot()).toEqual(before);
    const summary = await summaryOf("acctA", ctx.t3Sid);
    expect(summary.depositsInTransit).toEqual([]);
  });

  test("unmatching the deposit releases every OR of the combination together", async () => {
    const before = await accountingSnapshot();
    const res = await api("acctA", "delete", `/api/bank-recon/matches/${ctx.t3Group.matchIds[1]}`);
    expect(res.status).toBe(200);
    expect((await groupRows(ctx.t3Sid)).map((r) => r.status)).toEqual(["REJECTED", "REJECTED", "REJECTED"]);
    expect((await statementLines("acctA", ctx.t3Sid))[0].matchStatus).toBe("UNMATCHED");
    expect((await summaryOf("acctA", ctx.t3Sid)).depositsInTransit.map((t) => t.sourceId).sort()).toEqual(Object.values(ctx.t3).sort());
    expect(await accountingSnapshot()).toEqual(before);
    // and it can be proposed and confirmed again
    expect((await run("acctA", ctx.t3Sid)).status).toBe(200);
    const g = itemFor(await queueOf("acctA", ctx.t3Sid), `Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`).candidate;
    expect((await confirm("acctA", g.matchId, g.matchIds)).status).toBe(200);
    ctx.t3Group = g;
  });

  test("Super Admin confirms through the record's own company", async () => {
    const bank = await newBank("SA");
    await or(bank, "SA-1", 1200, "2097-03-09");
    await or(bank, "SA-2", 800, "2097-03-09");
    const sid = await newSession("super", bank, "2097-03-01", "2097-03-31", { companyId: co.A });
    expect((await importRows("super", sid, [`2097-03-10,Dep ${P}SA-1 ${P}SA-2,,,,2000.00`])).status).toBe(200);
    expect((await run("super", sid)).status).toBe(200);
    const g = itemFor(await queueOf("super", sid), `Dep ${P}SA-1 ${P}SA-2`).candidate;
    expect(g.group).toBe(true);
    expect((await confirm("super", g.matchId, g.matchIds)).status).toBe(200);
    const audit = await one("SELECT company_id FROM audit_logs WHERE entity_type = 'MATCH' AND entity_id = ? AND action = 'MATCH'", [g.matchId]);
    expect(Number(audit.company_id)).toBe(co.A);
  });

  test("2 ORs by amount only: one combination is proposed but needs review", async () => {
    const bank = await newBank("T2");
    await or(bank, "T2-A", 4000, "2097-03-09");
    await or(bank, "T2-B", 6000, "2097-03-10");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Cash deposit,,,,10000.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const it = itemFor(await queueOf("acctA", sid), "Cash deposit");
    expect(it.bucket).toBe("needsReview");
    expect(it.candidates[0]).toMatchObject({ group: true, matchType: "SUGGESTED", matchLevel: "GROUP_AMOUNT", total: 10000, difference: 0 });
    expect(it.reason).toMatch(/evidence is weak/);
    expect(it.candidates[0].explanation).toMatch(/Only the amounts add up/);
    // the accountant can still confirm it after review
    expect((await confirm("acctA", it.candidates[0].matchId, it.candidates[0].matchIds)).status).toBe(200);
  });

  test("4 ORs (the size limit) are proposed but never high confidence; 5 are never proposed", async () => {
    const bank = await newBank("T4");
    for (const [n, a] of [["T4-1", 1000], ["T4-2", 2000], ["T4-3", 3000], ["T4-4", 4500]]) await or(bank, n, a, "2097-03-09");
    const bank5 = await newBank("T5");
    for (const [n, a] of [["T5-1", 100], ["T5-2", 200], ["T5-3", 300], ["T5-4", 400], ["T5-5", 500]]) await or(bank5, n, a, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}T4-1 ${P}T4-2 ${P}T4-3 ${P}T4-4,,,,10500.00`])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const it = itemFor(await queueOf("acctA", sid), `Dep ${P}T4-1 ${P}T4-2 ${P}T4-3 ${P}T4-4`);
    expect(it.bucket).toBe("needsReview");
    expect(it.candidates[0]).toMatchObject({ group: true, matchType: "SUGGESTED" });
    expect(it.candidates[0].members).toHaveLength(4);

    const sid5 = await newSession("acctA", bank5, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid5, ["2097-03-10,Five receipts,,,,1500.00"])).status).toBe(200);
    expect((await run("acctA", sid5)).status).toBe(200);
    expect(await groupRows(sid5)).toEqual([]);
    expect(itemFor(await queueOf("acctA", sid5), "Five receipts").bucket).toBe("unmatchedBank");
  });

  test("total mismatch: no combination; a deposit naming ORs that do not add up is an exception", async () => {
    const bank = await newBank("MM");
    await or(bank, "MM-1", 5000, "2097-03-09");
    await or(bank, "MM-2", 6000, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}MM-1 ${P}MM-2,,,,11500.00`])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    expect(await groupRows(sid)).toEqual([]);
    const queue = await queueOf("acctA", sid);
    const ex = queue.exceptions.find((e) => e.type === "GROUP_AMOUNT_MISMATCH");
    expect(ex.message).toBe(`Deposit ₱11,500.00 names OR ${P}MM-1, OR ${P}MM-2 (total ₱11,000.00), but the amounts do not reconcile (difference ₱500.00).`);
  });

  test("several combinations: all are AMBIGUOUS alternatives (closest dates first); the accountant picks one and the rest are rejected", async () => {
    const bank = await newBank("AM");
    const near1 = await or(bank, "AM-1000", 1000, "2097-03-10");
    const near2 = await or(bank, "AM-2000", 2000, "2097-03-10");
    await or(bank, "AM-1500a", 1500, "2097-03-05");
    await or(bank, "AM-1500b", 1500, "2097-03-05");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Over the counter,,,,3000.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const it = itemFor(await queueOf("acctA", sid), "Over the counter");
    expect(it.bucket).toBe("needsReview");
    expect(it.reason).toMatch(/^Multiple possible combinations found/);
    const groups = it.candidates.filter((c) => c.group);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.matchType === "AMBIGUOUS")).toBe(true);
    // date ranking: the same-day receipts rank first
    expect(groups[0].members.map((m) => m.bookSourceId).sort()).toEqual([near1, near2].sort());
    expect(groups[0].confidenceScore).toBeGreaterThan(groups[1].confidenceScore);
    expect(groups[0].explanation).toMatch(/Ambiguous: multiple possible combinations found - the accountant must choose/);

    // two users pick DIFFERENT alternatives at the same time: one wins
    const [r1, r2] = await Promise.all([
      confirm("acctA", groups[1].matchId, groups[1].matchIds),
      confirm("acctA2", groups[0].matchId, groups[0].matchIds),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const rows = await groupRows(sid);
    const winner = r1.status === 200 ? groups[1] : groups[0];
    expect(rows.filter((r) => r.status === "CONFIRMED").map((r) => r.id)).toEqual(winner.matchIds);
    expect(rows.filter((r) => r.status === "PENDING")).toEqual([]);
  });

  test("reference similarity: when the statement names one combination's ORs, that combination alone is high confidence", async () => {
    const bank = await newBank("RF");
    await or(bank, "RF-1000", 1000, "2097-03-10");
    await or(bank, "RF-2000", 2000, "2097-03-10");
    const named1 = await or(bank, "RF-1500a", 1500, "2097-03-09");
    const named2 = await or(bank, "RF-1500b", 1500, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}RF-1500a ${P}RF-1500b,,,,3000.00`])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const it = itemFor(await queueOf("acctA", sid), `Dep ${P}RF-1500a ${P}RF-1500b`);
    expect(it.bucket).toBe("highConfidence");
    expect(it.candidate.members.map((m) => m.bookSourceId).sort()).toEqual([named1, named2].sort());
  });

  test("isolation: ORs of another company or another bank account are never combined; candidates never mix them", async () => {
    const bank = await newBank("IS");
    const other = await newBank("IS2");
    await or(bank, "IS-A3000", 3000, "2097-03-09");
    await or(bank, "IS-B4000", 4000, "2097-03-09", { company: "B" });
    await or(other, "IS-A4000", 4000, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Isolated deposit,,,,7000.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    expect(await groupRows(sid)).toEqual([]);
    // company B's session on the same bank account sees only its own OR
    const sidB = await newSession("acctB", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctB", sidB, ["2097-03-10,B deposit,,,,7000.00"])).status).toBe(200);
    expect((await run("acctB", sidB)).status).toBe(200);
    expect(await groupRows(sidB)).toEqual([]);
    // every group row anywhere belongs to its session's company + bank account
    const mixed = await q(
      `SELECT m.id FROM bank_recon_matches m JOIN bank_recon_sessions s ON s.id = m.session_id
       JOIN or_headers o ON o.id = m.book_source_id
       WHERE m.match_group IS NOT NULL AND s.company_id IN (?) AND (o.company_id <> s.company_id OR o.bank_account_id <> s.bank_account_id)`,
      [Object.values(co)]
    );
    expect(mixed).toEqual([]);
  });

  test("already-reconciled, unposted, money-out and foreign-currency documents are excluded (mixed eligibility)", async () => {
    const bank = await newBank("EL");
    const done = await or(bank, "EL-done", 2000, "2097-02-27");
    await or(bank, "EL-1000", 1000, "2097-03-09");
    await or(bank, "EL-draft", 2000, "2097-03-09", { status: "Draft" });
    await voucher("cv", "A", { bank, no: "EL-CV2000", amount: 2000, date: "2097-03-09", checkNo: "88001" });
    const usd = await or(bank, "EL-usd", 2000, "2097-03-09");
    await q("UPDATE or_headers SET currency_id = ? WHERE id = ?", [cur.USD, usd]);
    // February reconciles EL-done
    const feb = await newSession("acctA", bank, "2097-02-01", "2097-02-28");
    expect((await importRows("acctA", feb, ["2097-02-28,Feb deposit,,,,2000.00"])).status).toBe(200);
    expect((await run("acctA", feb)).status).toBe(200);
    const febItem = itemFor(await queueOf("acctA", feb), "Feb deposit");
    expect(febItem.candidates[0]).toMatchObject({ bookSourceId: done });
    expect((await confirm("acctA", febItem.candidates[0].matchId)).status).toBe(200);

    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Mixed deposit,,,,3000.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    expect(await groupRows(sid)).toEqual([]);
    ctx.elBank = bank;
    ctx.elUsd = usd;
  });

  test("currency changed after the proposal: confirmation is refused (409) and rolled back", async () => {
    const bank = await newBank("CU");
    const a = await or(bank, "CU-1", 700, "2097-03-09");
    await or(bank, "CU-2", 300, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}CU-1 ${P}CU-2,,,,1000.00`])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const g = itemFor(await queueOf("acctA", sid), `Dep ${P}CU-1 ${P}CU-2`).candidate;
    await q("UPDATE or_headers SET currency_id = ? WHERE id = ?", [cur.USD, a]);
    const res = await confirm("acctA", g.matchId, g.matchIds);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GROUP_CURRENCY_MISMATCH");
    expect((await groupRows(sid)).every((r) => r.status === "PENDING")).toBe(true);
    expect((await statementLines("acctA", sid))[0].matchStatus).toBe("SUGGESTED");
  });

  test("revalidation: an OR unposted, re-amounted or reconciled elsewhere after the proposal -> 409, nothing confirmed", async () => {
    const bank = await newBank("RV");
    const a = await or(bank, "RV-1", 2500, "2097-03-09");
    const b = await or(bank, "RV-2", 1500, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}RV-1 ${P}RV-2,,,,4000.00`, "2097-03-12,Other deposit,,,,1500.00"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const g = itemFor(await queueOf("acctA", sid), `Dep ${P}RV-1 ${P}RV-2`).candidate;
    const pending = async () => (await q("SELECT status FROM bank_recon_matches WHERE match_group = ?", [g.matchGroup])).map((r) => r.status);

    await q("UPDATE or_headers SET status = 'Draft' WHERE id = ?", [a]);
    let res = await confirm("acctA", g.matchId, g.matchIds);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_NOT_POSTED");
    expect(await pending()).toEqual(["PENDING", "PENDING"]);
    await q("UPDATE or_headers SET status = 'Posted' WHERE id = ?", [a]);

    await q("UPDATE or_lines SET debit = 2400 WHERE or_id = ? AND account_id = ?", [a, bankCoa[bank].id]);
    res = await confirm("acctA", g.matchId, g.matchIds);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GROUP_PROPOSAL_CHANGED");
    expect(await pending()).toEqual(["PENDING", "PENDING"]);
    await q("UPDATE or_lines SET debit = 2500 WHERE or_id = ? AND account_id = ?", [a, bankCoa[bank].id]);

    // RV-2 is matched by hand to the other deposit first
    const other = (await statementLines("acctA", sid)).find((l) => l.description === "Other deposit");
    expect((await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: other.id, bookSourceType: "OR", bookSourceId: b })).status).toBe(200);
    res = await confirm("acctA", g.matchId, g.matchIds);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_ALREADY_MATCHED");
    expect(await pending()).toEqual(["PENDING", "PENDING"]);
    expect((await statementLines("acctA", sid)).find((l) => l.id !== other.id).matchStatus).toBe("SUGGESTED");
  });

  test("a finalized session refuses the confirmation", async () => {
    const bank = await newBank("FN");
    await or(bank, "FN-1", 600, "2097-03-09");
    await or(bank, "FN-2", 400, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, [`2097-03-10,Dep ${P}FN-1 ${P}FN-2,,,,1000.00`])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const g = itemFor(await queueOf("acctA", sid), `Dep ${P}FN-1 ${P}FN-2`).candidate;
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${sid}/finalize`, { overrideReason: "R84B test" })).status).toBe(200);
    const res = await confirm("acctA", g.matchId, g.matchIds);
    expect(res.status).toBe(400);
    expect((await q("SELECT status FROM bank_recon_matches WHERE match_group = ?", [g.matchGroup])).every((r) => r.status === "PENDING")).toBe(true);
  });

  test("carried-forward ORs from the previous period combine into a deposit early in the next period", async () => {
    const bank = await newBank("CF");
    const jan30 = await or(bank, "CF-1", 2200, "2097-03-30");
    const jan31 = await or(bank, "CF-2", 1800, "2097-03-31");
    const mar = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await run("acctA", mar)).status).toBe(200);
    const apr = await newSession("acctA", bank, "2097-04-01", "2097-04-30");
    expect((await importRows("acctA", apr, [`2097-04-02,Dep ${P}CF-1 ${P}CF-2,,,,4000.00`])).status).toBe(200);
    expect((await run("acctA", apr)).status).toBe(200);
    const queue = await queueOf("acctA", apr);
    expect(queue.unmatchedBook.filter((t) => t.carriedForward).map((t) => t.sourceId).sort()).toEqual([jan30, jan31].sort());
    const it = itemFor(queue, `Dep ${P}CF-1 ${P}CF-2`);
    expect(it.bucket).toBe("highConfidence");
    expect(it.candidate.members.map((m) => m.bookSourceId).sort()).toEqual([jan30, jan31].sort());
    expect((await confirm("acctA", it.candidate.matchId, it.candidate.matchIds)).status).toBe(200);
    expect((await queueOf("acctA", apr)).unmatchedBook).toEqual([]);
  });

  test("late-clearing check (one-to-one, check number) is unaffected", async () => {
    const bank = await newBank("LC");
    const cv = await voucher("cv", "A", { bank, no: "LC-CV", amount: 900, date: "2097-03-02", checkNo: "77001" });
    await or(bank, "LC-OR1", 400, "2097-04-20");
    await or(bank, "LC-OR2", 500, "2097-04-20");
    const sid = await newSession("acctA", bank, "2097-04-01", "2097-04-30");
    expect((await importRows("acctA", sid, ["2097-04-25,Check 77001,,77001,900.00,"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    const it = itemFor(await queueOf("acctA", sid), "Check 77001");
    expect(it.bucket).toBe("highConfidence");
    expect(it.candidate).toMatchObject({ bookSourceType: "CV", bookSourceId: cv, matchLevel: "CHECK_NO", strictExact: true });
    expect(await groupRows(sid)).toEqual([]);
  });

  test("an old (dropped) check older than the statement history stays outstanding, gets an attention item, and still matches by check number", async () => {
    const bank = await newBank("OLD");
    const cv = await voucher("cv", "A", { bank, no: "OLD-CV", amount: 1250, date: "2096-06-15", checkNo: "55501" });
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-05,Service fee,,,25.00,"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    let queue = await queueOf("acctA", sid);
    expect(queue.unmatchedBook.map((t) => [t.sourceId, t.carriedForward])).toEqual([[cv, true]]);
    const ex = queue.exceptions.find((e) => e.type === "OLD_OUTSTANDING_ITEM");
    expect(ex.document).toMatchObject({ type: "CV", id: cv, checkNo: "55501", beforeStatementHistory: true });
    expect(ex.message).toMatch(/outstanding for 289 days \(over 180\)\. It is dated before the first imported bank statement row \(2097-03-05\)/);
    expect(ex.message).toMatch(/stale or dropped check/);
    // the check finally clears: check-number matching still finds it
    expect((await importRows("acctA", sid, ["2097-03-20,Check 55501,,55501,1250.00,"])).status).toBe(200);
    expect((await run("acctA", sid)).status).toBe(200);
    queue = await queueOf("acctA", sid);
    const it = itemFor(queue, "Check 55501");
    expect(it.bucket).toBe("highConfidence");
    expect(it.candidate).toMatchObject({ bookSourceId: cv, matchLevel: "CHECK_NO" });
  });

  test("too many receipts for the search limits: manual review required, nothing guessed", async () => {
    const bank = await newBank("LIM");
    for (let i = 1; i <= LIMITS.MAX_POOL + 3; i++) await or(bank, `LIM-${i}`, 100, "2097-03-09");
    const sid = await newSession("acctA", bank, "2097-03-01", "2097-03-31");
    expect((await importRows("acctA", sid, ["2097-03-10,Bulk deposit,,,,250.50"])).status).toBe(200);
    const t0 = Date.now();
    expect((await run("acctA", sid)).status).toBe(200);
    const runMs = Date.now() - t0;
    expect(await groupRows(sid)).toEqual([]);
    const it = itemFor(await queueOf("acctA", sid), "Bulk deposit");
    expect(it).toMatchObject({ bucket: "needsReview", manualReview: true });
    expect(it.reason).toMatch(/^Manual review required/);
    // eslint-disable-next-line no-console
    console.log(`R8.4-B run-matching with ${LIMITS.MAX_POOL + 3} candidate ORs: ${runMs} ms`);
  });
});
