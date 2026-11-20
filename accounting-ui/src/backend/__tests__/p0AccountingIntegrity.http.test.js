// P0 accounting integrity (TEST CASE 1 UAT, decisions of 2026-11-18):
//
//   TC1-062  An APV that withholds EWT (Dr Expense, Dr Input VAT / Cr EWT,
//            Cr AP) owes the AP CONTROL amount (Gross - EWT), not its credit
//            total. A CV paying that amount fully settles it. Mirror: an
//            invoice recording customer withholding (CWT) is owed its AR
//            control amount.
//   TC1-084  Option A - a posted CV / OR that moves the AP / AR control
//            account must be fully applied (no unapplied/advance model);
//            direct CVs / cash-sale ORs (no control line) are unaffected;
//            bulk posting cannot bypass the rule.
//   TC1-092b Debit / Credit Memos are standalone party entries in aging
//            (customer DM +, CM -; supplier DM -, CM +), dated by the memo
//            date, amount = the control-line net.
//
// Every scenario checks that the subledger (stored balance, unpaid list,
// aging, summary, overdue, subsidiary ledger, statement, dashboard) agrees
// with the GL control account. Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(240000);

const P = "p0ai-";
const ACC = "P0AI-";
const PASSWORD = "P0AiPass!1";
const D = "2097-06-10";
const AS_OF = "2097-12-31";
const ATC_AP = "P0AI-WC158"; // 1%
const ATC_AR = "P0AI-WC120"; // 2%

let companyId, supplierId, customerId, token, userId;
const acc = {};
let seq = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });
const vno = (tag) => `${P}${tag}-${++seq}`;

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { accountId: r.insertId, accountCode: `${ACC}${key}`, accountTitle: title };
}
const line = (key, debit, credit, extra = {}) => ({ ...acc[key], particulars: key, genRef: "", genName: "", debit, credit, ...extra });
const sum = (lines, k) => lines.reduce((s, l) => s + Number(l[k] || 0), 0);
const party = (id, name, type) => ({ supplierId: id, supplierName: name, customerId: id, customerName: name, payeeId: id, payeeName: name, partyId: id, partyName: name, partyType: type });
const SUP = () => party(supplierId, "P0AI Supplier", "SUPPLIER");
const CUS = () => party(customerId, "P0AI Customer", "CUSTOMER");
const body = (who, voucherNo, status, lines, extra = {}) => ({
  ...who, voucherNo, referenceNo: voucherNo, transactionDate: D, dueDate: "2097-07-10", description: voucherNo, status,
  lines, totalDebit: sum(lines, "debit"), totalCredit: sum(lines, "credit"), currency: { companyId }, ...extra,
});
const post = (path, b) => request(app).post(path).set(auth()).send(b);
const get = (path, q = {}) => request(app).get(path).set(auth()).query({ companyId, ...q });

// --- documents -------------------------------------------------------------
const apvEwtLines = () => [
  line("EXP", 20000, 0),
  line("INVAT", 2400, 0, { taxEntry: { entryType: "INPUT_VAT", vatEntryMode: "EXCLUSIVE", vatTreatment: "STANDARD", vatRate: 12, grossAmount: 22400, vatAmount: 2400 } }),
  line("EWTP", 0, 200, { taxEntry: { entryType: "EWT", atcCode: ATC_AP, taxType: "EWT", taxableBase: 20000, withheldAmount: 200 } }),
  line("AP", 0, 22200, { genName: "P0AI Supplier" }),
];
const makeApvEwt = (status = "Posted") => post("/api/apv", body(SUP(), vno("APV-EWT"), status, apvEwtLines(), { atcCode: ATC_AP, taxWithheldAmount: 200 }));
const invCwtLines = () => [
  line("AR", 55000, 0, { genName: "P0AI Customer" }),
  line("CWT", 1000, 0, { taxEntry: { entryType: "EWT", atcCode: ATC_AR, taxType: "EWT", taxableBase: 50000, withheldAmount: 1000 } }),
  line("REV", 0, 50000),
  line("OUTVAT", 0, 6000),
];
const makeInvCwt = () => post("/api/invoices", body(CUS(), vno("INV-CWT"), "Posted", invCwtLines(), { atcCode: ATC_AR, taxWithheldAmount: 1000, invoiceType: "Standard" }));
const cvBody = (tag, amount, apps, status = "Posted", extraLines = null) =>
  body(SUP(), vno(tag), status, extraLines || [line("AP", amount, 0), line("BANK", 0, amount)], { paymentMethod: "Cash", apvApplications: apps });
