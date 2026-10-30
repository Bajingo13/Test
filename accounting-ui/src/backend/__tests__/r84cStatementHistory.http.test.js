// R8.4-C - bank statement history & reconciliation review.
//   * one company + bank account's imported statement rows, filtered and
//     paginated on the server, with statuses from the stored reconciliation
//     state and the deterministic queue;
//   * a read-only detail per row: its confirmed match (one-to-one or a
//     combination of ORs) with the engine's explanation, or its candidates;
//   * import history; the AI assistant reads the same data and can neither
//     invent nor confirm anything;
//   * the OR / CV payment-field investigation (no payment changes).
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "r84c-";
const PW = "R84cPass!1";
const co = {};
const cur = {};
const acct = {};
const banks = [];
const bankCoa = {};
const tok = {};
const users = {};
const sessions = [];
const convs = [];
const doc = {};
const s = {};

const q = async (sql, params) => (await pool.query(sql, params))[0];
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
async function newBank(tag) {
  const code = `${P}BANK-${tag}`;
  const title = `R84C Cash in Bank ${tag}`;
  const coa = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, 'ASSET')", [code, title])).insertId, code, title };
  const id = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R84C', ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `R84C ${tag}`, `000-${tag}`, coa.id, coa.code])).insertId;
  banks.push(id);
  bankCoa[id] = coa;
  return id;
}
const ln = (a, debit, credit) => ({ accountId: a.id, accountCode: a.code, accountTitle: a.title, particulars: "", debit, credit });
async function voucher(kind, company, o) {
  const isCv = kind === "cv";
  const who = company === "A" ? "acctA" : "acctB";
  const res = await api(who, "post", `/api/${kind}`, {
    voucherNo: `${P}${o.no}`, [isCv ? "payeeName" : "customerName"]: o.party || "R84C Party", transactionDate: o.date,
    referenceNo: o.ref || "", receiptNo: o.receiptNo || "", description: "R84C", status: "Posted",
    paymentMethod: o.method || (o.checkNo ? "Check" : "Cash"), bankAccountId: o.bank, checkNo: o.checkNo || "", checkDate: o.checkDate || o.date,
    totalDebit: o.amount, totalCredit: o.amount,
    lines: isCv ? [ln(acct.EXP, o.amount, 0), ln(bankCoa[o.bank], 0, o.amount)] : [ln(bankCoa[o.bank], o.amount, 0), ln(acct.AR, 0, o.amount)],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date },
  });
  if (res.status !== 200) throw new Error(`${kind} ${o.no}: ${res.status} ${res.body.message}`);
  return res.body.id;
}
async function newSession(who, bank, start, end, o = {}) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: bank, periodStart: start, periodEnd: end, dateToleranceDays: 3,
    ...(o.begin !== undefined ? { statementBeginningBalance: o.begin } : {}), statementEndingBalance: o.end ?? 0,
    ...(o.companyId ? { companyId: o.companyId } : {}),
  });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}
