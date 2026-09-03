const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");
const { computeEwtTaxableBase, computeEwtAmount } = require("../services/ewtCalculationService");

// Phase 7L Parts D/E/F/G: modern APV EWT base = VAT-exclusive structured
// net (balance-independent); APV VAT/EWT journal balances; a CV settling an
// APV never creates a second Input VAT / structured EWT row; frontend and
// backend agree on the base.

jest.setTimeout(220000);

let CO, userId, token;
let expId, apId, ivatId, taxesRecoverableId, ewtPayId, cashId;
let suppId;
const ATC = "PH7L-WC010";
const D = "2026-08-15";

let fe;

async function mkAcc(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return r.insertId;
}
async function tagValidation(coaId, name) {
  await pool.execute("INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)", [coaId, name]);
}
async function countTaxEntries(type, id) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) c FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ?",
    [type, id]
  );
  return row.c;
}
async function countTaxEntriesByType(type, id, entryType) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) c FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ? AND entry_type = ?",
    [type, id, entryType]
  );
  return row.c;
}

const authH = () => ({ Authorization: `Bearer ${token}` });
let seq = 0;

// The modern APV journal from the mandatory acceptance example:
//   Inclusive gross 11,200 @12% -> net 10,000, VAT 1,200; EWT 10% -> 1,000
//   Dr Expense 10,000 / Dr Input VAT 1,200 / Cr EWT Payable 1,000 / Cr AP 10,200
function acceptanceLines({ apCredit = 10200 } = {}) {
  return [
    { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: 10000, credit: 0 },
    {
      accountId: ivatId, accountCode: "PH7L-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)",
      genRef: "", genName: "PH7L Supplier", debit: 1200, credit: 0,
      taxEntry: {
        entryType: "INPUT_VAT", accountId: ivatId, partyId: suppId, partyName: "PH7L Supplier",
        partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
        grossAmount: 11200, netAmount: 10000, vatRate: 12, vatAmount: 1200,
        vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "INCLUSIVE", purchaseClassification: "Services",
      },
    },
    {
      accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
      genRef: "", genName: "PH7L Supplier", debit: 0, credit: 1000,
      taxEntry: {
        entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH7L Supplier",
        partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
        atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
      },
    },
    { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 0, credit: apCredit },
  ];
}

async function createApv(body) {
  const v = `PH7L-APV-${++seq}`;
  return request(app).post("/api/apv").set(authH()).send({
    voucherNo: v, supplierId: suppId, supplierName: "PH7L Supplier",
    transactionDate: D, referenceNo: v, description: "Purchase",
    currency: { companyId: CO },
    ...body,
  });
}

beforeAll(async () => {
  assertNotProductionDatabase();
  fe = await import("../../utils/ewtCalculations.mjs");

  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('PH7L Co', 'Active')");
  CO = c.insertId;
  const hash = await bcrypt.hash("Ph7lPass!1", 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES ('ph7l_admin', ?, 2, 'ACTIVE')", [hash]);
  userId = u.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, CO]);
  token = (await request(app).post("/api/login").send({ username: "ph7l_admin", password: "Ph7lPass!1" })).body.token;

  const admin = { id: userId, roleCode: "ADMIN" };
  await CurrencyService.createCurrency(admin, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "P",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: CO,
  });

  expId = await mkAcc("PH7L-EXP", "Purchases Expense", "EXPENSE");
  apId = await mkAcc("PH7L-AP", "Accounts Payable", "LIABILITY");
  ivatId = await mkAcc("PH7L-IVAT", "Input VAT Receivable", "ASSET");
  taxesRecoverableId = await mkAcc("PH7L-TXR", "Taxes Recoverable", "ASSET"); // non-standard title
  ewtPayId = await mkAcc("PH7L-EWTP", "Withholding Tax Payable", "LIABILITY");
  cashId = await mkAcc("PH7L-CASH", "Cash in Bank", "ASSET");

  await tagValidation(ivatId, "INPUT VAT");
  await tagValidation(taxesRecoverableId, "INPUT VAT"); // tagged, but NOT titled "input vat"
  await tagValidation(ewtPayId, "EXPANDED TAX");
  await tagValidation(apId, "AP");

  const [p] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'PH7L-S', 'SUPPLIER', 'PH7L Supplier', 'ACTIVE', '111-222-333-000')",
    [CO]
  );
  suppId = p.insertId;
  await pool.execute("INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES (?, 'PH7L fixture', 10, 'EWT', 'ACTIVE')", [ATC]);
  await pool.execute(
    "INSERT INTO accounting_periods (company_id, year, period_month, start_date, end_date, status) VALUES (?, 2026, 8, '2026-08-01', '2026-08-31', 'OPEN')",
    [CO]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [CO]);
  for (const t of ["apv", "cv"]) {
    await pool.query(`DELETE ln FROM ${t}_lines ln JOIN ${t}_headers h ON h.id = ln.${t}_id WHERE h.company_id = ?`, [CO]);
  }
  await pool.query("DELETE FROM transaction_applications WHERE applied_id IN (SELECT id FROM cv_headers WHERE company_id = ?)", [CO]);
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM cv_headers WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM accounting_periods WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM audit_logs WHERE entity_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [CO]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [CO]);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [CO]);
  await pool.query("DELETE FROM coa_validations WHERE coa_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'PH7L-%')");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7L-%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = ?", [ATC]);
  await pool.end();
});