const orBody = (tag, amount, apps, status = "Posted", extraLines = null) =>
  body(CUS(), vno(tag), status, extraLines || [line("BANK", amount, 0), line("AR", 0, amount)], { paymentMethod: "Cash", invoiceApplications: apps });

// --- readers ---------------------------------------------------------------
async function header(table, id) {
  const [[r]] = await pool.execute(`SELECT total_debit, total_credit, paid_amount, balance_amount, payment_status FROM ${table} WHERE id = ?`, [id]);
  return { totalDebit: Number(r.total_debit), totalCredit: Number(r.total_credit), paid: Number(r.paid_amount), balance: Number(r.balance_amount), status: r.payment_status };
}
async function agingRows(kind, q = {}) {
  const res = await get(`/api/reports/${kind}-aging`, { asOf: AS_OF, status: "ALL", ...q });
  expect(res.status).toBe(200);
  return Array.isArray(res.body) ? res.body : res.body.rows;
}
async function agingParty(kind, partyId) {
  const res = await get(`/api/reports/${kind}-aging-summary`, { asOf: AS_OF });
  expect(res.status).toBe(200);
  return res.body.parties.find((p) => p.partyId === partyId)?.baseBalance ?? 0;
}
// GL control balance for one account in this company (sum of posted lines via the TB).
async function glBalance(key) {
  const res = await get("/api/reports/trial-balance", { from: "2097-01-01", to: AS_OF });
  expect(res.status).toBe(200);
  const r = res.body.find((x) => x.account_code === acc[key].accountCode);
  return r ? Number(r.debit) - Number(r.credit) : 0;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co`]);
  companyId = c.insertId;
  await pool.execute("INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, 'PHP', 'Philippine Peso', 'P', 1, 1)", [companyId]);
  const [s] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'P0AI Supplier', '111-222-333-000', 'ACTIVE')", [companyId, `${P}sup`]);
  supplierId = s.insertId;
  const [cu] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'CUSTOMER', 'P0AI Customer', '444-555-666-000', 'ACTIVE')", [companyId, `${P}cus`]);
  customerId = cu.insertId;
  await mkAccount("AP", "P0AI Accounts Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("AR", "P0AI Accounts Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("EXP", "P0AI Supplies Expense", "EXPENSE");
  await mkAccount("INVAT", "P0AI Input VAT", "ASSET", ["INPUT VAT"]);
  await mkAccount("EWTP", "P0AI EWT Payable", "LIABILITY", ["EXPANDED TAX"]);
  await mkAccount("CWT", "P0AI Creditable Withholding Tax", "ASSET", ["EXPANDED TAX"]);
  await mkAccount("REV", "P0AI Service Revenue", "INCOME");
  await mkAccount("OUTVAT", "P0AI Output VAT", "LIABILITY", ["OUTPUT VAT"]);
  await mkAccount("BANK", "P0AI Cash in Bank", "ASSET", ["BANK / CASH"]);
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'P0AI fixture 1%', 1, 'EWT', 'ACTIVE')", [ATC_AP]);
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'P0AI fixture 2%', 2, 'EWT', 'ACTIVE')", [ATC_AR]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ACCOUNTANT'), 'ACTIVE')", [`${P}acct`, hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  const res = await request(app).post("/api/login").send({ username: `${P}acct`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login: ${res.status}`);
  token = res.body.token;
});

