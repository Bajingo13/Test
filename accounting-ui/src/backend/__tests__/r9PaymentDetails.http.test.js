// R9 - OR / CV payment details for Bank Reconciliation.
//   * one validated payment model: Cash / Check / Bank Transfer, each with
//     only its own fields (check_no + check_date; payment_reference +
//     payment_date), required when posted, refused when they don't belong;
//   * receipt_no is the receipt number, never a check number;
//   * Bank Reconciliation reads the canonical fields: check numbers only
//     from check_no, transfer references as reference evidence, check /
//     transfer dates as date evidence, cash off the bank is not a bank item.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgentActions = require("../services/BankReconAgentActions");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "r9-";
const PW = "R9Pass!123";
const co = {};
const cur = {};
const acct = {};
const banks = [];
const bankCoa = {};
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
async function newBank(tag, status = "ACTIVE") {
  const code = `${P}BANK-${tag}`;
  const coa = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, 'ASSET')", [code, `R9 Bank ${tag}`])).insertId, code, title: `R9 Bank ${tag}` };
  const id = (await q("INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R9', ?, ?, ?)",
    [`${P}${tag}`, `R9 ${tag}`, `000-${tag}`, coa.id, coa.code, status])).insertId;
  banks.push(id);
  bankCoa[id] = coa;
  return id;
}
const ln = (a, debit, credit) => ({ accountId: a.id, accountCode: a.code, accountTitle: a.title, particulars: "", debit, credit });
let seq = 0;
// o: { bank, amount, date, method, checkNo, checkDate, paymentReference, paymentDate, receiptNo, status, onBank (default true) }
function body(kind, company, o) {
  const isCv = kind === "cv";
  const cashAcct = o.onBank === false || !bankCoa[o.bank] ? acct.CASH : bankCoa[o.bank];
  const b = {
    voucherNo: `${P}${o.no || `${kind}-${++seq}`}`,
    [isCv ? "payeeName" : "customerName"]: "R9 Party",
    transactionDate: o.date || "2097-05-10",
    referenceNo: "", receiptNo: o.receiptNo || "", description: "R9", status: o.status || "Posted",
    bankAccountId: o.bank ?? null,
    totalDebit: o.amount || 100, totalCredit: o.amount || 100,
    lines: isCv ? [ln(acct.EXP, o.amount || 100, 0), ln(cashAcct, 0, o.amount || 100)] : [ln(cashAcct, o.amount || 100, 0), ln(acct.AR, 0, o.amount || 100)],
    currency: { companyId: co[company], currencyId: o.currencyId || cur[company], exchangeRate: 1, rateDate: o.date || "2097-05-10" },
  };
  for (const k of ["checkNo", "checkDate", "paymentReference", "paymentDate"]) if (o[k] !== undefined) b[k] = o[k];
  if (o.method !== undefined) b.paymentMethod = o.method;
  return b;
}
const post = (kind, company, o, who) => api(who || (company === "A" ? "acctA" : "acctB"), "post", `/api/${kind}`, body(kind, company, o));
async function make(kind, company, o, who) {
  const res = await post(kind, company, o, who);
  if (res.status !== 200) throw new Error(`${kind}: ${res.status} ${res.body.message}`);
  return res.body.id;
}
const header = (table, id) => one(
  `SELECT payment_method AS method, bank_account_id AS bank, check_no AS checkNo, DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate,
          payment_reference AS ref, DATE_FORMAT(payment_date, '%Y-%m-%d') AS refDate${table === "or_headers" ? ", receipt_no AS receiptNo" : ""}
   FROM ${table} WHERE id = ?`, [id]);

