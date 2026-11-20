// TC-REPORT-015 (AP Statement of Accounts), TC-REPORT-016 (foreign currency
// reporting), plus the Trial Balance Posted-only rule behind its now
// informational Status control.
//
// Documents are created through the real APIs; reports are reconciled with
// each other and with the GL. P0 rules: AP subledger amounts are the AP
// control amounts (APV + EWT -> Gross - EWT); supplier DM -, CM +.
// FX: lines are entered in the document currency and converted at the
// document's own rate (transactionCurrencyService.computeBaseLines); a payment
// application is entered in the foreign currency and valued at the SOURCE
// document's historical rate (buildApplication).
//
// Local test database only. Fixture prefix RPTR2-.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

jest.setTimeout(300000);

const P = "rptr2-";
const ACC = "RPTR2-";
const PASSWORD = "Rptr2Pass!1";
const ATC_AP = "RPTR2-WC158"; // 1%
const AS_OF = "2096-06-30";
const FROM = "2096-06-01";
const TO = "2096-06-30";
const RATE = 56;

const acc = {};
const co = { A: {}, B: {} };
let seq = 0;
let userId;
let token;

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, '2096-01-01', ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { accountId: r.insertId, accountCode: `${ACC}${key}`, accountTitle: title };
}
const line = (key, debit, credit, extra = {}) => ({ ...acc[key], particulars: key, genRef: "", genName: "", debit, credit, ...extra });
const sum = (lines, k) => lines.reduce((s, l) => s + Number(l[k] || 0), 0);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const party = (id, name, type) => ({ supplierId: id, supplierName: name, customerId: id, customerName: name, payeeId: id, payeeName: name, partyId: id, partyName: name, partyType: type });
const auth = () => ({ Authorization: `Bearer ${token}` });

function ctx(key) {
  const c = co[key];
  const body = (who, tag, status, lines, date, due, extra = {}) => ({
    ...who, voucherNo: `${P}${key}-${tag}-${++seq}`, referenceNo: `${P}${key}-${tag}`, transactionDate: date, dueDate: due, description: `${key} ${tag}`, status,
    lines, totalDebit: sum(lines, "debit"), totalCredit: sum(lines, "credit"), currency: { companyId: c.id }, companyId: c.id, ...extra,
  });
  const post = (path, b) => request(app).post(path).set(auth()).send(b);
  const get = (path, q = {}) => request(app).get(path).set(auth()).query({ companyId: c.id, ...q });
  return { c, body, post, get };
}
async function ok(res, what) {
  if (res.status !== 200) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
}
async function read(key, path, q = {}) {
  return ok(await ctx(key).get(path, q), path);
}
async function tb(key, from = "2096-01-01", to = AS_OF) {
  const m = {};
  for (const r of await read(key, "/api/reports/trial-balance", { from, to })) m[r.account_code] = round2(Number(r.debit) - Number(r.credit));
  return m;
}
const g = (m, k) => m[acc[k].accountCode] || 0;

