const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7C.1: closes the gap Phase 7C's own completion report flagged -
// "the legacy EWT header columns and the new journal line are kept in
// sync by the frontend, not enforced as a DB invariant." Every test here
// proves the BACKEND (server.js's reconcileEwtTaxEntry() /
// taxEntryService.js), not the browser, is what actually guarantees
// header <-> transaction_tax_entries <-> journal-line agreement.

jest.setTimeout(180000);

let companyA, companyB, userId, token;
let arId, revId, expId, apId, outputVatId, inputVatId, ewtReceivableId, ewtPayableId;
let custId, suppId;
let usdId;

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}
async function makeParty(companyId, code, partyType, name, tin, address1) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin, address1) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)",
    [companyId, code, partyType, name, tin, address1]
  );
  return result.insertId;
}
async function countTaxEntries(transactionType, transactionId) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) c FROM transaction_tax_entries WHERE transaction_type = ? AND transaction_id = ?",
    [transactionType, transactionId]
  );
  return row.c;
}
async function countInvoiceRows(companyId) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) c FROM invoice_headers WHERE company_id = ?",
    [companyId]
  );
  return row.c;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  companyA = await makeCompany("PH7C1 Company A");
  companyB = await makeCompany("PH7C1 Company B");

  const hash = await bcrypt.hash("Ph7c1Pass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7c1_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyA]);

  const loginRes = await request(app).post("/api/login").send({ username: "ph7c1_admin", password: "Ph7c1Pass!1" });
  token = loginRes.body.token;

  const adminUser = { id: userId, roleCode: "ADMIN" };
  const php = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyA,
  });
  const usd = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyA,
  });
  usdId = usd.id;
  await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58, effectiveDate: "2026-08-01", reason: "PH7C1 fixture" });

  arId = await makeAccount("PH7C1AR", "Accounts Receivable", "ASSET");
  revId = await makeAccount("PH7C1REV", "Sales Revenue", "INCOME");
  expId = await makeAccount("PH7C1EXP", "Purchases Expense", "EXPENSE");
  apId = await makeAccount("PH7C1AP", "Accounts Payable", "LIABILITY");
  outputVatId = await makeAccount("PH7C1OVAT", "Output VAT Payable", "LIABILITY");
  inputVatId = await makeAccount("PH7C1IVAT", "Input VAT Receivable", "ASSET");
  ewtReceivableId = await makeAccount("PH7C1EWTR", "Creditable Withholding Tax Receivable", "ASSET");
  ewtPayableId = await makeAccount("PH7C1EWTP", "Withholding Tax Payable", "LIABILITY");

  custId = await makeParty(companyA, "PH7C1-CUST", "CUSTOMER", "PH7C1 Customer", "111-222-333-000", "Customer Address, Manila");
  suppId = await makeParty(companyA, "PH7C1-SUPP", "SUPPLIER", "PH7C1 Supplier", "444-555-666-000", "Supplier Address, Cebu");

  await pool.execute(
    "INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES ('PH7C1-WC010', 'Professional fees - PH7C1 fixture', 10, 'EWT', 'ACTIVE')"
  );
});

afterAll(async () => {
  for (const companyId of [companyA, companyB]) {
    await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [companyId]);
    await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [companyId]);
    await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [companyId]);
    await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
  }
  await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [companyA]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyA]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7C1%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = 'PH7C1-WC010'");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyA, companyB]);
  await pool.end();
});

