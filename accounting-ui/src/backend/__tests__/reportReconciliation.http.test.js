// TC-REPORT-001 .. TC-REPORT-012, TC-REPORT-014 - accounting report reconciliation.
//
// One controlled dataset per company (created through the real APIs, posted
// through the normal posting path), then every report is read and checked
// against the GL / Trial Balance and against each other where they represent
// the same accounting balance. The P0 rule is asserted throughout: AR / AP
// subledger amounts are the amounts actually posted to the AR / AP control
// account (APV + EWT -> Gross - EWT, Invoice + CWT -> Gross - CWT).
//
// Local test database only (assertNotProductionDatabase). Fixture prefix RPTR-.
const bcrypt = require("bcryptjs");
const fs = require("fs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(300000);

const P = "rptr-";
const ACC = "RPTR-";
const PASSWORD = "RptrPass!1";
const ATC_AP = "RPTR-WC158"; // 1%
const ATC_AR = "RPTR-WC120"; // 2%
const AS_OF = "2096-06-30";
const FROM = "2096-06-01";
const TO = "2096-06-30";

const acc = {};
const co = { A: {}, B: {} };
let seq = 0;
let userId, adminId;
const tokens = {};

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { accountId: r.insertId, accountCode: `${ACC}${key}`, accountTitle: title };
}
const line = (key, debit, credit, extra = {}) => ({ ...acc[key], particulars: key, genRef: "", genName: "", debit, credit, ...extra });
const sum = (lines, k) => lines.reduce((s, l) => s + Number(l[k] || 0), 0);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const party = (id, name, type) => ({ supplierId: id, supplierName: name, customerId: id, customerName: name, payeeId: id, payeeName: name, partyId: id, partyName: name, partyType: type });

function ctx(key) {
  const c = co[key];
  const auth = () => ({ Authorization: `Bearer ${tokens.accountant}` });
  const body = (who, tag, status, lines, date, due, extra = {}) => ({
    ...who, voucherNo: `${P}${key}-${tag}-${++seq}`, referenceNo: `${P}${key}-${tag}`, transactionDate: date, dueDate: due, description: `${key} ${tag}`, status,
    lines, totalDebit: sum(lines, "debit"), totalCredit: sum(lines, "credit"), currency: { companyId: c.id }, companyId: c.id, ...extra,
  });
  const post = (path, b) => request(app).post(path).set(auth()).send(b);
  const get = (path, q = {}) => request(app).get(path).set(auth()).query({ companyId: c.id, ...q });
  return { c, body, post, get, auth };
}

async function ok(res, what) {
  if (res.status !== 200) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
}