async function buildCompany(key) {
  const { c, body, post } = ctx(key);
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}${key} Co`]);
  c.id = r.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, c.id]);
  const admin = { id: userId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(admin, { currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: c.id });
  const usd = await CurrencyService.createCurrency(admin, { currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: c.id });
  c.usd = usd.id;
  await CurrencyService.recordRate(admin, c.usd, { rateMode: "MANUAL", rate: RATE, effectiveDate: "2096-06-01", reason: "RPTR2 fixture" });
  const mkParty = async (tag, type, name) => {
    const [p] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, ?, ?, '123-456-789-000', 'ACTIVE')", [c.id, `${P}${key}-${tag}`, type, name]);
    return p.insertId;
  };
  c.S1 = await mkParty("S1", "SUPPLIER", `${key} Supplier One`);
  c.S2 = await mkParty("S2", "SUPPLIER", `${key} Supplier Two`);
  c.S3 = await mkParty("S3", "SUPPLIER", `${key} USD Supplier`);
  c.C2 = await mkParty("C2", "CUSTOMER", `${key} USD Customer`);
  const S = (id, n) => party(id, n, "SUPPLIER");
  const S1 = S(c.S1, `${key} Supplier One`), S2 = S(c.S2, `${key} Supplier Two`), S3 = S(c.S3, `${key} USD Supplier`), C2 = party(c.C2, `${key} USD Customer`, "CUSTOMER");
  c.docs = {};
  const save = async (name, path, b) => { c.docs[name] = (await ok(await post(path, b), `${key} ${name}`)).id; };

  if (key === "B") {
    await save("APV", "/api/apv", body(S1, "APV", "Posted", [line("EXP", 8888, 0), line("AP", 0, 8888)], "2096-06-10", "2096-06-20"));
    return;
  }

  // ---- AP (PHP) ----------------------------------------------------------
  await save("APVPLAIN", "/api/apv", body(S1, "APVPLAIN", "Posted", [line("EXP", 10000, 0), line("AP", 0, 10000)], "2096-06-02", "2096-06-12"));
  await save("APVEWT", "/api/apv", body(S1, "APVEWT", "Posted", [
    line("EXP", 20000, 0),
    line("INVAT", 2400, 0, { taxEntry: { entryType: "INPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 22400, netAmount: 20000, vatAmount: 2400, partyId: c.S1, partyName: `${key} Supplier One`, partyTin: "123-456-789-000", purchaseClassification: "Services" } }),
    line("EWTP", 0, 200, { taxEntry: { entryType: "EWT", atcCode: ATC_AP, taxType: "EWT", taxableBase: 20000, withheldAmount: 200 } }),
    line("AP", 0, 22200),
  ], "2096-06-03", "2096-06-18", { atcCode: ATC_AP, taxWithheldAmount: 200 }));
  await save("CVFULL", "/api/cv", body(S1, "CVFULL", "Posted", [line("AP", 10000, 0), line("BANK", 0, 10000)], "2096-06-05", null, { paymentMethod: "Cash", apvApplications: [{ sourceId: c.docs.APVPLAIN, amount: 10000, applicationDate: "2096-06-05" }] }));
  await save("CVPART", "/api/cv", body(S1, "CVPART", "Posted", [line("AP", 10000, 0), line("BANK", 0, 10000)], "2096-06-20", null, { paymentMethod: "Cash", apvApplications: [{ sourceId: c.docs.APVEWT, amount: 10000, applicationDate: "2096-06-20" }] }));
  await save("SDM", "/api/debit-memos", body(S1, "SDM", "Posted", [line("AP", 400, 0), line("EXP", 0, 400)], "2096-06-21", null));
  await save("SCM", "/api/credit-memos", body(S1, "SCM", "Posted", [line("EXP", 300, 0), line("AP", 0, 300)], "2096-06-22", null));
  await save("APVVOID", "/api/apv", body(S1, "APVVOID", "Posted", [line("EXP", 4000, 0), line("AP", 0, 4000)], "2096-06-08", "2096-06-18"));
  await ok(await post(`/api/apv/${c.docs.APVVOID}/void`, { reason: "RPTR2 void" }), "void");
  await save("APVDRAFT", "/api/apv", body(S1, "APVDRAFT", "Draft", [line("EXP", 7000, 0), line("AP", 0, 7000)], "2096-06-09", "2096-06-19"));
  await save("APVJULY", "/api/apv", body(S1, "APVJULY", "Posted", [line("EXP", 5000, 0), line("AP", 0, 5000)], "2096-07-01", "2096-07-31"));
  await save("APVS2", "/api/apv", body(S2, "APVS2", "Posted", [line("EXP", 1111, 0), line("AP", 0, 1111)], "2096-06-10", "2096-06-25"));
  c.bbAP = await ok(await post("/api/arap-beginning-balances", {
    companyId: c.id, balanceType: "AP", balanceDate: "2096-05-31", currencyCode: "PHP", currencyName: "PHILIPPINE PESO", remarks: `${P}AP`,
    line: { partyId: c.S1, partyCode: `${P}${key}-S1`, partyName: `${key} Supplier One`, accountId: acc.AP.accountId, accountCode: acc.AP.accountCode, accountTitle: acc.AP.accountTitle, referenceNo: `${P}BB-AP`, dueDate: "2096-04-30", debit: 0, credit: 3000 },
  }), "AP beginning");

  // ---- foreign currency (USD at 56) ----------------------------------------
  const fx = (date) => ({ companyId: c.id, currencyId: c.usd, exchangeRate: RATE, rateDate: date });
  await save("APVUSD", "/api/apv", body(S3, "APVUSD", "Posted", [line("EXP", 1000, 0), line("AP", 0, 1000)], "2096-06-10", "2096-06-25", { currency: fx("2096-06-10") }));
  await save("CVUSD", "/api/cv", body(S3, "CVUSD", "Posted", [line("AP", 400, 0), line("BANK", 0, 400)], "2096-06-15", null, { currency: fx("2096-06-15"), paymentMethod: "Cash", apvApplications: [{ sourceId: c.docs.APVUSD, amount: 400, applicationDate: "2096-06-15" }] }));
  await save("INVUSD", "/api/invoices", body(C2, "INVUSD", "Posted", [line("AR", 2000, 0), line("REV", 0, 2000)], "2096-06-10", "2096-06-25", { currency: fx("2096-06-10"), invoiceType: "Standard" }));
  await save("ORUSD", "/api/or", body(C2, "ORUSD", "Posted", [line("BANK", 500, 0), line("AR", 0, 500)], "2096-06-15", null, { currency: fx("2096-06-15"), paymentMethod: "Cash", invoiceApplications: [{ sourceId: c.docs.INVUSD, amount: 500, applicationDate: "2096-06-15" }] }));
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await mkAccount("AP", "RPTR2 Accounts Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("AR", "RPTR2 Accounts Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("EXP", "RPTR2 Supplies Expense", "EXPENSE");
  await mkAccount("INVAT", "RPTR2 Input VAT", "ASSET", ["INPUT VAT"]);
  await mkAccount("EWTP", "RPTR2 EWT Payable", "LIABILITY", ["EXPANDED TAX"]);
  await mkAccount("REV", "RPTR2 Service Revenue", "INCOME");
  await mkAccount("BANK", "RPTR2 Cash in Bank", "ASSET", ["BANK / CASH"]);
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'RPTR2 fixture 1%', 1, 'EWT', 'ACTIVE')", [ATC_AP]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ACCOUNTANT'), 'ACTIVE')", [`${P}acct`, hash]);
  userId = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}acct`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login: ${res.status}`);
  token = res.body.token;
  await buildCompany("A");
  await buildCompany("B");
});

afterAll(async () => {
  try {
    const cs = [co.A.id, co.B.id].filter(Boolean);
    if (cs.length) {
      await pool.query("DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id IN (?)", [cs]);
      await pool.query("DELETE ta FROM transaction_applications ta JOIN or_headers h ON h.id = ta.applied_id AND ta.applied_type = 'OR' WHERE h.company_id IN (?)", [cs]);
      for (const [lines, fk, hdr] of [["cv_lines", "cv_id", "cv_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["memo_lines", "memo_id", "memo_headers"], ["jv_lines", "jv_id", "jv_headers"], ["arap_beginning_balance_lines", "header_id", "arap_beginning_balance_headers"]]) {
        await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [cs]).catch(() => {});
      }
      await pool.query("DELETE FROM invoice_verifications WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [cs]).catch(() => {});
      for (const t of ["cv_headers", "or_headers", "apv_headers", "invoice_headers", "memo_headers", "jv_headers", "arap_beginning_balance_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "currency_rates", "currencies"]) {
        await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cs]).catch(() => {});
      }
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [userId]).catch(() => {});
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    if (cs.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [cs]);
    await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC_AP]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

const apStmt = (key, partyId, from = FROM, to = TO) => read(key, "/api/reports/ap-statement-of-accounts", { partyId, from, to });
const apAgingParty = async (key, partyId) => ((await read(key, "/api/reports/ap-aging-summary", { asOf: AS_OF })).parties.find((p) => p.partyId === partyId) || {}).baseBalance || 0;
const slEnd = (rows) => (rows.length ? Number(rows[rows.length - 1].running_balance) : 0);

// ===========================================================================
describe("TC-REPORT-015 AP Statement of Accounts", () => {
  test("1-10. beginning balance, APV with / without EWT, memos, full / partial payment, running and ending balance", async () => {
    const { c } = ctx("A");
    const s = await apStmt("A", c.S1);
    expect(s).toMatchObject({ partyId: c.S1, partyName: "A Supplier One", from: FROM, to: TO, beginningBalance: 3000, endingBalance: 15100 });
    expect(s.rows.map((r) => [r.transactionDate, r.sourceType, r.debit, r.credit, r.runningBalance])).toEqual([
      ["2096-06-02", "APV", 0, 10000, 13000], // no withholding
      ["2096-06-03", "APV", 0, 22200, 35200], // gross 22,400 - EWT 200 = AP control
      ["2096-06-05", "CV", 10000, 0, 25200], // full payment of the plain APV
      ["2096-06-20", "CV", 10000, 0, 15200], // partial payment of the EWT APV
      ["2096-06-21", "DEBIT MEMO", 400, 0, 14800], // supplier DM decreases AP
      ["2096-06-22", "CREDIT MEMO", 0, 300, 15100], // supplier CM increases AP
    ]);
    expect(s.rows.find((r) => r.sourceType === "APV" && r.transactionDate === "2096-06-03").dueDate).toBe("2096-06-18");
  });

  test("reconciles: AP Statement = AP Aging = AP Subsidiary Ledger = AP control (per supplier)", async () => {
    const { c } = ctx("A");
    const s = await apStmt("A", c.S1);
    expect(s.endingBalance).toBe(await apAgingParty("A", c.S1));
    const sl = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S1, from: FROM, to: TO });
    expect(slEnd(sl)).toBe(s.endingBalance);
    const pp = await read("A", "/api/reports/ap-payables-and-payments", { from: FROM, to: TO, partyId: c.S1 });
    expect(pp.suppliers.find((x) => x.partyId === c.S1).endingPayable).toBe(s.endingBalance);
    // GL AP control (PHP suppliers + the USD supplier's base balance) = sum of the supplier statements
    let total = 0;
    for (const p of [c.S1, c.S2, c.S3]) total += (await apStmt("A", p)).endingBalance;
    expect(round2(total)).toBe(-g(await tb("A"), "AP"));
  });

  test("11. date range: a mid-period start carries earlier activity; July is outside June", async () => {
    const { c } = ctx("A");
    const mid = await apStmt("A", c.S1, "2096-06-06", TO);
    expect(mid.beginningBalance).toBe(25200);
    expect(mid.endingBalance).toBe(15100);
    const july = await apStmt("A", c.S1, "2096-07-01", "2096-07-31");
    expect(july.beginningBalance).toBe(15100);
    expect(july.rows.map((r) => [r.transactionDate, r.credit])).toEqual([["2096-07-01", 5000]]);
    expect(july.endingBalance).toBe(20100);
  });

  test("12. supplier filter: each supplier sees only its own documents", async () => {
    const { c } = ctx("A");
    const s2 = await apStmt("A", c.S2);
    expect(s2.rows.map((r) => r.credit)).toEqual([1111]);
    expect(s2.endingBalance).toBe(1111);
    expect((await apStmt("A", c.S1)).rows.some((r) => r.credit === 1111)).toBe(false);
  });

  test("13. company isolation: another company's supplier is not found; company B is separate", async () => {
    const { c: a } = ctx("A");
    const { c: b } = ctx("B");
    expect((await ctx("B").get("/api/reports/ap-statement-of-accounts", { partyId: a.S1, from: FROM, to: TO })).status).toBe(404);
    const sb = await apStmt("B", b.S1);
    expect(sb.endingBalance).toBe(8888);
  });

  test("14. voided and draft APVs never appear", async () => {
    const { c } = ctx("A");
    const s = await apStmt("A", c.S1);
    expect(s.rows.some((r) => r.credit === 4000 || r.credit === 7000)).toBe(false);
  });

  test("validation: partyId and dates are required; a customer has no AP statement rows", async () => {
    const { c } = ctx("A");
    expect((await ctx("A").get("/api/reports/ap-statement-of-accounts", { from: FROM, to: TO })).status).toBe(400);
    expect((await ctx("A").get("/api/reports/ap-statement-of-accounts", { partyId: c.S1 })).status).toBe(400);
    const cust = await apStmt("A", c.C2);
    expect(cust.rows).toEqual([]);
    expect(cust.endingBalance).toBe(0);
  });

  test("permission: the route is REPORTS.AP VIEW like the other AP reports", async () => {
    const res = await request(app).get("/api/reports/ap-statement-of-accounts").query({ partyId: 1, from: FROM, to: TO });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe("TC-REPORT-016 foreign currency reporting (USD at 56)", () => {
  const findRow = (rows, type, id) => rows.find((r) => r.sourceType === type && r.sourceId === id);

  test("AP aging: foreign original / paid / balance x historical rate = base amounts", async () => {
    const { c } = ctx("A");
    const rows = (await read("A", "/api/reports/ap-aging", { asOf: AS_OF, status: "ALL" })).rows;
    const r = findRow(rows, "APV", c.docs.APVUSD);
    expect(r).toMatchObject({ isForeign: true, currencyCode: "USD", historicalRate: RATE, foreignOriginal: 1000, foreignPaid: 400, foreignBalance: 600, baseOriginal: 56000, basePaid: 22400, baseBalance: 33600 });
    expect(round2(r.foreignBalance * r.historicalRate)).toBe(r.baseBalance);
    expect(round2(r.foreignOriginal * r.historicalRate)).toBe(r.baseOriginal);
  });

  test("AR aging: same reconciliation for the USD invoice", async () => {
    const { c } = ctx("A");
    const rows = (await read("A", "/api/reports/ar-aging", { asOf: AS_OF, status: "ALL" })).rows;
    const r = findRow(rows, "INV", c.docs.INVUSD);
    expect(r).toMatchObject({ isForeign: true, currencyCode: "USD", historicalRate: RATE, foreignOriginal: 2000, foreignPaid: 500, foreignBalance: 1500, baseOriginal: 112000, basePaid: 28000, baseBalance: 84000 });
    expect(round2(r.foreignBalance * r.historicalRate)).toBe(r.baseBalance);
  });

  test("statements carry base-currency amounts (AP and AR) and agree with aging", async () => {
    const { c } = ctx("A");
    const ap = await apStmt("A", c.S3);
    expect(ap.rows.map((r) => [r.sourceType, r.debit, r.credit])).toEqual([["APV", 0, 56000], ["CV", 22400, 0]]);
    expect(ap.endingBalance).toBe(33600);
    expect(ap.endingBalance).toBe(await apAgingParty("A", c.S3));
    const ar = await read("A", "/api/reports/ar-statement-of-accounts", { partyId: c.C2, from: FROM, to: TO });
    expect(ar.rows.map((r) => [r.sourceType, r.debit, r.credit])).toEqual([["INV", 112000, 0], ["OR", 0, 28000]]);
    expect(ar.endingBalance).toBe(84000);
  });

  test("subsidiary ledgers and the GL carry the same base amounts", async () => {
    const { c } = ctx("A");
    const slAp = await read("A", "/api/reports/subsidiary-ledger", { type: "AP", partyId: c.S3, from: FROM, to: TO });
    expect(slAp.map((r) => [r.source_type, Number(r.debit), Number(r.credit)])).toEqual([["APV", 0, 56000], ["CV", 22400, 0]]);
    expect(slEnd(slAp)).toBe(33600);
    const slAr = await read("A", "/api/reports/subsidiary-ledger", { type: "AR", partyId: c.C2, from: FROM, to: TO });
    expect(slEnd(slAr)).toBe(84000);
    const t = await tb("A", FROM, TO);
    expect(g(t, "AR")).toBe(84000); // the only AR document is the USD invoice
    const gl = await read("A", "/api/reports/general-ledger", { from: FROM, to: TO, accountCode: acc.AR.accountCode });
    expect(gl.map((r) => [r.source_type, Number(r.debit), Number(r.credit)])).toEqual([["INV", 112000, 0], ["OR", 0, 28000]]);
  });

  test("stored foreign / base payment state matches the reports", async () => {
    const { c } = ctx("A");
    const [[apv]] = await pool.execute("SELECT balance_amount, foreign_balance_amount, foreign_paid_amount FROM apv_headers WHERE id = ?", [c.docs.APVUSD]);
    expect([Number(apv.balance_amount), Number(apv.foreign_balance_amount), Number(apv.foreign_paid_amount)]).toEqual([33600, 600, 400]);
    const [[inv]] = await pool.execute("SELECT balance_amount, foreign_balance_amount FROM invoice_headers WHERE id = ?", [c.docs.INVUSD]);
    expect([Number(inv.balance_amount), Number(inv.foreign_balance_amount)]).toEqual([84000, 1500]);
  });

  test("aging currency filter keeps only USD documents", async () => {
    const rows = (await read("A", "/api/reports/ap-aging", { asOf: AS_OF, status: "ALL", currency: "USD" })).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.currencyCode === "USD")).toBe(true);
  });
});

// ===========================================================================
describe("Trial Balance status rule (behind the informational Status control)", () => {
  test("Posted only: the draft (7,000) and voided (4,000) APVs are not in the trial balance", async () => {
    const t = await tb("A", FROM, TO);
    // AP movement: 10,000 + 22,200 - 10,000 - 10,000 - 400 + 300 + 1,111 + 56,000 - 22,400
    expect(-g(t, "AP")).toBe(46811);
  });
});
