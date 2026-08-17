const pool = require("../../db");
const CurrencyService = require("../currencyService");
const AgingReportService = require("../agingReportService");

// Checkpoint 3E: Multi-Currency AR/AP Aging Reporting. Row-level source
// data is inserted directly (mirroring the exact column shapes server.js
// writes on Invoice/APV/AR-AP-Beginning-Balance/transaction_applications
// creation - confirmed by reading server.js/paymentApplicationService.js)
// rather than going through the full posting stack, so these tests
// isolate the REPORT math (currency, bucketing, as-of reconstruction)
// from transaction-creation logic already covered by 3A-3D's test suites.

jest.setTimeout(30000);

let companyId, adminUser;
let phpId, usdId;
const invoiceIds = [];
const apvIds = [];
const bbLineIds = [];
const bbHeaderIds = [];

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
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return { id: userId };
}

async function insertInvoice({ customerId = 500001, customerName, voucherNo, transactionDate, dueDate, totalDebit, paidAmount = 0, balanceAmount, paymentStatus = "Unpaid", currencyId = null }) {
  const [result] = await pool.execute(
    `INSERT INTO invoice_headers
      (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'Posted', ?)`,
    [companyId, voucherNo, customerId, customerName, transactionDate, dueDate, totalDebit, paidAmount, balanceAmount ?? totalDebit, paymentStatus, currencyId]
  );
  invoiceIds.push(result.insertId);
  return result.insertId;
}

async function insertApv({ supplierId = 600001, supplierName, voucherNo, transactionDate, dueDate, totalCredit, paidAmount = 0, balanceAmount, paymentStatus = "Unpaid", currencyId = null }) {
  const [result] = await pool.execute(
    `INSERT INTO apv_headers
      (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'Posted', ?)`,
    [companyId, voucherNo, supplierId, supplierName, transactionDate, dueDate, totalCredit, paidAmount, balanceAmount ?? totalCredit, paymentStatus, currencyId]
  );
  apvIds.push(result.insertId);
  return result.insertId;
}

async function insertSnapshot({ transactionType, transactionId, currencyId, currencyCode, rate, rateDate, foreignTotal, baseTotal }) {
  await pool.execute(
    `INSERT INTO transaction_currency_snapshots
      (company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code,
       exchange_rate, rate_date, rate_source, rate_locked, foreign_total, base_total)
     VALUES (?, ?, ?, ?, ?, ?, 'PHP', ?, ?, 'MANUAL', 1, ?, ?)`,
    [companyId, transactionType, transactionId, currencyId, currencyCode, phpId, rate, rateDate, foreignTotal, baseTotal]
  );
}

async function insertApplication({ sourceType, sourceId, appliedType, appliedId, amount, applicationDate, foreignAmountApplied = null, sourceExchangeRate = null, paymentExchangeRate = null }) {
  await pool.execute(
    `INSERT INTO transaction_applications
      (source_type, source_id, applied_type, applied_id, amount, application_date, foreign_amount_applied, source_exchange_rate, payment_exchange_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sourceType, sourceId, appliedType, appliedId, amount, applicationDate, foreignAmountApplied, sourceExchangeRate, paymentExchangeRate]
  );
}

async function insertBeginningBalance({ balanceType, balanceDate, partyId = 500002, partyName, dueDate, amount, currencyId = null, foreignOriginal = null }) {
  const [headerResult] = await pool.execute(
    `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, ?, ?, 'PHP', 'PHILIPPINE PESO', 'TEST3E', 'Posted')`,
    [companyId, balanceType, balanceDate]
  );
  const headerId = headerResult.insertId;
  bbHeaderIds.push(headerId);
  const isAR = balanceType === "AR";
  const [lineResult] = await pool.execute(
    `INSERT INTO arap_beginning_balance_lines
      (header_id, party_id, party_name, account_code, account_title, reference_no, due_date, debit, credit, balance_amount, paid_amount, status, currency_id, foreign_original_amount, foreign_paid_amount, foreign_balance_amount)
     VALUES (?, ?, ?, 'TEST3EACCT', 'Test Account', ?, ?, ?, ?, ?, 0, 'Unpaid', ?, ?, 0, ?)`,
    [
      headerId, partyId, partyName, `TEST3E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, dueDate,
      isAR ? amount : 0, isAR ? 0 : amount, amount, currencyId, foreignOriginal, foreignOriginal,
    ]
  );
  bbLineIds.push(lineResult.insertId);
  return lineResult.insertId;
}

