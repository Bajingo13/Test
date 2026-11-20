// P1 final pass (decisions of 2026-11-19):
//  1. Inactive parties - a NEW Invoice / OR / Quotation / DM / CM (customer) or
//     APV / CV / PO / DM / CM (supplier) / RFP (supplier) needs an ACTIVE party.
//     An EXISTING document that already references a party which was later
//     deactivated stays viewable and editable as long as the edit keeps that
//     same party; historical rows are never rewritten.
//  2. Recurring templates - the template's party follows the rule of the
//     transaction it generates (AR -> CUSTOMER, AP -> SUPPLIER, same company,
//     ACTIVE) when the template is saved, and is REVALIDATED every time an
//     occurrence is generated; a failed generation creates no document.
// Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const TemplateService = require("../services/recurringTemplateService");
const GenerationService = require("../services/recurringGenerationService");

jest.setTimeout(240000);

const P = "p1ia-";
const ACC = "P1IA-";
const D = "2097-06-10";
let A, userId, token, currencyId;
const party = {};
const acc = {};
let seq = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });

async function mkAccount(key, cls) {
  const [r] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)", [`${ACC}${key}`, `P1IA ${key}`, cls]);
  acc[key] = { accountId: r.insertId, accountCode: `${ACC}${key}`, accountTitle: `P1IA ${key}` };
}
async function mkParty(key, type, status = "ACTIVE") {
  const [r] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, ?)", [A, `${P}${key}`, type, `P1IA ${key}`, status]);
  party[key] = { id: r.insertId, name: `P1IA ${key}`, type };
}
const setStatus = (key, status) => pool.execute("UPDATE general_libraries SET status = ? WHERE id = ?", [status, party[key].id]);
const L = (key, debit, credit) => ({ ...acc[key], particulars: key, genRef: "", genName: "", debit, credit });
const MOD = {
  INV: { path: "/api/invoices", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)], extra: { invoiceType: "Standard" } },
  OR: { path: "/api/or", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)], extra: { paymentMethod: "Cash" } },
  APV: { path: "/api/apv", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
  CV: { path: "/api/cv", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)], extra: { paymentMethod: "Cash" } },
  PO: { path: "/api/purchase-orders", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
  DM: { path: "/api/debit-memos", lines: () => [L("BANK", 100, 0), L("REV", 0, 100)] },
  CM: { path: "/api/credit-memos", lines: () => [L("EXP", 100, 0), L("BANK", 0, 100)] },
};
function body(mod, key, voucherNo) {
  const p = party[key];
  return {
    voucherNo: voucherNo || `${P}${mod}-${++seq}`, referenceNo: `${P}ref-${seq}`, transactionDate: D, dueDate: D, description: "p1ia", status: "Draft",
    supplierId: p.id, supplierName: p.name, customerId: p.id, customerName: p.name, payeeId: p.id, payeeName: p.name, partyId: p.id, partyName: p.name, partyType: p.type,
    lines: MOD[mod].lines(), totalDebit: 100, totalCredit: 100, currency: { companyId: A }, ...(MOD[mod].extra || {}),
  };
}
const post = (mod, key, vno) => request(app).post(MOD[mod].path).set(auth()).send(body(mod, key, vno));
const put = (mod, id, key, vno) => request(app).put(`${MOD[mod].path}/${id}`).set(auth()).send(body(mod, key, vno));
const quotation = (key) => request(app).post("/api/quotations").set(auth()).send({
  companyId: A, customerId: party[key].id, customerName: party[key].name, quotationDate: D, expirationDate: "2097-07-10", status: "Draft",
  lines: [{ lineType: "item", description: "Service", quantity: 1, unitPrice: 100, amount: 100 }],
});
const rfpBody = (key, purpose) => ({ companyId: A, rfpDate: D, requestedPaymentDate: "2097-06-30", supplierId: party[key].id, currencyId, purpose, lines: [{ description: "Supplies", grossAmount: "100.00", accountId: acc.EXP.accountId }] });

