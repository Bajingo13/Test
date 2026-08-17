const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");

// Checkpoint 3C: JV (GL-posting) + Purchase Order (non-GL, reference-only)
// multi-currency. Mirrors server.js's actual INSERT/UPDATE shape for
// jv_headers/jv_lines and purchase_order_headers/purchase_order_lines so a
// column-name or value-mapping regression in the route handlers would show
// up here, not just a resolveTransactionCurrency() unit gap (already
// covered generically by transactionCurrencyService.test.js).
//
// JE, Debit/Credit Memo, and Petty Cash have no backend table/route at
// all (confirmed by investigation) - there is nothing for this checkpoint
// to test for them.

jest.setTimeout(45000);

let companyId, adminUser, nonPrivilegedUser;
let phpId, usdId, jpyId, eurId;
let expenseAccountId, liabilityAccountId, inventoryAccountId, apAccountId;
const createdUserIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, roleId) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', ?, 'ACTIVE')",
    [username, roleId]
  );
  const userId = result.insertId;
  createdUserIds.push(userId);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return { id: userId, roleCode: roleId === 1 ? "SUPER_ADMIN" : "NON_SUPER" };
}

async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}

function jvLines({ debitAmount, creditAmount }) {
  return [
    { accountId: expenseAccountId, accountCode: "TEST3CEXP", accountTitle: "Expense (Test)", particulars: "Debit entry", debit: debitAmount, credit: 0 },
    { accountId: liabilityAccountId, accountCode: "TEST3CLIA", accountTitle: "Accrued Liability (Test)", particulars: "Credit entry", debit: 0, credit: creditAmount },
  ];
}