async function buildCompany(key) {
  const { c, body, post } = ctx(key);
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}${key} Co`]);
  c.id = r.insertId;
  await pool.execute("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [c.id]);
  for (const uid of [userId, adminId]) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [uid, c.id]);
  const mkParty = async (tag, type, name) => {
    const [p] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, ?, ?, '123-456-789-000', 'ACTIVE')", [c.id, `${P}${key}-${tag}`, type, name]);
    return p.insertId;
  };
  c.C1 = await mkParty("C1", "CUSTOMER", `${key} Customer One`);
  c.C2 = await mkParty("C2", "CUSTOMER", `${key} Customer Two`);
  c.C3 = await mkParty("C3", "CUSTOMER", `${key} Customer Credit`);
  c.S1 = await mkParty("S1", "SUPPLIER", `${key} Supplier One`);
  const CUS = (id, n) => party(id, n, "CUSTOMER");
  const SUP = (id, n) => party(id, n, "SUPPLIER");
  const C1 = CUS(c.C1, `${key} Customer One`), C2 = CUS(c.C2, `${key} Customer Two`), C3 = CUS(c.C3, `${key} Customer Credit`), S1 = SUP(c.S1, `${key} Supplier One`);
  c.docs = {};
  const save = async (name, path, b) => { c.docs[name] = (await ok(await post(path, b), `${key} ${name}`)).id; };

  if (key === "B") {
    // Company B: one invoice and one APV, only to prove isolation.
    await save("INV", "/api/invoices", body(C1, "INV", "Posted", [line("AR", 9999, 0), line("REV", 0, 9999)], "2096-06-10", "2096-06-20", { invoiceType: "Standard" }));
    await save("APV", "/api/apv", body(S1, "APV", "Posted", [line("EXP", 8888, 0), line("AP", 0, 8888)], "2096-06-10", "2096-06-20"));
    return;
  }

  // ---- AR -------------------------------------------------------------
  // INV1: gross 56,000 receivable, CWT 1,000 -> AR control 55,000; partly collected 30,000.
  await save("INV1", "/api/invoices", body(C1, "INV1", "Posted", [
    line("AR", 55000, 0),
    line("CWT", 1000, 0, { taxEntry: { entryType: "EWT", atcCode: ATC_AR, taxType: "EWT", taxableBase: 50000, withheldAmount: 1000 } }),
    line("REV", 0, 50000),
    line("OUTVAT", 0, 6000, { taxEntry: { entryType: "OUTPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 56000, netAmount: 50000, vatAmount: 6000, partyId: c.C1, partyName: `${key} Customer One`, partyTin: "123-456-789-000" } }),
  ], "2096-06-05", "2096-06-20", { atcCode: ATC_AR, taxWithheldAmount: 1000, invoiceType: "Standard" }));
  await save("OR1", "/api/or", body(C1, "OR1", "Posted", [line("BANK", 30000, 0), line("AR", 0, 30000)], "2096-06-25", null, { paymentMethod: "Cash", invoiceApplications: [{ sourceId: c.docs.INV1, amount: 30000, applicationDate: "2096-06-25" }] }));
  // INV2: last day of the period, not yet due.
  await save("INV2", "/api/invoices", body(C1, "INV2", "Posted", [
    line("AR", 11200, 0), line("REV", 0, 10000),
    line("OUTVAT", 0, 1200, { taxEntry: { entryType: "OUTPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 11200, netAmount: 10000, vatAmount: 1200, partyId: c.C1, partyName: `${key} Customer One`, partyTin: "123-456-789-000" } }),
  ], TO, "2096-07-30", { invoiceType: "Standard" }));
  // INV3: first day of the next month - outside the period and after the as-of date.
  await save("INV3", "/api/invoices", body(C1, "INV3", "Posted", [line("AR", 5000, 0), line("REV", 0, 5000)], "2096-07-01", "2096-07-31", { invoiceType: "Standard" }));
  // INV4: Draft - never in any report.
  await save("INV4", "/api/invoices", body(C1, "INV4", "Draft", [line("AR", 7000, 0), line("REV", 0, 7000)], "2096-06-12", "2096-06-22", { invoiceType: "Standard" }));
  // Memos for C1.
  await save("DM", "/api/debit-memos", body(C1, "DM", "Posted", [line("AR", 2000, 0), line("REV", 0, 2000)], "2096-06-15", null));
  await save("CM", "/api/credit-memos", body(C1, "CM", "Posted", [line("REV", 1500, 0), line("AR", 0, 1500)], "2096-06-16", null));
  // C2: invoice fully collected -> zero balance.
  await save("INV5", "/api/invoices", body(C2, "INV5", "Posted", [line("AR", 3000, 0), line("REV", 0, 3000)], "2096-06-02", "2096-06-12", { invoiceType: "Standard" }));
  await save("OR2", "/api/or", body(C2, "OR2", "Posted", [line("BANK", 3000, 0), line("AR", 0, 3000)], "2096-06-11", null, { paymentMethod: "Cash", invoiceApplications: [{ sourceId: c.docs.INV5, amount: 3000, applicationDate: "2096-06-11" }] }));
  // C3: credit memo only -> credit balance.
  await save("CM3", "/api/credit-memos", body(C3, "CM3", "Posted", [line("REV", 800, 0), line("AR", 0, 800)], "2096-06-18", null));

  // ---- AP -------------------------------------------------------------
  // APV1: gross 22,400 (20,000 + 2,400 VAT), EWT 200 -> AP control 22,200; partly paid 10,000.
  await save("APV1", "/api/apv", body(S1, "APV1", "Posted", [
    line("EXP", 20000, 0),
    line("INVAT", 2400, 0, { taxEntry: { entryType: "INPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 22400, netAmount: 20000, vatAmount: 2400, partyId: c.S1, partyName: `${key} Supplier One`, partyTin: "123-456-789-000", purchaseClassification: "Services" } }),
    line("EWTP", 0, 200, { taxEntry: { entryType: "EWT", atcCode: ATC_AP, taxType: "EWT", taxableBase: 20000, withheldAmount: 200 } }),
    line("AP", 0, 22200),
  ], "2096-06-03", "2096-06-18", { atcCode: ATC_AP, taxWithheldAmount: 200 }));
  await save("CV1", "/api/cv", body(S1, "CV1", "Posted", [line("AP", 10000, 0), line("BANK", 0, 10000)], "2096-06-20", null, { paymentMethod: "Cash", apvApplications: [{ sourceId: c.docs.APV1, amount: 10000, applicationDate: "2096-06-20" }] }));
  // APV2: no withholding, not yet due.
  await save("APV2", "/api/apv", body(S1, "APV2", "Posted", [
    line("EXP", 5000, 0),
    line("INVAT", 600, 0, { taxEntry: { entryType: "INPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 5600, netAmount: 5000, vatAmount: 600, partyId: c.S1, partyName: `${key} Supplier One`, partyTin: "123-456-789-000", purchaseClassification: "Services" } }),
    line("AP", 0, 5600),
  ], TO, "2096-07-30"));
  // APV3: posted then voided -> excluded everywhere.
  await save("APV3", "/api/apv", body(S1, "APV3", "Posted", [line("EXP", 4000, 0), line("AP", 0, 4000)], "2096-06-08", "2096-06-18"));
  await ok(await post(`/api/apv/${c.docs.APV3}/void`, { reason: "RPTR void" }), "A APV3 void");
  // Supplier memos.
  await save("SDM", "/api/debit-memos", body(S1, "SDM", "Posted", [line("AP", 400, 0), line("EXP", 0, 400)], "2096-06-21", null));
  await save("SCM", "/api/credit-memos", body(S1, "SCM", "Posted", [line("EXP", 300, 0), line("AP", 0, 300)], "2096-06-22", null));

  // ---- beginning balances (opening, dated before the period) -----------
  const bb = (balanceType, partyId, partyName, key2, debit, credit, due) => post("/api/arap-beginning-balances", {
    companyId: c.id, balanceType, balanceDate: "2096-05-31", currencyCode: "PHP", currencyName: "PHILIPPINE PESO", remarks: `${P}${balanceType}`,
    line: { partyId, partyCode: `${P}${key}`, partyName, accountId: acc[key2].accountId, accountCode: acc[key2].accountCode, accountTitle: acc[key2].accountTitle, referenceNo: `${P}BB-${balanceType}`, dueDate: due, debit, credit },
  });
  c.bbAR = await ok(await bb("AR", c.C1, `${key} Customer One`, "AR", 5000, 0, "2096-04-30"), "A AR beginning");
  c.bbAP = await ok(await bb("AP", c.S1, `${key} Supplier One`, "AP", 0, 3000, "2096-04-30"), "A AP beginning");
  // The AR / AP beginning-balance lines post one-sided to the AR / AP control
  // accounts; the opening offset is a GL beginning balance (opening equity).
  const [gh] = await pool.execute("INSERT INTO gl_beginning_balance_headers (company_id, filter_code, balance_date, currency_code, title, status) VALUES (?, 'RPTR', '2096-05-31', 'PHP', 'RPTR opening equity', 'Posted')", [c.id]);
  await pool.execute("INSERT INTO gl_beginning_balance_lines (header_id, account_id, account_code, account_title, othrdebit, othrcredit) VALUES (?, ?, ?, ?, 0, 2000)", [gh.insertId, acc.EQ.accountId, acc.EQ.accountCode, acc.EQ.accountTitle]);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkAccount("AP", "RPTR Accounts Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("AR", "RPTR Accounts Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("EXP", "RPTR Supplies Expense", "EXPENSE");
  await mkAccount("INVAT", "RPTR Input VAT", "ASSET", ["INPUT VAT"]);
  await mkAccount("EWTP", "RPTR EWT Payable", "LIABILITY", ["EXPANDED TAX"]);
  await mkAccount("CWT", "RPTR Creditable Withholding Tax", "ASSET", ["EXPANDED TAX"]);
  await mkAccount("REV", "RPTR Service Revenue", "INCOME");
  await mkAccount("OUTVAT", "RPTR Output VAT", "LIABILITY", ["OUTPUT VAT"]);
  await mkAccount("BANK", "RPTR Cash in Bank", "ASSET", ["BANK / CASH"]);
  await mkAccount("EQ", "RPTR Opening Balance Equity", "EQUITY");
  for (const [code, desc, cls, section, order, status] of [
    ["RPTR-GC-REV", "RPTR Revenue group", "INCOME", "REVENUE", 1, "ACTIVE"],
    ["RPTR-GC-EXP", "RPTR Operating expense group", "EXPENSE", "OPERATING_EXPENSE", 2, "ACTIVE"],
    ["RPTR-GC-AR", "RPTR Receivables group", "ASSET", "CURRENT_ASSET", 3, "ACTIVE"],
    ["RPTR-GC-BANK", "RPTR Cash group", "ASSET", "CURRENT_ASSET", 1, "ACTIVE"],
    ["RPTR-GC-OFF", "RPTR Inactive asset group", "ASSET", "CURRENT_ASSET", 2, "INACTIVE"],
  ]) {
    await pool.execute("INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status) VALUES (?, ?, ?, ?, ?, ?)", [code, desc, cls, section, order, status]);
  }
  for (const [k, code, desc] of [["REV", "RPTR-GC-REV", "RPTR Revenue group"], ["EXP", "RPTR-GC-EXP", "RPTR Operating expense group"], ["AR", "RPTR-GC-AR", "RPTR Receivables group"], ["BANK", "RPTR-GC-BANK", "RPTR Cash group"], ["CWT", "RPTR-GC-OFF", "RPTR Inactive asset group"]]) {
    await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [acc[k].accountId, code, desc]);
  }
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'RPTR fixture 1%', 1, 'EWT', 'ACTIVE')", [ATC_AP]);
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'RPTR fixture 2%', 2, 'EWT', 'ACTIVE')", [ATC_AR]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ACCOUNTANT'), 'ACTIVE')", [`${P}acct`, hash]);
  userId = u.insertId;
  const [a] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ADMIN'), 'ACTIVE')", [`${P}admin`, hash]);
  adminId = a.insertId;
  for (const [k, n] of [["accountant", `${P}acct`], ["admin", `${P}admin`]]) {
    const res = await request(app).post("/api/login").send({ username: n, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login ${n}: ${res.status}`);
    tokens[k] = res.body.token;
  }
  await buildCompany("A");
  await buildCompany("B");
});

