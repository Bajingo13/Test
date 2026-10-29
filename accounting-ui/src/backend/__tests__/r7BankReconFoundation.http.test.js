// R7 - Payment and Bank Reconciliation foundation fixes.
//   R7-1 Accountant read-only access to bank accounts (data-only grant)
//   R7-2 reconciliation uses the bank movement, not the gross voucher amount
//   R7-3 one book document can be confirmed only once
//   R7-4 EXACT needs check / document-number evidence; ties are AMBIGUOUS
//   R7-5 statement dates: explicit or provable format, real dates only
//   R7-6 manual match amount is derived and validated on the server
//   R7-7 the same statement cannot be imported twice into one session
// Runs against the local test database through the real HTTP API.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { resolveDatabaseConfig } = require("../config/database");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const { MIGRATION_ORDER } = require("../scripts/migrationOrder");

jest.setTimeout(240000);

const P = "r7-";
const PW = "R7Pass!1";
const MIGRATION = "r7_accountant_bank_codes_view_migration.sql";
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const co = {};
const cur = {};
const acct = {};
const bank = {};
const tok = {};
const users = {};
const doc = {};
const sessions = [];

async function applyMigration() {
  const { environment, ...cfg } = resolveDatabaseConfig();
  const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
  try {
    await c.query(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), "utf8"));
  } finally {
    await c.end();
  }
}

async function makeUser(tag, roleCode, companyIds = []) {
  const [[role]] = await pool.query("SELECT id FROM roles WHERE code = ?", [roleCode]);
  const [u] = await pool.query(
    "INSERT INTO users (username, password, role_id, status, email) VALUES (?, ?, ?, 'ACTIVE', ?)",
    [`${P}${tag}`, await bcrypt.hash(PW, 10), role.id, `${P}${tag}@example.test`]
  );
  for (const c of companyIds) await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PW });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tok[tag] = res.body.token;
}

const api = (who, method, url, body) => {
  const r = request(app)[method](url).set({ Authorization: `Bearer ${tok[who]}` });
  return body === undefined ? r : r.send(body);
};
const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];

async function coaAccount(key, title, cls) {
  const [r] = await pool.query(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [`${P}${key}`, title, cls]
  );
  acct[key] = { id: r.insertId, code: `${P}${key}`, title };
}
const ln = (key, debit, credit) => ({
  accountId: acct[key].id, accountCode: acct[key].code, accountTitle: acct[key].title, particulars: "", debit, credit,
});

async function sourceDoc(table, company, no, amount) {
  const party = table === "invoice_headers" ? "customer_name" : "supplier_name";
  const [r] = await pool.query(
    `INSERT INTO ${table} (company_id, voucher_no, ${party}, transaction_date, total_debit, total_credit, balance_amount, paid_amount, payment_status, status)
     VALUES (?, ?, 'R7 Party', '2098-07-01', ?, ?, ?, 0, 'Unpaid', 'Posted')`,
    [co[company], no, amount, amount, amount]
  );
  return r.insertId;
}

// CV / OR through the real API as the company's Accountant.
async function createCv(who, company, o) {
  const res = await api(who, "post", "/api/cv", {
    voucherNo: o.no, payeeName: "R7 Supplier", transactionDate: o.date || "2098-07-10", referenceNo: o.ref || "",
    description: o.description || "R7 CV", status: o.status || "Posted", paymentMethod: "Check",
    bankAccountId: o.bank ?? bank.BK, checkNo: o.checkNo || "", checkDate: o.date || "2098-07-10",
    totalDebit: o.gross, totalCredit: o.gross, lines: o.lines, apvApplications: o.apps || [],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date || "2098-07-10" },
  });
  if (res.status !== 200) throw new Error(`CV ${o.no}: ${res.status} ${res.body.message}`);
  return res.body.id;
}
async function createOr(who, company, o) {
  const res = await api(who, "post", "/api/or", {
    voucherNo: o.no, customerName: "R7 Customer", transactionDate: o.date || "2098-07-10", referenceNo: o.ref || "",
    receiptNo: o.receiptNo || "", description: "R7 OR", status: o.status || "Posted",
    paymentMethod: o.checkNo ? "Check" : "Cash", bankAccountId: o.bank ?? bank.BK,
    checkNo: o.checkNo || "", checkDate: o.date || "2098-07-10",
    totalDebit: o.gross, totalCredit: o.gross, lines: o.lines, invoiceApplications: o.apps || [],
    currency: { companyId: co[company], currencyId: cur[company], exchangeRate: 1, rateDate: o.date || "2098-07-10" },
  });
  return res;
}

// R8.4-A: one company + bank account cannot have two sessions for
// overlapping periods, so tests that work in the same month share that
// month's session (under R8.3 they already shared its statement history).
const sessionCache = new Map();
async function newSession(who, o = {}) {
  const key = [who, o.bank ?? bank.BK, o.start || "2098-07-01", o.end || "2098-07-31", o.companyId || ""].join("|");
  if (sessionCache.has(key)) return sessionCache.get(key);
  const id = await createSession(who, o);
  sessionCache.set(key, id);
  return id;
}

async function createSession(who, o = {}) {
  const res = await api(who, "post", "/api/bank-recon/sessions", {
    bankAccountId: o.bank ?? bank.BK, periodStart: o.start || "2098-07-01", periodEnd: o.end || "2098-07-31",
    statementBeginningBalance: 0, statementEndingBalance: 0, ...(o.companyId ? { companyId: o.companyId } : {}),
  });
  if (res.status !== 200) throw new Error(`session: ${res.status} ${res.body.message}`);
  sessions.push(res.body.id);
  return res.body.id;
}

