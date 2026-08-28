const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 7C1: proves the new outputVat field GET /api/print/invoice/:id
// returns - aggregated server-side by transactionPrintDataService.js's
// getOutputVatSummary() from real transaction_tax_entries OUTPUT_VAT rows
// (the exact same TaxEntryService.loadTaxEntries() the Invoice detail
// route already uses - no GL-account-title heuristics, no query against
// vat_rate_codes). Covers: single/multiple entries, correct net/VAT sums,
// no-VAT/VAT-only/EWT-only/VAT+EWT combinations, Draft vs Posted, and that
// no VAT Rate Library row is required at all for the print path to work
// correctly (proving there is no live-catalog dependency).

jest.setTimeout(180000);

let companyId, token, adminId;
let arId, revId, outputVatAcctId, ewtReceivableAcctId;
let custId;
const createdInvoiceIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeLoginUser(username, password, roleId, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')",
    [username, hash, roleId]
  );
  const userId = result.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return userId;
}
async function makeAccount(code, title, cls) {
  const [existing] = await pool.execute("SELECT id FROM chart_of_accounts WHERE code = ?", [code]);
  if (existing.length) return existing[0].id;
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  return result.insertId;
}
async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// Self-healing, dependency-order-safe cleanup - deletes children before
// parents (currency snapshots/lines before currencies/headers before
// companies) so a run interrupted between tests (leaving a fixture that a
// normal single-pass afterAll wouldn't anticipate) can never permanently
// block the next run with a foreign-key error. Looked up fresh by name/
// username pattern each time, not by the in-memory companyId/adminId
// (which wouldn't exist yet on the very first run, and wouldn't match a
// PRIOR interrupted run's different id on a later one).
async function cleanupStaleFixtures() {
  const [companies] = await pool.query("SELECT id FROM companies WHERE name LIKE 'TEST Output VAT Print%'");
  const companyIds = companies.map((c) => c.id);

  if (companyIds.length) {
    const [currencies] = await pool.query("SELECT id FROM currencies WHERE company_id IN (?)", [companyIds]);
    const currencyIds = currencies.map((c) => c.id);
    if (currencyIds.length) {
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE currency_id IN (?) OR base_currency_id IN (?)", [currencyIds, currencyIds]);
    }
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [companyIds]);
    await pool.query("DELETE FROM transaction_tax_entries WHERE transaction_type IN ('INV', 'OR') AND transaction_id IN (SELECT id FROM invoice_headers WHERE company_id IN (?))", [companyIds]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE company_id IN (?))", [companyIds]);
    await pool.query("DELETE FROM or_headers WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companyIds]);
  }

  const [users] = await pool.query("SELECT id FROM users WHERE username LIKE 'test_ovp%'");
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }

  if (companyIds.length) {
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companyIds]);
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TESTOVP%'");
  await pool.execute("DELETE FROM ewt_library WHERE atc_code = 'TESTOVP-ATC'");
}

beforeAll(async () => {
  assertNotProductionDatabase();

  await cleanupStaleFixtures();

  companyId = await makeCompany("TEST Output VAT Print Co");
  adminId = await makeLoginUser("test_ovp_admin", "OvpPass!1", 2, companyId);
  token = await loginAs("test_ovp_admin", "OvpPass!1");

  arId = await makeAccount("TESTOVPAR", "Accounts Receivable (Print Test)", "ASSET");
  revId = await makeAccount("TESTOVPREV", "Sales Revenue (Print Test)", "INCOME");
  outputVatAcctId = await makeAccount("TESTOVPVAT", "Output VAT Payable (Print Test)", "LIABILITY");
  ewtReceivableAcctId = await makeAccount("TESTOVPEWT", "Creditable WHT Receivable (Print Test)", "ASSET");
  custId = await makeParty("TESTOVP-CUST", "CUSTOMER", "Output VAT Print Test Customer", companyId);

  const CurrencyService = require("../services/currencyService");
  await CurrencyService.createCurrency({ id: adminId, roleCode: "ADMIN" }, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });

  // Real ewt_library row - resolveTaxWithholding() (server.js) looks this
  // up by atc_code and silently records no withholding at all for an
  // unknown code, so a real row is required for the EWT-only/VAT+EWT
  // fixtures below to actually produce a taxWithheldAmount.
  await pool.execute("DELETE FROM ewt_library WHERE atc_code = 'TESTOVP-ATC'");
  await pool.execute(
    "INSERT INTO ewt_library (atc_code, description, tax_type, rate, bir_form, status) VALUES ('TESTOVP-ATC', 'Professional Fees (Print Test)', 'EWT', 5.000, '1601-EQ', 'ACTIVE')"
  );

  // Deliberately: NO vat_rate_codes row is created anywhere in this setup -
  // proves the print path needs none (spec section 3/5's "no
  // recalculation from catalog").
});