afterAll(async () => {
  try {
    const cs = [co.A.id, co.B.id].filter(Boolean);
    if (cs.length) {
      await pool.query("DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id IN (?)", [cs]);
      await pool.query("DELETE ta FROM transaction_applications ta JOIN or_headers h ON h.id = ta.applied_id AND ta.applied_type = 'OR' WHERE h.company_id IN (?)", [cs]);
      for (const [lines, fk, hdr] of [["cv_lines", "cv_id", "cv_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["memo_lines", "memo_id", "memo_headers"], ["jv_lines", "jv_id", "jv_headers"], ["arap_beginning_balance_lines", "header_id", "arap_beginning_balance_headers"], ["gl_beginning_balance_lines", "header_id", "gl_beginning_balance_headers"]]) {
        await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [cs]).catch(() => {});
      }
      await pool.query("DELETE FROM invoice_verifications WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [cs]).catch(() => {});
      for (const t of ["cv_headers", "or_headers", "apv_headers", "invoice_headers", "memo_headers", "jv_headers", "arap_beginning_balance_headers", "gl_beginning_balance_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "currencies"]) {
        await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cs]).catch(() => {});
      }
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id IN (?, ?)", [userId, adminId]).catch(() => {});
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [userId, adminId]);
    await pool.query("DELETE FROM users WHERE id IN (?, ?)", [userId, adminId]);
    if (cs_ok()) await pool.query("DELETE FROM companies WHERE id IN (?)", [[co.A.id, co.B.id].filter(Boolean)]);
    await pool.query("DELETE FROM ewt_library WHERE atc_code IN (?, ?)", [ATC_AP, ATC_AR]);
    await pool.query(`DELETE FROM coa_groups WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'RPTR-GC-%'");
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});
function cs_ok() { return Boolean(co.A.id || co.B.id); }

// ---------------------------------------------------------------------------
// Discovery: when RPTR_DUMP is set, write every report response to that file.
test("discovery dump (only when RPTR_DUMP is set)", async () => {
  if (!process.env.RPTR_DUMP) return;
  const { get, c } = ctx("A");
  const out = { companyId: c.id, docs: c.docs, parties: { C1: c.C1, C2: c.C2, C3: c.C3, S1: c.S1 }, acc };
  const reads = {
    arAging: ["/api/reports/ar-aging", { asOf: AS_OF, status: "ALL" }],
    arAgingOpen: ["/api/reports/ar-aging", { asOf: AS_OF }],
    arSummary: ["/api/reports/ar-aging-summary", { asOf: AS_OF }],
    apAging: ["/api/reports/ap-aging", { asOf: AS_OF, status: "ALL" }],
    apSummary: ["/api/reports/ap-aging-summary", { asOf: AS_OF }],
    arOverdue: ["/api/reports/ar-overdue-accounts", { asOf: AS_OF }],
    apOverdue: ["/api/reports/ap-overdue-accounts", { asOf: AS_OF }],
    soaC1: ["/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO }],
    bc: ["/api/reports/ar-billings-and-collections", { from: FROM, to: TO }],
    pp: ["/api/reports/ap-payables-and-payments", { from: FROM, to: TO }],
    slAR: ["/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: FROM, to: TO }],
    slAP: ["/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO }],
    tb: ["/api/reports/trial-balance", { from: FROM, to: TO }],
    glAR: ["/api/reports/general-ledger", { from: FROM, to: TO, accountCode: acc.AR.accountCode }],
    aaAR: ["/api/reports/account-analysis", { from: FROM, to: TO, accountCode: acc.AR.accountCode }],
    aaINVAT: ["/api/reports/account-analysis", { from: FROM, to: TO, accountCode: acc.INVAT.accountCode }],
    outVat: ["/api/reports/output-vat", { from: FROM, to: TO }],
    f2307: ["/api/reports/2307", { supplierId: c.S1, year: 2096, quarter: 2 }],
    ewtAudit: ["/api/reports/ewt-audit", { from: FROM, to: TO }],
    dash: ["/api/dashboard/summary", { from: FROM, to: TO }],
    isStruct: ["/api/reports/income-statement", { from: FROM, to: TO, view: "structured", comparePrev: 0, ytd: 0 }],
    bsStruct: ["/api/reports/balance-sheet", { to: TO, view: "structured" }],
    slARmid: ["/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: "2096-06-16", to: TO }],
  };
  for (const [k, [path, q]] of Object.entries(reads)) {
    const res = await get(path, q);
    out[k] = { status: res.status, body: res.body };
  }
  fs.writeFileSync(process.env.RPTR_DUMP, JSON.stringify(out, null, 1));
});

// ===========================================================================
// Readers
async function read(key, path, q = {}) {
  const res = await ctx(key).get(path, q);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body;
}
const rowsOf = (b) => (Array.isArray(b) ? b : b.rows);
// Trial balance as net (debit - credit) per account. From the start of the
// year so the 2096-05-31 beginning balances are included (GL = as-of balance).
async function tb(key, from = "2096-01-01", to = AS_OF) {
  const m = {};
  for (const r of await read(key, "/api/reports/trial-balance", { from, to })) m[r.account_code] = round2(Number(r.debit) - Number(r.credit));
  return m;
}
const g = (m, k) => m[acc[k].accountCode] || 0;
const aging = async (key, kind, q = {}) => read(key, `/api/reports/${kind}-aging`, { asOf: AS_OF, status: "ALL", ...q });
const summaryParty = async (key, kind, partyId) => ((await read(key, `/api/reports/${kind}-aging-summary`, { asOf: AS_OF })).parties.find((p) => p.partyId === partyId) || {}).baseBalance || 0;
const findRow = (rows, type, id) => rows.find((r) => r.sourceType === type && r.sourceId === id);
const slEnd = (rows) => (rows.length ? Number(rows[rows.length - 1].running_balance) : 0);

// ===========================================================================
describe("TC-REPORT-001 AR / AP aging reconciliation", () => {
  test("AR aging: control amounts, partial / full payment, memos, credit balance, beginning balance, buckets", async () => {
    const { c } = ctx("A");
    const b = await aging("A", "ar");
    const rows = b.rows;
    expect(findRow(rows, "INV", c.docs.INV1)).toMatchObject({ baseOriginal: 55000, baseBalance: 25000, bucket: "days1to30" }); // partial
    expect(findRow(rows, "INV", c.docs.INV2)).toMatchObject({ baseOriginal: 11200, baseBalance: 11200, bucket: "current" });
    expect(findRow(rows, "INV", c.docs.INV5)).toMatchObject({ baseBalance: 0 }); // fully collected
    expect(findRow(rows, "DM", c.docs.DM)).toMatchObject({ baseBalance: 2000 });
    expect(findRow(rows, "CM", c.docs.CM)).toMatchObject({ baseBalance: -1500 });
    expect(findRow(rows, "CM", c.docs.CM3)).toMatchObject({ baseBalance: -800, partyId: c.C3 }); // credit balance
    expect(rows.find((r) => r.sourceType === "AR_BEGINNING")).toMatchObject({ baseBalance: 5000, dueDate: "2096-04-30", bucket: "days61to90" });
    expect(b.bucketTotals.base).toEqual({ current: 11200, days1to30: 24700, days31to60: 0, days61to90: 5000, over90: 0, total: 40900 });
  });

  test("default OPEN aging drops the fully collected invoice but keeps the credit balance", async () => {
    const { c } = ctx("A");
    const rows = (await read("A", "/api/reports/ar-aging", { asOf: AS_OF })).rows;
    expect(findRow(rows, "INV", c.docs.INV5)).toBeUndefined();
    expect(findRow(rows, "CM", c.docs.CM3)).toBeTruthy();
  });

  test("AP aging: APV control amount, partial payment, supplier memos, beginning balance, buckets", async () => {
    const { c } = ctx("A");
    const b = await aging("A", "ap");
    expect(findRow(b.rows, "APV", c.docs.APV1)).toMatchObject({ baseOriginal: 22200, baseBalance: 12200, bucket: "days1to30" });
    expect(findRow(b.rows, "APV", c.docs.APV2)).toMatchObject({ baseBalance: 5600, bucket: "current" });
    expect(findRow(b.rows, "DM", c.docs.SDM)).toMatchObject({ baseBalance: -400 });
    expect(findRow(b.rows, "CM", c.docs.SCM)).toMatchObject({ baseBalance: 300 });
    expect(b.rows.find((r) => r.sourceType === "AP_BEGINNING")).toMatchObject({ baseBalance: 3000, bucket: "days61to90" });
    expect(b.bucketTotals.base).toEqual({ current: 5600, days1to30: 12100, days31to60: 0, days61to90: 3000, over90: 0, total: 20700 });
  });

  test("aging totals = aging summaries = GL control balances", async () => {
    const { c } = ctx("A");
    const t = await tb("A");
    expect(g(t, "AR")).toBe(40900);
    expect(-g(t, "AP")).toBe(20700);
    expect((await summaryParty("A", "ar", c.C1)) + (await summaryParty("A", "ar", c.C2)) + (await summaryParty("A", "ar", c.C3))).toBe(40900);
    expect(await summaryParty("A", "ar", c.C1)).toBe(41700);
    expect(await summaryParty("A", "ap", c.S1)).toBe(20700);
  });

  test("overdue lists: only past-due items, zero balances excluded, memos follow the P0 standalone rule", async () => {
    const { c } = ctx("A");
    const ar = await read("A", "/api/reports/ar-overdue-accounts", { asOf: AS_OF });
    expect(findRow(ar.rows, "INV", c.docs.INV2)).toBeUndefined(); // not yet due
    expect(findRow(ar.rows, "INV", c.docs.INV5)).toBeUndefined(); // zero balance
    expect(findRow(ar.rows, "INV", c.docs.INV1)).toMatchObject({ baseBalance: 25000 });
    expect(findRow(ar.rows, "CM", c.docs.CM3)).toMatchObject({ baseBalance: -800 }); // documented in arOverdueAccounts test 19
    expect(ar.bucketTotals.base.total).toBe(29700);
    expect(ar.bucketTotals.base.current).toBe(0);
    const ap = await read("A", "/api/reports/ap-overdue-accounts", { asOf: AS_OF });
    expect(findRow(ap.rows, "APV", c.docs.APV2)).toBeUndefined();
    expect(ap.bucketTotals.base.total).toBe(15100);
  });

  test("dashboard receivables / payables consume the same aging totals", async () => {
    const d = await read("A", "/api/dashboard/summary", { from: FROM, to: TO });
    expect(d.sections.receivables).toMatchObject({ total: 40900, overdue: 29700 });
    expect(d.sections.payables).toMatchObject({ total: 20700, overdue: 15100 });
  });
});

// ===========================================================================
describe("TC-REPORT-002 statement reconciliation (Statement <-> Aging <-> GL)", () => {
  test("Statement of Accounts: beginning balance, dated rows, running balance, ending = aging = GL share", async () => {
    const { c } = ctx("A");
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO });
    expect(s.beginningBalance).toBe(5000);
    expect(s.rows.map((r) => [r.transactionDate, r.sourceType, r.debit, r.credit, r.runningBalance])).toEqual([
      ["2096-06-05", "INV", 55000, 0, 60000],
      ["2096-06-15", "DEBIT MEMO", 2000, 0, 62000],
      ["2096-06-16", "CREDIT MEMO", 0, 1500, 60500],
      ["2096-06-25", "OR", 0, 30000, 30500],
      ["2096-06-30", "INV", 11200, 0, 41700],
    ]);
    expect(s.endingBalance).toBe(41700);
    expect(s.endingBalance).toBe(await summaryParty("A", "ar", c.C1));
  });

  test("a statement starting mid-period carries the earlier activity in its beginning balance", async () => {
    const { c } = ctx("A");
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: "2096-06-16", to: TO });
    expect(s.beginningBalance).toBe(62000);
    expect(s.endingBalance).toBe(41700);
  });

  test("Billings & Collections: per-customer ending = aging, grand total = GL AR", async () => {
    const { c } = ctx("A");
    const bc = await read("A", "/api/reports/ar-billings-and-collections", { from: FROM, to: TO });
    const by = Object.fromEntries(bc.customers.map((x) => [x.partyId, x]));
    expect(by[c.C1]).toMatchObject({ beginningBalance: 5000, billings: 66200, debitMemos: 2000, collections: 30000, creditMemos: 1500, endingBalance: 41700 });
    expect(by[c.C2]).toMatchObject({ billings: 3000, collections: 3000, endingBalance: 0 });
    expect(by[c.C3]).toMatchObject({ creditMemos: 800, endingBalance: -800 });
    expect(bc.grandTotalEndingBalance).toBe(40900);
    expect(bc.grandTotalEndingBalance).toBe(g(await tb("A"), "AR"));
  });
});

// ===========================================================================
describe("TC-REPORT-003 AP / AR control amount (gross vs control line)", () => {
  async function header(table, id) {
    const [[r]] = await pool.execute(`SELECT total_debit, total_credit, balance_amount FROM ${table} WHERE id = ?`, [id]);
    return { totalDebit: Number(r.total_debit), totalCredit: Number(r.total_credit), balance: Number(r.balance_amount) };
  }

  test("Invoice + CWT: gross 56,000 on the header, 55,000 in every AR report", async () => {
    const { c } = ctx("A");
    expect(await header("invoice_headers", c.docs.INV1)).toMatchObject({ totalDebit: 56000, balance: 25000 });
    expect(findRow((await aging("A", "ar")).rows, "INV", c.docs.INV1).baseOriginal).toBe(55000);
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO });
    expect(s.rows.find((r) => r.referenceNo && r.sourceType === "INV" && r.transactionDate === "2096-06-05").debit).toBe(55000);
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: FROM, to: TO });
    expect(Number(sl.find((r) => r.transaction_id === c.docs.INV1).debit)).toBe(55000);
  });

  test("APV + EWT: gross 22,400 on the header, 22,200 in every AP report", async () => {
    const { c } = ctx("A");
    expect(await header("apv_headers", c.docs.APV1)).toMatchObject({ totalCredit: 22400, balance: 12200 });
    expect(findRow((await aging("A", "ap")).rows, "APV", c.docs.APV1).baseOriginal).toBe(22200);
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO });
    expect(Number(sl.find((r) => r.transaction_id === c.docs.APV1).credit)).toBe(22200);
    const pp = await read("A", "/api/reports/ap-payables-and-payments", { from: FROM, to: TO });
    expect(pp.suppliers.find((x) => x.partyId === c.S1)).toMatchObject({ beginningPayable: 3000, payables: 27800, payments: 10000, debitMemos: 400, creditMemos: 300, endingPayable: 20700 });
  });

  test("no withholding: control amount = header total", async () => {
    const { c } = ctx("A");
    expect(findRow((await aging("A", "ar")).rows, "INV", c.docs.INV2).baseOriginal).toBe((await header("invoice_headers", c.docs.INV2)).totalDebit);
    expect(findRow((await aging("A", "ap")).rows, "APV", c.docs.APV2).baseOriginal).toBe((await header("apv_headers", c.docs.APV2)).totalCredit);
  });

  test("application cap: paying more than the remaining control balance (12,200) is refused; nothing changes", async () => {
    const { c, body, post } = ctx("A");
    const before = (await pool.execute("SELECT COUNT(*) n FROM cv_headers WHERE company_id = ?", [c.id]))[0][0].n;
    const S1 = party(c.S1, "A Supplier One", "SUPPLIER");
    const res = await post("/api/cv", body(S1, "CV-OVER", "Posted", [line("AP", 12400, 0), line("BANK", 0, 12400)], "2096-06-26", null, { paymentMethod: "Cash", apvApplications: [{ sourceId: c.docs.APV1, amount: 12400, applicationDate: "2096-06-26" }] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/cannot exceed APV balance of 12200\.00/);
    expect((await pool.execute("SELECT COUNT(*) n FROM cv_headers WHERE company_id = ?", [c.id]))[0][0].n).toBe(before);
    expect((await header("apv_headers", c.docs.APV1)).balance).toBe(12200);
  });
});

// ===========================================================================
describe("TC-REPORT-004 memo aging (signs, dates, ledgers)", () => {
  test("customer DM +, customer CM -, supplier DM -, supplier CM +; aged from the memo date", async () => {
    const { c } = ctx("A");
    const ar = (await aging("A", "ar")).rows, ap = (await aging("A", "ap")).rows;
    expect(findRow(ar, "DM", c.docs.DM)).toMatchObject({ baseBalance: 2000, transactionDate: "2096-06-15", dueDate: "2096-06-15", partyId: c.C1 });
    expect(findRow(ar, "CM", c.docs.CM)).toMatchObject({ baseBalance: -1500, transactionDate: "2096-06-16", dueDate: "2096-06-16" });
    expect(findRow(ap, "DM", c.docs.SDM)).toMatchObject({ baseBalance: -400, transactionDate: "2096-06-21", dueDate: "2096-06-21", partyId: c.S1 });
    expect(findRow(ap, "CM", c.docs.SCM)).toMatchObject({ baseBalance: 300, dueDate: "2096-06-22" });
  });

  test("memos never cross ledgers", async () => {
    const { c } = ctx("A");
    const ar = (await aging("A", "ar")).rows, ap = (await aging("A", "ap")).rows;
    for (const id of [c.docs.SDM, c.docs.SCM]) expect(ar.find((r) => r.sourceId === id && ["DM", "CM"].includes(r.sourceType))).toBeUndefined();
    for (const id of [c.docs.DM, c.docs.CM, c.docs.CM3]) expect(ap.find((r) => r.sourceId === id && ["DM", "CM"].includes(r.sourceType))).toBeUndefined();
  });

  test("subsidiary ledgers carry the memos with the same signs", async () => {
    const { c } = ctx("A");
    const slAr = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: FROM, to: TO });
    expect(Number(slAr.find((r) => r.transaction_id === c.docs.DM).debit)).toBe(2000);
    expect(Number(slAr.find((r) => r.transaction_id === c.docs.CM).credit)).toBe(1500);
    const slAp = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO });
    expect(Number(slAp.find((r) => r.transaction_id === c.docs.SDM).debit)).toBe(400);
    expect(Number(slAp.find((r) => r.transaction_id === c.docs.SCM).credit)).toBe(300);
  });
});

// ===========================================================================
describe("TC-REPORT-005 subsidiary ledger reconciliation (GL <-> Subsidiary Ledger <-> Aging)", () => {
  test("AR: balance forward from the beginning balance, ending = statement = aging", async () => {
    const { c } = ctx("A");
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: FROM, to: TO });
    expect(sl[0]).toMatchObject({ source_type: "BALANCE FORWARD", transaction_date: FROM, debit: "0.0000", credit: "0.0000", running_balance: "5000.0000" });
    expect(sl.map((r) => Number(r.running_balance))).toEqual([5000, 60000, 62000, 60500, 30500, 41700]);
    expect(slEnd(sl)).toBe(await summaryParty("A", "ar", c.C1));
  });

  test("AR from mid-period: earlier rows become the balance forward; ending unchanged", async () => {
    const { c } = ctx("A");
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: "2096-06-16", to: TO });
    expect(sl[0]).toMatchObject({ source_type: "BALANCE FORWARD", running_balance: "62000.0000" });
    expect(sl.filter((r) => r.source_type !== "BALANCE FORWARD").map((r) => r.transaction_date)).toEqual(["2096-06-16", "2096-06-25", "2096-06-30"]);
    expect(slEnd(sl)).toBe(41700);
  });

  test("AP: balance forward 3,000, ending = aging = Payables & Payments", async () => {
    const { c } = ctx("A");
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO });
    expect(sl[0]).toMatchObject({ source_type: "BALANCE FORWARD", running_balance: "3000.0000" });
    expect(slEnd(sl)).toBe(20700);
    expect(slEnd(sl)).toBe(await summaryParty("A", "ap", c.S1));
  });

  test("no prior activity: no balance-forward row; party ledgers sum to the GL control", async () => {
    const { c } = ctx("A");
    const c2 = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C2, from: FROM, to: TO });
    expect(c2.find((r) => r.source_type === "BALANCE FORWARD")).toBeUndefined();
    let total = 0;
    for (const p of [c.C1, c.C2, c.C3]) total += slEnd(await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: p, from: FROM, to: TO }));
    expect(round2(total)).toBe(g(await tb("A"), "AR"));
  });
});

// ===========================================================================
describe("TC-REPORT-006 date boundaries, cancelled and draft documents", () => {
  test("last day of the period is included, the next month is not", async () => {
    const { c } = ctx("A");
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO });
    expect(s.rows.some((r) => r.transactionDate === TO)).toBe(true);
    expect(s.rows.some((r) => r.transactionDate === "2096-07-01")).toBe(false);
    expect(findRow((await aging("A", "ar")).rows, "INV", c.docs.INV3)).toBeUndefined();
    expect(g(await tb("A", FROM, TO), "AR")).toBe(35900); // June movement only
  });

  test("the next period picks the next-month document up, carried from the June ending balance", async () => {
    const { c } = ctx("A");
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: "2096-07-01", to: "2096-07-31" });
    expect(s.beginningBalance).toBe(41700);
    expect(s.rows.map((r) => [r.transactionDate, r.debit])).toEqual([["2096-07-01", 5000]]);
    expect(s.endingBalance).toBe(46700);
  });

  test("month-end as-of: aging on 2096-05-31 shows only the opening balances", async () => {
    const ar = await read("A", "/api/reports/ar-aging", { asOf: "2096-05-31", status: "ALL" });
    expect(ar.rows.map((r) => r.sourceType)).toEqual(["AR_BEGINNING"]);
    expect(ar.bucketTotals.base.total).toBe(5000);
  });

  test("document date filter: documentFrom = documentTo = last day keeps only that day's documents", async () => {
    const { c } = ctx("A");
    const rows = (await aging("A", "ar", { documentFrom: TO, documentTo: TO })).rows;
    expect(rows.map((r) => r.sourceId)).toEqual([c.docs.INV2]);
  });

  test("voided APV and draft invoice appear in no report", async () => {
    const { c } = ctx("A");
    expect(findRow((await aging("A", "ap")).rows, "APV", c.docs.APV3)).toBeUndefined();
    expect(findRow((await aging("A", "ar")).rows, "INV", c.docs.INV4)).toBeUndefined();
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO });
    expect(sl.find((r) => r.transaction_id === c.docs.APV3)).toBeUndefined();
    const gl = await read("A", "/api/reports/general-ledger", { from: FROM, to: TO, accountCode: acc.AP.accountCode });
    expect(gl.find((r) => r.reference_no && r.reference_no.includes("APV3"))).toBeUndefined();
    expect(-g(await tb("A", FROM, TO), "AP")).toBe(17700); // 22,200 + 5,600 - 10,000 - 400 + 300
  });
});

// ===========================================================================
describe("TC-REPORT-007 company isolation", () => {
  test("company A reports never include company B documents", async () => {
    const { c: b } = ctx("B");
    const ar = await aging("A", "ar"), ap = await aging("A", "ap");
    expect(ar.rows.some((r) => r.sourceId === b.docs.INV && r.sourceType === "INV")).toBe(false);
    expect(ap.rows.some((r) => r.sourceId === b.docs.APV && r.sourceType === "APV")).toBe(false);
    expect(ar.bucketTotals.base.total).toBe(40900);
    expect(g(await tb("A"), "AR")).toBe(40900);
  });

  test("company B sees only its own invoice / APV", async () => {
    const { c: b } = ctx("B");
    expect((await aging("B", "ar")).bucketTotals.base.total).toBe(9999);
    expect((await aging("B", "ap")).bucketTotals.base.total).toBe(8888);
    const t = await tb("B");
    expect(g(t, "AR")).toBe(9999);
    expect(-g(t, "AP")).toBe(8888);
    const bc = await read("B", "/api/reports/ar-billings-and-collections", { from: FROM, to: TO });
    expect(bc.customers.map((x) => x.partyId)).toEqual([b.C1]);
  });

  test("a party of company A cannot be read through company B", async () => {
    const { c: a } = ctx("A");
    const sl = await ctx("B").get("/api/reports/subsidiary-ledger", { type: "AR", partyId: a.C1, from: FROM, to: TO });
    expect(sl.status).toBe(404);
    const s = await ctx("B").get("/api/reports/ar-statement-of-accounts", { partyId: a.C1, from: FROM, to: TO });
    expect(s.status === 404 || (s.status === 200 && s.body.rows.length === 0 && s.body.endingBalance === 0)).toBe(true);
  });
});

// ===========================================================================
describe("TC-REPORT-008 party isolation (customers vs suppliers)", () => {
  test("AR reports list customers only, AP reports suppliers only", async () => {
    const { c } = ctx("A");
    const customers = new Set([c.C1, c.C2, c.C3]);
    expect((await aging("A", "ar")).rows.every((r) => customers.has(r.partyId))).toBe(true);
    expect((await aging("A", "ap")).rows.every((r) => r.partyId === c.S1)).toBe(true);
    const bc = await read("A", "/api/reports/ar-billings-and-collections", { from: FROM, to: TO });
    expect(bc.customers.some((x) => x.partyId === c.S1)).toBe(false);
    const pp = await read("A", "/api/reports/ap-payables-and-payments", { from: FROM, to: TO });
    expect(pp.suppliers.map((x) => x.partyId)).toEqual([c.S1]);
  });

  test("an AR ledger / statement for the supplier is empty (supplier memos stay on AP)", async () => {
    const { c } = ctx("A");
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.S1, from: FROM, to: TO });
    expect(sl).toEqual([]);
    const s = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.S1, from: FROM, to: TO });
    expect(s.rows).toEqual([]);
    expect(s.endingBalance).toBe(0);
  });
});

// ===========================================================================
describe("TC-REPORT-009 account analysis / general ledger vs trial balance", () => {
  test("account analysis: beginning balance, period movement and ending balance agree with the TB", async () => {
    for (const k of ["AR", "AP", "BANK", "REV", "INVAT"]) {
      const rows = await read("A", "/api/reports/account-analysis", { from: FROM, to: TO, accountCode: acc[k].accountCode });
      const movement = round2(rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0));
      expect(movement).toBe(g(await tb("A", FROM, TO), k));
      const beginning = rows.length ? Number(rows[0].beginning_balance) : 0;
      expect(round2(beginning)).toBe(g(await tb("A", "2096-01-01", "2096-05-31"), k));
      if (rows.length) expect(round2(Number(rows[rows.length - 1].running_balance))).toBe(g(await tb("A"), k));
    }
  });

  test("general ledger rows for the AR control sum to the TB movement; page adds beginning_balance to running_balance", async () => {
    const rows = await read("A", "/api/reports/general-ledger", { from: FROM, to: TO, accountCode: acc.AR.accountCode });
    expect(round2(rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0))).toBe(35900);
    expect(Number(rows[0].beginning_balance)).toBe(5000);
    expect(round2(Number(rows[0].beginning_balance) + Number(rows[rows.length - 1].running_balance))).toBe(40900);
  });
});

// ===========================================================================
describe("TC-REPORT-010 VAT and EWT reports vs source documents and GL", () => {
  test("Output VAT: posted invoices in the period, vatable base + VAT = gross, total = GL Output VAT", async () => {
    const { c } = ctx("A");
    const r = await read("A", "/api/reports/output-vat", { from: FROM, to: TO });
    expect(r.rows.map((x) => [x.docRef.includes("INV1"), x.vatableSales, x.vatAmount, x.grossAmount, x.reconciles])).toEqual([
      [true, 50000, 6000, 56000, true],
      [false, 10000, 1200, 11200, true],
    ]);
    expect(r.totals).toMatchObject({ vatableSales: 60000, vatAmount: 7200, grossAmount: 67200 });
    expect(-g(await tb("A", FROM, TO), "OUTVAT")).toBe(r.totals.vatAmount);
    expect(r.rows.every((x) => x.tin === "123-456-789-000")).toBe(true);
    expect(c.docs.INV3).toBeTruthy(); // July invoice exists but is outside the period
  });

  test("Input VAT (account analysis on the Input VAT account) = APV VAT lines = GL; voided APV contributes nothing", async () => {
    const rows = await read("A", "/api/reports/account-analysis", { from: FROM, to: TO, accountCode: acc.INVAT.accountCode });
    expect(rows.map((x) => Number(x.debit))).toEqual([2400, 600]);
    expect(g(await tb("A", FROM, TO), "INVAT")).toBe(3000);
  });

  test("Form 2307: EWT withheld = GL EWT payable; income payment follows the existing APV-header convention", async () => {
    const { c } = ctx("A");
    const f = await read("A", "/api/reports/2307", { supplierId: c.S1, year: 2096, quarter: 2 });
    expect(f.totals.totalTaxWithheld).toBe(200);
    expect(f.totals.totalTaxWithheld).toBe(-g(await tb("A", FROM, TO), "EWTP"));
    // Existing behaviour (EwtReportReconciliationService: total_credit AS grossAmount) - the
    // VAT-inclusive APV total. Recorded for a business decision; not changed by this suite.
    const [[h]] = await pool.execute("SELECT total_credit FROM apv_headers WHERE id = ?", [c.docs.APV1]);
    expect(f.totals.month3Amount).toBe(Number(h.total_credit));
    const audit = await read("A", "/api/reports/ewt-audit", { from: FROM, to: TO });
    expect(audit.flaggedCount).toBe(0);
  });
});

// ===========================================================================
describe("TC-REPORT-011 beginning balances flow into every report", () => {
  test("AR opening 5,000 and AP opening 3,000 reach aging, statement, B&C, P&P, ledgers and the GL", async () => {
    const { c } = ctx("A");
    expect((await aging("A", "ar")).rows.find((r) => r.sourceType === "AR_BEGINNING")).toMatchObject({ partyId: c.C1, transactionDate: "2096-05-31", baseBalance: 5000 });
    expect((await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO })).beginningBalance).toBe(5000);
    expect((await read("A", "/api/reports/ar-billings-and-collections", { from: FROM, to: TO })).grandTotalBeginningBalance).toBe(5000);
    expect((await read("A", "/api/reports/ap-payables-and-payments", { from: FROM, to: TO })).grandTotalBeginningPayable).toBe(3000);
    expect((await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO }))[0].running_balance).toBe("3000.0000");
    const opening = await tb("A", "2096-01-01", "2096-05-31");
    expect(g(opening, "AR")).toBe(5000);
    expect(-g(opening, "AP")).toBe(3000);
    // GL Beginning Balance (the opening-equity offset) is intentionally NOT a Trial
    // Balance source (documented in trialBalanceDifferenceService.js, "Known
    // Limitations") - it is carried by the ledger union instead, so Account
    // Analysis / General Ledger / the balance sheet see it.
    expect(g(opening, "EQ")).toBe(0);
    const eq = await read("A", "/api/reports/account-analysis", { from: "2096-05-01", to: "2096-05-31", accountCode: acc.EQ.accountCode });
    expect(eq.map((r) => [r.source_type, Number(r.credit)])).toEqual([["GL BEGINNING", 2000]]);
  });

  test("with the opening-equity offset the balance sheet balances", async () => {
    const bs = await read("A", "/api/reports/balance-sheet", { to: AS_OF, view: "structured" });
    expect(bs.balanceCheck.balanced).toBe(true);
  });
});

// ===========================================================================
describe("TC-REPORT-012 group code / report section classification", () => {
  test("income statement: mapped groups land in their sections; totals = GL; cross-check holds", async () => {
    const is = await read("A", "/api/reports/income-statement", { from: FROM, to: TO, view: "structured", comparePrev: 0, ytd: 0 });
    const line = (code) => is.nodes.find((n) => n.kind === "group-line" && n.groupCode === code);
    const t = await tb("A", FROM, TO);
    expect(line("RPTR-GC-REV")).toMatchObject({ section: "REVENUE" });
    expect(line("RPTR-GC-REV").values.current).toBe(-g(t, "REV"));
    expect(line("RPTR-GC-EXP")).toMatchObject({ section: "OPERATING_EXPENSE" });
    expect(line("RPTR-GC-EXP").values.current).toBe(-g(t, "EXP"));
    expect(is.crossCheck.ok).toBe(true);
    expect(is.nodes.find((n) => n.id === "NET_INCOME").values.current).toBe(-(g(t, "REV") + g(t, "EXP")));
  });

  test("balance sheet: display order within a section; AR group = aging; inactive group -> unclassified (not dropped)", async () => {
    const bs = await read("A", "/api/reports/balance-sheet", { to: AS_OF, view: "structured" });
    const current = bs.nodes.filter((n) => n.kind === "group-line" && n.section === "CURRENT_ASSET").map((n) => n.groupCode);
    expect(current.indexOf("RPTR-GC-BANK")).toBeLessThan(current.indexOf("RPTR-GC-AR")); // display_order 1 before 3
    expect(current).not.toContain("RPTR-GC-OFF"); // INACTIVE group contributes no section
    expect(bs.nodes.find((n) => n.groupCode === "RPTR-GC-AR").values.current).toBe(40900);
    const t = await tb("A");
    // CWT (inactive group) and Input VAT (no group) are still reported, as unclassified assets
    expect(bs.unclassified.ASSET.current).toBe(g(t, "CWT") + g(t, "INVAT"));
  });
});

// ===========================================================================
describe("TC-REPORT-014 accountant RBAC", () => {
  const asAcct = (method, path) => request(app)[method](path).set({ Authorization: `Bearer ${tokens.accountant}` });

  test("an accountant can open every report in this suite", async () => {
    const { c } = ctx("A");
    const reads = [
      ["/api/reports/ar-aging", { asOf: AS_OF }], ["/api/reports/ap-aging", { asOf: AS_OF }],
      ["/api/reports/ar-aging-summary", { asOf: AS_OF }], ["/api/reports/ap-aging-summary", { asOf: AS_OF }],
      ["/api/reports/ar-overdue-accounts", { asOf: AS_OF }], ["/api/reports/ap-overdue-accounts", { asOf: AS_OF }],
      ["/api/reports/ar-statement-of-accounts", { partyId: c.C1, from: FROM, to: TO }],
      ["/api/reports/ar-billings-and-collections", { from: FROM, to: TO }], ["/api/reports/ap-payables-and-payments", { from: FROM, to: TO }],
      ["/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C1, from: FROM, to: TO }],
      ["/api/reports/general-ledger", { from: FROM, to: TO, accountCode: acc.AR.accountCode }],
      ["/api/reports/account-analysis", { from: FROM, to: TO, accountCode: acc.AR.accountCode }],
      ["/api/reports/trial-balance", { from: FROM, to: TO }], ["/api/reports/output-vat", { from: FROM, to: TO }],
      ["/api/reports/2307", { supplierId: c.S1, year: 2096, quarter: 2 }],
      ["/api/reports/income-statement", { from: FROM, to: TO }], ["/api/reports/balance-sheet", { to: AS_OF }],
    ];
    for (const [path, q] of reads) {
      const res = await ctx("A").get(path, q);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  test("an accountant cannot manage users, roles / permissions, audit logs, invitations or close periods", async () => {
    const [[role]] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const denied = [
      await asAcct("get", "/api/users"),
      await asAcct("put", `/api/roles/${role.id}/permissions`).send({ permissions: [] }),
      await asAcct("get", "/api/audit-logs"),
      await asAcct("post", "/api/invitations").send({ email: "nobody@example.invalid" }),
      await asAcct("post", "/api/accounting-periods/999999999/close").send({}),
    ];
    for (const res of denied) expect(res.status).toBe(403);
  });
});