describe("Phase 7L - Mandatory Behavioral Acceptance Example", () => {
  let apvId;
  const lines = acceptanceLines();

  test("Posted APV: Dr Expense 10,000 / Dr Input VAT 1,200 / Cr EWT Payable 1,000 / Cr AP 10,200 - BALANCED", async () => {
    const res = await createApv({
      status: "Posted", atcCode: ATC, taxWithheldAmount: 1000,
      lines, totalDebit: 11200, totalCredit: 11200,
    });
    expect(res.status).toBe(200);
    apvId = res.body.id;

    const [[h]] = await pool.query(
      "SELECT total_debit, total_credit, taxable_base, tax_withheld_amount FROM apv_headers WHERE id = ?",
      [apvId]
    );
    expect(Number(h.total_debit)).toBe(11200);
    expect(Number(h.total_credit)).toBe(11200);
    expect(Number(h.total_debit)).toBe(Number(h.total_credit)); // BALANCED

    // EWT base = VAT-exclusive net 10,000 -> withheld 1,000. NOT 8,800 / 880.
    expect(Number(h.taxable_base)).toBe(10000);
    expect(Number(h.tax_withheld_amount)).toBe(1000);
    expect(Number(h.taxable_base)).not.toBe(8800);
    expect(Number(h.tax_withheld_amount)).not.toBe(880);
  });

  test("exactly one structured INPUT_VAT row and exactly one structured EWT row", async () => {
    expect(await countTaxEntriesByType("APV", apvId, "INPUT_VAT")).toBe(1);
    expect(await countTaxEntriesByType("APV", apvId, "EWT")).toBe(1);
    expect(await countTaxEntries("APV", apvId)).toBe(2);

    const [[ivat]] = await pool.query(
      "SELECT net_amount, vat_amount FROM transaction_tax_entries WHERE transaction_type='APV' AND transaction_id=? AND entry_type='INPUT_VAT'",
      [apvId]
    );
    expect(Number(ivat.net_amount)).toBe(10000);
    expect(Number(ivat.vat_amount)).toBe(1200);
  });

  test("frontend preview and backend stored taxable_base agree", async () => {
    const [[h]] = await pool.query("SELECT taxable_base FROM apv_headers WHERE id = ?", [apvId]);
    const beBase = computeEwtTaxableBase({ grossAmount: 11200, lines });
    const feBase = fe.computeEwtTaxableBase({ grossAmount: 11200, lines });
    expect(beBase).toBe(10000);
    expect(feBase).toBe(beBase);
    expect(Number(h.taxable_base)).toBe(feBase);
    expect(computeEwtAmount({ taxableBase: feBase, ewtRate: 10 })).toBe(1000);
  });

  test("re-saving (PUT) the same entries keeps exactly one INPUT_VAT + one EWT row", async () => {
    const putRes = await request(app).put(`/api/apv/${apvId}`).set(authH()).send({
      voucherNo: `PH7L-APV-${seq}`, supplierId: suppId, supplierName: "PH7L Supplier",
      transactionDate: D, referenceNo: "re", description: "Purchase edited",
      status: "Posted", atcCode: ATC, taxWithheldAmount: 1000,
      currency: { companyId: CO },
      lines, totalDebit: 11200, totalCredit: 11200,
    });
    // Posted APV may be immutable (Phase 7A.1) - either way, no duplication.
    if (putRes.status === 200) {
      expect(await countTaxEntriesByType("APV", apvId, "INPUT_VAT")).toBe(1);
      expect(await countTaxEntriesByType("APV", apvId, "EWT")).toBe(1);
    }
  });
});