function invoiceWithEwt({ voucherNo, ewtDebit, includeLine = true, atcCode = "PH7C1-WC010" }) {
  // Gross 22400, Output VAT(12%) 2400 -> taxable base 20000, authoritative
  // EWT at PH7C1-WC010's 10% = 2000.
  const lines = [
    { accountId: arId, accountCode: "PH7C1AR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "PH7C1-CUST", genName: "PH7C1 Customer", debit: 22400 - (includeLine ? ewtDebit : 0), credit: 0 },
    { accountId: revId, accountCode: "PH7C1REV", accountTitle: "Sales Revenue", particulars: "Revenue", genRef: "", genName: "", debit: 0, credit: 20000 },
    { accountId: outputVatId, accountCode: "PH7C1OVAT", accountTitle: "Output VAT Payable", particulars: "Output VAT (12%)", genRef: "", genName: "PH7C1 Customer", debit: 0, credit: 2400 },
  ];
  if (includeLine) {
    lines.push({
      accountId: ewtReceivableId, accountCode: "PH7C1EWTR", accountTitle: "Creditable Withholding Tax Receivable",
      particulars: `EWT - ${atcCode}`, genRef: "", genName: "PH7C1 Customer", debit: ewtDebit, credit: 0,
      taxEntry: {
        entryType: "EWT", accountId: ewtReceivableId,
        partyId: custId, partyName: "PH7C1 Customer", partyTin: "111-222-333-000", partyAddress: "Customer Address, Manila",
        transactionDate: "2026-08-12", atcCode, taxType: "EWT", taxableBase: 20000, withheldAmount: ewtDebit,
      },
    });
  }
  return {
    voucherNo, customerId: custId, customerName: "PH7C1 Customer",
    transactionDate: "2026-08-12", referenceNo: voucherNo, description: "Sale", status: "Draft",
    atcCode, taxWithheldAmount: ewtDebit,
    lines,
    totalDebit: 22400 - (includeLine ? ewtDebit : 0) + (includeLine ? ewtDebit : 0),
    totalCredit: 22400,
  };
}

describe("Phase 7C.1 - EWT mismatched client amount (spec section 4/7)", () => {
  test("client's EWT line amount (1500) disagrees with the authoritative calculation (2000) - save is rejected, nothing persisted", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-MISMATCH", ewtDebit: 2000 });
    payload.lines[3].debit = 1500; // tamper the line only - taxEntry.withheldAmount still says 2000, mimicking a stale/tampered client
    payload.lines[0].debit = 22400 - 1500; // keep the tampered payload internally balanced so it fails on OUR check, not a generic balance error
    payload.totalDebit = 22400;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not match the authoritative withholding/i);

    const [[row]] = await pool.query("SELECT COUNT(*) c FROM invoice_headers WHERE voucher_no = 'PH7C1-INV-MISMATCH'");
    expect(row.c).toBe(0); // nothing persisted - full rollback
  });
});

describe("Phase 7C.1 - missing EWT journal line (spec section 8)", () => {
  test("header EWT metadata (ATC/rate/base/amount) submitted with NO corresponding journal line is rejected", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-NOLINE", ewtDebit: 2000, includeLine: false });
    // Rebalance without the EWT line: AR(22400) = Revenue(20000)+VAT(2400).
    payload.lines[0].debit = 22400;
    payload.totalDebit = 22400;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/without its corresponding journal line/i);

    const [[row]] = await pool.query("SELECT COUNT(*) c FROM invoice_headers WHERE voucher_no = 'PH7C1-INV-NOLINE'");
    expect(row.c).toBe(0);
  });
});

describe("Phase 7C.1 - orphan EWT line (spec section 9)", () => {
  test("an EWT-tagged line with no valid ATC code is rejected, never persisted as an unexplained accounting line", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-ORPHAN", ewtDebit: 2000, atcCode: "NOT-A-REAL-ATC-CODE" });

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/without a valid ATC code/i);

    const [[row]] = await pool.query("SELECT COUNT(*) c FROM invoice_headers WHERE voucher_no = 'PH7C1-INV-ORPHAN'");
    expect(row.c).toBe(0);
  });
});

