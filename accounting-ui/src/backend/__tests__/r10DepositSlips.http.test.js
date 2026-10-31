// R10 - deposit slips: OR / CV -> Deposit Slip -> bank statement deposit.
//   * a slip groups posted Cash / Check bank items of one company + bank
//     account (server-computed total, company-unique DS number), never posts
//     a journal or changes a document;
//   * a document is on at most one active slip (database + service);
//   * Bank Reconciliation proposes the slip first (deposit number on the
//     statement, then exact total on a compatible date) and confirms it
//     through the existing all-or-nothing group confirmation; R8.4-B
//     combinations remain the fallback;
//   * the assistant can read slips, never change them.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "r10-";
const PW = "R10Pass!1";
const co = {};
const cur = {};
const acct = {};
const banks = [];
const bankCoa = {};
const tok = {};
const users = {};
const sessions = [];
const convs = [];
let seq = 0;

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
async function newBank(tag) {
  const code = `${P}BANK-${tag}`;
  const coa = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, 'ASSET')", [code, `R10 Bank ${tag}`])).insertId, code, title: `R10 Bank ${tag}` };
  const id = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R10', ?, ?, 'ACTIVE')",
    [`${P}${tag}`, `R10 ${tag}`, `000-${tag}`, coa.id, coa.code])).insertId;
  banks.push(id);
  bankCoa[id] = coa;
  return id;
}
const ln = (a, debit, credit) => ({ accountId: a.id, accountCode: a.code, accountTitle: a.title, particulars: "", debit, credit });
// o: { bank, amount, date, method, checkNo, status, company, moneyIn (CV only) }
async function doc(kind, o) {
  const company = o.company || "A";
  const who = company === "A" ? "acctA" : "acctB";
  const isCv = kind === "cv";
  const amt = o.amount;
  const method = o.method || "Cash";
  const lines = isCv
    ? (o.moneyIn ? [ln(bankCoa[o.bank], amt, 0), ln(acct.AR, 0, amt)] : [ln(acct.EXP, amt, 0), ln(bankCoa[o.bank], 0, amt)])
    : [ln(bankCoa[o.bank], amt, 0), ln(acct.AR, 0, amt)];
  const no = `${P}${kind.toUpperCase()}-${o.no || ++seq}`;
  const body = {
    voucherNo: no, referenceNo: no, [isCv ? "payeeName" : "customerName"]: o.party || "R10 Party",
    transactionDate: o.date || "2098-03-05", description: "R10", status: o.status || "Posted",
    paymentMethod: method, bankAccountId: o.bank, totalDebit: amt, totalCredit: amt, lines,
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date || "2098-03-05" },
  };
  if (method === "Check") Object.assign(body, { checkNo: o.checkNo || `CHK-${seq}`, checkDate: o.date || "2098-03-05" });
  if (method === "Bank Transfer") Object.assign(body, { paymentReference: `FT-${seq}`, paymentDate: o.date || "2098-03-05" });
  const res = await api(who, "post", `/api/${kind}`, body);
  if (res.status !== 200) throw new Error(`${kind} ${no}: ${res.status} ${res.body.message}`);
  return { type: kind.toUpperCase(), id: res.body.id, no };
}
const items = (...docs) => docs.map((d) => ({ type: d.type, id: d.id }));
const createSlip = (who, body) => api(who, "post", "/api/bank-recon/deposit-slips", body);
const slip = async (who, id) => (await api(who, "get", `/api/bank-recon/deposit-slips/${id}`)).body;
async function makeSlip(bank, depositDate, docs, { deposit = true, who = "acctA" } = {}) {
  const res = await createSlip(who, { bankAccountId: bank, depositDate, items: items(...docs) });
  if (res.status !== 200) throw new Error(`slip ${res.status} ${res.body.message}`);
  if (deposit) {
    const d = await api(who, "post", `/api/bank-recon/deposit-slips/${res.body.id}/deposit`);
    if (d.status !== 200) throw new Error(`deposit ${d.status} ${d.body.message}`);
  }
  return res.body;
}
async function newSession(bank, start, end, who = "acctA") {
  const res = await api(who, "post", "/api/bank-recon/sessions", { bankAccountId: bank, periodStart: start, periodEnd: end, dateToleranceDays: 3, statementBeginningBalance: 0, statementEndingBalance: 0 });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}