const CSV_HEAD = "Date,Description,Reference,Check No,Debit,Credit";
function importRows(who, sessionId, rows, { dateFormat, name = "statement.csv", head = CSV_HEAD } = {}) {
  const r = request(app)
    .post(`/api/bank-recon/sessions/${sessionId}/import`)
    .set({ Authorization: `Bearer ${tok[who]}` });
  if (dateFormat) r.field("dateFormat", dateFormat);
  return r.attach("file", Buffer.from([head, ...rows].join("\n")), name);
}

const lineId = (sessionId, description) =>
  one("SELECT id FROM bank_recon_statement_lines WHERE session_id = ? AND description = ? ORDER BY id LIMIT 1", [sessionId, description]).then((r) => r?.id);
const pendingFor = (statementLineId) =>
  q(
    `SELECT id, book_source_type AS type, book_source_id AS docId, match_type AS matchType, score_breakdown AS breakdown, amount
     FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING' ORDER BY confidence_score DESC, id`,
    [statementLineId]
  );
const confirmedFor = (type, docId) =>
  q("SELECT id, session_id AS sessionId, statement_line_id AS lineId, amount FROM bank_recon_matches WHERE book_source_type = ? AND book_source_id = ? AND status = 'CONFIRMED'", [type, docId]);
const level = (m) => (typeof m.breakdown === "string" ? JSON.parse(m.breakdown) : m.breakdown).matchLevel;