beforeAll(async () => {
  assertNotProductionDatabase();
  A = (await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}A`]))[0].insertId;
  const hash = await bcrypt.hash("P1IaPass!1", 10);
  userId = (await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = 'ADMIN'), 'ACTIVE')", [`${P}admin`, hash]))[0].insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, A]);
  await CurrencyService.createCurrency({ id: userId, roleCode: "NON_SUPER" }, { currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P", decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: A });
  currencyId = (await pool.execute("SELECT id FROM currencies WHERE company_id = ? AND currency_code = 'PHP'", [A]))[0][0].id;
  await mkAccount("BANK", "ASSET");
  await mkAccount("REV", "INCOME");
  await mkAccount("EXP", "EXPENSE");
  await mkParty("CUS", "CUSTOMER");
  await mkParty("CUS-OFF", "CUSTOMER", "INACTIVE");
  await mkParty("SUP", "SUPPLIER");
  await mkParty("SUP-OFF", "SUPPLIER", "INACTIVE");
  const res = await request(app).post("/api/login").send({ username: `${P}admin`, password: "P1IaPass!1" });
  token = res.body.token;
});

afterAll(async () => {
  try {
    const cs = [A];
    await pool.query(`DELETE o FROM recurring_transaction_occurrences o JOIN recurring_transaction_schedules s ON s.id = o.schedule_id JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)`, [cs]);
    await pool.query("DELETE s FROM recurring_transaction_schedules s JOIN recurring_transaction_templates t ON t.id = s.template_id WHERE t.company_id IN (?)", [cs]);
    await pool.query("DELETE l FROM recurring_transaction_template_lines l JOIN recurring_transaction_templates t ON t.id = l.template_id WHERE t.company_id IN (?)", [cs]);
    await pool.query("DELETE FROM recurring_transaction_templates WHERE company_id IN (?)", [cs]);
    await pool.query("DELETE FROM rfp_history WHERE rfp_id IN (SELECT id FROM rfp_headers WHERE company_id IN (?))", [cs]).catch(() => {});
    await pool.query("DELETE FROM rfp_lines WHERE rfp_id IN (SELECT id FROM rfp_headers WHERE company_id IN (?))", [cs]).catch(() => {});
    await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [cs]).catch(() => {});
    for (const [lines, fk, hdr] of [["invoice_lines", "invoice_id", "invoice_headers"], ["or_lines", "or_id", "or_headers"], ["apv_lines", "apv_id", "apv_headers"], ["cv_lines", "cv_id", "cv_headers"], ["purchase_order_lines", "po_id", "purchase_order_headers"], ["memo_lines", "memo_id", "memo_headers"], ["quotation_lines", "quotation_id", "quotation_headers"]]) {
      await pool.query(`DELETE ln FROM ${lines} ln JOIN ${hdr} h ON h.id = ln.${fk} WHERE h.company_id IN (?)`, [cs]).catch(() => {});
    }
    await pool.query("DELETE FROM invoice_verifications WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [cs]).catch(() => {});
    for (const t of ["invoice_headers", "or_headers", "apv_headers", "cv_headers", "purchase_order_headers", "memo_headers", "quotation_headers", "transaction_tax_entries", "transaction_currency_snapshots", "audit_logs", "general_libraries", "accounting_periods", "currency_rates", "currencies"]) {
      await pool.query(`DELETE FROM ${t} WHERE company_id IN (?)`, [cs]).catch(() => {});
    }
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
    await pool.query("DELETE FROM users WHERE id = ?", [userId]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [cs]);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

// ===========================================================================
describe("1. inactive parties on NEW documents", () => {
  test.each(["INV", "OR", "DM", "CM"])("%s: active customer allowed, inactive customer -> 400 PARTY_INACTIVE", async (mod) => {
    expect((await post(mod, "CUS")).status).toBe(200);
    const res = await post(mod, "CUS-OFF");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTY_INACTIVE");
  });
  test.each(["APV", "CV", "PO", "DM", "CM"])("%s: active supplier allowed, inactive supplier -> 400 PARTY_INACTIVE", async (mod) => {
    expect((await post(mod, "SUP")).status).toBe(200);
    const res = await post(mod, "SUP-OFF");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTY_INACTIVE");
  });
  test("Quotation: active customer allowed, inactive customer rejected", async () => {
    expect((await quotation("CUS")).status).toBe(200);
    expect((await quotation("CUS-OFF")).body.code).toBe("PARTY_INACTIVE");
  });
  test("RFP: active supplier allowed, inactive supplier rejected", async () => {
    expect((await request(app).post("/api/rfp").set(auth()).send(rfpBody("SUP", "active supplier"))).status).toBe(201);
    const res = await request(app).post("/api/rfp").set(auth()).send(rfpBody("SUP-OFF", "inactive supplier"));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not active/i);
  });
});

describe("1b. EXISTING documents whose party was deactivated later", () => {
  test.each([["INV", "CUSTOMER"], ["OR", "CUSTOMER"], ["APV", "SUPPLIER"], ["CV", "SUPPLIER"], ["PO", "SUPPLIER"], ["DM", "CUSTOMER"], ["CM", "SUPPLIER"]])(
    "%s: stays viewable and editable with the same party; switching to another inactive party is rejected",
    async (mod, type) => {
      const key = `${mod}-LATER`;
      await mkParty(key, type);
      const vno = `${P}${mod}-HIST-${++seq}`;
      const created = await post(mod, key, vno);
      expect(created.status).toBe(200);
      await setStatus(key, "INACTIVE");
      expect((await request(app).get(`${MOD[mod].path}/${created.body.id}`).set(auth()).query({ companyId: A })).status).toBe(200);
      const keep = await put(mod, created.body.id, key, vno);
      expect(keep.status).toBe(200);
      const other = type === "CUSTOMER" ? "CUS-OFF" : "SUP-OFF";
      const swap = await put(mod, created.body.id, other, vno);
      expect(swap.status).toBe(400);
      expect(swap.body.code).toBe("PARTY_INACTIVE");
    }
  );
  test("RFP: a draft whose supplier was deactivated can still be edited with that supplier", async () => {
    await mkParty("RFP-LATER", "SUPPLIER");
    const created = await request(app).post("/api/rfp").set(auth()).send(rfpBody("RFP-LATER", "before deactivation"));
    expect(created.status).toBe(201);
    await setStatus("RFP-LATER", "INACTIVE");
    const { companyId, ...edit } = rfpBody("RFP-LATER", "edited after deactivation");
    void companyId;
    const res = await request(app).put(`/api/rfp/${created.body.id}`).set(auth()).send(edit);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
const tl = (key, debit, credit) => ({ accountId: acc[key].accountId, accountCode: acc[key].accountCode, accountTitle: acc[key].accountTitle, particularsTemplate: key, debit, credit });
const template = (moduleType, key, over = {}) => TemplateService.createTemplate({
  moduleType, templateName: `${P}tmpl ${moduleType} ${++seq}`,
  partyId: key ? party[key].id : null, partyName: key ? party[key].name : null,
  descriptionTemplate: "P1IA recurring", currency: "PHP", currencyId: null, amountMode: "FIXED", amountConfig: {},
  dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
  lines: moduleType === "apv" ? [tl("EXP", 50, 0), tl("BANK", 0, 50)] : [tl("BANK", 50, 0), tl("REV", 0, 50)],
  schedule: { frequency: "MONTHLY", startDate: D, endDate: null, dateAdjustmentRule: "KEEP_ORIGINAL" }, ...over,
}, userId, A);
const headerCount = async (table) => (await pool.execute(`SELECT COUNT(*) n FROM ${table} WHERE company_id = ?`, [A]))[0][0].n;
async function generateExpectingFailure(scheduleId, code) {
  const table = "apv_headers";
  const before = await headerCount(table) + (await headerCount("invoice_headers"));
  let err = null;
  try { await GenerationService.processSchedule(scheduleId, { triggerType: "MANUAL", userId }); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(err.statusCode).toBe(422);
  expect(err.code).toBe(code);
  expect(await headerCount(table) + (await headerCount("invoice_headers"))).toBe(before); // nothing created
  const [[occ]] = await pool.execute("SELECT status FROM recurring_transaction_occurrences WHERE schedule_id = ? ORDER BY id DESC LIMIT 1", [scheduleId]);
  expect(occ.status).toBe("FAILED");
}

describe("2. recurring templates - saving", () => {
  test("active party of the right type -> template saved", async () => {
    await expect(template("apv", "SUP")).resolves.toBeTruthy();
    await expect(template("invoice", "CUS")).resolves.toBeTruthy();
  });
  test("inactive party -> 400 PARTY_INACTIVE", async () => {
    await expect(template("apv", "SUP-OFF")).rejects.toMatchObject({ statusCode: 400, code: "PARTY_INACTIVE" });
  });
  test("wrong party type -> 400 PARTY_TYPE_NOT_ALLOWED (an AP template with a customer, an AR template with a supplier)", async () => {
    await expect(template("apv", "CUS")).rejects.toMatchObject({ statusCode: 400, code: "PARTY_TYPE_NOT_ALLOWED" });
    await expect(template("invoice", "SUP")).rejects.toMatchObject({ statusCode: 400, code: "PARTY_TYPE_NOT_ALLOWED" });
  });
  test("missing party -> 400", async () => {
    await expect(template("apv", null)).rejects.toMatchObject({ statusCode: 400 });
  });
  test("unknown party -> 400 PARTY_NOT_FOUND", async () => {
    await expect(template("apv", null, { partyId: 99999999, partyName: "ghost" })).rejects.toMatchObject({ statusCode: 400, code: "PARTY_NOT_FOUND" });
  });
});

describe("2b. recurring templates - generation-time revalidation", () => {
  test("valid active party -> generation succeeds (Draft APV for that supplier)", async () => {
    await mkParty("GEN-OK", "SUPPLIER");
    const t = await template("apv", "GEN-OK");
    const r = await GenerationService.processSchedule(t.scheduleId, { triggerType: "MANUAL", userId });
    expect(r.status).toBe("SUCCESS");
    const [[h]] = await pool.execute("SELECT status, supplier_id FROM apv_headers WHERE id = ?", [r.generatedId]);
    expect(h).toEqual({ status: "Draft", supplier_id: party["GEN-OK"].id });
  });
  test("party deactivated AFTER the template was saved -> 422 PARTY_INACTIVE, nothing created", async () => {
    await mkParty("GEN-OFF", "SUPPLIER");
    const t = await template("apv", "GEN-OFF");
    await setStatus("GEN-OFF", "INACTIVE");
    await generateExpectingFailure(t.scheduleId, "PARTY_INACTIVE");
  });
  test("party retyped AFTER the template was saved -> 422 PARTY_TYPE_NOT_ALLOWED, nothing created", async () => {
    await mkParty("GEN-RETYPE", "SUPPLIER");
    const t = await template("apv", "GEN-RETYPE");
    await pool.execute("UPDATE general_libraries SET party_type = 'CUSTOMER' WHERE id = ?", [party["GEN-RETYPE"].id]);
    await generateExpectingFailure(t.scheduleId, "PARTY_TYPE_NOT_ALLOWED");
  });
  test("template party missing at generation -> 422 PARTY_REQUIRED, nothing created", async () => {
    const t = await template("invoice", "CUS");
    await pool.execute("UPDATE recurring_transaction_templates SET party_id = NULL WHERE id = ?", [t.templateId]);
    await generateExpectingFailure(t.scheduleId, "PARTY_REQUIRED");
  });
  test("template party unknown at generation -> 422 PARTY_NOT_FOUND, nothing created", async () => {
    const t = await template("invoice", "CUS");
    await pool.execute("UPDATE recurring_transaction_templates SET party_id = 99999999 WHERE id = ?", [t.templateId]);
    await generateExpectingFailure(t.scheduleId, "PARTY_NOT_FOUND");
  });
});
