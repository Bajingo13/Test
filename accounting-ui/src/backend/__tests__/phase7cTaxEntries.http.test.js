const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const CurrencyService = require("../services/currencyService");

// Phase 7C spec sections 42-46: tax schedule metadata persistence,
// snapshot immutability against a later-changed party master, edit/delete
// round-trips, Phase 7A.1 Posted immutability applied to tax-generated
// lines/metadata, and multi-currency consistency.

jest.setTimeout(180000);

let companyId, userId, token;
let arId, revId, expId, apId, outputVatId, inputVatId, ewtPayableId;
let custId, suppId;
let phpId, usdId;

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
async function makeParty(code, partyType, name, tin, address1) {
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

beforeAll(async () => {
  assertNotProductionDatabase();

  companyId = await makeCompany("PH7C Company");

  const hash = await bcrypt.hash("Ph7cPass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph7c_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);

  const loginRes = await request(app).post("/api/login").send({ username: "ph7c_admin", password: "Ph7cPass!1" });
  token = loginRes.body.token;

  const adminUser = { id: userId, roleCode: "ADMIN" };
  const php = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId,
  });
  phpId = php.id;
  const usd = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
  });
  usdId = usd.id;
  await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58, effectiveDate: "2026-08-01", reason: "PH7C fixture" });

  arId = await makeAccount("PH7CAR", "Accounts Receivable", "ASSET");
  revId = await makeAccount("PH7CREV", "Sales Revenue", "INCOME");
  expId = await makeAccount("PH7CEXP", "Purchases Expense", "EXPENSE");
  apId = await makeAccount("PH7CAP", "Accounts Payable", "LIABILITY");
  outputVatId = await makeAccount("PH7COVAT", "Output VAT Payable", "LIABILITY");
  inputVatId = await makeAccount("PH7CIVAT", "Input VAT Receivable", "ASSET");
  ewtPayableId = await makeAccount("PH7CEWT", "Withholding Tax Payable", "LIABILITY");

  custId = await makeParty("PH7C-CUST", "CUSTOMER", "PH7C Customer Original", "111-222-333-000", "Original Address, Manila");
  suppId = await makeParty("PH7C-SUPP", "SUPPLIER", "PH7C Supplier Original", "444-555-666-000", "Original Supplier Address, Cebu");

  // Phase 7C.1: needed by the reload/resave regression test below, now
  // that EWT lines are backend-validated against a real ewt_library entry.
  await pool.execute(
    "INSERT INTO ewt_library (atc_code, description, rate, tax_type, status) VALUES ('PH7C-WC010', 'Professional fees - PH7C fixture', 10, 'EWT', 'ACTIVE')"
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_tax_entries WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoice_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM invoice_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM apv_lines WHERE apv_id IN (SELECT id FROM apv_headers WHERE company_id = ?)", [companyId]);
  await pool.query("DELETE FROM apv_headers WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM general_libraries WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PH7C%'");
  await pool.query("DELETE FROM ewt_library WHERE atc_code = 'PH7C-WC010'");
  await pool.query("DELETE FROM user_companies WHERE company_id = ?", [companyId]);
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

function apvInputVatLine({ gross = 11200, rate = 12 } = {}) {
  const net = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  const vat = Math.round((gross - net) * 100) / 100;
  return {
    line: {
      accountId: inputVatId, accountCode: "PH7CIVAT", accountTitle: "Input VAT Receivable",
      particulars: `Input VAT (${rate}%)`, genRef: "", genName: "PH7C Supplier Original",
      debit: vat, credit: 0,
      taxEntry: {
        entryType: "INPUT_VAT", accountId: inputVatId,
        partyId: suppId, partyName: "PH7C Supplier Original", partyTin: "444-555-666-000", partyAddress: "Original Supplier Address, Cebu",
        transactionDate: "2026-08-10", grossAmount: gross, netAmount: net, vatRate: rate, vatAmount: vat,
        purchaseClassification: "Services",
      },
    },
    net, vat,
  };
}

describe("Phase 7C - Input VAT (APV) tax entry persistence", () => {
  test("saving an APV with an Input VAT entry creates the journal line and the schedule metadata (supplier snapshot)", async () => {
    const { line: vatLine, net, vat } = apvInputVatLine();

    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-1", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-1", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: net, credit: 0 },
        vatLine,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "PH7C-SUPP", genName: "PH7C Supplier Original", debit: 0, credit: net + vat },
      ],
      totalDebit: net + vat, totalCredit: net + vat,
    });

    expect(res.status).toBe(200);
    const apvId = res.body.id;

    const [[headerRow]] = await pool.query("SELECT total_debit, total_credit FROM apv_headers WHERE id = ?", [apvId]);
    expect(Number(headerRow.total_debit)).toBe(Number(headerRow.total_credit));

    expect(await countTaxEntries("APV", apvId)).toBe(1);

    const [entries] = await pool.query(
      "SELECT * FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?",
      [apvId]
    );
    expect(entries[0].entry_type).toBe("INPUT_VAT");
    expect(entries[0].party_name_snapshot).toBe("PH7C Supplier Original");
    expect(entries[0].party_tin_snapshot).toBe("444-555-666-000");
    expect(Number(entries[0].net_amount)).toBeCloseTo(net, 2);
    expect(Number(entries[0].vat_amount)).toBeCloseTo(vat, 2);
    expect(entries[0].line_id).toBeTruthy();

    // The line_id must point at a REAL apv_lines row for this transaction.
    const [[lineRow]] = await pool.query("SELECT apv_id, account_id FROM apv_lines WHERE id = ?", [entries[0].line_id]);
    expect(lineRow.apv_id).toBe(apvId);
    expect(lineRow.account_id).toBe(inputVatId);
  });

  test("GET returns taxEntries correlated to the reloaded lines' real ids", async () => {
    const { line: vatLine, net, vat } = apvInputVatLine({ gross: 5600 });
    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-2", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-2", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: net, credit: 0 },
        vatLine,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "PH7C-SUPP", genName: "PH7C Supplier Original", debit: 0, credit: net + vat },
      ],
      totalDebit: net + vat, totalCredit: net + vat,
    });
    const apvId = createRes.body.id;

    const getRes = await request(app).get(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.taxEntries).toHaveLength(1);
    const taxLineId = getRes.body.taxEntries[0].lineId;
    const matchingLine = getRes.body.lines.find((l) => l.id === taxLineId);
    expect(matchingLine).toBeTruthy();
    expect(matchingLine.accountId).toBe(inputVatId);
  });

  test("VAT line amount must match the centralized calculation - a mismatched save is rejected", async () => {
    const { line: vatLine, net } = apvInputVatLine();
    vatLine.debit = 999; // tampered - doesn't match Gross/Rate's true VAT

    const res = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-BAD", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-BAD", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: net, credit: 0 },
        vatLine,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: net + 999 },
      ],
      totalDebit: net + 999, totalCredit: net + 999,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not match/i);
  });
});