beforeAll(async () => {
  companyId = await makeCompany("TEST CO - Checkpoint 3E Aging");
  adminUser = await makeUser("test_admin_3e_aging", 2);

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
});

afterAll(async () => {
  if (invoiceIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'INV' AND source_id IN (?)", [invoiceIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [invoiceIds]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [invoiceIds]);
  }
  if (apvIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?)", [apvIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'APV' AND transaction_id IN (?)", [apvIds]);
    await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [apvIds]);
  }
  if (bbLineIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type IN ('AR_BEGINNING','AP_BEGINNING') AND source_id IN (?)", [bbLineIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type IN ('AR_BEGINNING','AP_BEGINNING') AND transaction_id IN (?)", [bbLineIds]);
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE id IN (?)", [bbLineIds]);
  }
  if (bbHeaderIds.length) {
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id IN (?)", [bbHeaderIds]);
  }
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM user_companies WHERE user_id = ?", [adminUser.id]);
  await pool.execute("DELETE FROM users WHERE id = ?", [adminUser.id]);
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("AR Aging - currency, buckets, as-of reconstruction", () => {
  test("1. PHP invoice: not foreign, base amounts correct", async () => {
    const id = await insertInvoice({
      customerName: "TEST3E Customer PHP", voucherNo: "TEST3E-INV-1",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1000,
    });
    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-15", partyId: 500001 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.isForeign).toBe(false);
    expect(row.baseOriginal).toBe(1000);
    expect(row.baseBalance).toBe(1000);
    expect(row.foreignBalance).toBeNull();
  });

  test("2. USD invoice: foreign fields populated from the snapshot, never resolveRate", async () => {
    const id = await insertInvoice({
      customerId: 500010, customerName: "TEST3E Customer USD", voucherNo: "TEST3E-INV-2",
      transactionDate: "2026-01-05", dueDate: "2026-02-04", totalDebit: 5700, currencyId: usdId,
    });
    await insertSnapshot({ transactionType: "INV", transactionId: id, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-05", foreignTotal: 100, baseTotal: 5700 });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-15", partyId: 500010 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.isForeign).toBe(true);
    expect(row.currencyCode).toBe("USD");
    expect(row.historicalRate).toBe(57);
    expect(row.foreignOriginal).toBe(100);
    expect(row.foreignBalance).toBe(100);
    expect(row.baseOriginal).toBe(5700);
  });

  test.each([
    ["current (not yet due)", "2026-04-10", "current"],
    ["current (due exactly today)", "2026-03-01", "current"],
    ["1-30 bucket", "2026-02-15", "days1to30"],
    ["31-60 bucket", "2026-01-16", "days31to60"],
    ["61-90 bucket", "2025-12-17", "days61to90"],
    ["over 90 bucket", "2025-10-01", "over90"],
  ])("3-8. bucket assignment: %s", async (_label, dueDate, expectedBucket) => {
    const id = await insertInvoice({
      customerId: 500020, customerName: "TEST3E Bucket Customer", voucherNo: `TEST3E-BKT-${dueDate}`,
      transactionDate: "2025-01-01", dueDate, totalDebit: 100,
    });
    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-03-01", partyId: 500020 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.bucket).toBe(expectedBucket);
  });

  test("9. Fully paid invoice (as of a date after full payment) excluded from OPEN status", async () => {
    const id = await insertInvoice({
      customerId: 500030, customerName: "TEST3E Paid Customer", voucherNo: "TEST3E-INV-PAID",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1000,
    });
    await insertApplication({ sourceType: "INV", sourceId: id, appliedType: "OR", appliedId: 1, amount: 1000, applicationDate: "2026-01-20" });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500030, status: "OPEN" });
    expect(rows.find((r) => r.sourceId === id)).toBeUndefined();

    const allRows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500030, status: "ALL" });
    const row = allRows.find((r) => r.sourceId === id);
    expect(row.baseBalance).toBe(0);
  });

  test("10. Partially paid invoice: base balance reduced correctly", async () => {
    const id = await insertInvoice({
      customerId: 500040, customerName: "TEST3E Partial Customer", voucherNo: "TEST3E-INV-PARTIAL",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1000,
    });
    await insertApplication({ sourceType: "INV", sourceId: id, appliedType: "OR", appliedId: 2, amount: 400, applicationDate: "2026-01-20" });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500040 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.basePaid).toBe(400);
    expect(row.baseBalance).toBe(600);
  });

  test("11. Foreign invoice partially paid: foreign AND base balances both reduced independently", async () => {
    const id = await insertInvoice({
      customerId: 500050, customerName: "TEST3E Foreign Partial", voucherNo: "TEST3E-INV-FXPARTIAL",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 5700, currencyId: usdId,
    });
    await insertSnapshot({ transactionType: "INV", transactionId: id, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });
    await insertApplication({ sourceType: "INV", sourceId: id, appliedType: "OR", appliedId: 3, amount: 2300, applicationDate: "2026-01-15", foreignAmountApplied: 40 });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500050 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.foreignPaid).toBe(40);
    expect(row.foreignBalance).toBe(60);
    expect(row.basePaid).toBe(2300);
    expect(row.baseBalance).toBe(3400);
  });

  test("12. AR Beginning Balance included with its OWN historical opening rate", async () => {
    const lineId = await insertBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-01", partyId: 500060, partyName: "TEST3E BB Customer",
      dueDate: "2026-01-31", amount: 5700, currencyId: usdId, foreignOriginal: 100,
    });
    await insertSnapshot({ transactionType: "AR_BEGINNING", transactionId: lineId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500060 });
    const row = rows.find((r) => r.sourceId === lineId && r.sourceType === "AR_BEGINNING");
    expect(row.historicalRate).toBe(57);
    expect(row.foreignOriginal).toBe(100);
    expect(row.baseOriginal).toBe(5700);
  });

  test("13. Currency filter returns only that currency's own documents (never converts)", async () => {
    const phpInv = await insertInvoice({ customerId: 500070, customerName: "TEST3E Filter Customer", voucherNo: "TEST3E-FILT-PHP", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 100 });
    const usdInv = await insertInvoice({ customerId: 500070, customerName: "TEST3E Filter Customer", voucherNo: "TEST3E-FILT-USD", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 5700, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: usdInv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });

    const usdRows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500070, currencyCode: "USD" });
    expect(usdRows.some((r) => r.sourceId === phpInv)).toBe(false);
    expect(usdRows.some((r) => r.sourceId === usdInv)).toBe(true);
  });

  test("14. Party filter isolates a single customer's documents", async () => {
    const a = await insertInvoice({ customerId: 500080, customerName: "TEST3E Party A", voucherNo: "TEST3E-PARTY-A", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 100 });
    const b = await insertInvoice({ customerId: 500081, customerName: "TEST3E Party B", voucherNo: "TEST3E-PARTY-B", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 100 });

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500080 });
    expect(rows.some((r) => r.sourceId === a)).toBe(true);
    expect(rows.some((r) => r.sourceId === b)).toBe(false);
  });

  test("15. Bucket totals: base and foreign totals grouped separately, never summed together", async () => {
    const phpInv = await insertInvoice({ customerId: 500090, customerName: "TEST3E Totals Customer", voucherNo: "TEST3E-TOT-PHP", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1000 });
    const usdInv = await insertInvoice({ customerId: 500090, customerName: "TEST3E Totals Customer", voucherNo: "TEST3E-TOT-USD", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 5700, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: usdInv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });
    void phpInv;

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500090 });
    const totals = AgingReportService.getBucketTotals(rows);
    expect(totals.base.total).toBeCloseTo(1000 + 5700, 2);
    expect(totals.byCurrency.USD.total).toBeCloseTo(100, 2);
    // Foreign total must never be folded into the base total.
    expect(totals.base.total).not.toBeCloseTo(100, 2);
  });

  test("16. getSummaryByParty groups documents by customer with per-currency foreign breakdown", async () => {
    const php = await insertInvoice({ customerId: 500100, customerName: "TEST3E Summary Customer", voucherNo: "TEST3E-SUM-PHP", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1000 });
    const usdInv = await insertInvoice({ customerId: 500100, customerName: "TEST3E Summary Customer", voucherNo: "TEST3E-SUM-USD", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 5700, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: usdInv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });
    void php;

    const rows = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500100 });
    const summary = AgingReportService.getSummaryByParty(rows);
    const party = summary.find((p) => p.partyId === 500100);
    expect(party.documentCount).toBe(2);
    expect(party.baseBalance).toBeCloseTo(6700, 2);
    expect(party.foreignByCurrency.USD.balance).toBeCloseTo(100, 2);
  });

  test("17. Base-total reconciliation: sum of report balances matches independently-computed balances", async () => {
    const id1 = await insertInvoice({ customerId: 500110, customerName: "TEST3E Recon A", voucherNo: "TEST3E-RECON-A", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 1500 });
    const id2 = await insertInvoice({ customerId: 500111, customerName: "TEST3E Recon B", voucherNo: "TEST3E-RECON-B", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalDebit: 2500 });
    await insertApplication({ sourceType: "INV", sourceId: id2, appliedType: "OR", appliedId: 4, amount: 500, applicationDate: "2026-01-10" });

    const rowsA = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500110 });
    const rowsB = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-02-01", partyId: 500111 });
    const balanceA = rowsA.find((r) => r.sourceId === id1).baseBalance;
    const balanceB = rowsB.find((r) => r.sourceId === id2).baseBalance;

    expect(balanceA).toBeCloseTo(1500, 2);
    expect(balanceB).toBeCloseTo(2000, 2);
  });

  test("CRITICAL HISTORICAL TEST: as-of reconstruction using application_date, not live balance", async () => {
    const id = await insertInvoice({
      customerId: 500120, customerName: "TEST3E Historical Customer", voucherNo: "TEST3E-HIST-USD",
      transactionDate: "2026-07-01", dueDate: "2026-07-31", totalDebit: 57000, currencyId: usdId,
      paidAmount: 22800, balanceAmount: 34200, paymentStatus: "Partially Paid",
    });
    await insertSnapshot({ transactionType: "INV", transactionId: id, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-07-01", foreignTotal: 1000, baseTotal: 57000 });
    await insertApplication({
      sourceType: "INV", sourceId: id, appliedType: "OR", appliedId: 5, amount: 22800, applicationDate: "2026-08-10",
      foreignAmountApplied: 400, sourceExchangeRate: 57.0, paymentExchangeRate: 57.5,
    });

    const beforePayment = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-07-31", partyId: 500120, status: "ALL" });
    const rowBefore = beforePayment.find((r) => r.sourceId === id);
    expect(rowBefore.foreignBalance).toBe(1000);
    expect(rowBefore.foreignPaid).toBe(0);
    expect(rowBefore.historicalRate).toBe(57);

    const afterPayment = await AgingReportService.getAgingRows("AR", { companyId, asOfDate: "2026-08-31", partyId: 500120, status: "ALL" });
    const rowAfter = afterPayment.find((r) => r.sourceId === id);
    expect(rowAfter.foreignBalance).toBe(600);
    expect(rowAfter.foreignPaid).toBe(400);
    // The invoice's OWN historical rate must never change, even though the
    // payment happened at a different rate (57.5) - that difference is
    // realized FX, tracked elsewhere (Checkpoint 3FX), never rewritten here.
    expect(rowAfter.historicalRate).toBe(57);
  });
});