async function importRows(sid, rows, who = "acctA") {
  const res = await request(app).post(`/api/bank-recon/sessions/${sid}/import`).set({ Authorization: `Bearer ${tok[who]}` })
    .attach("file", Buffer.from(["Date,Description,Reference,Check No,Debit,Credit", ...rows].join("\n")), "stmt.csv");
  if (res.status !== 200) throw new Error(`import ${res.status} ${res.body.message}`);
}
const run = (sid, who = "acctA") => api(who, "post", `/api/bank-recon/sessions/${sid}/run-matching`);
const lineOf = async (sid, desc) => (await one("SELECT id FROM bank_recon_statement_lines WHERE description = ? AND company_id IN (?) ORDER BY id DESC LIMIT 1", [desc, Object.values(co)])).id;
const candidates = async (lineId, who = "acctA") => (await api(who, "get", `/api/bank-recon/statement-lines/${lineId}/candidates`)).body;
async function accountingSnapshot() {
  const out = {};
  for (const [k, sql] of [
    ["or", "SELECT id, status, total_debit, total_credit, payment_method, bank_account_id, updated_at FROM or_headers WHERE company_id IN (?) ORDER BY id"],
    ["orLines", "SELECT l.* FROM or_lines l JOIN or_headers h ON h.id = l.or_id WHERE h.company_id IN (?) ORDER BY l.id"],
    ["cv", "SELECT id, status, total_debit, total_credit, updated_at FROM cv_headers WHERE company_id IN (?) ORDER BY id"],
    ["cvLines", "SELECT l.* FROM cv_lines l JOIN cv_headers h ON h.id = l.cv_id WHERE h.company_id IN (?) ORDER BY l.id"],
    ["jv", "SELECT COUNT(*) AS n FROM jv_headers WHERE company_id IN (?)"],
  ]) out[k] = JSON.stringify(await q(sql, [Object.values(co)]));
  return out;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["EXP", "R10 Expense", "EXPENSE"], ["AR", "R10 Receivable", "ASSET"]]) {
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
    await pool.query("DELETE FROM deposit_slips WHERE company_id IN (?)", [cos]);
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
describe("schema", () => {
  test("two new tables with company / bank / OR / CV foreign keys and one-active-slip-per-document unique keys", async () => {
    const fks = await q(`SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS c, REFERENCED_TABLE_NAME AS r FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('deposit_slips', 'deposit_slip_lines') AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY t, c`);
    expect(fks.map((f) => `${f.t}.${f.c}->${f.r}`)).toEqual([
      "deposit_slip_lines.fk_deposit_line_cv->cv_headers",
      "deposit_slip_lines.fk_deposit_line_or->or_headers",
      "deposit_slip_lines.fk_deposit_line_slip->deposit_slips",
      "deposit_slips.fk_deposit_slip_bank->bank_codes",
      "deposit_slips.fk_deposit_slip_company->companies",
    ]);
    const uniques = await q(`SELECT DISTINCT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('deposit_slips', 'deposit_slip_lines') AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY' ORDER BY i`);
    expect(uniques.map((u) => u.i)).toEqual(["uq_deposit_line_active_cv", "uq_deposit_line_active_or", "uq_deposit_slip_company_no"]);
  });
});

// ---------------------------------------------------------------------------
describe("deposit slip workflow", () => {
  const w = {};
  beforeAll(async () => {
    w.bank = await newBank("WF");
    w.bank2 = await newBank("WF2");
    w.cash = await doc("or", { bank: w.bank, amount: 5000, method: "Cash" });
    w.check = await doc("or", { bank: w.bank, amount: 4000, method: "Check", checkNo: "000777" });
    w.check2 = await doc("or", { bank: w.bank, amount: 6000, method: "Check" });
    w.cvIn = await doc("cv", { bank: w.bank, amount: 500, method: "Cash", moneyIn: true });
    w.cvOut = await doc("cv", { bank: w.bank, amount: 450, method: "Cash" });
    w.transfer = await doc("or", { bank: w.bank, amount: 700, method: "Bank Transfer" });
    w.draft = await doc("or", { bank: w.bank, amount: 300, status: "Draft" });
    w.late = await doc("or", { bank: w.bank, amount: 800, date: "2098-03-20" });
    w.otherBank = await doc("or", { bank: w.bank2, amount: 900 });
    w.companyB = await doc("or", { bank: w.bank, amount: 5000, company: "B" });
  });

  test("eligible receipts: posted Cash / Check money-in documents of this company + bank on or before the deposit date", async () => {
    const res = await api("acctA", "get", `/api/bank-recon/deposit-slips/eligible?bankAccountId=${w.bank}&depositDate=2098-03-07`);
    expect(res.status).toBe(200);
    const keys = res.body.rows.map((r) => `${r.sourceType}:${r.sourceId}`).sort();
    expect(keys).toEqual([`CV:${w.cvIn.id}`, `OR:${w.cash.id}`, `OR:${w.check.id}`, `OR:${w.check2.id}`].sort());
    expect(res.body.rows.find((r) => r.sourceId === w.check.id)).toMatchObject({ paymentMethod: "Check", checkNo: "000777", amount: 4000 });
  });

  test("create: DRAFT, company-unique number, total computed from the documents (a client total is ignored)", async () => {
    const res = await createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(w.cash, w.check), totalAmount: 1, remarks: "Morning deposit" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ depositNo: "DS-00001", status: "DRAFT", total: 9000 });
    w.slipId = res.body.id;
    const d = await slip("acctA", w.slipId);
    expect(d).toMatchObject({ depositNo: "DS-00001", status: "DRAFT", totalAmount: 9000, editable: true, companyId: co.A, bankAccountId: w.bank, remarks: "Morning deposit" });
    expect(d.lines.map((l) => [l.sourceType, l.voucherNo, l.amount, l.paymentMethod])).toEqual([
      ["OR", w.cash.no, 5000, "Cash"], ["OR", w.check.no, 4000, "Check"],
    ]);
  });

  test("edit draft: add an OR and a CV, remove an OR; total follows", async () => {
    let res = await api("acctA", "put", `/api/bank-recon/deposit-slips/${w.slipId}`, { depositDate: "2098-03-07", items: items(w.cash, w.check, w.check2, w.cvIn) });
    expect(res.body).toMatchObject({ total: 15500 });
    res = await api("acctA", "put", `/api/bank-recon/deposit-slips/${w.slipId}`, { depositDate: "2098-03-07", items: items(w.check, w.check2, w.cvIn) });
    expect(res.body).toMatchObject({ total: 10500 });
    res = await api("acctA", "put", `/api/bank-recon/deposit-slips/${w.slipId}`, { depositDate: "2098-03-07", items: items(w.cash, w.check, w.check2) });
    expect(res.body).toMatchObject({ total: 15000 });
    expect((await slip("acctA", w.slipId)).lines.map((l) => l.sourceType)).toEqual(["OR", "OR", "OR"]);
  });

  test("ineligible documents are refused: other bank, other company, transfer, draft, money-out CV, dated after the deposit", async () => {
    for (const [d, code, status] of [
      [w.otherBank, "DEPOSIT_ITEM_NOT_ELIGIBLE", 409],
      [w.transfer, "DEPOSIT_ITEM_NOT_ELIGIBLE", 409],
      [w.draft, "DEPOSIT_ITEM_NOT_ELIGIBLE", 409],
      [w.cvOut, "DEPOSIT_ITEM_NOT_ELIGIBLE", 409],
      [w.late, "DEPOSIT_ITEM_NOT_ELIGIBLE", 409],
      [w.companyB, "DEPOSIT_ITEM_NOT_FOUND", 404],
    ]) {
      const res = await createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(d) });
      expect([d.no, res.status, res.body.code]).toEqual([d.no, status, code]);
    }
  });

  test("duplicates: the same document twice in one request, or already on another active slip", async () => {
    let res = await createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: [...items(w.cvIn), ...items(w.cvIn)] });
    expect([res.status, res.body.code]).toEqual([400, "DUPLICATE_DEPOSIT_ITEM"]);
    res = await createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(w.cash) });
    expect([res.status, res.body.code]).toEqual([409, "DEPOSIT_ITEM_ALREADY_DEPOSITED"]);
    expect(res.body.message).toMatch(/already in deposit slip DS-00001/);
    // the database refuses it too
    await expect(q("INSERT INTO deposit_slip_lines (deposit_slip_id, source_type, or_id, amount, payment_method) VALUES (?, 'OR', ?, 1, 'Cash')", [w.slipId, w.cash.id]))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  test("two users creating slips with the same document at once: one succeeds, the other gets 409", async () => {
    const extra = await doc("or", { bank: w.bank, amount: 250 });
    const [r1, r2] = await Promise.all([
      createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(extra) }),
      createSlip("acctA2", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(extra) }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await one("SELECT COUNT(*) n FROM deposit_slip_lines WHERE or_id = ? AND released_at IS NULL", [extra.id])).n).toBe(1);
    const winner = r1.status === 200 ? r1 : r2;
    await api("acctA", "post", `/api/bank-recon/deposit-slips/${winner.body.id}/cancel`, { reason: "test" });
  });

  test("concurrent creation numbers slips one after the other, per company", async () => {
    const docs = [];
    for (let i = 0; i < 4; i++) docs.push(await doc("or", { bank: w.bank, amount: 10 + i }));
    const res = await Promise.all(docs.map((d, i) => createSlip(i % 2 ? "acctA2" : "acctA", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(d) })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const nos = res.map((r) => r.body.depositNo).sort();
    expect(new Set(nos).size).toBe(4);
    for (const r of res) await api("acctA", "post", `/api/bank-recon/deposit-slips/${r.body.id}/cancel`, { reason: "test" });
    const b = await createSlip("acctB", { bankAccountId: w.bank, depositDate: "2098-03-07", items: items(w.companyB) });
    expect([b.status, b.body.depositNo]).toEqual([200, "DS-00001"]); // company B has its own sequence
    w.slipB = b.body.id;
  });

  test("mark deposited, then the slip is fixed; cancel releases its documents for a new slip", async () => {
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${w.slipId}/deposit`)).body).toMatchObject({ status: "DEPOSITED", total: 15000 });
    const edit = await api("acctA", "put", `/api/bank-recon/deposit-slips/${w.slipId}`, { depositDate: "2098-03-07", items: items(w.cash) });
    expect([edit.status, edit.body.code]).toEqual([409, "DEPOSIT_SLIP_NOT_EDITABLE"]);
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${w.slipId}/deposit`)).status).toBe(409);
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${w.slipId}/cancel`, {})).body.code).toBe("CANCEL_REASON_REQUIRED");
    const cancel = await api("acctA", "post", `/api/bank-recon/deposit-slips/${w.slipId}/cancel`, { reason: "Wrong bank date" });
    expect(cancel.body).toMatchObject({ status: "CANCELLED" });
    const d = await slip("acctA", w.slipId);
    expect(d).toMatchObject({ status: "CANCELLED", cancelReason: "Wrong bank date", cancelledBy: `${P}acctA`, editable: false });
    expect(d.lines.every((l) => l.releasedAt)).toBe(true);
    const again = await makeSlip(w.bank, "2098-03-07", [w.cash, w.check, w.check2]);
    expect(again.status).toBe("DRAFT");
    w.slipId = again.id;
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${w.slipId}/cancel`, { reason: "x" })).status).toBe(200);
    w.slipId = (await makeSlip(w.bank, "2098-03-07", [w.cash, w.check, w.check2])).id;
    expect((await slip("acctA", w.slipId)).status).toBe("DEPOSITED");
  });

  test("access: other company 404, malformed id 400, Super Admin must choose the company, wrong company 403", async () => {
    expect((await api("acctB", "get", `/api/bank-recon/deposit-slips/${w.slipId}`)).status).toBe(404);
    expect((await api("acctB", "post", `/api/bank-recon/deposit-slips/${w.slipId}/cancel`, { reason: "x" })).status).toBe(404);
    expect((await api("acctA", "get", `/api/bank-recon/deposit-slips/${w.slipB}`)).status).toBe(404);
    expect((await api("acctA", "get", "/api/bank-recon/deposit-slips/abc")).status).toBe(400);
    expect((await api("acctA", "get", "/api/bank-recon/deposit-slips/999999999")).status).toBe(404);
    expect((await api("super", "get", `/api/bank-recon/deposit-slips?bankAccountId=${w.bank}`)).status).toBe(400);
    const listB = await api("super", "get", `/api/bank-recon/deposit-slips?companyId=${co.B}&bankAccountId=${w.bank}`);
    expect(listB.body.rows.map((r) => r.id)).toEqual([w.slipB]);
    expect((await createSlip("acctA", { companyId: co.B, bankAccountId: w.bank, depositDate: "2098-03-07", items: [] })).status).toBe(403);
    expect((await createSlip("acctA", { bankAccountId: 999999999, depositDate: "2098-03-07", items: [] })).status).toBe(404);
    expect((await createSlip("acctA", { bankAccountId: w.bank, depositDate: "2098-02-30", items: [] })).status).toBe(400);
    const list = await api("acctA", "get", `/api/bank-recon/deposit-slips?bankAccountId=${w.bank}`);
    expect(list.body.rows.every((r) => r.id !== w.slipB)).toBe(true);
  });

  test("a document on a slip cannot be deleted from the database (RESTRICT)", async () => {
    await expect(q("DELETE FROM or_headers WHERE id = ?", [w.cash.id])).rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
  });

  test("audit: CREATE, EDIT, DEPOSIT, CANCEL with company, user, status, documents and total", async () => {
    const events = await q("SELECT action, company_id AS c, user_id AS u, before_data AS b, after_data AS a FROM audit_logs WHERE entity_type = 'DEPOSIT_SLIP' AND company_id = ? ORDER BY id", [co.A]);
    const actions = new Set(events.map((e) => e.action));
    for (const a of ["CREATE", "EDIT", "DEPOSIT", "CANCEL"]) expect(actions.has(a)).toBe(true);
    const dep = events.find((e) => e.action === "DEPOSIT");
    const after = typeof dep.a === "string" ? JSON.parse(dep.a) : dep.a;
    expect(after).toMatchObject({ status: "DEPOSITED" });
    expect(after.lines.length).toBeGreaterThan(0);
    expect(typeof after.total).toBe("number");
    expect(JSON.stringify(events)).not.toMatch(/password|token/i);
    expect(events.every((e) => Number(e.c) === co.A && e.u)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("Bank Reconciliation with deposit slips", () => {
  test("direct match by exact total + date: high confidence, explained, confirmed; no accounting entries; unmatch restores DEPOSITED", async () => {
    const bank = await newBank("DM");
    const a = await doc("or", { bank, amount: 5000, method: "Cash", date: "2098-04-05" });
    const b = await doc("or", { bank, amount: 4000, method: "Check", date: "2098-04-05" });
    const c = await doc("or", { bank, amount: 6000, method: "Check", date: "2098-04-06" });
    const s = await makeSlip(bank, "2098-04-07", [a, b, c]);
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, ["2098-04-08,Over the counter deposit,,,,15000.00"]);
    const before = await accountingSnapshot();
    expect((await run(sid)).status).toBe(200);
    const queue = (await api("acctA", "get", `/api/bank-recon/sessions/${sid}/queue`)).body;
    const h = queue.highConfidence.find((x) => x.line.description === "Over the counter deposit");
    expect(h.candidate).toMatchObject({ group: true, matchType: "EXACT", matchLevel: "DEPOSIT_SLIP", depositSlip: { id: s.id, depositNo: s.depositNo, evidence: "AMOUNT_DATE" }, total: 15000, difference: 0 });
    expect(h.candidate.explanation).toBe(`Bank statement deposit ₱15,000.00 matches Deposit Slip ${s.depositNo} for ₱15,000.00. The bank account and amount match and the deposit date is within tolerance; the statement does not name the slip. Review and confirm the match.`);
    // strict (assistant / bulk) confirmation is refused for a slip
    expect((await ai("acctA", "confirmMatch", h.candidate.matchId)).body.code).toBe("MATCH_NOT_STRICT_EXACT");
    expect((await api("acctA", "post", `/api/bank-recon/matches/${h.candidate.matchId}/confirm`, { expectedMatchIds: h.candidate.matchIds })).status).toBe(200);
    const d = await slip("acctA", s.id);
    expect(d).toMatchObject({ status: "RECONCILED", bankRecon: { status: "MATCHED", match: { statementDate: "2098-04-08", bankAmount: 15000, confirmedBy: `${P}acctA`, evidence: "AMOUNT_DATE" } } });
    expect(d.bankRecon.match.explanation).toMatch(/matches Deposit Slip DS-/);
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${s.id}/cancel`, { reason: "x" })).body.code).toBe("DEPOSIT_SLIP_RECONCILED");
    expect(await accountingSnapshot()).toEqual(before);
    // statement history shows the slip
    const hist = (await api("acctA", "get", `/api/bank-recon/statement-history/lines/${h.line.id}`)).body;
    expect(hist.confirmedMatch).toMatchObject({ oneToMany: true, depositSlip: { id: s.id, depositNo: s.depositNo } });
    expect(hist.confirmedMatch.explanation).toMatch(/matches Deposit Slip/);
    // unmatch
    const [m] = await q("SELECT id FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'CONFIRMED' LIMIT 1", [h.line.id]);
    expect((await api("acctA", "delete", `/api/bank-recon/matches/${m.id}`)).status).toBe(200);
    expect((await slip("acctA", s.id)).status).toBe("DEPOSITED");
    const audits = await q("SELECT action FROM audit_logs WHERE entity_type = 'DEPOSIT_SLIP' AND entity_id = ? ORDER BY id", [s.id]);
    expect(audits.map((x) => x.action)).toEqual(["CREATE", "DEPOSIT", "RECONCILE", "UNRECONCILE"]);
    expect(await accountingSnapshot()).toEqual(before);
  });

  test("the deposit number on the statement picks the right slip among equal totals; without it they are ambiguous", async () => {
    const bank = await newBank("REF");
    const s1 = await makeSlip(bank, "2098-04-07", [await doc("or", { bank, amount: 1000, date: "2098-04-05" }), await doc("cv", { bank, amount: 500, moneyIn: true, date: "2098-04-05" })]);
    const s2 = await makeSlip(bank, "2098-04-07", [await doc("or", { bank, amount: 1500, method: "Check", date: "2098-04-06" })]);
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, [`2098-04-08,Deposit ${s2.depositNo},,,,1500.00`]);
    await run(sid);
    const [c] = await candidates(await lineOf(sid, `Deposit ${s2.depositNo}`));
    expect(c).toMatchObject({ matchType: "EXACT", depositSlip: { id: s2.id, evidence: "DEPOSIT_REFERENCE" } });
    expect(c.explanation).toMatch(/The bank account, amount and deposit reference match\./);

    const bank2 = await newBank("AMB");
    const t1 = await makeSlip(bank2, "2098-04-07", [await doc("or", { bank: bank2, amount: 1500, date: "2098-04-05" })]);
    const t2 = await makeSlip(bank2, "2098-04-07", [await doc("or", { bank: bank2, amount: 1500, date: "2098-04-06" })]);
    const sid2 = await newSession(bank2, "2098-04-01", "2098-04-30");
    await importRows(sid2, ["2098-04-08,Cash deposit,,,,1500.00"]);
    await run(sid2);
    const cs = await candidates(await lineOf(sid2, "Cash deposit"));
    expect(cs.filter((x) => x.depositSlip).map((x) => [x.depositSlip.id, x.matchType]).sort()).toEqual([[t1.id, "AMBIGUOUS"], [t2.id, "AMBIGUOUS"]].sort());
    expect(s1.id).toBeTruthy();
  });

  test("a slip and a CV member: the slip can include a money-in CV and is confirmed with it", async () => {
    const bank = await newBank("CVM");
    const o = await doc("or", { bank, amount: 1000, date: "2098-04-05" });
    const v = await doc("cv", { bank, amount: 500, moneyIn: true, date: "2098-04-05" });
    const s = await makeSlip(bank, "2098-04-07", [o, v]);
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, [`2098-04-07,${s.depositNo},,,,1500.00`]);
    await run(sid);
    const [c] = await candidates(await lineOf(sid, s.depositNo));
    expect(c.members.map((m) => m.bookSourceType).sort()).toEqual(["CV", "OR"]);
    expect((await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`, { expectedMatchIds: c.matchIds })).status).toBe(200);
    expect((await slip("acctA", s.id)).status).toBe("RECONCILED");
  });

  test("no slip proposal on amount mismatch, another bank account or another company", async () => {
    const bank = await newBank("MIS");
    const other = await newBank("MIS2");
    const s = await makeSlip(bank, "2098-04-07", [await doc("or", { bank, amount: 2500, date: "2098-04-05" })]);
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, ["2098-04-08,Short deposit,,,,2499.00"]);
    await run(sid);
    expect((await candidates(await lineOf(sid, "Short deposit"))).some((x) => x.depositSlip)).toBe(false);
    const sidO = await newSession(other, "2098-04-01", "2098-04-30");
    await importRows(sidO, [`2098-04-08,Deposit ${s.depositNo},,,,2500.00`]);
    await run(sidO);
    expect((await candidates(await lineOf(sidO, `Deposit ${s.depositNo}`))).some((x) => x.depositSlip)).toBe(false);
    const sidB = await newSession(bank, "2098-04-01", "2098-04-30", "acctB");
    await importRows(sidB, [`2098-04-08,B deposit ${s.depositNo},,,,2500.00`], "acctB");
    await run(sidB, "acctB");
    expect((await candidates(await lineOf(sidB, `B deposit ${s.depositNo}`), "acctB")).some((x) => x.depositSlip)).toBe(false);
  });

  test("slip documents are never matched alone or in another combination; R8.4-B still works for documents without a slip", async () => {
    const bank = await newBank("FB");
    const slipped = await doc("or", { bank, amount: 3000, date: "2098-04-05" });
    await makeSlip(bank, "2098-04-07", [slipped, await doc("or", { bank, amount: 100, date: "2098-04-05" })]);
    const x = await doc("or", { bank, amount: 1000, date: "2098-04-06", no: "FB-X" });
    const y = await doc("or", { bank, amount: 2000, date: "2098-04-06", no: "FB-Y" });
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, [`2098-04-08,Dep ${x.no} ${y.no},,,,3000.00`]);
    await run(sid);
    const cs = await candidates(await lineOf(sid, `Dep ${x.no} ${y.no}`));
    expect(cs.some((c) => !c.group && c.bookSourceId === slipped.id)).toBe(false);
    const g = cs.find((c) => c.group && !c.depositSlip);
    expect(g.members.map((m) => m.bookSourceId).sort()).toEqual([x.id, y.id].sort());
    // a manual match of a slip document is refused
    const line = await lineOf(sid, `Dep ${x.no} ${y.no}`);
    const manual = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: line, bookSourceType: "OR", bookSourceId: slipped.id });
    expect([manual.status, manual.body.code]).toEqual([409, "BOOK_DOCUMENT_ON_DEPOSIT_SLIP"]);
  });

  test("a proposal becomes stale when the slip is cancelled: confirmation 409, nothing changed", async () => {
    const bank = await newBank("ST");
    const s = await makeSlip(bank, "2098-04-07", [await doc("or", { bank, amount: 700, date: "2098-04-05" })]);
    const sid = await newSession(bank, "2098-04-01", "2098-04-30");
    await importRows(sid, [`2098-04-08,${s.depositNo},,,,700.00`]);
    await run(sid);
    const [c] = await candidates(await lineOf(sid, s.depositNo));
    expect((await api("acctA", "post", `/api/bank-recon/deposit-slips/${s.id}/cancel`, { reason: "bounced" })).status).toBe(200);
    const res = await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`, { expectedMatchIds: c.matchIds });
    expect([res.status, res.body.code]).toEqual([409, "GROUP_PROPOSAL_CHANGED"]);
    expect((await q("SELECT status FROM bank_recon_matches WHERE match_group = ?", [c.matchGroup])).every((r) => r.status === "PENDING")).toBe(true);
  });

  test("carry-forward: a slip deposited at month end is matched from the next month's session", async () => {
    const bank = await newBank("CF");
    const s = await makeSlip(bank, "2098-04-30", [await doc("or", { bank, amount: 1200, date: "2098-04-29" }), await doc("or", { bank, amount: 800, date: "2098-04-30" })]);
    const apr = await newSession(bank, "2098-04-01", "2098-04-30");
    await run(apr);
    const may = await newSession(bank, "2098-05-01", "2098-05-31");
    await importRows(may, ["2098-05-02,Deposit,,,,2000.00"]);
    await run(may);
    const [c] = await candidates(await lineOf(may, "Deposit"));
    expect(c).toMatchObject({ matchType: "EXACT", depositSlip: { id: s.id } });
    expect((await api("acctA", "post", `/api/bank-recon/matches/${c.id}/confirm`, { expectedMatchIds: c.matchIds })).status).toBe(200);
    const queue = (await api("acctA", "get", `/api/bank-recon/sessions/${may}/queue`)).body;
    expect(queue.unmatchedBook).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("assistant (read-only)", () => {
  test("lists and explains deposit slips through the same service; has no way to change them", async () => {
    const bank = await newBank("AI");
    const s = await makeSlip(bank, "2098-06-03", [await doc("or", { bank, amount: 1100, date: "2098-06-02", no: "AI-1" })]);
    const sid = await newSession(bank, "2098-06-01", "2098-06-30");
    await importRows(sid, ["2098-06-05,Other credit,,,,5.00"]);
    const list = await ai("acctA", "getDepositSlips", sid, { status: "UNRECONCILED" });
    expect(list.body.rows.map((r) => [r.depositNo, r.missingFromStatement])).toEqual([[s.depositNo, true]]);
    const detail = await ai("acctA", "getDepositSlipDetail", sid, s.depositNo);
    expect(detail.body.lines.map((l) => l.voucherNo)).toEqual([`${P}OR-AI-1`]);
    expect((await ai("acctB", "getDepositSlips", sid, {})).status).toBe(404);
    expect(Object.keys(AgentActions).filter((k) => /deposit/i.test(k)).sort()).toEqual(["getDepositSlipDetail", "getDepositSlips"]);

    const conv = await api("acctA", "post", "/api/ai/bank-recon/conversations", {});
    convs.push(conv.body.id);
    await pool.query("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [sid, conv.body.id]);
    const say = (message) => api("acctA", "post", `/api/ai/bank-recon/conversations/${conv.body.id}/messages`, { message });
    const r1 = await say(`What receipts are included in ${s.depositNo}?`);
    expect(r1.body.reply).toMatch(new RegExp(`Deposit slip ${s.depositNo} .* deposited, total ₱ 1,100\\.00: OR r10-OR-AI-1 ₱ 1,100\\.00 \\(Cash\\)`));
    expect(r1.body.reply).toMatch(/not reconciled to any bank statement deposit/);
    const r2 = await say("Which deposits are missing from the bank statement?");
    expect(r2.body.reply).toMatch(new RegExp(`${s.depositNo} 2098-06-03 ₱ 1,100\\.00 .* not found on the imported statement yet`));
    expect((await slip("acctA", s.id)).status).toBe("DEPOSITED");
  });
});