describe("Phase 7C - snapshot rule (spec section 12/42)", () => {
  test("supplier master changing later does not change the already-saved Input VAT schedule", async () => {
    const { line: vatLine, net, vat } = apvInputVatLine({ gross: 2240 });
    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-SNAP", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-SNAP", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: net, credit: 0 },
        vatLine,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: net + vat },
      ],
      totalDebit: net + vat, totalCredit: net + vat,
    });
    const apvId = createRes.body.id;

    // Supplier master changes AFTER the schedule was saved.
    await pool.execute(
      "UPDATE general_libraries SET name = 'PH7C Supplier RENAMED', tin = '999-999-999-999', address1 = 'New Address' WHERE id = ?",
      [suppId]
    );

    const [entries] = await pool.query(
      "SELECT party_name_snapshot, party_tin_snapshot, party_address_snapshot FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?",
      [apvId]
    );
    expect(entries[0].party_name_snapshot).toBe("PH7C Supplier Original");
    expect(entries[0].party_tin_snapshot).toBe("444-555-666-000");
    expect(entries[0].party_address_snapshot).toBe("Original Supplier Address, Cebu");

    // Restore for subsequent tests.
    await pool.execute(
      "UPDATE general_libraries SET name = 'PH7C Supplier Original', tin = '444-555-666-000', address1 = 'Original Supplier Address, Cebu' WHERE id = ?",
      [suppId]
    );
  });
});