describe("Phase 7L - Inclusive 10,000 acceptance example (spec section 8)", () => {
  test("gross 10,000 @12% inclusive -> net 8,928.57, VAT 1,071.43, EWT@10% 892.86", async () => {
    const net = 8928.57;
    const vat = 1071.43;
    const ewt = 892.86;
    const lines = [
      { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "p", genRef: "", genName: "", debit: net, credit: 0 },
      {
        accountId: ivatId, accountCode: "PH7L-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)",
        genRef: "", genName: "", debit: vat, credit: 0,
        taxEntry: {
          entryType: "INPUT_VAT", accountId: ivatId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          grossAmount: 10000, netAmount: net, vatRate: 12, vatAmount: vat,
          vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "INCLUSIVE", purchaseClassification: "Services",
        },
      },
      {
        accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
        genRef: "", genName: "", debit: 0, credit: ewt,
        taxEntry: {
          entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          atcCode: ATC, taxType: "EWT", taxableBase: net, withheldAmount: ewt,
        },
      },
      { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 0, credit: net + vat - ewt },
    ];
    const res = await createApv({ status: "Posted", atcCode: ATC, taxWithheldAmount: ewt, lines, totalDebit: 10000, totalCredit: 10000 });
    expect(res.status).toBe(200);
    const [[h]] = await pool.query("SELECT taxable_base, tax_withheld_amount, total_debit, total_credit FROM apv_headers WHERE id = ?", [res.body.id]);
    expect(Number(h.taxable_base)).toBe(net);
    expect(Number(h.tax_withheld_amount)).toBe(ewt);
    expect(Number(h.total_debit)).toBe(Number(h.total_credit));
  });
});

describe("Phase 7L - Exclusive acceptance example (spec section 9)", () => {
  test("base 10,000 @12% EXCLUSIVE -> gross 11,200, EWT base 10,000, EWT@10% 1,000", async () => {
    const lines = [
      { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "p", genRef: "", genName: "", debit: 10000, credit: 0 },
      {
        accountId: ivatId, accountCode: "PH7L-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)",
        genRef: "", genName: "", debit: 1200, credit: 0,
        taxEntry: {
          entryType: "INPUT_VAT", accountId: ivatId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          grossAmount: 11200, netAmount: 10000, vatRate: 12, vatAmount: 1200,
          vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "EXCLUSIVE", purchaseClassification: "Services",
        },
      },
      {
        accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
        genRef: "", genName: "", debit: 0, credit: 1000,
        taxEntry: {
          entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
        },
      },
      { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 0, credit: 10200 },
    ];
    const res = await createApv({ status: "Posted", atcCode: ATC, taxWithheldAmount: 1000, lines, totalDebit: 11200, totalCredit: 11200 });
    expect(res.status).toBe(200);
    const [[h]] = await pool.query("SELECT taxable_base, tax_withheld_amount FROM apv_headers WHERE id = ?", [res.body.id]);
    expect(Number(h.taxable_base)).toBe(10000);
    expect(Number(h.tax_withheld_amount)).toBe(1000);
    const [[ivat]] = await pool.query(
      "SELECT vat_entry_mode, net_amount FROM transaction_tax_entries WHERE transaction_type='APV' AND transaction_id=? AND entry_type='INPUT_VAT'",
      [res.body.id]
    );
    expect(ivat.vat_entry_mode).toBe("EXCLUSIVE"); // Phase 7J snapshot preserved
    expect(Number(ivat.net_amount)).toBe(10000);
  });
});