describe("Phase 7C.1 - EWT direction (spec section 4/5)", () => {
  test("an Invoice EWT line submitted on the CREDIT side (wrong for inbound/debit) is rejected", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-WRONGSIDE", ewtDebit: 2000 });
    const ewtLine = payload.lines[3];
    ewtLine.credit = ewtLine.debit;
    ewtLine.debit = 0;
    // Rebalance purely to isolate the direction check from a generic
    // balance failure (not a realistic transaction): AR(22400 debit) =
    // Revenue(18000) + VAT(2400) + EWT(2000, wrong side) credit = 22400.
    payload.lines[0].debit = 22400;
    payload.lines[1].credit = 18000;
    payload.totalDebit = 22400;
    payload.totalCredit = 22400;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/wrong side/i);
  });

  test("documented direction: Invoice (inbound) = debit, APV (outbound) = credit - confirmed via a successful save of each", async () => {
    const invPayload = invoiceWithEwt({ voucherNo: "PH7C1-INV-DIRECTION-OK", ewtDebit: 2000 });
    const invRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(invPayload);
    expect(invRes.status).toBe(200);

    const apvGross = 11200, apvNet = 10000, apvVat = 1200, apvBase = apvNet, apvEwt = Math.round(apvBase * 0.1 * 100) / 100; // 1000
    const apvRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C1-APV-DIRECTION-OK", supplierId: suppId, supplierName: "PH7C1 Supplier",
      transactionDate: "2026-08-12", referenceNo: "PH7C1-APV-DIRECTION-OK", description: "Purchase", status: "Draft",
      atcCode: "PH7C1-WC010", taxWithheldAmount: apvEwt,
      lines: [
        { accountId: expId, accountCode: "PH7C1EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: apvNet, credit: 0 },
        { accountId: inputVatId, accountCode: "PH7C1IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)", genRef: "", genName: "PH7C1 Supplier", debit: apvVat, credit: 0,
          taxEntry: { entryType: "INPUT_VAT", accountId: inputVatId, partyId: suppId, partyName: "PH7C1 Supplier", partyTin: "444-555-666-000", partyAddress: "Supplier Address, Cebu", transactionDate: "2026-08-12", grossAmount: apvGross, netAmount: apvNet, vatRate: 12, vatAmount: apvVat, purchaseClassification: "Services" } },
        { accountId: ewtPayableId, accountCode: "PH7C1EWTP", accountTitle: "Withholding Tax Payable", particulars: "EWT - PH7C1-WC010", genRef: "", genName: "PH7C1 Supplier", debit: 0, credit: apvEwt,
          taxEntry: { entryType: "EWT", accountId: ewtPayableId, partyId: suppId, partyName: "PH7C1 Supplier", partyTin: "444-555-666-000", partyAddress: "Supplier Address, Cebu", transactionDate: "2026-08-12", atcCode: "PH7C1-WC010", taxType: "EWT", taxableBase: apvBase, withheldAmount: apvEwt } },
        { accountId: apId, accountCode: "PH7C1AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: apvGross - apvEwt },
      ],
      totalDebit: apvNet + apvVat, totalCredit: (apvGross - apvEwt) + apvEwt,
    });
    expect(apvRes.status).toBe(200);
  });
});

describe("Phase 7C.1 - header <-> structured entry <-> journal line agreement (spec section 6)", () => {
  test("after commit, header EWT columns and the transaction_tax_entries row always agree (sourced from the same authoritative object)", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-CONSISTENCY", ewtDebit: 2000 });
    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(200);
    const invoiceId = res.body.id;

    const [[header]] = await pool.query(
      "SELECT atc_code, tax_type, tax_rate FROM invoice_headers WHERE id = ?", [invoiceId]
    );
    const [[entry]] = await pool.query(
      "SELECT atc_code, tax_type, taxable_base, withheld_amount FROM transaction_tax_entries WHERE transaction_type='INV' AND transaction_id=? AND entry_type='EWT'",
      [invoiceId]
    );
    expect(header.atc_code).toBe("PH7C1-WC010");
    expect(entry.atc_code).toBe(header.atc_code);
    expect(header.tax_type).toBe(entry.tax_type);
    expect(Number(header.tax_rate)).toBe(10);
    expect(Number(entry.taxable_base)).toBeCloseTo(20000, 2);
    expect(Number(entry.withheld_amount)).toBeCloseTo(2000, 2);
  });
});