describe("AP Aging - mirrored currency, buckets, as-of reconstruction", () => {
  test("18. PHP APV: not foreign, base amounts correct", async () => {
    const id = await insertApv({
      supplierName: "TEST3E Supplier PHP", voucherNo: "TEST3E-APV-1",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 1000,
    });
    const rows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-15", partyId: 600001 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.isForeign).toBe(false);
    expect(row.baseBalance).toBe(1000);
  });

  test("19. USD APV: foreign fields from snapshot", async () => {
    const id = await insertApv({
      supplierId: 600010, supplierName: "TEST3E Supplier USD", voucherNo: "TEST3E-APV-2",
      transactionDate: "2026-01-05", dueDate: "2026-02-04", totalCredit: 5700, currencyId: usdId,
    });
    await insertSnapshot({ transactionType: "APV", transactionId: id, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-05", foreignTotal: 100, baseTotal: 5700 });

    const rows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-15", partyId: 600010 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.isForeign).toBe(true);
    expect(row.foreignBalance).toBe(100);
    expect(row.historicalRate).toBe(57);
  });

  test("20. AP Beginning Balance included with its own historical rate", async () => {
    const lineId = await insertBeginningBalance({
      balanceType: "AP", balanceDate: "2026-01-01", partyId: 600020, partyName: "TEST3E BB Supplier",
      dueDate: "2026-01-31", amount: 5700, currencyId: usdId, foreignOriginal: 100,
    });
    await insertSnapshot({ transactionType: "AP_BEGINNING", transactionId: lineId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });

    const rows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600020 });
    const row = rows.find((r) => r.sourceId === lineId && r.sourceType === "AP_BEGINNING");
    expect(row.historicalRate).toBe(57);
    expect(row.baseOriginal).toBe(5700);
  });

  test("21. Partially paid APV: base balance reduced", async () => {
    const id = await insertApv({
      supplierId: 600030, supplierName: "TEST3E Partial Supplier", voucherNo: "TEST3E-APV-PARTIAL",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 1000,
    });
    await insertApplication({ sourceType: "APV", sourceId: id, appliedType: "CV", appliedId: 6, amount: 400, applicationDate: "2026-01-20" });

    const rows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600030 });
    const row = rows.find((r) => r.sourceId === id);
    expect(row.basePaid).toBe(400);
    expect(row.baseBalance).toBe(600);
  });

  test("22. Currency filter for AP", async () => {
    const phpApv = await insertApv({ supplierId: 600040, supplierName: "TEST3E Filter Supplier", voucherNo: "TEST3E-APV-FILT-PHP", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 100 });
    const usdApv = await insertApv({ supplierId: 600040, supplierName: "TEST3E Filter Supplier", voucherNo: "TEST3E-APV-FILT-USD", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 5700, currencyId: usdId });
    await insertSnapshot({ transactionType: "APV", transactionId: usdApv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });

    const usdRows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600040, currencyCode: "USD" });
    expect(usdRows.some((r) => r.sourceId === phpApv)).toBe(false);
    expect(usdRows.some((r) => r.sourceId === usdApv)).toBe(true);
  });

  test("23. Status=PAID shows only fully settled documents", async () => {
    const id = await insertApv({
      supplierId: 600050, supplierName: "TEST3E Paid Supplier", voucherNo: "TEST3E-APV-PAID",
      transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 1000,
    });
    await insertApplication({ sourceType: "APV", sourceId: id, appliedType: "CV", appliedId: 7, amount: 1000, applicationDate: "2026-01-20" });

    const paidRows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600050, status: "PAID" });
    expect(paidRows.some((r) => r.sourceId === id)).toBe(true);
    const openRows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600050, status: "OPEN" });
    expect(openRows.some((r) => r.sourceId === id)).toBe(false);
  });

  test("24. Bucket totals for AP grouped by currency, never combined", async () => {
    const phpApv = await insertApv({ supplierId: 600060, supplierName: "TEST3E AP Totals Supplier", voucherNo: "TEST3E-APTOT-PHP", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 1000 });
    const usdApv = await insertApv({ supplierId: 600060, supplierName: "TEST3E AP Totals Supplier", voucherNo: "TEST3E-APTOT-USD", transactionDate: "2026-01-01", dueDate: "2026-01-31", totalCredit: 5700, currencyId: usdId });
    await insertSnapshot({ transactionType: "APV", transactionId: usdApv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 100, baseTotal: 5700 });
    void phpApv;

    const rows = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-02-01", partyId: 600060 });
    const totals = AgingReportService.getBucketTotals(rows);
    expect(totals.base.total).toBeCloseTo(6700, 2);
    expect(totals.byCurrency.USD.total).toBeCloseTo(100, 2);
  });

  test("CRITICAL HISTORICAL TEST (AP mirror): as-of reconstruction for a foreign APV/CV settlement", async () => {
    const id = await insertApv({
      supplierId: 600070, supplierName: "TEST3E Historical Supplier", voucherNo: "TEST3E-HIST-APV",
      transactionDate: "2026-07-01", dueDate: "2026-07-31", totalCredit: 57000, currencyId: usdId,
      paidAmount: 22800, balanceAmount: 34200, paymentStatus: "Partially Paid",
    });
    await insertSnapshot({ transactionType: "APV", transactionId: id, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-07-01", foreignTotal: 1000, baseTotal: 57000 });
    await insertApplication({
      sourceType: "APV", sourceId: id, appliedType: "CV", appliedId: 8, amount: 22800, applicationDate: "2026-08-10",
      foreignAmountApplied: 400, sourceExchangeRate: 57.0, paymentExchangeRate: 57.5,
    });

    const beforePayment = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-07-31", partyId: 600070, status: "ALL" });
    expect(beforePayment.find((r) => r.sourceId === id).foreignBalance).toBe(1000);

    const afterPayment = await AgingReportService.getAgingRows("AP", { companyId, asOfDate: "2026-08-31", partyId: 600070, status: "ALL" });
    const rowAfter = afterPayment.find((r) => r.sourceId === id);
    expect(rowAfter.foreignBalance).toBe(600);
    expect(rowAfter.historicalRate).toBe(57);
  });
});