describe("Phase 7L Part D - EWT base comes from structured net, not (totalCredit - VAT line)", () => {
  test("a balanced APV with an extra non-tax debit still stores taxable_base = 10,000", async () => {
    // Dr Expense 10,000 / Dr Input VAT 1,200 / Dr Freight 500
    //   / Cr EWT Payable 1,000 / Cr AP 10,700   (balanced 11,700 = 11,700)
    // The pre-7L formula (totalCredit 11,700 - VAT line 1,200 = 10,500)
    // would be WRONG here; the structured net is 10,000.
    const lines = [
      { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: 10000, credit: 0 },
      {
        accountId: ivatId, accountCode: "PH7L-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)",
        genRef: "", genName: "", debit: 1200, credit: 0,
        taxEntry: {
          entryType: "INPUT_VAT", accountId: ivatId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          grossAmount: 11200, netAmount: 10000, vatRate: 12, vatAmount: 1200,
          vatTreatment: "STANDARD", vatCode: null, vatEntryMode: "INCLUSIVE", purchaseClassification: "Services",
        },
      },
      { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "Freight", genRef: "", genName: "", debit: 500, credit: 0 },
      {
        accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`,
        genRef: "", genName: "", debit: 0, credit: 1000,
        taxEntry: {
          entryType: "EWT", accountId: ewtPayId, partyId: suppId, partyName: "PH7L Supplier",
          partyTin: "111-222-333-000", partyAddress: "Manila", transactionDate: D,
          atcCode: ATC, taxType: "EWT", taxableBase: 10000, withheldAmount: 1000,
        },
      },
      { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 0, credit: 10700 },
    ];
    const res = await createApv({
      status: "Posted", atcCode: ATC, taxWithheldAmount: 1000,
      lines, totalDebit: 11700, totalCredit: 11700,
    });
    expect(res.status).toBe(200);
    const [[h]] = await pool.query("SELECT taxable_base, tax_withheld_amount FROM apv_headers WHERE id = ?", [res.body.id]);
    expect(Number(h.taxable_base)).toBe(10000); // structured net, NOT 10,500 and NOT 8,800
    expect(Number(h.tax_withheld_amount)).toBe(1000);
  });
});

describe("Phase 7L Part D - legacy VAT line identified by validated account id, not title", () => {
  test("direct CV: 'Taxes Recoverable' (tagged INPUT VAT) is treated as the VAT line", async () => {
    // Direct CV (no apvApplications) - legacy VAT behavior is preserved.
    // VAT line posts to 'Taxes Recoverable' (id tagged INPUT VAT, title has
    // no 'input vat' text). Gross 11,200; VAT line 1,200; ATC 10%.
    const res = await request(app).post("/api/cv").set(authH()).send({
      voucherNo: `PH7L-CV-DIRECT-${++seq}`, payeeId: suppId, payeeName: "PH7L Supplier",
      transactionDate: D, referenceNo: "cvd", description: "direct cash purchase",
      status: "Posted", paymentMethod: "Cash",
      atcCode: ATC, taxWithheldAmount: 1000,
      currency: { companyId: CO },
      lines: [
        { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "p", genRef: "", genName: "", debit: 10000, credit: 0 },
        { accountId: taxesRecoverableId, accountCode: "PH7L-TXR", accountTitle: "Taxes Recoverable", particulars: "Input VAT (12%)", genRef: "", genName: "", debit: 1200, credit: 0 },
        { accountId: cashId, accountCode: "PH7L-CASH", accountTitle: "Cash in Bank", particulars: "cash", genRef: "", genName: "", debit: 0, credit: 10200 },
        { accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`, genRef: "", genName: "", debit: 0, credit: 1000 },
      ],
      totalDebit: 11200, totalCredit: 11200,
    });
    expect(res.status).toBe(200);
    const [[h]] = await pool.query("SELECT taxable_base, tax_withheld_amount FROM cv_headers WHERE id = ?", [res.body.id]);
    // base = 11,200 - 1,200 (the 'Taxes Recoverable' line, matched by
    // validated id) = 10,000; NOT 11,200 (which is what a title-only match
    // would have produced).
    expect(Number(h.taxable_base)).toBe(10000);
    expect(Number(h.tax_withheld_amount)).toBe(1000);
    expect(await countTaxEntries("CV", res.body.id)).toBe(0); // legacy: no structured rows
  });
});