beforeAll(async () => {
  assertNotProductionDatabase();
  await applyMigration();

  for (const t of ["A", "B"]) {
    co[t] = (await q("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${t}`])).insertId;
    cur[t] = (await q(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)",
      [co[t]]
    )).insertId;
  }
  await coaAccount("BANK", "R7 Cash in Bank - Main", "ASSET");
  await coaAccount("BANK2", "R7 Cash in Bank - Second", "ASSET");
  await coaAccount("AR", "R7 Accounts Receivable", "ASSET");
  await coaAccount("AP", "R7 Accounts Payable", "LIABILITY");
  await coaAccount("EXP", "R7 Office Expense", "EXPENSE");
  await coaAccount("WTP", "R7 Withholding Tax Payable - Expanded", "LIABILITY");
  await coaAccount("WTP2", "R7 Withholding Tax Payable - Other", "LIABILITY");
  await coaAccount("CWT", "R7 Creditable Withholding Receivable", "ASSET");
  const mkBank = async (key, coaKey) => {
    const [r] = await pool.query(
      "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, ?, ?, 'R7 Current', ?, ?, 'ACTIVE')",
      [`${P}${key}`, `R7 Bank ${key}`, `000-${key}`, coaKey ? acct[coaKey].id : null, coaKey ? acct[coaKey].code : null]
    );
    bank[key] = r.insertId;
  };
  await mkBank("BK", "BANK");
  await mkBank("BK2", "BANK2");
  await mkBank("NOGL", null);

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("acctA", "ACCOUNTANT", [co.A]);
  await makeUser("acctB", "ACCOUNTANT", [co.B]);

  // Source documents and payments (Company A unless stated).
  doc.apvFull = await sourceDoc("apv_headers", "A", `${P}APV-FULL`, 1000);
  doc.apvPart = await sourceDoc("apv_headers", "A", `${P}APV-PART`, 1000);
  doc.apvMulti = await sourceDoc("apv_headers", "A", `${P}APV-MULTI`, 1000);
  doc.invCwt = await sourceDoc("invoice_headers", "A", `${P}INV-CWT`, 1000);

  doc.cvPlain = await createCv("acctA", "A", { no: `${P}CV-PLAIN`, checkNo: "R7CHK-100", gross: 500, lines: [ln("EXP", 500, 0), ln("BANK", 0, 500)] });
  doc.cvWht = await createCv("acctA", "A", {
    no: `${P}CV-WHT`, checkNo: "R7CHK-200", gross: 1000,
    lines: [ln("AP", 1000, 0), ln("BANK", 0, 980), ln("WTP", 0, 20)],
    apps: [{ sourceType: "APV", sourceId: doc.apvFull, amount: 1000 }],
  });
  doc.cvMulti = await createCv("acctA", "A", {
    no: `${P}CV-MULTI`, checkNo: "R7CHK-300", gross: 1000,
    lines: [ln("AP", 1000, 0), ln("WTP", 0, 10), ln("WTP2", 0, 15), ln("BANK", 0, 975)],
    apps: [{ sourceType: "APV", sourceId: doc.apvMulti, amount: 1000 }],
  });
  doc.cvPart = await createCv("acctA", "A", {
    no: `${P}CV-PART`, checkNo: "R7CHK-400", gross: 400,
    lines: [ln("AP", 400, 0), ln("BANK", 0, 400)],
    apps: [{ sourceType: "APV", sourceId: doc.apvPart, amount: 400 }],
  });
  const orCwt = await createOr("acctA", "A", {
    no: `${P}OR-CWT`, checkNo: "R7DEP-500", gross: 1000,
    lines: [ln("BANK", 980, 0), ln("CWT", 20, 0), ln("AR", 0, 1000)],
    apps: [{ sourceType: "INV", sourceId: doc.invCwt, amount: 1000 }],
  });
  if (orCwt.status !== 200) throw new Error(`OR-CWT ${orCwt.status} ${orCwt.body.message}`);
  doc.orCwt = orCwt.body.id;
  // Header-only CV on a bank code with no GL link: falls back to gross - withholding.
  doc.cvNoGl = (await q(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_name, transaction_date, check_no, total_debit, total_credit, tax_withheld_amount, status, bank_account_id)
     VALUES (?, ?, 'R7 Supplier', '2098-07-10', 'R7CHK-600', 1000, 1000, 20, 'Posted', ?)`,
    [co.A, `${P}CV-NOGL`, bank.NOGL]
  )).insertId;
  // Second bank account: one withholding CV only (book balance check).
  doc.cvBk2 = await createCv("acctA", "A", {
    no: `${P}CV-BK2`, checkNo: "R7CHK-700", gross: 1000, bank: bank.BK2,
    lines: [ln("EXP", 1000, 0), ln("BANK2", 0, 980), ln("WTP", 0, 20)],
  });
});

afterAll(async () => {
  try {
    const cos = Object.values(co);
    const us = Object.values(users);
    if (sessions.length) {
      await pool.query("DELETE FROM bank_recon_adjustments WHERE session_id IN (?)", [sessions]);
      await pool.query("DELETE FROM bank_recon_matches WHERE session_id IN (?)", [sessions]);
      await pool.query("DELETE FROM bank_recon_statement_lines WHERE session_id IN (?)", [sessions]);
      await pool.query("DELETE FROM bank_recon_import_batches WHERE session_id IN (?)", [sessions]);
      await pool.query("DELETE FROM bank_recon_sessions WHERE id IN (?)", [sessions]);
    }
    if (cos.length) {
      const ors = (await q("SELECT id FROM or_headers WHERE company_id IN (?)", [cos])).map((r) => r.id);
      const cvs = (await q("SELECT id FROM cv_headers WHERE company_id IN (?)", [cos])).map((r) => r.id);
      if (ors.length) await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'OR' AND applied_id IN (?)", [ors]);
      if (cvs.length) await pool.query("DELETE FROM transaction_applications WHERE applied_type = 'CV' AND applied_id IN (?)", [cvs]);
      await pool.query("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE company_id IN (?))", [cos]);
      for (const t of ["jv_headers", "or_headers", "cv_headers", "invoice_headers", "apv_headers", "transaction_currency_snapshots", "audit_logs", "currencies"]) {
        await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cos]);
      }
    }
    if (us.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [us]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [us]);
    }
    if (Object.values(bank).length) await pool.query("DELETE FROM bank_codes WHERE id IN (?)", [Object.values(bank)]);
    if (cos.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [cos]);
    await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE ?", [`${P}%`]);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
describe("R7-1 Accountant bank-account access", () => {
  const grant = (role, action) =>
    one(
      `SELECT rp.granted FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
       WHERE r.code = ? AND p.module_key = 'FILESETUP.BANK_CODES' AND p.action = ?`,
      [role, action]
    );

  test("ACCOUNTANT gets VIEW only; ADMIN keeps VIEW + CONFIGURE", async () => {
    expect((await grant("ACCOUNTANT", "VIEW"))?.granted).toBe(1);
    expect((await grant("ACCOUNTANT", "CONFIGURE"))?.granted ?? 0).toBe(0);
    expect((await grant("ADMIN", "VIEW"))?.granted).toBe(1);
    expect((await grant("ADMIN", "CONFIGURE"))?.granted).toBe(1);
  });

  test("migration is registered, identical in both locations, and idempotent", async () => {
    expect(MIGRATION_ORDER).toContain(MIGRATION);
    expect(MIGRATION_ORDER.indexOf(MIGRATION)).toBeGreaterThan(MIGRATION_ORDER.indexOf("user_access_control_migration.sql"));
    const root = fs.readFileSync(path.join(REPO_ROOT, MIGRATION));
    const copy = fs.readFileSync(path.join(__dirname, "..", "migrations", MIGRATION));
    expect(copy.equals(root)).toBe(true);
    const before = await q("SELECT role_id, permission_id, granted FROM role_permissions ORDER BY role_id, permission_id");
    await applyMigration();
    expect(await q("SELECT role_id, permission_id, granted FROM role_permissions ORDER BY role_id, permission_id")).toEqual(before);
  });

  test("an administrator's explicit ACCOUNTANT revoke is preserved on re-run", async () => {
    const sql = `UPDATE role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
                 SET rp.granted = ? WHERE r.code = 'ACCOUNTANT' AND p.module_key = 'FILESETUP.BANK_CODES' AND p.action = 'VIEW'`;
    await pool.query(sql, [0]);
    try {
      await applyMigration();
      expect((await grant("ACCOUNTANT", "VIEW")).granted).toBe(0);
    } finally {
      await pool.query(sql, [1]);
    }
  });

  test("an Accountant can load bank accounts but cannot change them", async () => {
    const list = await api("acctA", "get", "/api/bank-codes");
    expect(list.status).toBe(200);
    expect(list.body.map((b) => b.id)).toEqual(expect.arrayContaining([bank.BK, bank.BK2]));
    expect((await api("acctA", "post", "/api/bank-codes", { bankCode: `${P}X`, bankName: "x" })).status).toBe(403);
    expect((await api("acctA", "put", `/api/bank-codes/${bank.BK}`, { bankCode: `${P}BK`, bankName: "hacked" })).status).toBe(403);
    expect((await api("acctA", "delete", `/api/bank-codes/${bank.BK}`)).status).toBe(403);
    expect((await api("acctA", "post", "/api/bank-codes/sync")).status).toBe(403);
    expect((await one("SELECT bank_name FROM bank_codes WHERE id = ?", [bank.BK])).bank_name).toBe("R7 Bank BK");
  });

  test("bank codes are shared master data: another company's Accountant sees the same list", async () => {
    const list = await api("acctB", "get", "/api/bank-codes");
    expect(list.status).toBe(200);
    expect(list.body.map((b) => b.id)).toContain(bank.BK);
  });

  test("an Accountant-saved OR/CV carries the bank account and appears in Bank Reconciliation", async () => {
    expect((await one("SELECT bank_account_id FROM cv_headers WHERE id = ?", [doc.cvPlain])).bank_account_id).toBe(bank.BK);
    const s = await newSession("acctA");
    const items = await api("acctA", "get", `/api/bank-recon/sessions/${s}/book-items`);
    expect(items.status).toBe(200);
    const keys = items.body.map((t) => `${t.sourceType}:${t.sourceId}`);
    expect(keys).toEqual(expect.arrayContaining([`CV:${doc.cvPlain}`, `CV:${doc.cvWht}`, `OR:${doc.orCwt}`]));
  });
});

// ---------------------------------------------------------------------------
describe("R7-2 bank movement amount", () => {
  let s;
  let items;
  const item = (type, id) => items.find((t) => t.sourceType === type && t.sourceId === id);

  beforeAll(async () => {
    s = await newSession("acctA");
    items = (await api("acctA", "get", `/api/bank-recon/sessions/${s}/book-items`)).body;
  });

  test("CV without withholding: bank movement = gross", () => {
    expect(item("CV", doc.cvPlain)).toMatchObject({ amount: 500, grossAmount: 500, bankMovementAmount: 500, amountSource: "BANK_LINE", direction: "OUT" });
  });

  test("CV with withholding: bank movement 980, gross 1,000 kept separately", () => {
    expect(item("CV", doc.cvWht)).toMatchObject({ amount: 980, grossAmount: 1000, bankMovementAmount: 980, amountSource: "BANK_LINE" });
  });

  test("CV with two withholding components: 1,000 - 10 - 15 = 975", () => {
    expect(item("CV", doc.cvMulti)).toMatchObject({ amount: 975, grossAmount: 1000 });
  });

  test("OR with creditable withholding: deposit 980 (money in)", () => {
    expect(item("OR", doc.orCwt)).toMatchObject({ amount: 980, grossAmount: 1000, direction: "IN" });
  });

  test("partial and full APV payment: application and status unchanged by reconciliation", async () => {
    expect(item("CV", doc.cvPart)).toMatchObject({ amount: 400 });
    expect(await one("SELECT paid_amount, balance_amount, payment_status FROM apv_headers WHERE id = ?", [doc.apvPart]))
      .toEqual({ paid_amount: "400.00", balance_amount: "600.00", payment_status: "Partially Paid" });
    expect(await one("SELECT paid_amount, balance_amount, payment_status FROM apv_headers WHERE id = ?", [doc.apvFull]))
      .toEqual({ paid_amount: "1000.00", balance_amount: "0.00", payment_status: "Paid" });
    expect(await one("SELECT payment_status FROM invoice_headers WHERE id = ?", [doc.invCwt])).toEqual({ payment_status: "Paid" });
  });

  test("the accounting documents keep their gross totals", async () => {
    expect(await one("SELECT total_debit, total_credit FROM cv_headers WHERE id = ?", [doc.cvWht])).toEqual({ total_debit: "1000.00", total_credit: "1000.00" });
    expect(await one("SELECT total_debit, total_credit FROM or_headers WHERE id = ?", [doc.orCwt])).toEqual({ total_debit: "1000.00", total_credit: "1000.00" });
  });

  test("a bank code with no GL link falls back to gross - stored withholding", async () => {
    const sNoGl = await newSession("acctA", { bank: bank.NOGL });
    const list = (await api("acctA", "get", `/api/bank-recon/sessions/${sNoGl}/book-items`)).body;
    expect(list.find((t) => t.sourceId === doc.cvNoGl)).toMatchObject({ amount: 980, grossAmount: 1000, withholdingAmount: 20, amountSource: "GROSS_LESS_WITHHOLDING" });
  });

  test("statement at the bank amount matches EXACT; statement at the gross amount does not match", async () => {
    expect((await importRows("acctA", s, ["2098-07-12,Check 200,,R7CHK-200,980,", "2098-07-12,Check 200 gross,,R7CHK-200,1000,"])).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s}/run-matching`)).status).toBe(200);
    const net = await pendingFor(await lineId(s, "Check 200"));
    expect(net[0]).toMatchObject({ type: "CV", docId: doc.cvWht, matchType: "EXACT", amount: "980.00" });
    const gross = await pendingFor(await lineId(s, "Check 200 gross"));
    expect(gross.some((m) => m.docId === doc.cvWht && m.type === "CV")).toBe(false);
  });

  test("book balance uses the bank movement (980), not the gross CV (1,000)", async () => {
    const s2 = await newSession("acctA", { bank: bank.BK2 });
    const summary = await api("acctA", "get", `/api/bank-recon/sessions/${s2}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.bookBalance).toBe(-980);
    expect(summary.body.outstandingChecksTotal).toBe(980);
  });
});

// ---------------------------------------------------------------------------
describe("R7-3 one confirmation per book document", () => {
  let s;
  let orDup;

  beforeAll(async () => {
    const res = await createOr("acctA", "A", { no: `${P}OR-DUP`, gross: 600, date: "2098-07-20", lines: [ln("BANK", 600, 0), ln("AR", 0, 600)] });
    orDup = res.body.id;
    s = await newSession("acctA");
    expect((await importRows("acctA", s, ["2098-07-20,Dup A,,,,600", "2098-07-20,Dup B,,,,600", "2098-07-20,Dup C,,,,600"])).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s}/run-matching`)).status).toBe(200);
  });

  test("amount + date alone is only a suggestion on each line", async () => {
    for (const d of ["Dup A", "Dup B", "Dup C"]) {
      const m = (await pendingFor(await lineId(s, d))).find((x) => x.docId === orDup);
      expect(m).toMatchObject({ matchType: "SUGGESTED" });
      expect(level(m)).toBe("AMOUNT_DATE");
    }
  });

  test("bulk confirm does not confirm amount/date suggestions", async () => {
    const res = await api("acctA", "post", "/api/bank-recon/matches/bulk-confirm", { sessionId: s });
    expect(res.status).toBe(200);
    expect(await confirmedFor("OR", orDup)).toHaveLength(0);
  });

  test("concurrent confirmations of the same document on two lines: one 200, one 409", async () => {
    const mA = (await pendingFor(await lineId(s, "Dup A"))).find((x) => x.docId === orDup);
    const mB = (await pendingFor(await lineId(s, "Dup B"))).find((x) => x.docId === orDup);
    const before = await one("SELECT total_debit, total_credit, status FROM or_headers WHERE id = ?", [orDup]);
    const results = await Promise.all([
      api("acctA", "post", `/api/bank-recon/matches/${mA.id}/confirm`),
      api("acctA", "post", `/api/bank-recon/matches/${mB.id}/confirm`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.code).toBe("BOOK_DOCUMENT_ALREADY_MATCHED");
    expect(await confirmedFor("OR", orDup)).toHaveLength(1);
    expect(await one("SELECT total_debit, total_credit, status FROM or_headers WHERE id = ?", [orDup])).toEqual(before);
  });

  test("a third line cannot take the same document manually either", async () => {
    const res = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: await lineId(s, "Dup C"), bookSourceType: "OR", bookSourceId: orDup });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_ALREADY_MATCHED");
    expect(await confirmedFor("OR", orDup)).toHaveLength(1);
  });

  test("confirming the same match twice at once: one 200, one 409", async () => {
    const s2 = await newSession("acctA");
    expect((await importRows("acctA", s2, ["2098-07-10,Plain,,R7CHK-100,500,"])).status).toBe(200);
    await api("acctA", "post", `/api/bank-recon/sessions/${s2}/run-matching`);
    const [m] = await pendingFor(await lineId(s2, "Plain"));
    const results = await Promise.all([
      api("acctA", "post", `/api/bank-recon/matches/${m.id}/confirm`),
      api("acctA", "post", `/api/bank-recon/matches/${m.id}/confirm`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await confirmedFor("CV", doc.cvPlain)).toHaveLength(1);
  });

  test("a document reconciled in another session of the same bank is refused and not suggested", async () => {
    const s3 = await newSession("acctA", { start: "2098-08-01", end: "2098-08-31" });
    expect((await importRows("acctA", s3, ["2098-07-29,Again,,,,600"])).status).toBe(200);
    await api("acctA", "post", `/api/bank-recon/sessions/${s3}/run-matching`);
    const line = await lineId(s3, "Again");
    expect((await pendingFor(line)).some((m) => m.docId === orDup && m.type === "OR")).toBe(false);
    const res = await api("acctA", "post", "/api/bank-recon/matches", { statementLineId: line, bookSourceType: "OR", bookSourceId: orDup });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/reconciliation session #/);
  });

  test("concurrent manual matches of one document from two lines: one succeeds", async () => {
    const res = await createOr("acctA", "A", { no: `${P}OR-RACE`, gross: 321, date: "2098-07-21", lines: [ln("BANK", 321, 0), ln("AR", 0, 321)] });
    const s4 = await newSession("acctA");
    await importRows("acctA", s4, ["2098-07-21,Race A,,,,321", "2098-07-21,Race B,,,,321"]);
    const [a, b] = [await lineId(s4, "Race A"), await lineId(s4, "Race B")];
    const results = await Promise.all([a, b].map((l) =>
      api("acctA", "post", "/api/bank-recon/matches", { statementLineId: l, bookSourceType: "OR", bookSourceId: res.body.id })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await confirmedFor("OR", res.body.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("R7-4 EXACT evidence rules", () => {
  let s;
  beforeAll(async () => {
    // Two CVs sharing one check number and amount, two ORs sharing amount/date.
    doc.cvTieA = await createCv("acctA", "A", { no: `${P}CV-TIE-A`, checkNo: "R7TIE-1", gross: 300, date: "2098-07-15", lines: [ln("EXP", 300, 0), ln("BANK", 0, 300)] });
    doc.cvTieB = await createCv("acctA", "A", { no: `${P}CV-TIE-B`, checkNo: "R7TIE-1", gross: 300, date: "2098-07-15", lines: [ln("EXP", 300, 0), ln("BANK", 0, 300)] });
    doc.orSameA = (await createOr("acctA", "A", { no: `${P}OR-SAME-A`, gross: 250, date: "2098-07-16", lines: [ln("BANK", 250, 0), ln("AR", 0, 250)] })).body.id;
    doc.orSameB = (await createOr("acctA", "A", { no: `${P}OR-SAME-B`, gross: 250, date: "2098-07-16", lines: [ln("BANK", 250, 0), ln("AR", 0, 250)] })).body.id;
    doc.orRef = (await createOr("acctA", "A", { no: `${P}OR-REF77`, gross: 777, date: "2098-07-17", lines: [ln("BANK", 777, 0), ln("AR", 0, 777)] })).body.id;
    doc.cvDupLine = await createCv("acctA", "A", { no: `${P}CV-DUPLINE`, checkNo: "R7DL-1", gross: 444, date: "2098-07-18", lines: [ln("EXP", 444, 0), ln("BANK", 0, 444)] });
    // Company B: same bank account, same check number and amount as CV-MULTI.
    doc.cvB = await createCv("acctB", "B", { no: `${P}CV-B`, checkNo: "R7CHK-300", gross: 975, lines: [ln("EXP", 975, 0), ln("BANK", 0, 975)] });

    s = await newSession("acctA");
    expect((await importRows("acctA", s, [
      "2098-07-11,Exact check,,R7CHK-300,975,",
      `2098-07-17,Exact ref,${P}OR-REF77,,,777`,
      "2098-07-15,Tie check,,R7TIE-1,300,",
      "2098-07-16,Same amount,,,,250",
      "2098-07-18,Dup line 1,,R7DL-1,444,",
      "2098-07-18,Dup line 2,,R7DL-1,444,",
      "2098-07-12,Wrong amount,,R7CHK-400,401,",
    ])).status).toBe(200);
    expect((await api("acctA", "post", `/api/bank-recon/sessions/${s}/run-matching`)).status).toBe(200);
  });

  test("exact check number + identical amount is EXACT (CHECK_NO)", async () => {
    const [m] = await pendingFor(await lineId(s, "Exact check"));
    expect(m).toMatchObject({ type: "CV", docId: doc.cvMulti, matchType: "EXACT" });
    expect(level(m)).toBe("CHECK_NO");
  });

  test("exact document number in the reference + identical amount is EXACT (REFERENCE)", async () => {
    const [m] = await pendingFor(await lineId(s, "Exact ref"));
    expect(m).toMatchObject({ type: "OR", docId: doc.orRef, matchType: "EXACT" });
    expect(level(m)).toBe("REFERENCE");
  });

  test("one check number on two documents: both AMBIGUOUS, never EXACT", async () => {
    const ms = (await pendingFor(await lineId(s, "Tie check"))).filter((m) => [doc.cvTieA, doc.cvTieB].includes(m.docId));
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => m.matchType === "AMBIGUOUS")).toBe(true);
  });

  test("same amount and date on several documents, no identifier: suggestions only", async () => {
    const ms = await pendingFor(await lineId(s, "Same amount"));
    expect(ms.filter((m) => [doc.orSameA, doc.orSameB].includes(m.docId))).toHaveLength(2);
    expect(ms.some((m) => m.matchType === "EXACT")).toBe(false);
  });

  test("one document EXACT for two statement lines: AMBIGUOUS on both", async () => {
    for (const d of ["Dup line 1", "Dup line 2"]) {
      const m = (await pendingFor(await lineId(s, d))).find((x) => x.docId === doc.cvDupLine);
      expect(m.matchType).toBe("AMBIGUOUS");
    }
  });

  test("check number with a different amount is not EXACT", async () => {
    const ms = await pendingFor(await lineId(s, "Wrong amount"));
    expect(ms.some((m) => m.matchType === "EXACT")).toBe(false);
  });

  test("another company's document with the same check number is never a candidate", async () => {
    const all = await q("SELECT book_source_id AS id FROM bank_recon_matches WHERE session_id = ? AND book_source_type = 'CV'", [s]);
    expect(all.some((m) => m.id === doc.cvB)).toBe(false);
  });

  test("bulk confirm takes only strict single EXACT rows; legacy amount/date EXACT rows are skipped", async () => {
    const legacyLine = (await importRows("acctA", s, ["2098-07-22,Legacy,,,,999"])).status;
    expect(legacyLine).toBe(200);
    const lid = await lineId(s, "Legacy");
    await pool.query(
      `INSERT INTO bank_recon_matches (session_id, statement_line_id, book_source_type, book_source_id, match_type, confidence_score, score_breakdown, status, amount)
       VALUES (?, ?, 'OR', ?, 'EXACT', 60, '{"amountScore":40,"dateScore":20}', 'PENDING', 999)`,
      [s, lid, doc.orSameA]
    );
    const res = await api("acctA", "post", "/api/bank-recon/matches/bulk-confirm", { sessionId: s });
    expect(res.status).toBe(200);
    expect(res.body.confirmedCount).toBe(2);
    expect(res.body.skippedCount).toBeGreaterThanOrEqual(1);
    expect((await confirmedFor("CV", doc.cvMulti))).toHaveLength(1);
    expect((await confirmedFor("OR", doc.orRef))).toHaveLength(1);
    expect((await confirmedFor("OR", doc.orSameA))).toHaveLength(0);
    for (const id of [doc.cvTieA, doc.cvTieB, doc.cvDupLine]) expect(await confirmedFor("CV", id)).toHaveLength(0);
  });

  test("an already-reconciled document is not offered again on re-run", async () => {
    await importRows("acctA", s, ["2098-07-11,Check again,,R7CHK-300,975,"]);
    await api("acctA", "post", `/api/bank-recon/sessions/${s}/run-matching`);
    expect((await pendingFor(await lineId(s, "Check again"))).some((m) => m.docId === doc.cvMulti)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("R7-5 statement dates", () => {
  let s;
  beforeAll(async () => {
    s = await newSession("acctA", { start: "2098-09-01", end: "2098-09-30" });
  });
  const lineDate = async (description) =>
    (await one("SELECT DATE_FORMAT(txn_date, '%Y-%m-%d') d FROM bank_recon_statement_lines WHERE session_id = ? AND description = ?", [s, description]))?.d;
  const count = async () => (await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE session_id = ?", [s])).n;

  test("05/08/2098 is 5 August under DD/MM/YYYY", async () => {
    expect((await importRows("acctA", s, ["05/08/2098,dmy,,,1,"], { dateFormat: "DD/MM/YYYY" })).status).toBe(200);
    expect(await lineDate("dmy")).toBe("2098-08-05");
  });

  test("05/08/2098 is 8 May under MM/DD/YYYY", async () => {
    expect((await importRows("acctA", s, ["05/08/2098,mdy,,,2,"], { dateFormat: "MM/DD/YYYY" })).status).toBe(200);
    expect(await lineDate("mdy")).toBe("2098-05-08");
  });

  test("an ambiguous slash date with auto-detect is refused, nothing imported", async () => {
    const before = await count();
    const res = await importRows("acctA", s, ["05/08/2098,amb,,,3,"]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DATE_FORMAT_REQUIRED");
    expect(await count()).toBe(before);
  });

  test("25/08/2098 proves day-first: the whole file is read DD/MM", async () => {
    expect((await importRows("acctA", s, ["25/08/2098,proof,,,4,", "06/08/2098,follows,,,5,"])).status).toBe(200);
    expect(await lineDate("proof")).toBe("2098-08-25");
    expect(await lineDate("follows")).toBe("2098-08-06");
  });

  test("25/08/2098 under MM/DD/YYYY is invalid - clear 400, no SQL error, nothing imported", async () => {
    const before = await count();
    const res = await importRows("acctA", s, ["25/08/2098,bad mdy,,,6,"], { dateFormat: "MM/DD/YYYY" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATEMENT_DATES");
    expect(res.body.message).not.toMatch(/Incorrect date value|SQL|txn_date/);
    expect(await count()).toBe(before);
  });

  test.each([
    ["31/02/2098", "DD/MM/YYYY"],
    ["2098-13-01", "AUTO"],
    ["2098-02-30", "AUTO"],
    ["not a date", "AUTO"],
  ])("impossible / invalid date %s is refused", async (value, dateFormat) => {
    const before = await count();
    const res = await importRows("acctA", s, [`${value},impossible,,,7,`], { dateFormat });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATEMENT_DATES");
    expect(await count()).toBe(before);
  });

  test("mixed day-first and month-first dates are refused", async () => {
    const res = await importRows("acctA", s, ["25/08/2098,m1,,,8,", "08/26/2098,m2,,,9,"]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DATE_FORMAT_MIXED");
  });

  // R8.2: an undated row that carries an amount is a blocking error (it
  // used to be skipped); undated rows with no amount are still ignored.
  test("an undated row with an amount blocks the import; an undated row without one is ignored", async () => {
    const before = await count();
    const blocked = await importRows("acctA", s, [",blank row,,,10,", "2098-09-02,dated,,,11,"]);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("INVALID_STATEMENT_DATES");
    expect(await count()).toBe(before);
    const res = await importRows("acctA", s, [",heading only,,,,", "2098-09-02,dated,,,11,"]);
    expect(res.status).toBe(200);
    expect(res.body.skippedRows).toEqual([{ row: 2, reason: "Ignored - not a transaction row (no date and no amount)." }]);
    expect(await lineDate("dated")).toBe("2098-09-02");
  });

  test("dates with a time part and written month names", async () => {
    expect((await importRows("acctA", s, ["2098-09-03 14:30:00,with time,,,12,", "\"Sep 4, 2098\",written,,,13,"])).status).toBe(200);
    expect(await lineDate("with time")).toBe("2098-09-03");
    expect(await lineDate("written")).toBe("2098-09-04");
  });

  test("an unknown date format value is refused", async () => {
    const res = await importRows("acctA", s, ["2098-09-05,x,,,14,"], { dateFormat: "YYYY/DD/MM" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_FORMAT");
  });

  test("xlsx: date cells and Excel serial numbers", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Date", "Description", "Debit", "Credit"]);
    ws.addRow([new Date(Date.UTC(2098, 8, 6)), "xlsx date cell", 15, null]);
    ws.addRow([46000, "xlsx serial", 16, null]); // 2025-12-09
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await request(app).post(`/api/bank-recon/sessions/${s}/import`).set({ Authorization: `Bearer ${tok.acctA}` }).attach("file", buf, "statement.xlsx");
    expect(res.status).toBe(200);
    expect(await lineDate("xlsx date cell")).toBe("2098-09-06");
    expect(await lineDate("xlsx serial")).toBe("2025-12-09");
  });

  test("a legacy .xls file gets a clear 400, not a parser error", async () => {
    const res = await request(app).post(`/api/bank-recon/sessions/${s}/import`).set({ Authorization: `Bearer ${tok.acctA}` })
      .attach("file", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "legacy.xls");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_STATEMENT_FILE");
    expect(res.body.message).not.toMatch(/zip|central directory/i);
  });

  test("the chosen date format is recorded with the import batch mapping", async () => {
    const batch = await one("SELECT column_mapping FROM bank_recon_import_batches WHERE session_id = ? AND file_name = 'statement.csv' ORDER BY id LIMIT 1", [s]);
    const mapping = typeof batch.column_mapping === "string" ? JSON.parse(batch.column_mapping) : batch.column_mapping;
    expect(mapping.dateFormat).toBe("DD/MM/YYYY");
  });
});

// ---------------------------------------------------------------------------
describe("R7-6 manual match amount", () => {
  let s;
  beforeAll(async () => {
    doc.cv77 = await createCv("acctA", "A", { no: `${P}CV-77`, checkNo: "R7CHK-77", gross: 77, date: "2098-07-25", lines: [ln("EXP", 77, 0), ln("BANK", 0, 77)] });
    doc.cvDraft = await createCv("acctA", "A", { no: `${P}CV-DRAFT`, checkNo: "R7CHK-88", gross: 88, status: "Draft", date: "2098-07-25", lines: [ln("EXP", 88, 0), ln("BANK", 0, 88)] });
    doc.orNear = (await createOr("acctA", "A", { no: `${P}OR-NEAR`, gross: 600, date: "2098-07-26", lines: [ln("BANK", 600, 0), ln("AR", 0, 600)] })).body.id;
    // Its own withholding CV: with shared statement history (R8.3) CV-WHT
    // may already be reconciled by another July session.
    doc.cvWht6 = await createCv("acctA", "A", {
      no: `${P}CV-WHT6`, gross: 1000, date: "2098-07-25", lines: [ln("EXP", 1000, 0), ln("BANK", 0, 980), ln("WTP", 0, 20)],
    });
    s = await newSession("acctA");
    await importRows("acctA", s, [
      "2098-07-25,Pay 77,,,77,",
      "2098-07-25,Pay 1000,,,1000,",
      "2098-07-26,Deposit 600.50,,,,600.50",
      "2098-07-25,Pay 88,,,88,",
      "2098-07-25,Pay 980 other bank,,,980,",
    ]);
  });
  const match = (desc, body) => lineId(s, desc).then((l) => api("acctA", "post", "/api/bank-recon/matches", { statementLineId: l, ...body }));

  test("a client amount that is not the document's bank amount is refused", async () => {
    const res = await match("Pay 77", { bookSourceType: "CV", bookSourceId: doc.cv77, amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATCH_AMOUNT_INVALID");
    expect(await confirmedFor("CV", doc.cv77)).toHaveLength(0);
  });

  test("without an amount the server stores the document's bank amount", async () => {
    const res = await match("Pay 77", { bookSourceType: "CV", bookSourceId: doc.cv77 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(77);
    expect((await confirmedFor("CV", doc.cv77))[0].amount).toBe("77.00");
  });

  test("an already-matched statement line is refused with 409", async () => {
    const res = await match("Pay 77", { bookSourceType: "CV", bookSourceId: doc.cvPart });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STATEMENT_LINE_ALREADY_MATCHED");
  });

  test("statement 1,000 vs bank movement 980 exceeds the variance: refused", async () => {
    const res = await match("Pay 1000", { bookSourceType: "CV", bookSourceId: doc.cvWht6 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATCH_AMOUNT_MISMATCH");
  });

  test("a difference inside the session variance is allowed; the book amount is stored", async () => {
    const res = await match("Deposit 600.50", { bookSourceType: "OR", bookSourceId: doc.orNear, amount: 600 });
    expect(res.status).toBe(200);
    expect((await confirmedFor("OR", doc.orNear))[0].amount).toBe("600.00");
  });

  test("direction must agree (money out line vs OR money in)", async () => {
    const res = await match("Pay 1000", { bookSourceType: "OR", bookSourceId: doc.orCwt });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MATCH_DIRECTION_MISMATCH");
  });

  test("a Draft document is not eligible", async () => {
    const res = await match("Pay 88", { bookSourceType: "CV", bookSourceId: doc.cvDraft });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_NOT_POSTED");
  });

  test("a document paid through another bank account is not eligible", async () => {
    const res = await match("Pay 980 other bank", { bookSourceType: "CV", bookSourceId: doc.cvBk2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOK_DOCUMENT_OTHER_BANK");
  });

  test("another company's document answers 404", async () => {
    const res = await match("Pay 88", { bookSourceType: "CV", bookSourceId: doc.cvB });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Book document not found");
  });

  test("a JV match must name the bank line", async () => {
    const res = await match("Pay 88", { bookSourceType: "JV", bookSourceId: 1 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("R7-7 duplicate statement import", () => {
  const rows = ["2098-10-01,Dupe one,,,10,", "2098-10-02,Dupe two,,,,20"];

  test("the same statement imported twice into one session: second refused with 409", async () => {
    const s = await newSession("acctA", { start: "2098-10-01", end: "2098-10-31" });
    expect((await importRows("acctA", s, rows)).status).toBe(200);
    const again = await importRows("acctA", s, rows, { name: "renamed.csv" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("DUPLICATE_STATEMENT_IMPORT");
    expect((await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE session_id = ?", [s])).n).toBe(2);

    // different content is fine
    expect((await importRows("acctA", s, ["2098-10-03,Other,,,30,"])).status).toBe(200);

    // after deleting the batch the statement can be imported again
    const batch = await one("SELECT id FROM bank_recon_import_batches WHERE session_id = ? ORDER BY id LIMIT 1", [s]);
    expect((await api("acctA", "delete", `/api/bank-recon/import-batches/${batch.id}`)).status).toBe(200);
    expect((await importRows("acctA", s, rows)).status).toBe(200);
  });

  test("two identical imports at the same moment: only one lands", async () => {
    const s = await newSession("acctA", { start: "2098-11-01", end: "2098-11-30" });
    const raceRows = ["2098-10-05,Race one,,,10,", "2098-10-06,Race two,,,,20"];
    const results = await Promise.all([importRows("acctA", s, raceRows), importRows("acctA", s, raceRows)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE session_id = ?", [s])).n).toBe(2);
  });

  // R8.2: duplicate protection is per company + bank account, across sessions.
  test("the same statement in a different session of the same bank account is refused", async () => {
    const s = await newSession("acctA", { start: "2098-12-01", end: "2098-12-31" });
    const res = await importRows("acctA", s, rows);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_STATEMENT_IMPORT");
    expect((await one("SELECT COUNT(*) n FROM bank_recon_statement_lines WHERE session_id = ?", [s])).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("OR/CV payment safety is unchanged", () => {
  test("overpayment and cross-company application are still blocked; nothing written", async () => {
    const before = await one("SELECT paid_amount, balance_amount FROM apv_headers WHERE id = ?", [doc.apvPart]);
    await expect(createCv("acctA", "A", {
      no: `${P}CV-OVER`, gross: 700, lines: [ln("AP", 700, 0), ln("BANK", 0, 700)],
      apps: [{ sourceType: "APV", sourceId: doc.apvPart, amount: 700 }],
    })).rejects.toThrow(/cannot exceed APV balance/);
    const invB = await sourceDoc("invoice_headers", "B", `${P}INV-B`, 100);
    const res = await createOr("acctA", "A", { no: `${P}OR-XCO`, gross: 100, lines: [ln("BANK", 100, 0), ln("AR", 0, 100)], apps: [{ sourceType: "INV", sourceId: invB, amount: 100 }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await one("SELECT paid_amount, balance_amount FROM apv_headers WHERE id = ?", [doc.apvPart])).toEqual(before);
    expect(await one("SELECT paid_amount, payment_status FROM invoice_headers WHERE id = ?", [invB])).toEqual({ paid_amount: "0.00", payment_status: "Unpaid" });
    expect(await one("SELECT COUNT(*) n FROM cv_headers WHERE voucher_no = ?", [`${P}CV-OVER`])).toEqual({ n: 0 });
  });

  test("reconciliation never changed a voucher line or total", async () => {
    const [[cvLines]] = await pool.query("SELECT SUM(debit) d, SUM(credit) c FROM cv_lines WHERE cv_id = ?", [doc.cvWht]);
    expect(cvLines).toEqual({ d: "1000.00", c: "1000.00" });
    const [[orLines]] = await pool.query("SELECT SUM(debit) d, SUM(credit) c FROM or_lines WHERE or_id = ?", [doc.orCwt]);
    expect(orLines).toEqual({ d: "1000.00", c: "1000.00" });
  });
});