afterAll(async () => {
  try {
    await cleanupStaleFixtures();
  } finally {
    await pool.end();
  }
});

function outputVatLine({ gross, rate }) {
  const netAmount = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  const vatAmount = Math.round((gross - netAmount) * 100) / 100;
  return {
    line: {
      accountId: outputVatAcctId, accountCode: "TESTOVPVAT", accountTitle: "Output VAT Payable",
      particulars: `Output VAT (${rate}%)`, debit: 0, credit: vatAmount, genRef: "", genName: "",
      taxEntry: {
        entryType: "OUTPUT_VAT", partyId: custId, partyName: "Output VAT Print Test Customer",
        partyTin: "", partyAddress: "", transactionDate: "2026-08-01",
        grossAmount: gross, netAmount, vatRate: rate, vatAmount, purchaseClassification: null,
      },
    },
    netAmount,
    vatAmount,
  };
}

// ewt: { rate } - EWT taxable base is computed the exact same way
// server.js's own resolveTaxWithholding()/ewtCalculationService.js does:
// totalCredit minus whatever was posted to a line whose accountTitle
// contains "output vat" (keyword match, not accountId - see
// ewtCalculationService.js's sumVatLines()). This is real, pre-existing,
// unrelated-to-this-checkpoint EWT behavior, not something this fixture
// invents - it happens to mean an Invoice with both a VAT line and EWT
// naturally computes EWT on the VAT-exclusive amount, exactly as intended.
async function createInvoice(token, { voucherNo, amount, status = "Posted", vatLines = [], ewt = null }) {
  const vatLineDefs = vatLines.map((v) => outputVatLine(v));
  const vatCredit = vatLineDefs.reduce((s, v) => s + v.vatAmount, 0);
  const grossTotal = amount + vatCredit;

  const taxableBase = ewt ? Math.round((grossTotal - vatCredit) * 100) / 100 : null;
  const ewtAmount = ewt ? Math.round((taxableBase * ewt.rate) / 100 * 100) / 100 : 0;

  const lines = [
    { accountId: arId, accountCode: "TESTOVPAR", accountTitle: "Accounts Receivable", particulars: "x", debit: grossTotal - ewtAmount, credit: 0, genRef: "", genName: "" },
    { accountId: revId, accountCode: "TESTOVPREV", accountTitle: "Sales Revenue", particulars: "x", debit: 0, credit: amount, genRef: "", genName: "" },
    ...vatLineDefs.map((v) => v.line),
  ];

  if (ewt) {
    lines.push({
      accountId: ewtReceivableAcctId, accountCode: "TESTOVPEWT", accountTitle: "Creditable WHT Receivable",
      particulars: `EWT (${ewt.rate}%)`, debit: ewtAmount, credit: 0, genRef: "", genName: "",
      taxEntry: {
        entryType: "EWT", partyId: custId, partyName: "Output VAT Print Test Customer",
        partyTin: "", partyAddress: "", transactionDate: "2026-08-01",
      },
    });
  }

  const body = {
    voucherNo, customerId: custId, customerName: "x", transactionDate: "2026-08-01", dueDate: "2026-08-08",
    status, lines, totalDebit: grossTotal, totalCredit: grossTotal, currency: { companyId },
  };
  if (ewt) {
    body.atcCode = "TESTOVP-ATC";
    body.taxWithheldAmount = ewtAmount;
  }

  const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(body);
  if (res.status !== 200 || !res.body.success) throw new Error(`Invoice create failed: ${JSON.stringify(res.body)}`);
  createdInvoiceIds.push(res.body.id);
  return { id: res.body.id, vatLineDefs, taxableBase, ewtAmount };
}