afterAll(async () => {
  try {
    const cs = [companyId];
    await pool.query("DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id IN (?)", [cs]);
    await pool.query("DELETE ta FROM transaction_applications ta JOIN or_headers h ON h.id = ta.applied_id AND ta.applied_type = 'OR' WHERE h.company_id IN (?)", [cs]);
    for (const [lines, fk, hdr] of [["cv_lines", "cv_id", "cv_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"], ["memo_lines", "memo_id", "memo_headers"], ["jv_lines", "jv_id", "jv_headers"]]) {
      await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [cs]);
    }
    await pool.query("DELETE FROM invoice_verifications WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [cs]).catch(() => {});
    for (const t of ["cv_headers", "or_headers", "apv_headers", "invoice_headers", "memo_headers", "jv_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "currencies"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cs]).catch(() => {});
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cs]);
    await pool.query("DELETE FROM ewt_library WHERE atc_code IN (?, ?)", [ATC_AP, ATC_AR]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("TC1-062 - APV with EWT owes its AP control amount (Gross - EWT)", () => {
  let apvId, cvId;

  test("stored balance and payment status are seeded from the AP control amount", async () => {
    const res = await makeApvEwt();
    expect(res.status).toBe(200);
    apvId = res.body.id;
    const h = await header("apv_headers", apvId);
    expect(h.totalCredit).toBe(22400); // gross credit side (AP + EWT) - unchanged
    expect(h.balance).toBe(22200);
    expect(h.paid).toBe(0);
    expect(h.status).toBe("Unpaid");
  });

  test("/api/apv/unpaid offers the APV at 22,200 (original and balance)", async () => {
    const res = await get("/api/apv/unpaid", { supplierId });
    const row = res.body.find((r) => r.sourceType === "APV" && r.id === apvId);
    expect(Number(row.totalAmount)).toBe(22200);
    expect(Number(row.balanceAmount)).toBe(22200);
  });

  test("AP aging / summary carry 22,200 and equal the GL AP control balance", async () => {
    const row = (await agingRows("ap")).find((r) => r.sourceType === "APV" && r.sourceId === apvId);
    expect(row.baseOriginal).toBe(22200);
    expect(row.baseBalance).toBe(22200);
    expect(await agingParty("ap", supplierId)).toBe(22200);
    expect(-(await glBalance("AP"))).toBe(22200);
    expect(await glBalance("EWTP")).toBe(-200); // EWT stays a separate GL liability
  });

  test("application cap: paying the gross 22,400 is refused", async () => {
    const res = await post("/api/cv", cvBody("CV-GROSS", 22400, [{ sourceId: apvId, amount: 22400, applicationDate: D }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/cannot exceed APV balance of 22200\.00/);
  });

  test("a CV for 22,200 fully settles the APV everywhere", async () => {
    const res = await post("/api/cv", cvBody("CV-NET", 22200, [{ sourceId: apvId, amount: 22200, applicationDate: D }]));
    expect(res.status).toBe(200);
    cvId = res.body.id;
    expect(await header("apv_headers", apvId)).toMatchObject({ paid: 22200, balance: 0, status: "Paid" });
    const unpaid = await get("/api/apv/unpaid", { supplierId });
    expect(unpaid.body.find((r) => r.sourceType === "APV" && r.id === apvId)).toBeUndefined();
    const row = (await agingRows("ap")).find((r) => r.sourceType === "APV" && r.sourceId === apvId);
    expect(row.baseBalance).toBe(0);
    expect(await agingParty("ap", supplierId)).toBe(0);
    expect(await glBalance("AP")).toBe(0); // GL AP control is fully settled too
    const overdue = await get("/api/reports/ap-overdue-accounts", { asOf: AS_OF });
    expect(overdue.status).toBe(200);
    expect((overdue.body.rows || []).find((r) => r.sourceType === "APV" && r.sourceId === apvId)).toBeUndefined();
  });

  test("AP subsidiary ledger nets to the GL AP movement (APV 22,200 credit, CV 22,200 debit)", async () => {
    const res = await get("/api/reports/subsidiary-ledger", { type: "AP", partyId: supplierId, from: D, to: D });
    expect(res.status).toBe(200);
    const rows = (Array.isArray(res.body) ? res.body : res.body.rows).filter((r) => [apvId, cvId].includes(r.transaction_id));
    const apvRow = rows.find((r) => r.source_type === "APV");
    const cvRow = rows.find((r) => r.source_type === "CV");
    expect(Number(apvRow.credit)).toBe(22200);
    expect(Number(cvRow.debit)).toBe(22200);
  });

  test("void of the CV restores the APV to its 22,200 payable, not 22,400", async () => {
    const res = await post(`/api/cv/${cvId}/void`, { reason: "P0 regression void" });
    expect(res.status).toBe(200);
    expect(await header("apv_headers", apvId)).toMatchObject({ paid: 0, balance: 22200, status: "Unpaid" });
  });

  test("editing a Draft APV with EWT recomputes the balance from the control amount", async () => {
    const res = await makeApvEwt("Draft");
    expect(res.status).toBe(200);
    const id = res.body.id;
    const edit = await request(app).put(`/api/apv/${id}`).set(auth()).send(body(SUP(), `${P}APV-EDIT-${id}`, "Draft", apvEwtLines(), { atcCode: ATC_AP, taxWithheldAmount: 200 }));
    expect(edit.status).toBe(200);
    expect(await header("apv_headers", id)).toMatchObject({ balance: 22200, status: "Unpaid" });
  });

  test("an APV without withholding is unchanged (balance = credit total)", async () => {
    const lines = [line("EXP", 5000, 0), line("AP", 0, 5000)];
    const res = await post("/api/apv", body(SUP(), vno("APV-PLAIN"), "Posted", lines));
    expect(res.status).toBe(200);
    expect(await header("apv_headers", res.body.id)).toMatchObject({ totalCredit: 5000, balance: 5000 });
  });
});

// ===========================================================================
describe("TC1-062 mirror - invoice with customer withholding owes its AR control amount", () => {
  let invId, orId;

  test("stored balance = AR control (55,000), unpaid list and aging agree with the GL", async () => {
    const res = await makeInvCwt();
    expect(res.status).toBe(200);
    invId = res.body.id;
    expect(await header("invoice_headers", invId)).toMatchObject({ totalDebit: 56000, balance: 55000, status: "Unpaid" });
    const unpaid = await get("/api/invoices/unpaid", { customerId });
    const row = unpaid.body.find((r) => r.sourceType === "INV" && r.id === invId);
    expect(Number(row.totalAmount)).toBe(55000);
    expect(Number(row.balanceAmount)).toBe(55000);
    const ag = (await agingRows("ar")).find((r) => r.sourceType === "INV" && r.sourceId === invId);
    expect(ag.baseOriginal).toBe(55000);
    expect(await agingParty("ar", customerId)).toBe(55000);
    expect(await glBalance("AR")).toBe(55000);
    expect(await glBalance("CWT")).toBe(1000);
  });

  test("an OR for 55,000 fully settles the invoice; AR aging, overdue, statement and GL agree", async () => {
    const res = await post("/api/or", orBody("OR-NET", 55000, [{ sourceId: invId, amount: 55000, applicationDate: D }]));
    expect(res.status).toBe(200);
    orId = res.body.id;
    expect(await header("invoice_headers", invId)).toMatchObject({ paid: 55000, balance: 0, status: "Paid" });
    expect(await agingParty("ar", customerId)).toBe(0);
    expect(await glBalance("AR")).toBe(0);
    const overdue = await get("/api/reports/ar-overdue-accounts", { asOf: AS_OF });
    expect((overdue.body.rows || []).find((r) => r.sourceType === "INV" && r.sourceId === invId)).toBeUndefined();
    const soa = await get("/api/reports/ar-statement-of-accounts", { partyId: customerId, from: D, to: D });
    expect(soa.status).toBe(200);
    expect(soa.body.rows.find((r) => r.sourceType === "INV").debit).toBe(55000);
    expect(soa.body.rows.find((r) => r.sourceType === "OR").credit).toBe(55000);
    expect(soa.body.endingBalance).toBe(0);
  });

  test("AR subsidiary ledger: invoice 55,000 debit, OR 55,000 credit", async () => {
    const res = await get("/api/reports/subsidiary-ledger", { type: "AR", partyId: customerId, from: D, to: D });
    const rows = (Array.isArray(res.body) ? res.body : res.body.rows).filter((r) => [invId, orId].includes(r.transaction_id));
    expect(Number(rows.find((r) => r.source_type === "INV").debit)).toBe(55000);
    expect(Number(rows.find((r) => r.source_type === "OR").credit)).toBe(55000);
  });
});

// ===========================================================================
describe("TC1-084 - Option A: posted control-account payments must be fully applied", () => {
  let openApv;
  beforeAll(async () => {
    const res = await post("/api/apv", body(SUP(), vno("APV-OPEN"), "Posted", [line("EXP", 3000, 0), line("AP", 0, 3000)]));
    openApv = res.body.id;
  });

  test("posted CV debiting AP with no application -> 400 UNAPPLIED_CONTROL_PAYMENT, nothing saved", async () => {
    const before = (await pool.execute("SELECT COUNT(*) n FROM cv_headers WHERE company_id = ?", [companyId]))[0][0].n;
    const res = await post("/api/cv", cvBody("CV-NOAPP", 1000, []));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNAPPLIED_CONTROL_PAYMENT");
    expect((await pool.execute("SELECT COUNT(*) n FROM cv_headers WHERE company_id = ?", [companyId]))[0][0].n).toBe(before);
  });

  test("posted CV debiting AP 3,000 with only 1,000 applied -> 400", async () => {
    const res = await post("/api/cv", cvBody("CV-PART", 3000, [{ sourceId: openApv, amount: 1000, applicationDate: D }]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNAPPLIED_CONTROL_PAYMENT");
  });

  test("posted CV fully applied -> allowed", async () => {
    const res = await post("/api/cv", cvBody("CV-OK", 1000, [{ sourceId: openApv, amount: 1000, applicationDate: D }]));
    expect(res.status).toBe(200);
  });

  test("Draft CV without application can still be saved, but cannot be posted by edit", async () => {
    const res = await post("/api/cv", cvBody("CV-DRAFT", 500, [], "Draft"));
    expect(res.status).toBe(200);
    const edit = await request(app).put(`/api/cv/${res.body.id}`).set(auth()).send(cvBody("CV-DRAFT-POST", 500, [], "Posted"));
    expect(edit.status).toBe(400);
    expect(edit.body.code).toBe("UNAPPLIED_CONTROL_PAYMENT");
  });

  test("direct CV (expense paid, no AP line) is unaffected", async () => {
    const res = await post("/api/cv", cvBody("CV-DIRECT", 800, [], "Posted", [line("EXP", 800, 0), line("BANK", 0, 800)]));
    expect(res.status).toBe(200);
  });

  test("posted OR crediting AR with no invoice application -> 400; cash-sale OR (no AR line) is unaffected", async () => {
    const res = await post("/api/or", orBody("OR-NOAPP", 700, []));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNAPPLIED_CONTROL_PAYMENT");
    const cash = await post("/api/or", orBody("OR-CASHSALE", 1120, [], "Posted", [line("BANK", 1120, 0), line("REV", 0, 1000), line("OUTVAT", 0, 120)]));
    expect(cash.status).toBe(200);
  });

  test("bulk posting skips a Draft CV whose AP amount is unapplied (reported in paymentBlockedCount)", async () => {
    const draft = await post("/api/cv", cvBody("CV-BULK", 250, [], "Draft"));
    expect(draft.status).toBe(200);
    const res = await post("/api/posting/post", { scope: "ap", companyId });
    expect(res.status).toBe(200);
    expect(res.body.paymentBlockedCount).toBeGreaterThanOrEqual(1);
    const [[h]] = await pool.execute("SELECT status FROM cv_headers WHERE id = ?", [draft.body.id]);
    expect(h.status).toBe("Draft");
  });

  test("no GL / subledger drift: AP aging for the supplier still equals the GL AP control balance", async () => {
    expect(await agingParty("ap", supplierId)).toBe(-(await glBalance("AP")));
  });
});

// ===========================================================================
describe("TC1-092b - Debit / Credit Memos are standalone aging entries", () => {
  let invId, dmId, cmId, sdmId, scmId;
  const memoLines = {
    DM: () => [line("AR", 2000, 0, { genName: "P0AI Customer" }), line("REV", 0, 2000)],
    CM: () => [line("REV", 1500, 0), line("AR", 0, 1500, { genName: "P0AI Customer" })],
    SDM: () => [line("AP", 400, 0, { genName: "P0AI Supplier" }), line("EXP", 0, 400)],
    SCM: () => [line("EXP", 300, 0), line("AP", 0, 300, { genName: "P0AI Supplier" })],
  };

  beforeAll(async () => {
    const inv = await post("/api/invoices", body(CUS(), vno("INV-MEMO"), "Posted", [line("AR", 10000, 0), line("REV", 0, 10000)], { invoiceType: "Standard" }));
    invId = inv.body.id;
    dmId = (await post("/api/debit-memos", body(CUS(), vno("DM"), "Posted", memoLines.DM()))).body.id;
    cmId = (await post("/api/credit-memos", body(CUS(), vno("CM"), "Posted", memoLines.CM()))).body.id;
    sdmId = (await post("/api/debit-memos", body(SUP(), vno("SDM"), "Posted", memoLines.SDM()))).body.id;
    scmId = (await post("/api/credit-memos", body(SUP(), vno("SCM"), "Posted", memoLines.SCM()))).body.id;
    expect([invId, dmId, cmId, sdmId, scmId].every(Boolean)).toBe(true);
  });

  test("AR aging: customer DM +2,000 and CM -1,500 as standalone items aged from the memo date", async () => {
    const rows = await agingRows("ar");
    const dm = rows.find((r) => r.sourceType === "DM" && r.sourceId === dmId);
    const cm = rows.find((r) => r.sourceType === "CM" && r.sourceId === cmId);
    expect(dm).toMatchObject({ baseBalance: 2000, dueDate: D, transactionDate: D, partyId: customerId });
    expect(cm).toMatchObject({ baseBalance: -1500, dueDate: D, partyId: customerId });
    // the invoice itself is untouched by the memos (no FIFO application)
    expect(rows.find((r) => r.sourceType === "INV" && r.sourceId === invId).baseBalance).toBe(10000);
  });

  test("default OPEN aging keeps the negative credit memo", async () => {
    const res = await get("/api/reports/ar-aging", { asOf: AS_OF });
    const rows = Array.isArray(res.body) ? res.body : res.body.rows;
    expect(rows.find((r) => r.sourceType === "CM" && r.sourceId === cmId)).toBeTruthy();
  });

  test("AP aging: supplier DM -400 (decreases AP), CM +300 (increases AP); memos never cross ledgers", async () => {
    const ap = await agingRows("ap");
    expect(ap.find((r) => r.sourceType === "DM" && r.sourceId === sdmId).baseBalance).toBe(-400);
    expect(ap.find((r) => r.sourceType === "CM" && r.sourceId === scmId).baseBalance).toBe(300);
    expect(ap.find((r) => r.sourceType === "DM" && r.sourceId === dmId)).toBeUndefined();
    const ar = await agingRows("ar");
    expect(ar.find((r) => r.sourceType === "CM" && r.sourceId === scmId)).toBeUndefined();
  });

  test("AR / AP aging summaries equal the GL control balances (invoice + memos)", async () => {
    expect(await agingParty("ar", customerId)).toBe(await glBalance("AR"));
    expect(await agingParty("ap", supplierId)).toBe(-(await glBalance("AP")));
  });

  test("AR statement and AR / AP subsidiary ledgers show the memos with the same signs", async () => {
    const soa = await get("/api/reports/ar-statement-of-accounts", { partyId: customerId, from: D, to: D });
    expect(soa.body.rows.find((r) => r.sourceType === "DEBIT MEMO").debit).toBe(2000);
    expect(soa.body.rows.find((r) => r.sourceType === "CREDIT MEMO").credit).toBe(1500);
    expect(soa.body.endingBalance).toBe(await glBalance("AR"));
    const slAp = await get("/api/reports/subsidiary-ledger", { type: "AP", partyId: supplierId, from: D, to: D });
    const rows = Array.isArray(slAp.body) ? slAp.body : slAp.body.rows;
    expect(Number(rows.find((r) => r.transaction_id === sdmId).debit)).toBe(400);
    expect(Number(rows.find((r) => r.transaction_id === scmId).credit)).toBe(300);
  });

  test("AP Payables & Payments uses the memo control-line amounts", async () => {
    const res = await get("/api/reports/ap-payables-and-payments", { from: D, to: D, partyId: supplierId });
    expect(res.status).toBe(200);
    const list = Array.isArray(res.body) ? res.body : res.body.rows || res.body.suppliers;
    const row = list.find((r) => r.partyId === supplierId);
    expect(row.debitMemos).toBe(400);
    expect(row.creditMemos).toBe(300);
  });

  test("dashboard receivables / payables equal the aging totals", async () => {
    const res = await get("/api/dashboard/summary", { from: "2097-06-01", to: AS_OF });
    expect(res.status).toBe(200);
    expect(res.body.sections.receivables.total).toBe(await agingParty("ar", customerId));
    expect(res.body.sections.payables.total).toBe(await agingParty("ap", supplierId));
  });

  test("a header-only memo (no lines) falls back to the header-total convention", async () => {
    const [r] = await pool.execute(
      "INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'DEBIT', ?, 'P0AI Customer', 'CUSTOMER', ?, 600, 600, 'Posted')",
      [companyId, `${P}HDR-DM`, customerId, D]
    );
    const rows = await agingRows("ar");
    expect(rows.find((x) => x.sourceType === "DM" && x.sourceId === r.insertId).baseBalance).toBe(600);
  });
});
