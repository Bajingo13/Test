// P0 TC1-062 coverage for RECURRING generation (recurringGenerationService):
// a generated APV / Invoice must open at its authoritative AP / AR control
// amount (controlAmountService), and every consumer - stored balance,
// unpaid list, payment cap, aging - must use that same figure.
//
// Generated documents carry no tax-entry rows (template lines are plain
// account lines - see recurringGenerationService's header comment), so the
// control amount here comes from the AP CODE / AR CODE flagged control line.
// The recurring workflow itself is not changed: templates are created and
// generated through the existing services, generated documents are Drafts,
// and they are posted through the existing bulk-posting route.
//
// Self-contained fixtures (own company, accounts, parties, user) so this
// suite does not depend on recurringCrossModuleGeneration.test.js, whose
// pre-existing cleanup failure is out of scope. Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const TemplateService = require("../services/recurringTemplateService");
const GenerationService = require("../services/recurringGenerationService");

jest.setTimeout(240000);

const P = "p0rec-";
const ACC = "P0REC-";
const PASSWORD = "P0RecPass!1";
const START = "2097-06-10";
const AS_OF = "2097-12-31";
const TEMPLATE_PREFIX = "P0REC template";

let companyId, supplierId, customerId, userId, token;
const acc = {};
const generated = { apv: [], invoice: [] };
const auth = () => ({ Authorization: `Bearer ${token}` });
const get = (path, q = {}) => request(app).get(path).set(auth()).query({ companyId, ...q });
const post = (path, b) => request(app).post(path).set(auth()).send(b);

async function mkAccount(key, title, cls, validations = []) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, title, cls]);
  for (const v of validations) await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [r.insertId, v]);
  acc[key] = { id: r.insertId, code: `${ACC}${key}`, title };
}
const tl = (key, debit, credit) => ({ accountId: acc[key].id, accountCode: acc[key].code, accountTitle: acc[key].title, particularsTemplate: `${key} {{month_name}}`, debit, credit });