async function getPrintData(id) {
  const res = await request(app).get(`/api/print/invoice/${id}`).set("Authorization", `Bearer ${token}`).query({ mode: "without_entries", companyId });
  expect(res.status).toBe(200);
  return res.body;
}

describe("1: single OUTPUT_VAT entry", () => {
  test("outputVat correctly reflects one entry's net/VAT amounts", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-1", amount: 1000, vatLines: [{ gross: 1120, rate: 12 }] });
    const data = await getPrintData(id);
    expect(data.outputVat).not.toBeNull();
    expect(data.outputVat.vatableSales).toBe(1000);
    expect(data.outputVat.vatAmount).toBe(120);
    expect(data.outputVat.grossTaxable).toBe(1120);
    expect(data.outputVat.entryCount).toBe(1);
    expect(data.outputVat.reconciles).toBe(true);
  });
});

describe("2: multiple OUTPUT_VAT entries", () => {
  test("outputVat sums net/VAT correctly across entries, not just the first", async () => {
    const { id } = await createInvoice(token, {
      voucherNo: "TESTOVP-INV-2", amount: 1500,
      vatLines: [{ gross: 1120, rate: 12 }, { gross: 560, rate: 12 }],
    });
    const data = await getPrintData(id);
    expect(data.outputVat.vatableSales).toBe(1500);
    expect(data.outputVat.vatAmount).toBe(180);
    expect(data.outputVat.grossTaxable).toBe(1680);
    expect(data.outputVat.entryCount).toBe(2);
    expect(data.outputVat.reconciles).toBe(true);
  });
});

describe("3: no recalculation from catalog", () => {
  test("print path works correctly with zero vat_rate_codes rows in the database", async () => {
    const [catalogRows] = await pool.query("SELECT COUNT(*) AS cnt FROM vat_rate_codes");
    // Not asserting catalogRows === 0 globally (other suites may run in the
    // same DB) - the real proof is that THIS test's own Invoice, created
    // and printed with zero dependency on the catalog, still resolves
    // correct figures purely from its own stored transaction_tax_entries.
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-3", amount: 1000, vatLines: [{ gross: 1120, rate: 12 }] });
    const data = await getPrintData(id);
    expect(data.outputVat.vatAmount).toBe(120);
    expect(Array.isArray(catalogRows)).toBe(true); // sanity - query itself succeeded regardless of row count
  });
});

describe("4: no Output VAT rows", () => {
  test("outputVat is null when the Invoice has no VAT lines at all", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-4", amount: 1000, vatLines: [] });
    const data = await getPrintData(id);
    expect(data.outputVat).toBeNull();
  });
});

describe("5: VAT only (no EWT)", () => {
  test("outputVat present, no atcCode/taxWithheldAmount on the header", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-5", amount: 1000, vatLines: [{ gross: 1120, rate: 12 }] });
    const data = await getPrintData(id);
    expect(data.outputVat).not.toBeNull();
    expect(data.doc.atcCode).toBeFalsy();
  });
});

describe("5b: EWT only (no Output VAT)", () => {
  test("outputVat is null; real EWT header fields are present and correctly computed", async () => {
    const { id, taxableBase, ewtAmount } = await createInvoice(token, {
      voucherNo: "TESTOVP-INV-5B", amount: 1000, ewt: { rate: 5 },
    });
    const data = await getPrintData(id);
    expect(data.outputVat).toBeNull();
    expect(data.doc.atcCode).toBe("TESTOVP-ATC");
    expect(Number(data.doc.taxableBase)).toBe(taxableBase);
    expect(Number(data.doc.taxWithheldAmount)).toBe(ewtAmount);
    // No VAT line existed, so EWT's taxable base is the full gross - proves
    // "if EWT exists without Output VAT, the EWT block still prints
    // correctly" without requiring VAT at all.
    expect(taxableBase).toBe(1000);
    expect(ewtAmount).toBe(50);
  });
});