async function importRows(who, sid, rows, name = "stmt.csv") {
  const res = await request(app).post(`/api/bank-recon/sessions/${sid}/import`).set({ Authorization: `Bearer ${tok[who]}` })
    .attach("file", Buffer.from(["Date,Description,Reference,Check No,Debit,Credit", ...rows].join("\n")), name);
  if (res.status !== 200) throw new Error(`import ${res.status} ${res.body.message}`);
  return res.body;
}
const run = (who, sid) => api(who, "post", `/api/bank-recon/sessions/${sid}/run-matching`);
const queueOf = async (who, sid) => (await api(who, "get", `/api/bank-recon/sessions/${sid}/queue`)).body;
const history = (who, params) => api(who, "get", `/api/bank-recon/statement-history?${new URLSearchParams(params)}`);
const detail = (who, id) => api(who, "get", `/api/bank-recon/statement-history/lines/${id}`);
const lineId = async (desc) => (await q("SELECT id FROM bank_recon_statement_lines WHERE description = ? AND company_id IN (?)", [desc, Object.values(co)]))[0]?.id;
const A = () => ({ companyId: co.A, bankAccountId: s.bank });

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["EXP", "R84C Expense", "EXPENSE"], ["AR", "R84C Receivable", "ASSET"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("acctAB", "ACCOUNTANT", [co.A, co.B]);

  s.bank = await newBank("BK");
  s.bank2 = await newBank("BK2");

  // ---- January: one-to-one matches, an ignored fee, an unmatched credit ----
  doc.or1 = await voucher("or", "A", { bank: s.bank, no: "OR-JAN1", amount: 1000, date: "2097-01-10", party: "Alpha Trading" });
  doc.cv501 = await voucher("cv", "A", { bank: s.bank, no: "CV-501", amount: 500, date: "2097-01-11", checkNo: "501" });
  s.jan = await newSession("acctA", s.bank, "2097-01-01", "2097-01-31", { begin: 0, end: 485 });
  await importRows("acctA", s.jan, [
    `2097-01-10,Deposit ${P}OR-JAN1,${P}OR-JAN1,,,1000.00`,
    "2097-01-12,Check 501,,0000501,500.00,",
    "2097-01-20,Mystery fee,,,15.00,",
    "2097-01-25,Unknown credit,,,,77.00",
  ], "january.csv");
  await run("acctA", s.jan);
  const jq = await queueOf("acctA", s.jan);
  for (const h of jq.highConfidence) expect((await api("acctA", "post", `/api/bank-recon/matches/${h.candidate.matchId}/confirm`)).status).toBe(200);
  expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${await lineId("Mystery fee")}/ignore`)).status).toBe(200);
  expect((await api("acctA", "post", `/api/bank-recon/sessions/${s.jan}/finalize`, { overrideReason: "R84C fixture" })).status).toBe(200);

  // ---- February: a one-to-many deposit, an ambiguous deposit, an exception ----
  doc.f1 = await voucher("or", "A", { bank: s.bank, no: "OR-001", amount: 5000, date: "2097-02-08", party: "Alpha Trading" });
  doc.f2 = await voucher("or", "A", { bank: s.bank, no: "OR-002", amount: 6000, date: "2097-02-09", party: "Beta Foods" });
  doc.f3 = await voucher("or", "A", { bank: s.bank, no: "OR-003", amount: 4000, date: "2097-02-09", party: "Gamma Corp" });
  for (const [n, a, d] of [["AM-1000", 1000, "2097-02-20"], ["AM-2000", 2000, "2097-02-20"], ["AM-1500a", 1500, "2097-02-17"], ["AM-1500b", 1500, "2097-02-17"]]) {
    await voucher("or", "A", { bank: s.bank, no: n, amount: a, date: d });
  }
  doc.cv777 = await voucher("cv", "A", { bank: s.bank, no: "CV-777", amount: 900, date: "2097-02-05", checkNo: "777" });
  s.feb = await newSession("acctA", s.bank, "2097-02-01", "2097-02-28", { end: 0 });
  await importRows("acctA", s.feb, [
    `2097-02-10,Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003,DEP-777,,,15000.00`,
    "2097-02-20,Over the counter,,,,3000.00",
    "2097-02-06,Check 777,,777,950.00,",
    "2097-02-14,Another unknown,,,,33.00",
  ], "february.csv");
  await run("acctA", s.feb);
  const fq = await queueOf("acctA", s.feb);
  const group = fq.highConfidence.find((h) => h.candidate.group).candidate;
  expect((await api("acctA", "post", `/api/bank-recon/matches/${group.matchId}/confirm`, { expectedMatchIds: group.matchIds })).status).toBe(200);
  // A pre-R8.2-style duplicate (no fingerprint) of the "Another unknown" row.
  const [[orig]] = await pool.query("SELECT * FROM bank_recon_statement_lines WHERE id = ?", [await lineId("Another unknown")]);
  await q(`INSERT INTO bank_recon_statement_lines (batch_id, session_id, company_id, bank_account_id, txn_date, description, debit, credit, row_fingerprint, match_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'UNMATCHED')`,
  [orig.batch_id, orig.session_id, orig.company_id, orig.bank_account_id, orig.txn_date, orig.description, orig.debit, orig.credit]);

  // ---- Other bank account of A, and company B on the same bank account ----
  s.other = await newSession("acctA", s.bank2, "2097-02-01", "2097-02-28", { begin: 0 });
  await importRows("acctA", s.other, ["2097-02-03,Other bank row,,,,10.00"]);
  s.b = await newSession("acctB", s.bank, "2097-02-01", "2097-02-28", { begin: 0 });
  await importRows("acctB", s.b, ["2097-02-03,B secret deposit,B-REF-9,,,123.45"]);
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
      await pool.query("UPDATE bank_recon_sessions SET opening_balance_source_session_id = NULL WHERE id IN (?)", [sessions]);
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

const descs = (res) => res.body.rows.map((r) => r.description);

// ---------------------------------------------------------------------------
describe("statement history list", () => {
  test("loads one company + bank account, newest first, with statuses and flags", async () => {
    const res = await history("acctA", A());
    expect(res.status).toBe(200);
    expect(res.body.scope).toMatchObject({ companyId: co.A, bankAccountId: s.bank, bankCode: `${P}BK` });
    expect(res.body.total).toBe(9);
    const dates = res.body.rows.map((r) => `${r.txnDate}#${String(r.id).padStart(8, "0")}`);
    expect(dates).toEqual([...dates].sort().reverse());
    const by = Object.fromEntries(res.body.rows.map((r) => [r.description, r]));
    expect(by[`Deposit ${P}OR-JAN1`]).toMatchObject({ status: "MATCHED", direction: "IN", amount: 1000, match: { matchType: "EXACT", documents: [`OR ${P}OR-JAN1`] } });
    expect(by["Mystery fee"]).toMatchObject({ status: "IGNORED", ignored: true, direction: "OUT" });
    expect(by["Unknown credit"]).toMatchObject({ status: "UNMATCHED", carriedForward: true });
    expect(by["Over the counter"]).toMatchObject({ status: "NEEDS_REVIEW", carriedForward: false });
    expect(by["Check 777"]).toMatchObject({ status: "EXCEPTION" });
    expect(by[`Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`].match).toMatchObject({ oneToMany: true, total: 15000, documents: [`OR ${P}OR-001`, `OR ${P}OR-002`, `OR ${P}OR-003`] });
    expect(res.body.rows.filter((r) => r.description === "Another unknown").map((r) => r.possibleDuplicate).sort()).toEqual([false, true]);
    // nothing internal leaks
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/score_breakdown|scoreBreakdown|row_fingerprint|column_mapping/);
    expect(res.body.sessions.map((x) => x.id)).toEqual([s.feb, s.jan]);
  });

  test("date, type, amount and search filters run on the server", async () => {
    expect(descs(await history("acctA", { ...A(), from: "2097-02-01", to: "2097-02-10" })).sort())
      .toEqual(["Check 777", `Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`]);
    expect(descs(await history("acctA", { ...A(), type: "DEBIT" })).sort()).toEqual(["Check 501", "Check 777", "Mystery fee"]);
    expect((await history("acctA", { ...A(), type: "CREDIT" })).body.total).toBe(6);
    expect(descs(await history("acctA", { ...A(), amountMin: "900", amountMax: "1000" })).sort()).toEqual(["Check 777", `Deposit ${P}OR-JAN1`]);
    expect(descs(await history("acctA", { ...A(), q: "501" }))).toEqual(["Check 501"]); // check number (stored 0000501)
    expect(descs(await history("acctA", { ...A(), q: "DEP-777" }))).toEqual([`Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`]);
    expect(descs(await history("acctA", { ...A(), q: "mystery" }))).toEqual(["Mystery fee"]);
    expect((await history("acctA", { ...A(), q: "%" })).body.total).toBe(0); // LIKE wildcards are literal
  });

  test("status filters: matched, unmatched, needs review, exception, carried, ignored, duplicate", async () => {
    const st = async (status) => descs(await history("acctA", { ...A(), status })).sort();
    expect(await st("MATCHED")).toEqual(["Check 501", `Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`, `Deposit ${P}OR-JAN1`]);
    expect(await st("UNMATCHED")).toEqual(["Another unknown", "Another unknown", "Unknown credit"]);
    expect(await st("NEEDS_REVIEW")).toEqual(["Over the counter"]);
    expect(await st("EXCEPTION")).toEqual(["Check 777"]);
    expect(await st("CARRIED_FORWARD")).toEqual(["Unknown credit"]);
    expect(await st("IGNORED")).toEqual(["Mystery fee"]);
    expect(await st("POSSIBLE_DUPLICATE")).toEqual(["Another unknown"]);
  });

  test("session and import-batch filters; a session or batch of another scope is 404", async () => {
    // February's statement set includes January's carried row
    expect(descs(await history("acctA", { ...A(), sessionId: s.feb })).sort())
      .toEqual(["Another unknown", "Another unknown", "Check 777", `Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`, "Over the counter", "Unknown credit"]);
    const [[janBatch]] = await pool.query("SELECT id FROM bank_recon_import_batches WHERE session_id = ?", [s.jan]);
    expect((await history("acctA", { ...A(), batchId: janBatch.id })).body.total).toBe(4);
    const [[bBatch]] = await pool.query("SELECT id FROM bank_recon_import_batches WHERE session_id = ?", [s.b]);
    expect((await history("acctA", { ...A(), batchId: bBatch.id })).status).toBe(404);
    expect((await history("acctA", { ...A(), sessionId: s.b })).status).toBe(404);
    expect((await history("acctA", { ...A(), sessionId: s.other })).status).toBe(404);
  });

  test("pagination is bounded and deterministic", async () => {
    const all = (await history("acctA", { ...A(), pageSize: 100 })).body.rows.map((r) => r.id);
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      const res = await history("acctA", { ...A(), pageSize: 4, page });
      expect(res.body).toMatchObject({ page, pageSize: 4, total: 9, pageCount: 3 });
      pages.push(...res.body.rows.map((r) => r.id));
    }
    expect(pages).toEqual(all);
    expect((await history("acctA", { ...A(), pageSize: 5000 })).body.pageSize).toBe(100);
    expect((await history("acctA", { ...A(), page: 99 })).body.rows).toEqual([]);
  });

  test("malformed parameters are 400; unknown bank account 404", async () => {
    for (const bad of [
      { bankAccountId: "abc" }, { bankAccountId: s.bank, companyId: "x1" }, { ...A(), from: "2097-13-01" }, { ...A(), status: "WHATEVER" },
      { ...A(), type: "SIDEWAYS" }, { ...A(), amountMin: "-5" }, { ...A(), page: "0" }, { ...A(), sessionId: "1;DROP" }, { companyId: co.A },
    ]) {
      expect([bad, (await history("acctA", bad)).status]).toEqual([bad, 400]);
    }
    expect((await history("acctA", { companyId: co.A, bankAccountId: 999999999 })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("isolation", () => {
  test("company A cannot see or search company B's rows on the same bank account", async () => {
    const res = await history("acctA", A());
    expect(descs(res)).not.toContain("B secret deposit");
    expect((await history("acctA", { ...A(), q: "B-REF-9" })).body.total).toBe(0);
    expect((await history("acctA", { companyId: co.B, bankAccountId: s.bank })).status).toBe(403);
    expect(descs(await history("acctB", { companyId: co.B, bankAccountId: s.bank }))).toEqual(["B secret deposit"]);
  });

  test("bank account A never shows bank account B's rows", async () => {
    expect(descs(await history("acctA", A()))).not.toContain("Other bank row");
    expect(descs(await history("acctA", { companyId: co.A, bankAccountId: s.bank2 }))).toEqual(["Other bank row"]);
  });

  test("Super Admin and multi-company users must choose the company; an invalid one is refused", async () => {
    const none = await history("super", { bankAccountId: s.bank });
    expect(none.status).toBe(400);
    expect(none.body.message).toMatch(/Select the company/);
    expect((await history("acctAB", { bankAccountId: s.bank })).status).toBe(400);
    expect(descs(await history("super", { companyId: co.B, bankAccountId: s.bank }))).toEqual(["B secret deposit"]);
    expect((await history("super", { companyId: 999999999, bankAccountId: s.bank })).status).toBe(403);
    // the single-company accountant needs no choice
    expect((await history("acctA", { bankAccountId: s.bank })).body.scope.companyId).toBe(co.A);
  });

  test("another company's statement row and its match are never exposed through the detail", async () => {
    const bLine = await lineId("B secret deposit");
    expect((await detail("acctA", bLine)).status).toBe(404);
    expect((await detail("acctA", "abc")).status).toBe(404);
    expect((await detail("acctA", 999999999)).status).toBe(404);
    // a CONFIRMED match recorded against company A's row from company B's session is not shown
    const aLine = await lineId("Unknown credit");
    await q(`INSERT INTO bank_recon_matches (session_id, statement_line_id, book_source_type, book_source_id, match_type, status, amount)
             VALUES (?, ?, 'OR', ?, 'MANUAL', 'CONFIRMED', 77)`, [s.b, aLine, doc.or1]);
    const res = await detail("acctA", aLine);
    expect(res.body.confirmedMatch).toBeNull();
    const list = await history("acctA", { ...A(), q: "Unknown credit" });
    expect(list.body.rows[0].match).toBeNull();
    await q("DELETE FROM bank_recon_matches WHERE session_id = ? AND statement_line_id = ?", [s.b, aLine]);
  });
});

// ---------------------------------------------------------------------------
describe("transaction detail", () => {
  test("one-to-one: bank amount, document, zero difference, evidence, who and when", async () => {
    const res = await detail("acctA", await lineId("Check 501"));
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.line).toMatchObject({ txnDate: "2097-01-12", checkNo: "0000501", amount: 500, direction: "OUT" });
    expect(d.company).toEqual({ id: co.A, name: `${P}Co A` });
    expect(d.bankAccount).toMatchObject({ id: s.bank, bankCode: `${P}BK` });
    expect(d.batch).toMatchObject({ fileName: "january.csv", importedBy: `${P}acctA` });
    expect(d.status).toBe("MATCHED");
    const m = d.confirmedMatch;
    expect(m).toMatchObject({ oneToMany: false, matchType: "EXACT", matchLevel: "CHECK_NO", bankAmount: 500, total: 500, difference: 0, confirmedBy: `${P}acctA` });
    expect(m.documents).toEqual([expect.objectContaining({ bookSourceType: "CV", voucherNo: `${P}CV-501`, checkNo: "501", amount: 500, txnDate: "2097-01-11" })]);
    expect(m.explanation).toBe(`Bank statement check 0000501 for ₱500.00 matches CV ${P}CV-501 for ₱500.00: the check number and amount match exactly, and the CV is posted to this company and bank account. Strong evidence - can be confirmed.`);
    expect(m.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(d.readOnly).toBe(true); // January is finalized
    expect(d.candidates).toEqual([]);
  });

  test("one-to-many: every OR, total, difference, group, confidence, confirming user", async () => {
    const d = (await detail("acctA", await lineId(`Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`))).body;
    const m = d.confirmedMatch;
    expect(m).toMatchObject({ oneToMany: true, matchType: "EXACT", matchLevel: "GROUP_REFERENCE", bankAmount: 15000, total: 15000, difference: 0, confirmedBy: `${P}acctA` });
    expect(m.matchGroup).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.confidenceScore).toBeGreaterThan(0);
    expect(m.documents.map((x) => [x.voucherNo, x.amount, x.partyName])).toEqual([
      [`${P}OR-001`, 5000, "Alpha Trading"], [`${P}OR-002`, 6000, "Beta Foods"], [`${P}OR-003`, 4000, "Gamma Corp"],
    ]);
    expect(m.explanation).toMatch(/^Bank deposit ₱15,000\.00 has a deterministic candidate consisting of r84c-OR-001, r84c-OR-002 and r84c-OR-003 totaling ₱15,000\.00\./);
    expect(d.readOnly).toBe(false);
  });

  test("ambiguous / needs-review: the engine's alternatives with confidence and evidence; nothing confirmed", async () => {
    const d = (await detail("acctA", await lineId("Over the counter"))).body;
    expect(d.status).toBe("NEEDS_REVIEW");
    expect(d.confirmedMatch).toBeNull();
    const groups = d.candidates.filter((c) => c.group);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.matchType === "AMBIGUOUS" && g.difference === 0 && /Ambiguous: multiple possible combinations found/.test(g.explanation))).toBe(true);
    expect(d.workingSession.id).toBe(s.feb);
    expect(JSON.stringify(d)).not.toMatch(/scoreBreakdown/);
  });

  test("unmatched: no candidate, the reason, and the session to work it in", async () => {
    const d = (await detail("acctA", (await q("SELECT id FROM bank_recon_statement_lines WHERE description = 'Another unknown' AND row_fingerprint IS NOT NULL AND company_id = ?", [co.A]))[0].id)).body;
    expect(d).toMatchObject({ status: "UNMATCHED", candidates: [], possibleDuplicate: false, workingSession: { id: s.feb, status: "IN_PROGRESS" } });
    expect(d.reasonOutstanding).toMatch(/no candidate/);
  });

  test("exception: the queue's own exception message", async () => {
    const d = (await detail("acctA", await lineId("Check 777"))).body;
    expect(d.status).toBe("EXCEPTION");
    expect(d.exceptions[0].type).toBe("AMOUNT_MISMATCH");
    expect(d.reasonOutstanding).toMatch(/is ₱950\.00, but CV r84c-CV-777 moved ₱900\.00/);
  });

  test("carried forward: original session, current session and why it is still open; one row, not a copy", async () => {
    const id = await lineId("Unknown credit");
    const d = (await detail("acctA", id)).body;
    expect(d.carriedForward).toMatchObject({
      label: "Carried forward from January 2097",
      from: { sessionId: s.jan, periodStart: "2097-01-01", periodEnd: "2097-01-31" },
      currentSession: { id: s.feb },
    });
    expect(d.line.txnDate).toBe("2097-01-25");
    expect((await q("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE description = 'Unknown credit' AND company_id = ?", [co.A]))[0].n).toBe(1);
  });

  test("ignored: who and when, its period, and the un-ignore rule", async () => {
    const d = (await detail("acctA", await lineId("Mystery fee"))).body;
    expect(d.status).toBe("IGNORED");
    expect(d.ignored).toMatchObject({ by: `${P}acctA`, reason: null, period: { sessionId: s.jan } });
    expect(d.ignored.at).toMatch(/^\d{4}-/);
    expect(d.ignored.unIgnoreRule).toMatch(/its own reconciliation session \(#\d+, 2097-01-01 to 2097-01-31\)/);
  });

  test("possible duplicate: the suspected original with its import and session; nothing merged", async () => {
    const [dup] = await q("SELECT id FROM bank_recon_statement_lines WHERE description = 'Another unknown' AND row_fingerprint IS NULL AND company_id = ?", [co.A]);
    const d = (await detail("acctA", dup.id)).body;
    expect(d.possibleDuplicate).toBe(true);
    expect(d.duplicates).toEqual([expect.objectContaining({ description: "Another unknown", batchFileName: "february.csv", sessionId: s.feb, evidence: expect.stringMatching(/Same date, amount/) })]);
    expect((await q("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE description = 'Another unknown' AND company_id = ?", [co.A]))[0].n).toBe(2);
  });

  test("stale / replaced proposals: a re-run replaces candidates; the old match id is refused", async () => {
    const id = await lineId("Over the counter");
    const before = (await detail("acctA", id)).body.candidates.map((c) => c.id);
    expect((await run("acctA", s.feb)).status).toBe(200);
    const after = (await detail("acctA", id)).body.candidates.map((c) => c.id);
    expect(after).toHaveLength(before.length);
    expect(after.some((x) => before.includes(x))).toBe(false);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${before[0]}/confirm`)).status).toBe(404);
    expect((await detail("acctA", id)).body.confirmedMatch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("import history and finalized sessions", () => {
  test("import history shows the stored batch values, newest first, scoped", async () => {
    const res = await api("acctA", "get", `/api/bank-recon/statement-history/imports?${new URLSearchParams(A())}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.fileName)).toEqual(["february.csv", "january.csv"]);
    expect(res.body.rows[1]).toMatchObject({ rowCount: 4, importedCount: 4, duplicateCount: 0, importedBy: `${P}acctA`, status: "IMPORTED", sessionId: s.jan, sessionStatus: "FINALIZED" });
    expect(res.body.rows[0].importedCount).toBe(5); // 4 imported + the legacy duplicate row
    expect(res.body.rows[0].parserVersion).not.toBeUndefined();
    const b = await api("acctA", "get", `/api/bank-recon/statement-history/imports?${new URLSearchParams({ companyId: co.B, bankAccountId: s.bank })}`);
    expect(b.status).toBe(403);
  });

  test("a finalized session stays read-only: the detail says so and every change is refused", async () => {
    const id = await lineId("Check 501");
    expect((await detail("acctA", id)).body).toMatchObject({ readOnly: true, workingSession: { id: s.jan, status: "FINALIZED" } });
    const [m] = await q("SELECT id FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'CONFIRMED'", [id]);
    expect((await api("acctA", "delete", `/api/bank-recon/matches/${m.id}`)).status).toBe(400);
    expect((await api("acctA", "post", `/api/bank-recon/statement-lines/${await lineId("Mystery fee")}/ignore`)).status).toBe(400);
    expect((await run("acctA", s.jan)).status).toBe(400);
    const imp = await request(app).post(`/api/bank-recon/sessions/${s.jan}/import`).set({ Authorization: `Bearer ${tok.acctA}` })
      .attach("file", Buffer.from("Date,Description,Debit,Credit\n2097-01-30,Late,1.00,"), "late.csv");
    expect(imp.status).toBe(400);
    expect((await q("SELECT status FROM bank_recon_matches WHERE id = ?", [m.id]))[0].status).toBe("CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
describe("AI assistant on the statement history", () => {
  test("history and line detail come from the same service and need the session's company", async () => {
    const h = await ai("acctA", "getBankHistory", s.feb, { status: "CARRIED_FORWARD" });
    expect(h.status).toBe(200);
    expect(h.body.rows.map((r) => r.description)).toEqual(["Unknown credit"]);
    expect((await ai("acctB", "getBankHistory", s.feb, {})).status).toBe(404);
    const d = await ai("acctA", "getBankLineDetail", await lineId(`Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`));
    expect(d.body.confirmedMatch.documents).toHaveLength(3);
    expect((await ai("acctB", "getBankLineDetail", await lineId("Check 501"))).status).toBe(404);
  });

  async function say(message, sessionId = s.feb) {
    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    if (sessionId) await pool.query("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [sessionId, conv.body.id]);
    return api("acctA", "post", `/api/ai/bank-recon/conversations/${conv.body.id}/messages`, { message });
  }

  test("'why was this deposit matched to these ORs?' is answered from the confirmed match", async () => {
    const id = await lineId(`Deposit ${P}OR-001 ${P}OR-002 ${P}OR-003`);
    const res = await say(`Why was line ${id} matched to these ORs?`);
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/Reconciled - confirmed by r84c-acctA/);
    expect(res.body.reply).toMatch(/OR r84c-OR-001 ₱ 5,000\.00, OR r84c-OR-002 ₱ 6,000\.00, OR r84c-OR-003 ₱ 4,000\.00 \(total ₱ 15,000\.00, difference ₱ 0\.00\)/);
    expect(res.body.reply).toMatch(/deterministic candidate consisting of/);
  });

  test("an unreconciled line is never called reconciled; with no evidence it says it cannot determine", async () => {
    const res = await say(`Why was line ${await lineId("Unknown credit")} matched?`);
    expect(res.body.reply).toMatch(/Not reconciled, and I cannot determine a match/);
    expect(res.body.reply).not.toMatch(/Reconciled -/);
    const amb = await say(`Explain line ${await lineId("Over the counter")}`);
    expect(amb.body.reply).toMatch(/Not reconciled yet - these are suggestions only/);
  });

  test("'show me the unmatched bank transactions' and 'carried-forward items' list history rows", async () => {
    const un = await say("Show me the unmatched bank transactions");
    expect(un.body.reply).toMatch(/3 unmatched bank transaction\(s\)/);
    expect(un.body.reply).toMatch(/Unknown credit ₱ 77\.00 \(in\) - unmatched \[carried forward\]/);
    expect(un.body.reply).toMatch(/possible duplicate/);
    const cf = await say("Show me the carried-forward items");
    expect(cf.body.reply).toMatch(/1 carried-forward bank transaction\(s\)/);
    const att = await say("What still needs my attention?");
    expect(att.body.reply).toMatch(/needs your attention/);
  });

  test("the assistant cannot confirm or unmatch: no such tools, and confirming a combination is refused", async () => {
    const tools = require("fs").readFileSync(require("path").join(__dirname, "..", "services", "ai", "AnthropicProvider.js"), "utf8");
    expect(tools).not.toMatch(/name: "unmatch/);
    expect(Object.keys(AgentActions)).not.toContain("unmatch");
    await run("acctA", s.feb);
    const g = (await detail("acctA", await lineId("Over the counter"))).body.candidates.find((c) => c.group);
    const res = await ai("acctA", "confirmMatch", g.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MATCH_NOT_STRICT_EXACT");
    expect((await detail("acctA", await lineId("Over the counter"))).body.confirmedMatch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R8.4-C investigation only - documents current behaviour, changes nothing.
describe("OR / CV payment fields (investigation)", () => {
  test("OR: receiptNo -> receipt_no and checkNo -> check_no are separate columns end to end", async () => {
    const id = await voucher("or", "A", { bank: s.bank2, no: "PAY-OR", amount: 50, date: "2097-03-01", receiptNo: "RCPT-77", checkNo: "CHK-88", ref: "REF-99", checkDate: "2097-03-02" });
    const [[row]] = await pool.query("SELECT payment_method, bank_account_id, check_no, DATE_FORMAT(check_date, '%Y-%m-%d') AS check_date, reference_no, receipt_no, currency_id FROM or_headers WHERE id = ?", [id]);
    expect(row).toEqual({ payment_method: "Check", bank_account_id: s.bank2, check_no: "CHK-88", check_date: "2097-03-02", reference_no: "REF-99", receipt_no: "RCPT-77", currency_id: cur.A });
    const got = (await api("acctA", "get", `/api/or/${id}`)).body;
    expect(got).toMatchObject({ receiptNo: "RCPT-77", checkNo: "CHK-88", referenceNo: "REF-99", paymentMethod: "Check" });
  });

  test("OR form: the header field labelled 'Check No.' is sent and reloaded as receiptNo (a label problem, not a mapping or column bug)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "pages", "TRANSACTIONS", "TransactionFormLayout.jsx"), "utf8");
    // submit: header form.checkNo goes to receiptNo (and remarks); the cash/check modal's checkNumber goes to checkNo
    expect(src).toMatch(/receiptNo: updatedForm\.checkNo/);
    expect(src).toMatch(/checkNo: \(code === "OR" \|\| code === "CV"\) && paymentMethod === "Check" \? checkNumber : null/);
    // load: OR header shows receiptNo back in the same "Check No." field; the modal reloads data.checkNo
    expect(src).toMatch(/: code === "OR"\s*\?\s*data\.receiptNo \|\| ""/);
    expect(src).toMatch(/setCheckNumber\(data\.checkNo \|\| ""\)/);
    const header = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "pages", "TRANSACTIONS", "TransactionVoucherHeader.jsx"), "utf8");
    expect(header).toMatch(/showCheckNo \? "Check No\." : "Transaction Type"/);
    const orPage = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "pages", "TRANSACTIONS", "OR.jsx"), "utf8");
    expect(orPage).toMatch(/showCheckNo=\{true\}/);
  });

  test("Cash OR / CV: no check fields are stored; CV has no receipt_no", async () => {
    const id = await voucher("or", "A", { bank: s.bank2, no: "PAY-OR-CASH", amount: 20, date: "2097-03-01", method: "Cash" });
    const [[row]] = await pool.query("SELECT payment_method, check_no FROM or_headers WHERE id = ?", [id]);
    expect(row.payment_method).toBe("Cash");
    const cv = await voucher("cv", "A", { bank: s.bank2, no: "PAY-CV", amount: 30, date: "2097-03-01", checkNo: "CV-CHK-1", ref: "CV-REF" });
    const [[c]] = await pool.query("SELECT payment_method, check_no, reference_no, bank_account_id FROM cv_headers WHERE id = ?", [cv]);
    expect(c).toEqual({ payment_method: "Check", check_no: "CV-CHK-1", reference_no: "CV-REF", bank_account_id: s.bank2 });
    const [cols] = await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cv_headers' AND COLUMN_NAME = 'receipt_no'");
    expect(cols).toEqual([]);
  });
});