describe("Phase 7C - Output VAT (Invoice) tax entry persistence", () => {
  test("saving an Invoice with an Output VAT entry creates the journal line and customer snapshot", async () => {
    const gross = 22400, rate = 12;
    const net = Math.round((gross / 1.12) * 100) / 100;
    const vat = Math.round((gross - net) * 100) / 100;

    const res = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-INV-1", customerId: custId, customerName: "PH7C Customer Original",
      transactionDate: "2026-08-10", referenceNo: "REF-INV-1", description: "Sale", status: "Draft",
      lines: [
        { accountId: arId, accountCode: "PH7CAR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "PH7C-CUST", genName: "PH7C Customer Original", debit: gross, credit: 0 },
        { accountId: revId, accountCode: "PH7CREV", accountTitle: "Sales Revenue", particulars: "Revenue", genRef: "", genName: "", debit: 0, credit: net },
        {
          accountId: outputVatId, accountCode: "PH7COVAT", accountTitle: "Output VAT Payable",
          particulars: `Output VAT (${rate}%)`, genRef: "", genName: "PH7C Customer Original", debit: 0, credit: vat,
          taxEntry: {
            entryType: "OUTPUT_VAT", accountId: outputVatId,
            partyId: custId, partyName: "PH7C Customer Original", partyTin: "111-222-333-000", partyAddress: "Original Address, Manila",
            transactionDate: "2026-08-10", grossAmount: gross, netAmount: net, vatRate: rate, vatAmount: vat,
          },
        },
      ],
      totalDebit: gross, totalCredit: gross,
    });

    expect(res.status).toBe(200);
    const invoiceId = res.body.id;
    expect(await countTaxEntries("INV", invoiceId)).toBe(1);

    const [entries] = await pool.query("SELECT * FROM transaction_tax_entries WHERE transaction_type = 'INV' AND transaction_id = ?", [invoiceId]);
    expect(entries[0].entry_type).toBe("OUTPUT_VAT");
    expect(entries[0].party_name_snapshot).toBe("PH7C Customer Original");
    expect(entries[0].purchase_classification).toBeNull();
  });
});

describe("Phase 7C - Edit test (spec section 43)", () => {
  test("editing Gross Purchase and re-saving updates the line and schedule with no duplicate", async () => {
    const first = apvInputVatLine({ gross: 3360 });
    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-EDIT", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-EDIT", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: first.net, credit: 0 },
        first.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: first.net + first.vat },
      ],
      totalDebit: first.net + first.vat, totalCredit: first.net + first.vat,
    });
    const apvId = createRes.body.id;

    const second = apvInputVatLine({ gross: 6720 }); // changed Gross Purchase
    const updateRes = await request(app).put(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-EDIT", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-EDIT", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: second.net, credit: 0 },
        second.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: second.net + second.vat },
      ],
      totalDebit: second.net + second.vat, totalCredit: second.net + second.vat,
    });

    expect(updateRes.status).toBe(200);
    expect(await countTaxEntries("APV", apvId)).toBe(1); // no duplicate

    const [entries] = await pool.query("SELECT * FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?", [apvId]);
    expect(Number(entries[0].gross_amount)).toBeCloseTo(6720, 2);
    expect(Number(entries[0].vat_amount)).toBeCloseTo(second.vat, 2);

    const [[headerRow]] = await pool.query("SELECT total_debit, total_credit FROM apv_headers WHERE id = ?", [apvId]);
    expect(Number(headerRow.total_debit)).toBe(Number(headerRow.total_credit));
  });
});