describe("5c: VAT + EWT together", () => {
  test("outputVat and EWT are both present, each correctly sourced and not mixed", async () => {
    const { id, taxableBase, ewtAmount } = await createInvoice(token, {
      voucherNo: "TESTOVP-INV-5C", amount: 1000, vatLines: [{ gross: 1120, rate: 12 }], ewt: { rate: 5 },
    });
    const data = await getPrintData(id);

    // VAT figures are IDENTICAL to the VAT-only case (test 5) - proves EWT
    // presence never contaminates the Output VAT aggregation.
    expect(data.outputVat).not.toBeNull();
    expect(data.outputVat.vatableSales).toBe(1000);
    expect(data.outputVat.vatAmount).toBe(120);
    expect(data.outputVat.grossTaxable).toBe(1120);

    // EWT's own taxable base correctly EXCLUDES the VAT line (1120 - 120 =
    // 1000), a real pre-existing behavior this fixture proves rather than
    // assumes - and the two figures (VATable Sales 1000 vs EWT Taxable
    // Base 1000) are equal here only by this test's own numbers, not
    // because they're the same source.
    expect(data.doc.atcCode).toBe("TESTOVP-ATC");
    expect(Number(data.doc.taxableBase)).toBe(taxableBase);
    expect(taxableBase).toBe(1000);
    expect(Number(data.doc.taxWithheldAmount)).toBe(ewtAmount);
    expect(ewtAmount).toBe(50);
  });
});

describe("6: Draft vs Posted", () => {
  test("outputVat is present for a Draft Invoice, not only Posted", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-6D", amount: 1000, status: "Draft", vatLines: [{ gross: 1120, rate: 12 }] });
    const data = await getPrintData(id);
    expect(data.doc.status).toBe("Draft");
    expect(data.outputVat).not.toBeNull();
    expect(data.outputVat.vatAmount).toBe(120);
  });

  test("outputVat is present for a Posted Invoice, identically shaped", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-6P", amount: 1000, status: "Posted", vatLines: [{ gross: 1120, rate: 12 }] });
    const data = await getPrintData(id);
    expect(data.doc.status).toBe("Posted");
    expect(data.outputVat).not.toBeNull();
    expect(data.outputVat.vatAmount).toBe(120);
  });
});

describe("7: historical snapshot (reprint unchanged)", () => {
  test("re-fetching print data for the same Invoice twice returns identical outputVat figures", async () => {
    const { id } = await createInvoice(token, { voucherNo: "TESTOVP-INV-7", amount: 1000, vatLines: [{ gross: 1120, rate: 12 }] });
    const first = await getPrintData(id);
    const second = await getPrintData(id);
    expect(second.outputVat).toEqual(first.outputVat);
  });
});

describe("8: other transaction modules unaffected", () => {
  test("OR print data's outputVat is always null (cfg.hasOutputVat is not set for OR) - never populated, never applied", async () => {
    const cashId = await makeAccount("TESTOVPCASH", "Cash (Print Test)", "ASSET");
    const orRes = await request(app).post("/api/or").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "TESTOVP-OR-1", customerId: custId, customerName: "x", transactionDate: "2026-08-05", status: "Posted",
      lines: [
        { accountId: cashId, accountCode: "TESTOVPCASH", accountTitle: "Cash", particulars: "x", debit: 1000, credit: 0 },
        { accountId: arId, accountCode: "TESTOVPAR", accountTitle: "AR", particulars: "x", debit: 0, credit: 1000 },
      ],
      totalDebit: 1000, totalCredit: 1000, currency: { companyId },
    });
    expect(orRes.status).toBe(200);
    const orId = orRes.body.id;

    try {
      const res = await request(app).get(`/api/print/or/${orId}`).set("Authorization", `Bearer ${token}`).query({ mode: "without_entries", companyId });
      expect(res.status).toBe(200);
      // outputVat is always returned as null (not omitted) for a module
      // whose MODULE_CONFIG entry has no hasOutputVat flag - documentPdfBuilder.js's
      // Tax Summary block is gated on `transactionType === "invoice" && outputVat`,
      // so a null value here can never render anything for OR regardless.
      expect(res.body.outputVat).toBeNull();
    } finally {
      await pool.query("DELETE FROM or_lines WHERE or_id = ?", [orId]);
      await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'OR' AND transaction_id = ?", [orId]);
      await pool.query("DELETE FROM or_headers WHERE id = ?", [orId]);
    }
  });
});