describe("Phase 7C.1 - legacy compatibility (spec section 17)", () => {
  test("a legacy-style Draft (atc_code set directly in the DB, no journal line, no tax entry) still saves cleanly when EWT is left untouched", async () => {
    // Simulates a pre-Phase-7C record: direct SQL insert, matching how
    // EWT worked before Phase 7C ever existed (header-only, no line).
    const [headerResult] = await pool.execute(
      `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, reference_no, description, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, atc_code, tax_type, tax_rate, tax_withheld_amount, taxable_base)
       VALUES (?, 'PH7C1-INV-LEGACY', ?, 'PH7C1 Customer', '2026-08-01', 'REF-LEGACY', 'Legacy sale', 20000, 20000, 0, 20000, 'Unpaid', 'Draft', 'PH7C1-WC010', 'EWT', 10, 2000, 20000)`,
      [companyA, custId]
    );
    const invoiceId = headerResult.insertId;
    await pool.execute(
      `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, 'PH7C1AR', 'Accounts Receivable', 'AR', 20000, 0), (?, ?, 'PH7C1REV', 'Sales Revenue', 'Revenue', 0, 20000)`,
      [invoiceId, arId, invoiceId, revId]
    );

    // Reopen and re-save WITHOUT touching EWT (no taxEntry-tagged line,
    // atcCode unchanged) - the exact "innocuous re-save" section 17
    // protects. Must succeed, not be rejected for lacking a line.
    const resaveRes = await request(app).put(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C1-INV-LEGACY", customerId: custId, customerName: "PH7C1 Customer",
      transactionDate: "2026-08-01", referenceNo: "REF-LEGACY", description: "Legacy sale (resaved)", status: "Draft",
      atcCode: "PH7C1-WC010", taxWithheldAmount: 2000,
      lines: [
        { accountId: arId, accountCode: "PH7C1AR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "", genName: "", debit: 20000, credit: 0 },
        { accountId: revId, accountCode: "PH7C1REV", accountTitle: "Sales Revenue", particulars: "Revenue", genRef: "", genName: "", debit: 0, credit: 20000 },
      ],
      totalDebit: 20000, totalCredit: 20000,
    });
    expect(resaveRes.status).toBe(200);
    expect(await countTaxEntries("INV", invoiceId)).toBe(0); // still no structured metadata - never fabricated
  });
});

describe("Phase 7C.1 - company/transaction/line ownership (spec section 13/14)", () => {
  test("a taxEntry payload cannot attach itself to another company - structural fields are always backend-derived, never trusted from the client", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-CROSSCO", ewtDebit: 2000 });
    // Attempt to smuggle a foreign company/transaction/line id into the taxEntry.
    payload.lines[3].taxEntry.companyId = companyB;
    payload.lines[3].taxEntry.transactionId = 999999;
    payload.lines[3].taxEntry.lineId = 999999;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(200);
    const invoiceId = res.body.id;

    const [[entry]] = await pool.query(
      "SELECT company_id, transaction_id, line_id FROM transaction_tax_entries WHERE transaction_type='INV' AND transaction_id=? AND entry_type='EWT'",
      [invoiceId]
    );
    expect(entry.company_id).toBe(companyA); // never companyB
    expect(entry.transaction_id).toBe(invoiceId); // never 999999
    const [[realLine]] = await pool.query("SELECT id FROM invoice_lines WHERE invoice_id = ? AND account_id = ?", [invoiceId, ewtReceivableId]);
    expect(entry.line_id).toBe(realLine.id); // the REAL line just inserted, never 999999

    // And it must never appear under Company B.
    expect(await countTaxEntries("INV", 999999)).toBe(0);
  });
});

describe("Phase 7C.1 - atomic rollback (spec section 15)", () => {
  test("an EWT reconciliation failure rolls back the ENTIRE save - no header, no lines, no currency snapshot, no tax entries", async () => {
    const before = await countInvoiceRows(companyA);
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-ROLLBACK", ewtDebit: 2000, includeLine: false });
    payload.lines[0].debit = 22400; // rebalance without the (missing) EWT line
    payload.totalDebit = 22400;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(res.status).toBe(400);

    expect(await countInvoiceRows(companyA)).toBe(before); // no header row leaked through
    const [[snap]] = await pool.query(
      "SELECT COUNT(*) c FROM transaction_currency_snapshots WHERE company_id = ? AND transaction_type = 'INV' AND transaction_id NOT IN (SELECT id FROM invoice_headers)",
      [companyA]
    );
    expect(snap.c).toBe(0); // no orphaned snapshot row either
  });
});