describe("Phase 7L Parts F/G - CV settling an APV does not duplicate tax", () => {
  let apvId;

  beforeAll(async () => {
    const res = await createApv({
      status: "Posted", atcCode: ATC, taxWithheldAmount: 1000,
      lines: acceptanceLines(), totalDebit: 11200, totalCredit: 11200,
    });
    apvId = res.body.id;
  });

  test("APV owns exactly one INPUT_VAT + one EWT structured row", async () => {
    expect(await countTaxEntriesByType("APV", apvId, "INPUT_VAT")).toBe(1);
    expect(await countTaxEntriesByType("APV", apvId, "EWT")).toBe(1);
  });

  test("CV applied to that APV - even if an ATC + a VAT-looking line are sent - creates ZERO structured tax rows", async () => {
    const res = await request(app).post("/api/cv").set(authH()).send({
      voucherNo: `PH7L-CV-SETTLE-${++seq}`, payeeId: suppId, payeeName: "PH7L Supplier",
      transactionDate: D, referenceNo: "cvs", description: "settle apv",
      status: "Posted", paymentMethod: "Cash",
      atcCode: ATC, taxWithheldAmount: 1000, // tamper: a client trying to double-withhold
      currency: { companyId: CO },
      lines: [
        { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "settle", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 10200, credit: 0 },
        { accountId: ivatId, accountCode: "PH7L-IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)", debit: 1200, credit: 0 },
        { accountId: cashId, accountCode: "PH7L-CASH", accountTitle: "Cash in Bank", particulars: "cash", genRef: "", genName: "", debit: 0, credit: 10400 },
        { accountId: ewtPayId, accountCode: "PH7L-EWTP", accountTitle: "Withholding Tax Payable", particulars: `EWT - ${ATC}`, debit: 0, credit: 1000 },
      ],
      totalDebit: 11400, totalCredit: 11400,
      apvApplications: [{ sourceType: "APV", sourceId: apvId, amount: 10200 }],
    });
    expect(res.status).toBe(200);
    // The CV backend has NO structured-tax path - zero rows, always.
    expect(await countTaxEntries("CV", res.body.id)).toBe(0);
    // The APV's own structured rows are untouched.
    expect(await countTaxEntriesByType("APV", apvId, "INPUT_VAT")).toBe(1);
    expect(await countTaxEntriesByType("APV", apvId, "EWT")).toBe(1);
  });
});

describe("Phase 7L - regression: a no-tax APV still posts cleanly", () => {
  test("plain Dr Expense / Cr AP, no ATC -> no tax entries, no taxable_base", async () => {
    const res = await createApv({
      status: "Posted",
      lines: [
        { accountId: expId, accountCode: "PH7L-EXP", accountTitle: "Purchases Expense", particulars: "p", genRef: "", genName: "", debit: 5000, credit: 0 },
        { accountId: apId, accountCode: "PH7L-AP", accountTitle: "Accounts Payable", particulars: "ap", genRef: "PH7L-S", genName: "PH7L Supplier", debit: 0, credit: 5000 },
      ],
      totalDebit: 5000, totalCredit: 5000,
    });
    expect(res.status).toBe(200);
    expect(await countTaxEntries("APV", res.body.id)).toBe(0);
    const [[h]] = await pool.query("SELECT taxable_base, tax_withheld_amount FROM apv_headers WHERE id = ?", [res.body.id]);
    expect(h.taxable_base == null || Number(h.taxable_base) === 0).toBe(true);
    expect(h.tax_withheld_amount == null || Number(h.tax_withheld_amount) === 0).toBe(true);
  });
});