describe("Phase 7C - reload-then-resave with multiple tax entries (regression)", () => {
  test("saving TWO tax entries, reloading, and resaving with an unchanged payload preserves BOTH (not just the newest)", async () => {
    // This exact sequence (save entry A, reload it, add entry B, save
    // both) is what a Playwright-driven reload cycle caught a real bug
    // in: a RELOADED tax entry echoes its own stale lineId back to the
    // server, which - before the fix - silently clobbered the freshly
    // inserted line's real id for THAT entry, breaking the correlation
    // and effectively dropping it on the next reload.
    const gross1 = 22400, rate = 12;
    const net1 = Math.round((gross1 / 1.12) * 100) / 100;
    const vat1 = Math.round((gross1 - net1) * 100) / 100;

    const outputVatLine = {
      accountId: outputVatId, accountCode: "PH7COVAT", accountTitle: "Output VAT Payable",
      particulars: `Output VAT (${rate}%)`, genRef: "", genName: "PH7C Customer Original", debit: 0, credit: vat1,
      taxEntry: {
        entryType: "OUTPUT_VAT", accountId: outputVatId,
        partyId: custId, partyName: "PH7C Customer Original", partyTin: "111-222-333-000", partyAddress: "Original Address, Manila",
        transactionDate: "2026-08-10", grossAmount: gross1, netAmount: net1, vatRate: rate, vatAmount: vat1,
      },
    };

    const createRes = await request(app).post("/api/invoices").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-INV-MULTI", customerId: custId, customerName: "PH7C Customer Original",
      transactionDate: "2026-08-10", referenceNo: "REF-MULTI", description: "Sale", status: "Draft",
      lines: [
        { accountId: arId, accountCode: "PH7CAR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "PH7C-CUST", genName: "PH7C Customer Original", debit: gross1, credit: 0 },
        { accountId: revId, accountCode: "PH7CREV", accountTitle: "Sales Revenue", particulars: "Revenue", genRef: "", genName: "", debit: 0, credit: net1 },
        outputVatLine,
      ],
      totalDebit: gross1, totalCredit: gross1,
    });
    expect(createRes.status).toBe(200);
    const invoiceId = createRes.body.id;
    expect(await countTaxEntries("INV", invoiceId)).toBe(1);

    // Reload (as the UI would before letting the user add a second entry).
    const getRes = await request(app).get(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`);
    expect(getRes.body.taxEntries).toHaveLength(1);
    const reloadedOutputVat = getRes.body.taxEntries[0]; // carries its OWN stale `lineId`, exactly like the client would echo back

    // Add a second, brand-new EWT entry alongside the reloaded VAT one.
    // Taxable base = totalDebit(22400) - VAT line(2400) = 20000; at the
    // fixture's PH7C-WC010 10% rate, the authoritative EWT is 2000
    // (Phase 7C.1 now independently recomputes this - see
    // reconcileEwtTaxEntry() - so it must match exactly, not an arbitrary
    // placeholder like the pre-7C.1 version of this test used).
    const ewtLine = {
      accountId: ewtPayableId, accountCode: "PH7CEWT", accountTitle: "Withholding Tax Payable",
      particulars: "EWT - PH7C-WC010", genRef: "", genName: "PH7C Customer Original", debit: 2000, credit: 0,
      taxEntry: {
        entryType: "EWT", accountId: ewtPayableId,
        partyId: custId, partyName: "PH7C Customer Original", partyTin: "111-222-333-000", partyAddress: "Original Address, Manila",
        transactionDate: "2026-08-10", atcCode: "PH7C-WC010", taxType: "EWT", taxableBase: 20000, withheldAmount: 2000,
      },
    };

    const reloadedVatLine = {
      accountId: outputVatId, accountCode: "PH7COVAT", accountTitle: "Output VAT Payable",
      particulars: `Output VAT (${rate}%)`, genRef: "", genName: "PH7C Customer Original", debit: 0, credit: vat1,
      taxEntry: { entryType: "OUTPUT_VAT", ...reloadedOutputVat }, // exactly what the frontend re-sends: the reloaded object, stale lineId included
    };

    const updateRes = await request(app).put(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-INV-MULTI", customerId: custId, customerName: "PH7C Customer Original",
      transactionDate: "2026-08-10", referenceNo: "REF-MULTI", description: "Sale", status: "Draft",
      atcCode: "PH7C-WC010", taxWithheldAmount: 2000,
      lines: [
        // Balanced: AR(20400) + EWT(2000) debit = Revenue(20000) + Output VAT(2400) credit = 22400.
        { accountId: arId, accountCode: "PH7CAR", accountTitle: "Accounts Receivable", particulars: "AR", genRef: "PH7C-CUST", genName: "PH7C Customer Original", debit: gross1 - 2000, credit: 0 },
        { accountId: revId, accountCode: "PH7CREV", accountTitle: "Sales Revenue", particulars: "Revenue", genRef: "", genName: "", debit: 0, credit: net1 },
        reloadedVatLine,
        ewtLine,
      ],
      totalDebit: gross1, totalCredit: gross1,
    });
    expect(updateRes.status).toBe(200);

    // BOTH must survive - this is the exact assertion that caught the bug.
    expect(await countTaxEntries("INV", invoiceId)).toBe(2);

    const [entries] = await pool.query(
      "SELECT entry_type, line_id FROM transaction_tax_entries WHERE transaction_type = 'INV' AND transaction_id = ? ORDER BY id",
      [invoiceId]
    );
    const [currentLines] = await pool.query("SELECT id FROM invoice_lines WHERE invoice_id = ?", [invoiceId]);
    const currentLineIds = currentLines.map((l) => l.id);

    for (const entry of entries) {
      // Every tax entry's line_id must point at a line from THIS save, not
      // a stale id from the previous one.
      expect(currentLineIds).toContain(entry.line_id);
    }
    expect(entries.map((e) => e.entry_type).sort()).toEqual(["EWT", "OUTPUT_VAT"]);
  });
});

describe("Phase 7C - Delete test (spec section 44)", () => {
  test("removing the VAT line and re-saving removes its schedule metadata, no orphan", async () => {
    const first = apvInputVatLine({ gross: 1120 });
    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-DEL", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-DEL", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: first.net, credit: 0 },
        first.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: first.net + first.vat },
      ],
      totalDebit: first.net + first.vat, totalCredit: first.net + first.vat,
    });
    const apvId = createRes.body.id;
    expect(await countTaxEntries("APV", apvId)).toBe(1);

    // Re-save WITHOUT the VAT line (as if the user clicked Remove on it).
    const updateRes = await request(app).put(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-DEL", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-DEL", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: first.net, credit: 0 },
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: first.net },
      ],
      totalDebit: first.net, totalCredit: first.net,
    });

    expect(updateRes.status).toBe(200);
    expect(await countTaxEntries("APV", apvId)).toBe(0);
  });
});

describe("Phase 7C - Posted immutability applies to tax-generated lines (spec section 45)", () => {
  test("a Posted APV's tax entries cannot be changed via direct PUT - rejected by the existing Phase 7A.1 guard", async () => {
    const first = apvInputVatLine({ gross: 4480 });
    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-POSTED", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-POSTED", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: first.net, credit: 0 },
        first.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: first.net + first.vat },
      ],
      totalDebit: first.net + first.vat, totalCredit: first.net + first.vat,
    });
    const apvId = createRes.body.id;

    const postRes = await request(app).put(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-POSTED", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-POSTED", description: "Purchase", status: "Posted",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: first.net, credit: 0 },
        first.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: first.net + first.vat },
      ],
      totalDebit: first.net + first.vat, totalCredit: first.net + first.vat,
    });
    expect(postRes.status).toBe(200);

    // Direct attempt to change the now-Posted transaction's tax-bearing line/amount.
    const second = apvInputVatLine({ gross: 8960 });
    const tamperRes = await request(app).put(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-POSTED", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-POSTED", description: "Purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: second.net, credit: 0 },
        second.line,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: second.net + second.vat },
      ],
      totalDebit: second.net + second.vat, totalCredit: second.net + second.vat,
    });

    expect(tamperRes.status).toBe(409);
    expect(tamperRes.body.code).toBe("TRANSACTION_ALREADY_POSTED");

    // The original schedule metadata is untouched - no side endpoint bypassed the guard.
    const [entries] = await pool.query("SELECT * FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?", [apvId]);
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].gross_amount)).toBeCloseTo(4480, 2);

    // No side endpoint exists to write transaction_tax_entries directly -
    // the only write path is saveTaxEntries(), called exclusively from
    // inside the guarded POST/PUT /api/apv and /api/invoices handlers.
  });
});

describe("Phase 7C - Multi-currency consistency (spec section 46)", () => {
  test("a foreign-currency APV's Input VAT tax entry stores transaction-currency figures consistent with the journal line", async () => {
    const gross = 112; // USD, VAT-inclusive
    const rate = 12;
    const net = Math.round((gross / 1.12) * 100) / 100;
    const vat = Math.round((gross - net) * 100) / 100;

    const vatLine = {
      accountId: inputVatId, accountCode: "PH7CIVAT", accountTitle: "Input VAT Receivable",
      particulars: `Input VAT (${rate}%)`, genRef: "", genName: "PH7C Supplier Original",
      debit: vat, credit: 0,
      taxEntry: {
        entryType: "INPUT_VAT", accountId: inputVatId,
        partyId: suppId, partyName: "PH7C Supplier Original", partyTin: "444-555-666-000", partyAddress: "Original Supplier Address, Cebu",
        transactionDate: "2026-08-10", grossAmount: gross, netAmount: net, vatRate: rate, vatAmount: vat,
        purchaseClassification: "Services",
      },
    };

    const createRes = await request(app).post("/api/apv").set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-FX", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-FX", description: "Foreign purchase", status: "Draft",
      lines: [
        { accountId: expId, accountCode: "PH7CEXP", accountTitle: "Purchases Expense", particulars: "Purchase", genRef: "", genName: "", debit: net, credit: 0 },
        vatLine,
        { accountId: apId, accountCode: "PH7CAP", accountTitle: "Accounts Payable", particulars: "Payable", genRef: "", genName: "", debit: 0, credit: net + vat },
      ],
      totalDebit: net + vat, totalCredit: net + vat,
      currency: { currencyId: usdId, exchangeRate: 58, rateDate: "2026-08-01" },
    });

    expect(createRes.status).toBe(200);
    const apvId = createRes.body.id;

    const [entries] = await pool.query("SELECT * FROM transaction_tax_entries WHERE transaction_type = 'APV' AND transaction_id = ?", [apvId]);
    // The tax entry stores the TRANSACTION-currency (foreign, USD) figures -
    // matching the actual physical supplier invoice, not a base-converted
    // abstraction (spec section 38/39 - Phase 7C's own documented decision).
    expect(Number(entries[0].gross_amount)).toBeCloseTo(gross, 2);
    expect(Number(entries[0].vat_amount)).toBeCloseTo(vat, 2);

    const [lineRows] = await pool.query("SELECT foreign_debit, debit FROM apv_lines WHERE id = ?", [entries[0].line_id]);
    expect(Number(lineRows[0].foreign_debit)).toBeCloseTo(vat, 2);
    // base debit = foreign x rate (58) - proves the line participated in
    // the normal currency conversion flow, not a second/duplicate one.
    expect(Number(lineRows[0].debit)).toBeCloseTo(Math.round(vat * 58 * 100) / 100, 1);

    // Reopen Draft and save again unchanged - must not double-convert.
    const getRes = await request(app).get(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`);
    const reloadedLines = getRes.body.lines.map((l) => ({
      accountId: l.accountId, accountCode: l.accountCode, accountTitle: l.accountTitle,
      particulars: l.particulars, genRef: l.genRef, genName: l.genName,
      debit: l.foreignDebit ?? l.debit, credit: l.foreignCredit ?? l.credit,
    }));
    const resaveRes = await request(app).put(`/api/apv/${apvId}`).set("Authorization", `Bearer ${token}`).send({
      voucherNo: "PH7C-APV-FX", supplierId: suppId, supplierName: "PH7C Supplier Original",
      transactionDate: "2026-08-10", referenceNo: "REF-FX", description: "Foreign purchase", status: "Draft",
      lines: reloadedLines, totalDebit: net + vat, totalCredit: net + vat,
      currency: { currencyId: usdId },
    });
    expect(resaveRes.status).toBe(200);

    const [[lineAfter]] = await pool.query("SELECT foreign_debit, debit FROM apv_lines WHERE apv_id = ? AND account_id = ?", [apvId, inputVatId]);
    expect(Number(lineAfter.foreign_debit)).toBeCloseTo(vat, 2); // unchanged, not re-multiplied by the rate again
  });
});