async function generate(moduleType, lines, party) {
  const created = await TemplateService.createTemplate(
    {
      moduleType,
      templateName: `${TEMPLATE_PREFIX} ${moduleType} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      partyId: party.id,
      partyName: party.name,
      descriptionTemplate: `P0 recurring ${moduleType} {{month_name}} {{year}}`,
      currency: "PHP",
      currencyId: null,
      amountMode: "FIXED",
      amountConfig: {},
      dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
      lines,
      schedule: { frequency: "MONTHLY", startDate: START, endDate: null, dateAdjustmentRule: "KEEP_ORIGINAL" },
    },
    userId,
    companyId
  );
  const result = await GenerationService.processSchedule(created.scheduleId, { triggerType: "MANUAL", userId });
  expect(result.status).toBe("SUCCESS");
  const id = result.generatedTransactionId ?? result.transactionId ?? result.generatedId;
  expect(id).toBeTruthy();
  generated[moduleType].push(id);
  return id;
}

async function header(table, id) {
  const [[r]] = await pool.execute(`SELECT status, total_debit, total_credit, paid_amount, balance_amount, payment_status FROM ${table} WHERE id = ?`, [id]);
  return { status: r.status, totalDebit: Number(r.total_debit), totalCredit: Number(r.total_credit), paid: Number(r.paid_amount), balance: Number(r.balance_amount), paymentStatus: r.payment_status };
}
async function agingRow(kind, sourceType, id) {
  const res = await get(`/api/reports/${kind}-aging`, { asOf: AS_OF, status: "ALL" });
  expect(res.status).toBe(200);
  return (Array.isArray(res.body) ? res.body : res.body.rows).find((r) => r.sourceType === sourceType && r.sourceId === id);
}

beforeAll(async () => {
  assertNotProductionDatabase();
  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`${P}Co`]);
  companyId = c.insertId;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ACCOUNTANT'), 'ACTIVE')", [`${P}acct`, hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  await CurrencyService.createCurrency({ id: userId, roleCode: "NON_SUPER" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });
  const [s] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'SUPPLIER', 'P0REC Supplier', '111-000-000-000', 'ACTIVE')", [companyId, `${P}sup`]);
  supplierId = s.insertId;
  const [cu] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, tin, status) VALUES (?, ?, 'CUSTOMER', 'P0REC Customer', '222-000-000-000', 'ACTIVE')", [companyId, `${P}cus`]);
  customerId = cu.insertId;
  await mkAccount("AP", "P0REC Accounts Payable", "LIABILITY", ["AP CODE"]);
  await mkAccount("AR", "P0REC Accounts Receivable", "ASSET", ["AR CODE"]);
  await mkAccount("EXP", "P0REC Utilities Expense", "EXPENSE");
  await mkAccount("INVAT", "P0REC Input VAT", "ASSET", ["INPUT VAT"]);
  await mkAccount("EWTP", "P0REC EWT Payable", "LIABILITY", ["EXPANDED TAX"]);
  await mkAccount("CWT", "P0REC Creditable Withholding Tax", "ASSET", ["EXPANDED TAX"]);
  await mkAccount("REV", "P0REC Service Revenue", "INCOME");
  await mkAccount("OUTVAT", "P0REC Output VAT", "LIABILITY", ["OUTPUT VAT"]);
  await mkAccount("BANK", "P0REC Cash in Bank", "ASSET", ["BANK / CASH"]);
  await mkAccount("APX", "P0REC Unflagged Payable", "LIABILITY"); // no AP CODE - documents the fallback
  const res = await request(app).post("/api/login").send({ username: `${P}acct`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  token = res.body.token;
});

afterAll(async () => {
  try {
    const cs = [companyId];
    await pool.query("DELETE ta FROM transaction_applications ta JOIN cv_headers h ON h.id = ta.applied_id AND ta.applied_type = 'CV' WHERE h.company_id IN (?)", [cs]);
    await pool.query("DELETE ta FROM transaction_applications ta JOIN or_headers h ON h.id = ta.applied_id AND ta.applied_type = 'OR' WHERE h.company_id IN (?)", [cs]);
    for (const [lines, fk, hdr] of [["cv_lines", "cv_id", "cv_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["invoice_lines", "invoice_id", "invoice_headers"]]) {
      await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [cs]);
    }
    await pool.query(
      `DELETE o FROM recurring_transaction_occurrences o JOIN recurring_transaction_schedules s ON s.id = o.schedule_id
         JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)`, [cs]);
    await pool.query("DELETE s FROM recurring_transaction_schedules s JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)", [cs]);
    await pool.query("DELETE l FROM recurring_transaction_template_lines l JOIN recurring_transaction_templates t ON t.id = l.template_id WHERE t.company_id IN (?)", [cs]);
    await pool.query("DELETE FROM recurring_transaction_templates WHERE company_id IN (?)", [cs]);
    for (const t of ["cv_headers", "or_headers", "apv_headers", "invoice_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "accounting_periods", "currency_rates", "currencies"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cs]).catch(() => {});
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cs]);
    await pool.query(`DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE '${ACC}%')`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

describe("P0 TC1-062 - recurring APV with EWT opens at its AP control amount", () => {
  let apvId;

  test("generated Draft APV: credit total 22,400 but stored balance 22,200 (AP control after EWT)", async () => {
    apvId = await generate("apv", [tl("EXP", 20000, 0), tl("INVAT", 2400, 0), tl("EWTP", 0, 200), tl("AP", 0, 22200)], { id: supplierId, name: "P0REC Supplier" });
    const h = await header("apv_headers", apvId);
    expect(h.status).toBe("Draft"); // recurring workflow unchanged: generated documents are Drafts
    expect(h.totalCredit).toBe(22400);
    expect(h.balance).toBe(22200);
    expect(h.paid).toBe(0);
    expect(h.paymentStatus).toBe("Unpaid");
  });

  test("after posting (existing bulk posting), unpaid list and AP aging carry the same 22,200", async () => {
    const res = await post("/api/posting/post", { scope: "ap", companyId });
    expect(res.status).toBe(200);
    expect((await header("apv_headers", apvId)).status).toBe("Posted");
    expect((await header("apv_headers", apvId)).balance).toBe(22200);
    const unpaid = await get("/api/apv/unpaid", { supplierId });
    const row = unpaid.body.find((r) => r.sourceType === "APV" && r.id === apvId);
    expect(Number(row.totalAmount)).toBe(22200);
    expect(Number(row.balanceAmount)).toBe(22200);
    const ag = await agingRow("ap", "APV", apvId);
    expect(ag.baseOriginal).toBe(22200);
    expect(ag.baseBalance).toBe(22200);
  });

  test("payment cap = 22,200: the 22,400 gross is refused, 22,200 settles the APV in full", async () => {
    const cv = (amount, tag) => post("/api/cv", {
      voucherNo: `${P}CV-${tag}`, referenceNo: `${P}CV-${tag}`, payeeId: supplierId, payeeName: "P0REC Supplier", partyType: "SUPPLIER",
      transactionDate: START, description: "pay recurring APV", status: "Posted", paymentMethod: "Cash",
      lines: [
        { accountId: acc.AP.id, accountCode: acc.AP.code, accountTitle: acc.AP.title, particulars: "AP", genRef: "", genName: "P0REC Supplier", debit: amount, credit: 0 },
        { accountId: acc.BANK.id, accountCode: acc.BANK.code, accountTitle: acc.BANK.title, particulars: "cash", genRef: "", genName: "", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId },
      apvApplications: [{ sourceId: apvId, amount, applicationDate: START }],
    });
    const over = await cv(22400, "GROSS");
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.body.message).toMatch(/cannot exceed APV balance of 22200\.00/);
    const ok = await cv(22200, "NET");
    expect(ok.status).toBe(200);
    expect(await header("apv_headers", apvId)).toMatchObject({ paid: 22200, balance: 0, paymentStatus: "Paid" });
    expect((await agingRow("ap", "APV", apvId)).baseBalance).toBe(0);
    const unpaid = await get("/api/apv/unpaid", { supplierId });
    expect(unpaid.body.find((r) => r.sourceType === "APV" && r.id === apvId)).toBeUndefined();
  });

  test("a recurring APV without withholding keeps balance = credit total (unchanged behavior)", async () => {
    const id = await generate("apv", [tl("EXP", 1500, 0), tl("AP", 0, 1500)], { id: supplierId, name: "P0REC Supplier" });
    expect(await header("apv_headers", id)).toMatchObject({ totalCredit: 1500, balance: 1500 });
  });

  test("documented fallback: with an UNFLAGGED payable account a generated APV has no tax entries, so it keeps the credit total", async () => {
    const id = await generate("apv", [tl("EXP", 20000, 0), tl("INVAT", 2400, 0), tl("EWTP", 0, 200), tl("APX", 0, 22200)], { id: supplierId, name: "P0REC Supplier" });
    expect(await header("apv_headers", id)).toMatchObject({ totalCredit: 22400, balance: 22400 });
  });
});

describe("P0 TC1-062 mirror - recurring invoice with CWT opens at its AR control amount", () => {
  let invId;

  test("generated Draft invoice: debit total 56,000 but stored balance 55,000 (AR control after CWT)", async () => {
    invId = await generate("invoice", [tl("AR", 55000, 0), tl("CWT", 1000, 0), tl("REV", 0, 50000), tl("OUTVAT", 0, 6000)], { id: customerId, name: "P0REC Customer" });
    const h = await header("invoice_headers", invId);
    expect(h.status).toBe("Draft");
    expect(h.totalDebit).toBe(56000);
    expect(h.balance).toBe(55000);
    expect(h.paymentStatus).toBe("Unpaid");
  });

  test("after posting, unpaid list and AR aging carry the same 55,000; an OR for 55,000 settles it", async () => {
    const res = await post("/api/posting/post", { scope: "ar", companyId });
    expect(res.status).toBe(200);
    expect(await header("invoice_headers", invId)).toMatchObject({ status: "Posted", balance: 55000 });
    const unpaid = await get("/api/invoices/unpaid", { customerId });
    const row = unpaid.body.find((r) => r.sourceType === "INV" && r.id === invId);
    expect(Number(row.totalAmount)).toBe(55000);
    expect(Number(row.balanceAmount)).toBe(55000);
    const ag = await agingRow("ar", "INV", invId);
    expect(ag.baseOriginal).toBe(55000);
    expect(ag.baseBalance).toBe(55000);

    const orRes = (amount, tag) => post("/api/or", {
      voucherNo: `${P}OR-${tag}`, referenceNo: `${P}OR-${tag}`, customerId, customerName: "P0REC Customer", partyType: "CUSTOMER",
      transactionDate: START, description: "collect recurring invoice", status: "Posted", paymentMethod: "Cash",
      lines: [
        { accountId: acc.BANK.id, accountCode: acc.BANK.code, accountTitle: acc.BANK.title, particulars: "cash", genRef: "", genName: "", debit: amount, credit: 0 },
        { accountId: acc.AR.id, accountCode: acc.AR.code, accountTitle: acc.AR.title, particulars: "AR", genRef: "", genName: "P0REC Customer", debit: 0, credit: amount },
      ],
      totalDebit: amount, totalCredit: amount, currency: { companyId },
      invoiceApplications: [{ sourceId: invId, amount, applicationDate: START }],
    });
    const over = await orRes(56000, "GROSS");
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.body.message).toMatch(/cannot exceed invoice balance of 55000\.00/);
    const ok = await orRes(55000, "NET");
    expect(ok.status).toBe(200);
    expect(await header("invoice_headers", invId)).toMatchObject({ paid: 55000, balance: 0, paymentStatus: "Paid" });
    expect((await agingRow("ar", "INV", invId)).baseBalance).toBe(0);
  });
});