// Mirrors server.js's POST /api/jv exactly (grossAmount from summed lines,
// resolveTransactionCurrency, INSERT with baseDebit/baseCredit +
// foreignDebit/foreignCredit, saveSnapshot).
async function createJv({ user, currencyPayload, lines, status }) {
  const isPosting = status === "Posted";
  const grossAmount = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
    user, companyId, transactionType: "JV", transactionId: null, currencyPayload: currencyPayload,
    lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
  });
  const voucherNo = `ZZ3C-JV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [result] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, reference_no, prepared_for, description, remarks, total_debit, total_credit, status, created_by, posted_by, posted_at, currency_id)
     VALUES (?, ?, CURDATE(), '', 'Test', '', '', ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, voucherNo, currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, status, user.id, isPosting ? user.id : null, isPosting ? new Date() : null, currencyResult.currencyId]
  );
  const jvId = result.insertId;
  for (const line of currencyResult.lines) {
    await pool.execute(
      `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, gen_ref, gen_name, debit, credit, foreign_debit, foreign_credit)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)`,
      [jvId, line.accountId, line.accountCode, line.accountTitle, line.particulars, line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit]
    );
  }
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "JV", transactionId: jvId,
    currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
    baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
    rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
    userId: user.id, lockNow: isPosting,
  });
  return { jvId, voucherNo, currencyResult };
}

async function getJvRow(jvId) {
  const [[header]] = await pool.execute("SELECT * FROM jv_headers WHERE id = ?", [jvId]);
  const [lines] = await pool.execute("SELECT * FROM jv_lines WHERE jv_id = ? ORDER BY id", [jvId]);
  return { header, lines };
}

function poLines({ debitAmount, creditAmount }) {
  return [
    { accountId: inventoryAccountId, accountCode: "TEST3CINV", accountTitle: "Inventory (Test)", particulars: "Purchase / Inventory", debit: debitAmount, credit: 0 },
    { accountId: apAccountId, accountCode: "TEST3CAP", accountTitle: "Accrued Payable (Test)", particulars: "Accrued Payable", debit: 0, credit: creditAmount },
  ];
}

// Mirrors server.js's POST /api/purchase-orders exactly.
async function createPo({ user, currencyPayload, lines, status }) {
  const finalStatus = status === "Draft" ? "Draft" : "Open";
  const isPosting = finalStatus === "Open";
  const grossAmount = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
    user, companyId, transactionType: "PO", transactionId: null, currencyPayload: currencyPayload,
    lines, grossAmount, vatKeyword: "input vat", taxWithheldAmount: 0, isPosting,
  });
  const voucherNo = `ZZ3C-PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [result] = await pool.execute(
    `INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, reference_no, description, remarks, total_debit, total_credit, status, currency_id)
     VALUES (?, ?, NULL, 'Test Supplier', CURDATE(), '', '', '', ?, ?, ?, ?)`,
    [companyId, voucherNo, currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, finalStatus, currencyResult.currencyId]
  );
  const poId = result.insertId;
  for (const line of currencyResult.lines) {
    await pool.execute(
      `INSERT INTO purchase_order_lines (po_id, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name, foreign_debit, foreign_credit)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
      [poId, line.accountId, line.accountCode, line.accountTitle, line.particulars, line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit]
    );
  }
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "PO", transactionId: poId,
    currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
    baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
    rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
    userId: user.id, lockNow: isPosting,
  });
  return { poId, voucherNo, currencyResult };
}

async function getPoRow(poId) {
  const [[header]] = await pool.execute("SELECT * FROM purchase_order_headers WHERE id = ?", [poId]);
  const [lines] = await pool.execute("SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY id", [poId]);
  return { header, lines };
}

beforeAll(async () => {
  // Self-healing: a previous run that crashed/timed out mid-suite (before
  // reaching afterAll) can leave these fixed-code accounts orphaned, which
  // would otherwise fail every subsequent run on a duplicate-key error.
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3C%'");

  companyId = await makeCompany("TEST CO - Checkpoint 3C Transaction Currency");
  adminUser = await makeUser("test_admin_3c", 2); // ADMIN - has OVERRIDE_RATE
  nonPrivilegedUser = await makeUser("test_nonpriv_3c", 3); // ACCOUNTANT - does not

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
  const jpy = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "JPY", currencyName: "Japanese Yen", currencySymbol: "¥",
    decimalPlaces: 0, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
  });
  jpyId = jpy.id;
  const eur = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "EUR", currencyName: "Euro", currencySymbol: "€",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
  });
  eurId = eur.id;

  await CurrencyService.recordRate(adminUser, usdId, {
    rateMode: "MANUAL", rate: 57.5, effectiveDate: new Date().toISOString().slice(0, 10),
  });
  await CurrencyService.recordRate(adminUser, jpyId, {
    rateMode: "MANUAL", rate: 0.39, effectiveDate: new Date().toISOString().slice(0, 10),
  });
  await CurrencyService.recordRate(adminUser, eurId, {
    rateMode: "MANUAL", rate: 63.1, effectiveDate: new Date().toISOString().slice(0, 10),
  });

  expenseAccountId = await makeAccount("TEST3CEXP", "Expense (Test)", "EXPENSE");
  liabilityAccountId = await makeAccount("TEST3CLIA", "Accrued Liability (Test)", "LIABILITY");
  inventoryAccountId = await makeAccount("TEST3CINV", "Inventory (Test)", "ASSET");
  apAccountId = await makeAccount("TEST3CAP", "Accrued Payable (Test)", "LIABILITY");
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE voucher_no LIKE 'ZZ3C-JV-%')");
  await pool.query("DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_order_headers WHERE voucher_no LIKE 'ZZ3C-PO-%')");
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE transaction_type IN ('JV','PO') AND company_id = ?", [companyId]);
  await pool.execute("DELETE FROM jv_headers WHERE voucher_no LIKE 'ZZ3C-JV-%'");
  await pool.execute("DELETE FROM purchase_order_headers WHERE voucher_no LIKE 'ZZ3C-PO-%'");
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("Journal Voucher multi-currency", () => {
  test("1. PHP (base currency) JV: rate is exactly 1, no provider lookup", async () => {
    const { currencyResult } = await createJv({
      user: adminUser, currencyPayload: { currencyId: phpId }, lines: jvLines({ debitAmount: 5000, creditAmount: 5000 }), status: "Draft",
    });
    expect(currencyResult.rateInfo.exchangeRate).toBe(1);
    expect(currencyResult.rateInfo.rateSource).toBe("BASE");
    expect(currencyResult.baseTotalDebit).toBe(5000);
  });

  test("2. USD JV: foreign lines convert to base at the resolved rate", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: jvLines({ debitAmount: 1000, creditAmount: 1000 }), status: "Draft",
    });
    const { header, lines } = await getJvRow(jvId);
    expect(Number(header.total_debit)).toBeCloseTo(57500, 2);
    expect(Number(header.total_credit)).toBeCloseTo(57500, 2);
    expect(Number(lines[0].foreign_debit)).toBe(1000);
    expect(Number(lines[0].debit)).toBeCloseTo(57500, 2);
  });

  test("3. JPY JV: converts correctly at a sub-1 rate", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: jpyId }, lines: jvLines({ debitAmount: 100000, creditAmount: 100000 }), status: "Draft",
    });
    const { header } = await getJvRow(jvId);
    expect(Number(header.total_debit)).toBeCloseTo(39000, 2);
  });

  test("4. EUR JV: converts correctly", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: eurId }, lines: jvLines({ debitAmount: 500, creditAmount: 500 }), status: "Draft",
    });
    const { header } = await getJvRow(jvId);
    expect(Number(header.total_debit)).toBeCloseTo(31550, 2);
  });

  test("5. Draft persistence: reopening a draft loads the STORED rate, never silently refreshes", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: jvLines({ debitAmount: 200, creditAmount: 200 }), status: "Draft",
    });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 99, effectiveDate: new Date().toISOString().slice(0, 10) });

    const resaved = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: "JV", transactionId: jvId,
      currencyPayload: { currencyId: usdId }, lines: jvLines({ debitAmount: 200, creditAmount: 200 }),
      grossAmount: 200, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(resaved.rateInfo.exchangeRate).toBe(57.5); // unchanged, not the new 99 rate
  });

  test("6. Draft refresh: isRefresh explicitly re-resolves to the latest rate", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: eurId }, lines: jvLines({ debitAmount: 50, creditAmount: 50 }), status: "Draft",
    });
    await CurrencyService.recordRate(adminUser, eurId, { rateMode: "MANUAL", rate: 64.2, effectiveDate: new Date().toISOString().slice(0, 10) });

    const refreshed = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: "JV", transactionId: jvId,
      currencyPayload: { currencyId: eurId, isRefresh: true }, lines: jvLines({ debitAmount: 50, creditAmount: 50 }),
      grossAmount: 50, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(refreshed.rateInfo.exchangeRate).toBe(64.2);
  });

  test("7. Manual override: authorized user + reason stores override_rate and system_rate separately", async () => {
    // Explicit, not inherited from test 5's mutation - keeps this test
    // correct regardless of what ran before it in this file.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.5, effectiveDate: new Date().toISOString().slice(0, 10) });

    const overridden = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: "JV", transactionId: null,
      currencyPayload: { currencyId: usdId, isOverride: true, exchangeRate: 60, overrideReason: "Bank-quoted rate for this JV" },
      lines: jvLines({ debitAmount: 100, creditAmount: 100 }), grossAmount: 100, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(overridden.rateInfo.exchangeRate).toBe(60);
    expect(overridden.rateInfo.overrideRate).toBe(60);
    expect(overridden.rateInfo.overrideReason).toBe("Bank-quoted rate for this JV");
    expect(overridden.rateInfo.systemRate).toBe(57.5);
  });

  test("8. Posted lock: currency/rate cannot change once Posted", async () => {
    const { jvId } = await createJv({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: jvLines({ debitAmount: 300, creditAmount: 300 }), status: "Posted",
    });
    const { header } = await getJvRow(jvId);
    expect(header.status).toBe("Posted");

    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: "JV", transactionId: jvId,
        currencyPayload: { currencyId: usdId, exchangeRate: 999 }, lines: jvLines({ debitAmount: 300, creditAmount: 300 }),
        grossAmount: 300, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: true,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("9. Foreign debit != foreign credit is rejected before any row is written", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: "JV", transactionId: null,
        currencyPayload: { currencyId: usdId }, lines: jvLines({ debitAmount: 100, creditAmount: 90 }),
        grossAmount: 100, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("10. Base debit/credit balance exactly even with a rounding-prone rate", async () => {
    // 3 lines whose per-line rate x amount rounding could drift the base
    // sums apart by a centavo if not corrected (transactionCurrencyService's
    // computeBaseLines drift-correction, reused unchanged from 3A).
    const lines = [
      { accountId: expenseAccountId, accountCode: "TEST3CEXP", accountTitle: "Expense (Test)", particulars: "A", debit: 33.33, credit: 0 },
      { accountId: expenseAccountId, accountCode: "TEST3CEXP", accountTitle: "Expense (Test)", particulars: "B", debit: 33.33, credit: 0 },
      { accountId: expenseAccountId, accountCode: "TEST3CEXP", accountTitle: "Expense (Test)", particulars: "C", debit: 33.34, credit: 0 },
      { accountId: liabilityAccountId, accountCode: "TEST3CLIA", accountTitle: "Accrued Liability (Test)", particulars: "D", debit: 0, credit: 100 },
    ];
    const { jvId } = await createJv({ user: adminUser, currencyPayload: { currencyId: usdId }, lines, status: "Draft" });
    const { header } = await getJvRow(jvId);
    expect(Number(header.total_debit)).toBe(Number(header.total_credit));
  });

  test("11. Unauthorized override is rejected (permission enforced, not just UI-hidden)", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: nonPrivilegedUser, companyId, transactionType: "JV", transactionId: null,
        currencyPayload: { currencyId: usdId, isOverride: true, exchangeRate: 60, overrideReason: "test" },
        lines: jvLines({ debitAmount: 100, creditAmount: 100 }), grossAmount: 100, vatKeyword: "vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("12. Historical compatibility: a NULL-currency_id legacy JV is treated as implicit base currency", async () => {
    const voucherNo = `ZZ3C-JV-LEGACY-${Date.now()}`;
    const [result] = await pool.execute(
      `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, status, total_debit, total_credit, currency_id) VALUES (?, ?, CURDATE(), 'Posted', 500, 500, NULL)`,
      [companyId, voucherNo]
    );
    const legacySnapshot = await TransactionCurrencyService.getSnapshot("JV", result.insertId);
    expect(legacySnapshot).toBeNull(); // no snapshot row -> frontend/print treat as base currency, never guessed foreign
    await pool.execute("DELETE FROM jv_headers WHERE id = ?", [result.insertId]);
  });
});

describe("Purchase Order multi-currency (non-GL, reference-only)", () => {
  // The JV describe block above mutates USD's current rate (tests 5/6/8) -
  // reset it here so this block's assertions have a known, stable rate
  // regardless of what ran before it.
  beforeAll(async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.5, effectiveDate: new Date().toISOString().slice(0, 10) });
  });

  test("13. PHP PO: rate is exactly 1", async () => {
    const { currencyResult } = await createPo({
      user: adminUser, currencyPayload: { currencyId: phpId }, lines: poLines({ debitAmount: 2000, creditAmount: 2000 }), status: "Open",
    });
    expect(currencyResult.rateInfo.exchangeRate).toBe(1);
  });

  test("14. USD PO: foreign subtotal/total and base equivalent both stored on the snapshot", async () => {
    const { poId, currencyResult } = await createPo({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: poLines({ debitAmount: 1000, creditAmount: 1000 }), status: "Open",
    });
    expect(currencyResult.foreignTotals.foreignTotal).toBe(1000);
    expect(currencyResult.baseTotals.baseTotal).toBeCloseTo(57500, 2);

    const { header, lines } = await getPoRow(poId);
    expect(Number(header.total_debit)).toBeCloseTo(57500, 2);
    expect(Number(lines[0].foreign_debit)).toBe(1000);
  });

  test("15. Draft PO rate persistence: reopening keeps the stored rate", async () => {
    const { poId } = await createPo({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: poLines({ debitAmount: 400, creditAmount: 400 }), status: "Draft",
    });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 88, effectiveDate: new Date().toISOString().slice(0, 10) });

    const resaved = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: "PO", transactionId: poId,
      currencyPayload: { currencyId: usdId }, lines: poLines({ debitAmount: 400, creditAmount: 400 }),
      grossAmount: 400, vatKeyword: "input vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(resaved.rateInfo.exchangeRate).toBe(57.5);
  });

  test("16. PO currency locks once it leaves Draft (Open), mirroring GL modules' Posted lock", async () => {
    const { poId } = await createPo({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: poLines({ debitAmount: 250, creditAmount: 250 }), status: "Open",
    });
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: "PO", transactionId: poId,
        currencyPayload: { currencyId: usdId, exchangeRate: 999 }, lines: poLines({ debitAmount: 250, creditAmount: 250 }),
        grossAmount: 250, vatKeyword: "input vat", taxWithheldAmount: 0, isPosting: true,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("17. Historical compatibility: a NULL-currency_id legacy PO is treated as implicit base currency", async () => {
    const voucherNo = `ZZ3C-PO-LEGACY-${Date.now()}`;
    const [result] = await pool.execute(
      `INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_name, transaction_date, status, total_debit, total_credit, currency_id) VALUES (?, ?, 'Legacy Supplier', CURDATE(), 'Open', 500, 500, NULL)`,
      [companyId, voucherNo]
    );
    const legacySnapshot = await TransactionCurrencyService.getSnapshot("PO", result.insertId);
    expect(legacySnapshot).toBeNull();
    await pool.execute("DELETE FROM purchase_order_headers WHERE id = ?", [result.insertId]);
  });

  test("18. PO lines never appear in the GL ledger union (confirmed non-GL by construction)", async () => {
    const { poId } = await createPo({
      user: adminUser, currencyPayload: { currencyId: usdId }, lines: poLines({ debitAmount: 700, creditAmount: 700 }), status: "Open",
    });
    const LedgerReportService = require("../LedgerReportService");
    const rows = await LedgerReportService.getLedgerRows({
      from: "2000-01-01", to: "2999-12-31", accountCodes: ["TEST3CINV", "TEST3CAP"], companyId,
    });
    const fromThisPo = rows.filter((r) => r.source_type === "PO");
    expect(fromThisPo.length).toBe(0);
    void poId;
  });
});