describe("Phase 7C.1 - Posted immutability still protects EWT (spec section 21)", () => {
  test("posting a tax-bearing Invoice, then attempting to change its EWT via PUT, is rejected by the existing Phase 7A.1 guard - no side channel", async () => {
    const payload = invoiceWithEwt({ voucherNo: "PH7C1-INV-POSTED", ewtDebit: 2000 });
    const createRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send(payload);
    expect(createRes.status).toBe(200);
    const invoiceId = createRes.body.id;

    const postPayload = invoiceWithEwt({ voucherNo: "PH7C1-INV-POSTED", ewtDebit: 2000 });
    postPayload.status = "Posted";
    const postRes = await request(app).put(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).send(postPayload);
    expect(postRes.status).toBe(200);

    const tamperPayload = invoiceWithEwt({ voucherNo: "PH7C1-INV-POSTED", ewtDebit: 5000 }); // different EWT amount
    tamperPayload.status = "Draft";
    const tamperRes = await request(app).put(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).send(tamperPayload);
    expect(tamperRes.status).toBe(409);
    expect(tamperRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    const [[entry]] = await pool.query(
      "SELECT withheld_amount FROM transaction_tax_entries WHERE transaction_type='INV' AND transaction_id=? AND entry_type='EWT'",
      [invoiceId]
    );
    expect(Number(entry.withheld_amount)).toBeCloseTo(2000, 2); // untouched
  });
});

describe("Phase 7C.1 - multi-currency EWT consistency (spec section 19)", () => {
  test("a foreign-currency APV's EWT journal line participates in the normal currency conversion, tax entry stores transaction-currency figures", async () => {
    const apvGross = 112, apvNet = 100, apvVat = 12, apvBase = apvNet, apvEwt = 10; // USD, base@10%

    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C1-APV-FX", supplierId: suppId, supplierName: "PH7C1 Supplier",
      transactionDate: "2026-08-12", referenceNo: "PH7C1-APV-FX", description: "Foreign purchase", status: "Draft",
      atcCode: "PH7C1-WC010", taxWithheldAmount: apvEwt,
      lines: [
        { accountId: expId, accountCode: "PH7C1EXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: apvNet, credit: 0 },
        { accountId: inputVatId, accountCode: "PH7C1IVAT", accountTitle: "Input VAT Receivable", particulars: "Input VAT (12%)", genRef: "", genName: "PH7C1 Supplier", debit: apvVat, credit: 0,
          taxEntry: { entryType: "INPUT_VAT", accountId: inputVatId, partyId: suppId, partyName: "PH7C1 Supplier", partyTin: "444-555-666-000", partyAddress: "Supplier Address, Cebu", transactionDate: "2026-08-12", grossAmount: apvGross, netAmount: apvNet, vatRate: 12, vatAmount: apvVat, purchaseClassification: "Services" } },
        { accountId: ewtPayableId, accountCode: "PH7C1EWTP", accountTitle: "Withholding Tax Payable", particulars: "EWT - PH7C1-WC010", genRef: "", genName: "PH7C1 Supplier", debit: 0, credit: apvEwt,
          taxEntry: { entryType: "EWT", accountId: ewtPayableId, partyId: suppId, partyName: "PH7C1 Supplier", partyTin: "444-555-666-000", partyAddress: "Supplier Address, Cebu", transactionDate: "2026-08-12", atcCode: "PH7C1-WC010", taxType: "EWT", taxableBase: apvBase, withheldAmount: apvEwt } },
        { accountId: apId, accountCode: "PH7C1AP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: apvGross - apvEwt },
      ],
      totalDebit: apvNet + apvVat, totalCredit: (apvGross - apvEwt) + apvEwt,
      currency: { currencyId: usdId, exchangeRate: 58, rateDate: "2026-08-01" },
    });
    expect(res.status).toBe(200);
    const apvId = res.body.id;

    const [[entry]] = await pool.query(
      "SELECT withheld_amount, taxable_base FROM transaction_tax_entries WHERE transaction_type='APV' AND transaction_id=? AND entry_type='EWT'",
      [apvId]
    );
    expect(Number(entry.withheld_amount)).toBeCloseTo(apvEwt, 2); // transaction-currency (USD), not base-converted

    const [[lineRow]] = await pool.query("SELECT foreign_credit, credit FROM apv_lines WHERE apv_id = ? AND account_id = ?", [apvId, ewtPayableId]);
    expect(Number(lineRow.foreign_credit)).toBeCloseTo(apvEwt, 2);
    expect(Number(lineRow.credit)).toBeCloseTo(Math.round(apvEwt * 58 * 100) / 100, 1); // base = foreign x rate, single conversion
  });
});