async function newSession(bank, start = "2097-05-01", end = "2097-05-31", who = "acctA") {
  const res = await api(who, "post", "/api/bank-recon/sessions", { bankAccountId: bank, periodStart: start, periodEnd: end, dateToleranceDays: 3, statementBeginningBalance: 0, statementEndingBalance: 0 });
  if (res.status !== 200) throw new Error(`session ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}
async function importRows(sid, rows, who = "acctA", header = "Date,Description,Reference,Check No,Debit,Credit") {
  const res = await request(app).post(`/api/bank-recon/sessions/${sid}/import`).set({ Authorization: `Bearer ${tok[who]}` })
    .attach("file", Buffer.from([header, ...rows].join("\n")), "stmt.csv");
  if (res.status !== 200) throw new Error(`import ${res.status} ${res.body.message}`);
}
// Runs matching and returns the PENDING candidates of the session's only line.
async function candidatesFor(sid, who = "acctA") {
  expect((await api(who, "post", `/api/bank-recon/sessions/${sid}/run-matching`)).status).toBe(200);
  const [line] = await q("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? ORDER BY id", [sid]);
  return (await api(who, "get", `/api/bank-recon/statement-lines/${line.id}/candidates`)).body;
}
const bookItems = async (sid, who = "acctA") => (await api(who, "get", `/api/bank-recon/sessions/${sid}/book-items`)).body;

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [co[t]])).insertId;
  }
  for (const [k, t, c] of [["EXP", "R9 Expense", "EXPENSE"], ["AR", "R9 Receivable", "ASSET"], ["CASH", "R9 Cash on Hand", "ASSET"]]) {
    acct[k] = { id: (await q("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${P}${k}`, t, c])).insertId, code: `${P}${k}`, title: t };
  }
  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);
  await makeUser("acctAB", "ACCOUNTANT", [co.A, co.B]);
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
describe("schema", () => {
  test("payment_method fits 'Bank Transfer'; transfer reference + date columns exist on OR and CV", async () => {
    const cols = await q(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nul, COLUMN_DEFAULT AS def
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('or_headers', 'cv_headers')
        AND COLUMN_NAME IN ('payment_method', 'payment_reference', 'payment_date') ORDER BY t, c`);
    expect(cols).toEqual([
      { t: "cv_headers", c: "payment_date", type: "date", nul: "YES", def: null },
      { t: "cv_headers", c: "payment_method", type: "varchar(20)", nul: "NO", def: "Check" },
      { t: "cv_headers", c: "payment_reference", type: "varchar(100)", nul: "YES", def: null },
      { t: "or_headers", c: "payment_date", type: "date", nul: "YES", def: null },
      { t: "or_headers", c: "payment_method", type: "varchar(20)", nul: "NO", def: "Cash" },
      { t: "or_headers", c: "payment_reference", type: "varchar(100)", nul: "YES", def: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("payment validation (server-side)", () => {
  beforeAll(async () => {
    co.bankV = await newBank("V");
    co.bankOff = await newBank("OFF", "INACTIVE");
  });

  test.each(["or", "cv"])("%s: Cash / Check / Bank Transfer each store only their own fields", async (kind) => {
    const table = `${kind}_headers`;
    const cash = await make(kind, "A", { bank: co.bankV, method: "Cash" });
    expect(await header(table, cash)).toMatchObject({ method: "Cash", bank: co.bankV, checkNo: "", checkDate: null, ref: null, refDate: null });
    const chk = await make(kind, "A", { bank: co.bankV, method: "Check", checkNo: "000123", checkDate: "2097-05-12" });
    expect(await header(table, chk)).toMatchObject({ method: "Check", checkNo: "000123", checkDate: "2097-05-12", ref: null, refDate: null });
    const tr = await make(kind, "A", { bank: co.bankV, method: "Bank Transfer", paymentReference: "FT2097051001", paymentDate: "2097-05-10" });
    expect(await header(table, tr)).toMatchObject({ method: "Bank Transfer", checkNo: "", checkDate: null, ref: "FT2097051001", refDate: "2097-05-10" });
    const got = (await api("acctA", "get", `/api/${kind}/${tr}`)).body;
    expect(got).toMatchObject({ paymentMethod: "Bank Transfer", paymentReference: "FT2097051001", paymentDate: "2097-05-10" });
  });

  test.each(["or", "cv"])("%s: canonical codes and aliases are accepted and stored as the existing labels", async (kind) => {
    const table = `${kind}_headers`;
    expect((await header(table, await make(kind, "A", { bank: co.bankV, method: "CHECK", checkNo: "77", checkDate: "2097-05-10" }))).method).toBe("Check");
    expect((await header(table, await make(kind, "A", { bank: co.bankV, method: "BANK_TRANSFER", paymentReference: "R-1", paymentDate: "2097-05-10" }))).method).toBe("Bank Transfer");
    expect((await header(table, await make(kind, "A", { bank: co.bankV, method: "cash" }))).method).toBe("Cash");
    expect((await header(table, await make(kind, "A", { bank: co.bankV, method: "cheque", checkNo: "78", checkDate: "2097-05-10" }))).method).toBe("Check");
  });

  test.each(["or", "cv"])("%s: an omitted method is read from the fields sent - never a check without a check number", async (kind) => {
    const table = `${kind}_headers`;
    expect((await header(table, await make(kind, "A", { bank: co.bankV }))).method).toBe("Cash");
    expect((await header(table, await make(kind, "A", { bank: co.bankV, checkNo: "5501", checkDate: "2097-05-10" }))).method).toBe("Check");
    expect((await header(table, await make(kind, "A", { bank: co.bankV, paymentReference: "T-9", paymentDate: "2097-05-10" }))).method).toBe("Bank Transfer");
  });

  test.each(["or", "cv"])("%s: fields of another method are refused, never dropped", async (kind) => {
    for (const o of [
      { method: "Cash", checkNo: "1" },
      { method: "Cash", checkDate: "2097-05-10" },
      { method: "Cash", paymentReference: "X" },
      { method: "Check", checkNo: "1", checkDate: "2097-05-10", paymentReference: "X" },
      { method: "Bank Transfer", paymentReference: "X", paymentDate: "2097-05-10", checkNo: "1" },
    ]) {
      const res = await post(kind, "A", { bank: co.bankV, ...o });
      expect([o, res.status, res.body.code]).toEqual([o, 400, "PAYMENT_FIELD_NOT_ALLOWED"]);
    }
  });

  test.each(["or", "cv"])("%s: a posted Check / Bank Transfer needs all its fields; a draft may wait", async (kind) => {
    for (const o of [
      { method: "Check", checkDate: "2097-05-10" },
      { method: "Check", checkNo: "1" },
      { method: "Check", bank: null, checkNo: "1", checkDate: "2097-05-10" },
      { method: "Bank Transfer", paymentDate: "2097-05-10" },
      { method: "Bank Transfer", paymentReference: "R" },
      { method: "Bank Transfer", bank: null, paymentReference: "R", paymentDate: "2097-05-10" },
    ]) {
      const res = await post(kind, "A", { bank: co.bankV, ...o });
      expect([o, res.status, res.body.code]).toEqual([o, 400, "PAYMENT_DETAILS_INCOMPLETE"]);
    }
    const draft = await make(kind, "A", { bank: co.bankV, method: "Check", status: "Draft" });
    expect(await header(`${kind}_headers`, draft)).toMatchObject({ method: "Check", checkNo: "" });
  });

  test.each(["or", "cv"])("%s: malformed values are 400; unknown bank account 404; inactive bank account 400", async (kind) => {
    const cases = [
      [{ method: "Wire" }, "INVALID_PAYMENT_METHOD"],
      [{ method: 3 }, "INVALID_PAYMENT_METHOD"],
      [{ method: "Check", checkNo: 123, checkDate: "2097-05-10" }, "PAYMENT_FIELD_NOT_TEXT"],
      [{ method: "Check", checkNo: "1", checkDate: "2097-02-30" }, "INVALID_PAYMENT_DATE"],
      [{ method: "Bank Transfer", paymentReference: "R", paymentDate: "10/05/2097" }, "INVALID_PAYMENT_DATE"],
      [{ method: "Check", checkNo: "x".repeat(101), checkDate: "2097-05-10" }, "PAYMENT_FIELD_TOO_LONG"],
      [{ bank: "abc" }, "INVALID_BANK_ACCOUNT"],
      [{ bank: co.bankOff }, "BANK_ACCOUNT_INACTIVE"],
    ];
    for (const [o, code] of cases) {
      const res = await post(kind, "A", { bank: co.bankV, ...o });
      expect([o, res.status, res.body.code]).toEqual([o, 400, code]);
    }
    const missing = await post(kind, "A", { bank: 999999999 });
    expect([missing.status, missing.body.code]).toEqual([404, "BANK_ACCOUNT_NOT_FOUND"]);
  });

  test("OR: the receipt number and the check number stay in their own columns", async () => {
    const id = await make("or", "A", { bank: co.bankV, method: "Check", checkNo: "AB-7781", checkDate: "2097-05-10", receiptNo: "RCPT-0042" });
    expect(await header("or_headers", id)).toMatchObject({ checkNo: "AB-7781", receiptNo: "RCPT-0042" });
  });

  test("editing a payment is audited with its old and new details; an unchanged payment is not", async () => {
    const id = await make("or", "A", { bank: co.bankV, method: "Check", checkNo: "900", checkDate: "2097-05-10", status: "Draft" });
    const edit = (o) => api("acctA", "put", `/api/or/${id}`, body("or", "A", { no: `ED-${id}`, bank: co.bankV, status: "Draft", ...o }));
    expect((await edit({ method: "Check", checkNo: "900", checkDate: "2097-05-10" })).status).toBe(200);
    expect((await edit({ method: "Bank Transfer", paymentReference: "FT-77", paymentDate: "2097-05-11" })).status).toBe(200);
    const events = await q("SELECT description, before_data AS b, after_data AS a, company_id AS c, user_id AS u FROM audit_logs WHERE entity_type = 'OR' AND entity_id = ? AND action = 'PAYMENT_DETAILS_CHANGED' ORDER BY id", [id]);
    // the first edit kept the same payment (no event); the second changed it
    expect(events).toHaveLength(1);
    const last = events[0];
    const before = typeof last.b === "string" ? JSON.parse(last.b) : last.b;
    const after = typeof last.a === "string" ? JSON.parse(last.a) : last.a;
    expect(before).toMatchObject({ paymentMethod: "Check", checkNo: "900", checkDate: "2097-05-10", bankAccountId: co.bankV });
    expect(after).toMatchObject({ paymentMethod: "Bank Transfer", checkNo: "", paymentReference: "FT-77", paymentDate: "2097-05-11" });
    expect(last.description).toMatch(/payment changed from Check to Bank Transfer/);
    expect([Number(last.c), Number(last.u)]).toEqual([co.A, users.acctA.id]);
    expect(JSON.stringify(events)).not.toMatch(/password|token/i);
    // an edit that keeps the same payment adds nothing
    expect((await edit({ method: "Bank Transfer", paymentReference: "FT-77", paymentDate: "2097-05-11" })).status).toBe(200);
    expect((await q("SELECT COUNT(*) n FROM audit_logs WHERE entity_type = 'OR' AND entity_id = ? AND action = 'PAYMENT_DETAILS_CHANGED'", [id]))[0].n).toBe(events.length);
  });

  test("bulk posting skips drafts whose payment is incomplete and posts the rest", async () => {
    const bad = await make("cv", "B", { bank: co.bankV, method: "Check", status: "Draft", date: "2097-05-15" }, "acctB");
    const good = await make("cv", "B", { bank: co.bankV, method: "Check", checkNo: "B-1", checkDate: "2097-05-15", status: "Draft", date: "2097-05-15" }, "acctB");
    const res = await api("acctB", "post", "/api/posting/post", { scope: "ap" });
    expect(res.status).toBe(200);
    expect(res.body.paymentBlockedCount).toBe(1);
    expect(res.body.message).toMatch(/payment details are incomplete/);
    expect((await one("SELECT status FROM cv_headers WHERE id = ?", [bad])).status).toBe("Draft");
    expect((await one("SELECT status FROM cv_headers WHERE id = ?", [good])).status).toBe("Posted");
  });
});

// ---------------------------------------------------------------------------
describe("company handling", () => {
  test("another company's currency, an unassigned company, and Super Admin / multi-company choice", async () => {
    const bank = await newBank("CO");
    const other = await post("or", "A", { bank, currencyId: cur.B });
    expect(other.status).toBe(400);
    const unauthorized = await api("acctA", "post", "/api/or", { ...body("or", "B", { bank }) });
    expect([403, 400]).toContain(unauthorized.status);
    expect((await one("SELECT COUNT(*) n FROM or_headers WHERE company_id = ? AND voucher_no LIKE ?", [co.B, `${P}or-%`])).n).toBe(0);
    const sa = await make("or", "B", { bank, method: "Check", checkNo: "SA-1", checkDate: "2097-05-10" }, "super");
    expect((await one("SELECT company_id FROM or_headers WHERE id = ?", [sa])).company_id).toBe(co.B);
    const multi = await make("cv", "A", { bank, method: "Bank Transfer", paymentReference: "M-1", paymentDate: "2097-05-10" }, "acctAB");
    expect((await one("SELECT company_id FROM cv_headers WHERE id = ?", [multi])).company_id).toBe(co.A);
  });
});

// ---------------------------------------------------------------------------
describe("Bank Reconciliation uses the canonical payment fields", () => {
  // One bank account + May session per scenario.
  async function scenario(tag, docs, rows, who = "acctA") {
    const bank = await newBank(tag);
    const ids = [];
    for (const d of docs) ids.push(await make(d.kind, d.company || "A", { bank, ...d }, d.company === "B" ? "acctB" : undefined));
    const sid = await newSession(bank, "2097-05-01", "2097-05-31", who);
    await importRows(sid, rows, who);
    return { bank, ids, sid };
  }

  test.each(["or", "cv"])("%s: check -> statement check number -> exact CHECK_NO match (incl. leading zeros and letters)", async (kind) => {
    const amountCols = kind === "or" ? ",500.00" : "500.00,";
    for (const [stored, onStatement, tag] of [["123", "000123", "Z1"], ["000456", "456", "Z2"], ["AB-7781", "ab-7781", "AL"]]) {
      // statement: Date,Description,Reference,Check No,Debit,Credit
      const s = await scenario(`CK${kind}${tag}`, [{ kind, method: "Check", checkNo: stored, checkDate: "2097-05-10", amount: 500 }],
        [`2097-05-12,Check clearing,,${onStatement},${amountCols}`]);
      const c = await candidatesFor(s.sid);
      expect([stored, c.map((x) => [x.bookSourceId, x.matchType, x.matchLevel])]).toEqual([stored, [[s.ids[0], "EXACT", "CHECK_NO"]]]);
    }
  });

  test.each(["or", "cv"])("%s: the check date is the date evidence; a postdated check cannot clear before its date", async (kind) => {
    const amountCols = kind === "or" ? ",,700.00" : ",700.00,";
    const ok = await scenario(`PD${kind}`, [{ kind, method: "Check", checkNo: "PD-1", checkDate: "2097-05-20", date: "2097-05-02", amount: 700 }],
      [`2097-05-21,Check PD-1,,PD-1${amountCols}`]);
    const [c] = await candidatesFor(ok.sid);
    expect(c).toMatchObject({ matchType: "EXACT", matchLevel: "CHECK_NO" });
    const detail = (await api("acctA", "get", `/api/bank-recon/statement-history/lines/${(await one("SELECT id FROM bank_recon_statement_lines WHERE session_id = ?", [ok.sid])).id}`)).body;
    expect(detail.candidates[0].explanation).toMatch(/check number and amount match exactly/);
    const breakdown = await one("SELECT score_breakdown AS b FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING'", [ok.sid]);
    const b = typeof breakdown.b === "string" ? JSON.parse(breakdown.b) : breakdown.b;
    expect(b).toMatchObject({ dateBasis: "CHECK_DATE" });
    expect(b.dateScore).toBeGreaterThan(0);
    const early = await scenario(`PE${kind}`, [{ kind, method: "Check", checkNo: "PD-2", checkDate: "2097-05-25", date: "2097-05-02", amount: 700 }],
      [`2097-05-08,Check PD-2,,PD-2${amountCols}`]);
    expect(await candidatesFor(early.sid)).toEqual([]);
  });

  test.each(["or", "cv"])("%s: bank transfer -> the bank's reference -> exact match on the transfer reference", async (kind) => {
    const amountCols = kind === "or" ? ",,1250.00" : ",1250.00,";
    const s = await scenario(`TR${kind}`, [{ kind, method: "Bank Transfer", paymentReference: "FT97051234", paymentDate: "2097-05-14", date: "2097-05-13", amount: 1250 }],
      [`2097-05-14,Online transfer,FT97051234,${amountCols}`]);
    const [c] = await candidatesFor(s.sid);
    expect(c).toMatchObject({ bookSourceId: s.ids[0], matchType: "EXACT", matchLevel: "REFERENCE", strictExact: true });
    expect(c.explanation).toMatch(/matches the bank transfer reference of/);
  });

  // R9 deliberately keeps the pre-R9 Cash treatment (deferred until the
  // historical population is reviewed): a Cash voucher on a bank account is
  // a bank item - through its bank GL line, or, with no such line, through
  // the existing gross-less-withholding fallback.
  test.each(["or", "cv"])("%s: Cash keeps its existing Bank Recon behaviour (on the bank GL line or via the gross fallback)", async (kind) => {
    const amountCols = kind === "or" ? ",,300.00" : ",300.00,";
    const onHand = await scenario(`CA${kind}`, [{ kind, method: "Cash", onBank: false, amount: 300 }], [`2097-05-10,Cash ${kind},,${amountCols}`]);
    const items = await bookItems(onHand.sid);
    expect(items.find((t) => t.sourceId === onHand.ids[0])).toMatchObject({ amount: 300, amountSource: "GROSS_LESS_WITHHOLDING", direction: kind === "or" ? "IN" : "OUT" });
    const [c] = await candidatesFor(onHand.sid);
    expect(c).toMatchObject({ bookSourceId: onHand.ids[0], matchType: "SUGGESTED", matchLevel: "AMOUNT_DATE" });
    const inBank = await scenario(`CD${kind}`, [{ kind, method: "Cash", amount: 300 }], [`2097-05-10,Cash ${kind},,${amountCols}`]);
    expect((await bookItems(inBank.sid)).find((t) => t.sourceId === inBank.ids[0])).toMatchObject({ amount: 300, amountSource: "BANK_LINE" });
    // ... and a Cash voucher is never matched as a check
    expect((await candidatesFor(inBank.sid)).some((x) => x.matchLevel === "CHECK_NO")).toBe(false);
  });

  test("the OR / CV forms always send the payment method explicitly (inference is only an API fallback)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "pages", "TRANSACTIONS", "TransactionFormLayout.jsx"), "utf8");
    expect(src).toMatch(/paymentMethod: code === "OR" \|\| code === "CV" \? paymentMethod : null,/);
    expect(src).toMatch(/useState\(code === "CV" \? "Check" : "Cash"\)/);
  });

  test("OR: a receipt number is never used as a check number", async () => {
    const s = await scenario("RC", [{ kind: "or", method: "Cash", receiptNo: "880011", amount: 410, date: "2097-04-01" }], ["2097-05-10,Check 880011,,880011,,410.00"]);
    const c = await candidatesFor(s.sid);
    expect(c.filter((x) => x.matchLevel === "CHECK_NO" || x.matchLevel === "REFERENCE")).toEqual([]);
  });

  test.each(["or", "cv"])("%s: wrong bank account or wrong company -> no match", async (kind) => {
    const amountCols = kind === "or" ? ",,640.00" : ",640.00,";
    const bank = await newBank(`WB${kind}`);
    const other = await newBank(`WO${kind}`);
    await make(kind, "A", { bank: other, method: "Check", checkNo: "WB-1", checkDate: "2097-05-10", amount: 640 });
    await make(kind, "B", { bank, method: "Check", checkNo: "WB-1", checkDate: "2097-05-10", amount: 640 }, "acctB");
    const sid = await newSession(bank);
    await importRows(sid, [`2097-05-11,Check WB-1,,WB-1${amountCols}`]);
    expect(await candidatesFor(sid)).toEqual([]);
  });

  test("the bank-reference column is used for transfer evidence", async () => {
    const bank = await newBank("BREF");
    const id = await make("cv", "A", { bank, method: "Bank Transfer", paymentReference: "IB-55120", paymentDate: "2097-05-14", amount: 980 });
    const sid = await newSession(bank);
    await importRows(sid, ["2097-05-14,Transfer out,,,980.00,,IB-55120"], "acctA", "Date,Description,Reference,Check No,Debit,Credit,Bank Reference");
    const [c] = await candidatesFor(sid);
    expect(c).toMatchObject({ bookSourceId: id, matchType: "EXACT", matchLevel: "REFERENCE" });
  });
});

// ---------------------------------------------------------------------------
describe("AI boundary", () => {
  test("the assistant has no payment-changing action and explains a check match from the engine", async () => {
    const names = Object.keys(AgentActions);
    expect(names.filter((n) => /payment|create(Or|Cv)|update(Or|Cv)|setMethod|post/i.test(n))).toEqual([]);
    const bank = await newBank("AI");
    await make("or", "A", { bank, method: "Check", checkNo: "77001", checkDate: "2097-05-10", amount: 905 });
    const sid = await newSession(bank);
    await importRows(sid, ["2097-05-11,Deposit check,,77001,,905.00"]);
    await api("acctA", "post", `/api/bank-recon/sessions/${sid}/run-matching`);
    const [line] = await q("SELECT id FROM bank_recon_statement_lines WHERE session_id = ?", [sid]);
    const d = await ai("acctA", "getBankLineDetail", line.id);
    expect(d.status).toBe(200);
    expect(d.body.candidates[0].explanation).toMatch(/Bank statement check 77001 for ₱905\.00 matches OR r9-or-\d+ for ₱905\.00: the check number and amount match exactly/);
  });
});
