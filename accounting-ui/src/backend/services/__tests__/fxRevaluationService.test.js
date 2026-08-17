const pool = require("../../db");
const CurrencyService = require("../currencyService");
const FxAccountService = require("../fxAccountService");
const FxRevaluationService = require("../fxRevaluationService");
const PaymentApplicationService = require("../paymentApplicationService");

// Checkpoint 4: Unrealized FX / Month-End Revaluation. The two CRITICAL
// concerns per the spec are (a) consecutive month-end revaluations must
// not double-count a movement already recognized in a prior period
// (CARRY_FORWARD_REVALUATION), and (b) a later real settlement must not
// double-count FX already recognized by a revaluation. Both get dedicated
// tests below, in addition to the standard AR/AP gain/loss/partial/
// exclusion/posting/duplicate/concurrency/reversal coverage.

jest.setTimeout(60000);

let companyId, adminUser;
let phpId, usdId, eurId;
let arAccountId, apAccountId, revenueAccountId, expenseAccountId, gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId;
let testCustomerId, testSupplierId;
const createdUserIds = [];
const createdInvoiceIds = [];
const createdApvIds = [];

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
  return { id: userId, roleCode: "NON_SUPER" };
}
async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}

let invSeq = 0;
async function makeInvoice({ customerId = testCustomerId, transactionDate, dueDate = "2099-01-01", totalDebit, currencyId = null, paidAmount = 0, balanceAmount, paymentStatus = "Unpaid" }) {
  invSeq++;
  const [inv] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, 'TEST4 Customer', ?, ?, ?, 0, ?, ?, ?, 'Posted', ?)`,
    [companyId, `TEST4-INV-${Date.now()}-${invSeq}`, customerId, transactionDate, dueDate, totalDebit, paidAmount, balanceAmount ?? totalDebit, paymentStatus, currencyId]
  );
  createdInvoiceIds.push(inv.insertId);
  await pool.execute(
    `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4AR', 'Accounts Receivable (Test)', 'x', ?, 0, ?, 0)`,
    [inv.insertId, arAccountId, totalDebit, currencyId ? totalDebit / 1 : null]
  );
  return inv.insertId;
}

async function insertSnapshot({ transactionType, transactionId, currencyId, currencyCode, rate, rateDate, foreignTotal, baseTotal }) {
  await pool.execute(
    `INSERT INTO transaction_currency_snapshots
      (company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code, exchange_rate, rate_date, rate_source, rate_locked, foreign_total, base_total)
     VALUES (?, ?, ?, ?, ?, ?, 'PHP', ?, ?, 'MANUAL', 1, ?, ?)`,
    [companyId, transactionType, transactionId, currencyId, currencyCode, phpId, rate, rateDate, foreignTotal, baseTotal]
  );
}

let apvSeq = 0;
async function makeApv({ supplierId = testSupplierId, transactionDate, dueDate = "2099-01-01", totalCredit, currencyId = null, paidAmount = 0, balanceAmount, paymentStatus = "Unpaid" }) {
  apvSeq++;
  const [apv] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, 'TEST4 Supplier', ?, ?, 0, ?, ?, ?, ?, 'Posted', ?)`,
    [companyId, `TEST4-APV-${Date.now()}-${apvSeq}`, supplierId, transactionDate, dueDate, totalCredit, paidAmount, balanceAmount ?? totalCredit, paymentStatus, currencyId]
  );
  createdApvIds.push(apv.insertId);
  await pool.execute(
    `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4AP', 'Accounts Payable (Test)', 'x', 0, ?, 0, ?)`,
    [apv.insertId, apAccountId, totalCredit, currencyId ? totalCredit / 1 : null]
  );
  return apv.insertId;
}

async function calc(date) {
  return FxRevaluationService.calculate({ companyId, revaluationDate: date, userId: adminUser.id });
}
async function findItem(items, sourceId) {
  return items.find((i) => i.source_id === sourceId);
}

beforeAll(async () => {
  const [orphanedUsers] = await pool.execute("SELECT id FROM users WHERE username = 'test_admin_4_fxr'");
  if (orphanedUsers.length) {
    const orphanedUserId = orphanedUsers[0].id;
    const [orphanedCompanies] = await pool.execute("SELECT company_id FROM user_companies WHERE user_id = ?", [orphanedUserId]);
    for (const { company_id: oc } of orphanedCompanies) {
      await pool.execute("DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE source_reference_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?))", [oc]);
      await pool.execute("DELETE FROM fx_revaluation_items WHERE session_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?)", [oc]);
      await pool.execute("DELETE FROM fx_revaluation_sessions WHERE company_id = ?", [oc]);
      // company_fx_accounts references chart_of_accounts - must be cleared
      // before the chart_of_accounts cleanup a few lines below, or that
      // DELETE fails on the FK (the exact issue that blocked this file's
      // first live rerun after an interrupted prior run left this row
      // pointing at TEST4 accounts).
      await pool.execute("DELETE FROM company_fx_accounts WHERE company_id = ?", [oc]);
      await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [oc]);
      await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [oc]);
      await pool.execute("DELETE FROM currencies WHERE company_id = ?", [oc]);
      await pool.execute("DELETE FROM user_companies WHERE company_id = ?", [oc]);
      await pool.execute("DELETE FROM companies WHERE id = ?", [oc]);
    }
    await pool.execute("DELETE FROM users WHERE id = ?", [orphanedUserId]);
  }
  // Direct safety net, independent of the user-based orphan detection
  // above: if a PRIOR run's cleanup was interrupted partway through (e.g.
  // the user row got deleted but company_fx_accounts/chart_of_accounts
  // survived), the user-lookup above finds nothing and this class of
  // orphan would otherwise silently block every future run's chart_of_accounts
  // cleanup on the same FK forever. Clear any company_fx_accounts row
  // still pointing at a TEST4-prefixed account BEFORE that cleanup runs,
  // regardless of whether an orphaned user was found.
  await pool.execute(
    "DELETE FROM company_fx_accounts WHERE realized_fx_gain_account_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TEST4%') OR realized_fx_loss_account_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TEST4%') OR unrealized_fx_gain_account_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TEST4%') OR unrealized_fx_loss_account_id IN (SELECT id FROM chart_of_accounts WHERE code LIKE 'TEST4%')"
  );
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST4%'");
  await pool.execute("DELETE FROM general_libraries WHERE code IN ('TEST4CUST', 'TEST4SUPP')");

  companyId = await makeCompany("TEST CO - Checkpoint 4 FX Revaluation");
  adminUser = await makeUser("test_admin_4_fxr", 2);

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
  const eur = await CurrencyService.createCurrency(adminUser, {
    currencyCode: "EUR", currencyName: "Euro", currencySymbol: "€",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
  });
  eurId = eur.id;

  arAccountId = await makeAccount("TEST4AR", "Accounts Receivable (Test)", "ASSET");
  apAccountId = await makeAccount("TEST4AP", "Accounts Payable (Test)", "LIABILITY");
  revenueAccountId = await makeAccount("TEST4REV", "Revenue (Test)", "INCOME");
  expenseAccountId = await makeAccount("TEST4EXP", "Expense (Test)", "EXPENSE");
  gainAccountId = await makeAccount("TEST4RGAIN", "Realized FX Gain (Test)", "INCOME");
  lossAccountId = await makeAccount("TEST4RLOSS", "Realized FX Loss (Test)", "EXPENSE");
  unrealizedGainAccountId = await makeAccount("TEST4UGAIN", "Unrealized FX Gain (Test)", "INCOME");
  unrealizedLossAccountId = await makeAccount("TEST4ULOSS", "Unrealized FX Loss (Test)", "EXPENSE");

  await FxAccountService.upsertFxAccounts(adminUser, companyId, {
    gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId,
  });

  const [custResult] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TEST4CUST', 'CUSTOMER', 'TEST4 Customer', 'ACTIVE')", [companyId]);
  testCustomerId = custResult.insertId;
  const [suppResult] = await pool.execute("INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'TEST4SUPP', 'SUPPLIER', 'TEST4 Supplier', 'ACTIVE')", [companyId]);
  testSupplierId = suppResult.insertId;
});

// Removes every invoice/APV this file has created SO FAR after each test
// completes (never mid-test - each test only reads what IT created,
// within its own body, before this fires). This is necessary, not just
// tidy: agingReportService.getAgingRows() (reused unmodified by
// calculate()) recomputes "open" dynamically from transaction_applications
// sums - it does NOT read invoice_headers.balance_amount at all - so nothing
// short of removing the row (or fully applying it via transaction_applications)
// actually excludes a prior test's document from every LATER test's
// calculate() call. Left unfixed, the eligible-item pool grows every
// test, and calculate() reprocessing an ever-growing pile (several
// sequential DB round-trips per item, on top of this environment's
// ~1.5-2s per-query latency) turned what should be a multi-minute suite
// into a multi-hour hang the first time this file was run.
afterEach(async () => {
  const [invs] = await pool.query("SELECT id FROM invoice_headers WHERE customer_name = 'TEST4 Customer'");
  const invIds = invs.map((r) => r.id);
  if (invIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'INV' AND source_id IN (?)", [invIds]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [invIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [invIds]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [invIds]);
  }
  const [apvs] = await pool.query("SELECT id FROM apv_headers WHERE supplier_name = 'TEST4 Supplier'");
  const apvIds = apvs.map((r) => r.id);
  if (apvIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?)", [apvIds]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?)", [apvIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'APV' AND transaction_id IN (?)", [apvIds]);
    await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [apvIds]);
  }
});

afterAll(async () => {
  // FK-safe order: fx_revaluation_sessions.jv_id/reversal_jv_id REFERENCE
  // jv_headers(id) - jv_headers is the PARENT here, so the session rows
  // (the child holding the reference) must be cleared/deleted BEFORE
  // jv_headers, not after.
  const [jvIdsToDelete] = await pool.execute(
    `SELECT id FROM jv_headers WHERE source_module IN ('FX_REVALUATION','FX_REVALUATION_REVERSAL') AND source_reference_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?)`,
    [companyId]
  );
  await pool.execute(
    "DELETE FROM jv_lines WHERE jv_id IN (SELECT id FROM jv_headers WHERE source_module IN ('FX_REVALUATION','FX_REVALUATION_REVERSAL') AND source_reference_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?))",
    [companyId]
  );
  await pool.execute("DELETE FROM fx_revaluation_items WHERE session_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id = ?)", [companyId]);
  await pool.execute("DELETE FROM fx_revaluation_sessions WHERE company_id = ?", [companyId]);
  if (jvIdsToDelete.length) {
    await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIdsToDelete.map((r) => r.id)]);
  }

  if (createdInvoiceIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'INV' AND source_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [createdInvoiceIds]);
  }
  if (createdApvIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'APV' AND transaction_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [createdApvIds]);
  }
  await pool.execute("DELETE FROM company_fx_accounts WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST4%'");
  await pool.execute("DELETE FROM general_libraries WHERE id IN (?, ?)", [testCustomerId, testSupplierId]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("Calculation - AR/AP gain/loss, exclusions, historical As-Of", () => {
  test("1. Receivable gain: closing rate higher than carrying -> Dr AR / Cr Gain", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-01-01" });
    const invId = await makeInvoice({ transactionDate: "2026-01-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 1000, baseTotal: 57000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-01-31" });
    const { items } = await calc("2026-01-31");
    const item = await findItem(items, invId);
    expect(item.direction).toBe("UNREALIZED_GAIN");
    expect(Number(item.unrealized_difference)).toBeCloseTo(1000, 2);
    expect(Number(item.carrying_base_amount)).toBeCloseTo(57000, 2);
    expect(Number(item.closing_base_amount)).toBeCloseTo(58000, 2);
  });

  test("2. Receivable loss: closing rate lower than carrying -> Dr Loss / Cr AR", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-02-01" });
    const invId = await makeInvoice({ transactionDate: "2026-02-01", totalDebit: 58000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 58.0, rateDate: "2026-02-01", foreignTotal: 1000, baseTotal: 58000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-02-28" });
    const { items } = await calc("2026-02-28");
    const item = await findItem(items, invId);
    expect(item.direction).toBe("UNREALIZED_LOSS");
    expect(Number(item.unrealized_difference)).toBeCloseTo(-1000, 2);
  });

  test("3. Payable gain: liability DECREASES -> Dr AP / Cr Gain", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-03-01" });
    const apvId = await makeApv({ transactionDate: "2026-03-01", totalCredit: 58000, currencyId: usdId });
    await insertSnapshot({ transactionType: "APV", transactionId: apvId, currencyId: usdId, currencyCode: "USD", rate: 58.0, rateDate: "2026-03-01", foreignTotal: 1000, baseTotal: 58000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-03-31" });
    const { items } = await calc("2026-03-31");
    const item = await findItem(items, apvId);
    expect(item.direction).toBe("UNREALIZED_GAIN"); // liability shrank = gain for the payer
    expect(Number(item.unrealized_difference)).toBeCloseTo(-1000, 2); // closingBase - carryingBase is negative
  });

  test("4. Payable loss: liability INCREASES -> Dr Loss / Cr AP", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-04-01" });
    const apvId = await makeApv({ transactionDate: "2026-04-01", totalCredit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "APV", transactionId: apvId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-04-01", foreignTotal: 1000, baseTotal: 57000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-04-30" });
    const { items } = await calc("2026-04-30");
    const item = await findItem(items, apvId);
    expect(item.direction).toBe("UNREALIZED_LOSS");
    expect(Number(item.unrealized_difference)).toBeCloseTo(1000, 2);
  });

  test("5. Partial receivable: only the REMAINING open foreign balance is revalued", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-05-01" });
    const invId = await makeInvoice({ transactionDate: "2026-05-01", totalDebit: 57000, currencyId: usdId, paidAmount: 22800, balanceAmount: 34200, paymentStatus: "Partially Paid" });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-05-01", foreignTotal: 1000, baseTotal: 57000 });
    await pool.execute(
      `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date, foreign_amount_applied, source_exchange_rate, payment_exchange_rate)
       VALUES ('INV', ?, 'OR', 1, 22800, '2026-05-10', 400, 57.0, 57.0)`,
      [invId]
    );

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-05-31" });
    const { items } = await calc("2026-05-31");
    const item = await findItem(items, invId);
    expect(Number(item.foreign_balance)).toBeCloseTo(600, 2); // NOT 1000
    expect(Number(item.carrying_base_amount)).toBeCloseTo(34200, 2); // 600 * 57
    expect(Number(item.closing_base_amount)).toBeCloseTo(34800, 2); // 600 * 58
    expect(Number(item.unrealized_difference)).toBeCloseTo(600, 2); // NOT 1000
  });

  test("7. Fully paid items are excluded entirely", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-06-01" });
    const invId = await makeInvoice({ transactionDate: "2026-06-01", totalDebit: 57000, currencyId: usdId, paidAmount: 57000, balanceAmount: 0, paymentStatus: "Paid" });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-06-01", foreignTotal: 1000, baseTotal: 57000 });
    // agingReportService (reused unmodified by calculate()) derives "open"
    // dynamically from transaction_applications, not from the header's own
    // paid_amount/balance_amount columns - a real application row is
    // required to actually simulate "fully settled".
    await pool.execute(
      `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date, foreign_amount_applied, source_exchange_rate, payment_exchange_rate)
       VALUES ('INV', ?, 'OR', 3, 57000, '2026-06-15', 1000, 57.0, 57.0)`,
      [invId]
    );

    const { items } = await calc("2026-06-30");
    expect(await findItem(items, invId)).toBeUndefined();
  });

  test("8. Base-currency (PHP) balances are excluded entirely - never a zero-value item", async () => {
    const invId = await makeInvoice({ transactionDate: "2026-06-05", totalDebit: 5000, currencyId: null });
    const { items } = await calc("2026-06-30");
    expect(await findItem(items, invId)).toBeUndefined();
  });

  test("9. A document dated AFTER the revaluation date is excluded", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-07-01" });
    const invId = await makeInvoice({ transactionDate: "2026-09-02", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-09-02", foreignTotal: 1000, baseTotal: 57000 });

    const { items } = await calc("2026-08-31");
    expect(await findItem(items, invId)).toBeUndefined();
  });

  test("10. Historical As-Of: revaluation BEFORE a later payment sees the FULL original balance", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-07-01" });
    const invId = await makeInvoice({ transactionDate: "2026-07-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-07-01", foreignTotal: 1000, baseTotal: 57000 });
    // Payment happens AFTER the revaluation date being tested.
    await pool.execute(
      `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date, foreign_amount_applied, source_exchange_rate, payment_exchange_rate)
       VALUES ('INV', ?, 'OR', 2, 22800, '2026-09-10', 400, 57.0, 57.5)`,
      [invId]
    );

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-07-31" });
    const { items } = await calc("2026-07-31"); // BEFORE the Sept payment
    const item = await findItem(items, invId);
    expect(Number(item.foreign_balance)).toBeCloseTo(1000, 2); // NOT 600
  });

  test("11/12. Multiple currencies (USD, EUR) each use their OWN closing rate, never combined", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-08-01" });
    await CurrencyService.recordRate(adminUser, eurId, { rateMode: "MANUAL", rate: 63.0, effectiveDate: "2026-08-01" });
    const usdInv = await makeInvoice({ transactionDate: "2026-08-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: usdInv, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-08-01", foreignTotal: 1000, baseTotal: 57000 });
    const eurInv = await makeInvoice({ transactionDate: "2026-08-01", totalDebit: 63000, currencyId: eurId });
    await insertSnapshot({ transactionType: "INV", transactionId: eurInv, currencyId: eurId, currencyCode: "EUR", rate: 63.0, rateDate: "2026-08-01", foreignTotal: 1000, baseTotal: 63000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-08-31" });
    await CurrencyService.recordRate(adminUser, eurId, { rateMode: "MANUAL", rate: 64.0, effectiveDate: "2026-08-31" });
    const { items } = await calc("2026-08-31");
    const usdItem = await findItem(items, usdInv);
    const eurItem = await findItem(items, eurInv);
    expect(Number(usdItem.unrealized_difference)).toBeCloseTo(1000, 2);
    expect(Number(eurItem.unrealized_difference)).toBeCloseTo(1000, 2);
    expect(usdItem.currency_code).toBe("USD");
    expect(eurItem.currency_code).toBe("EUR");
  });

  test("15. No approved rate available -> RATE_REQUIRED, never rate 0/1/stale-arbitrary", async () => {
    const noRateCurrency = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "JPY", currencyName: "Japanese Yen", currencySymbol: "¥",
      decimalPlaces: 0, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    const invId = await makeInvoice({ transactionDate: "2026-09-01", totalDebit: 50000, currencyId: noRateCurrency.id });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: noRateCurrency.id, currencyCode: "JPY", rate: 0.5, rateDate: "2026-09-01", foreignTotal: 100000, baseTotal: 50000 });

    const { session, items } = await calc("2026-09-30");
    const item = await findItem(items, invId);
    expect(item.status).toBe("RATE_REQUIRED");
    expect(item.closing_rate).toBeNull();
    expect(session.status).toBe("RATE_REQUIRED");

    // The global afterEach deletes this test's invoice (and its snapshot)
    // AFTER the test body finishes - too late for this inline currency
    // cleanup, so the snapshot referencing noRateCurrency must be removed
    // here first.
    await pool.execute("DELETE FROM fx_revaluation_items WHERE currency_id = ?", [noRateCurrency.id]);
    await pool.execute("DELETE FROM transaction_currency_snapshots WHERE currency_id = ?", [noRateCurrency.id]);
    await pool.execute("DELETE FROM currency_rates WHERE currency_id = ?", [noRateCurrency.id]);
    await pool.execute("DELETE FROM currencies WHERE id = ?", [noRateCurrency.id]);
  });

  test("16/17. AR and AP Beginning Balances are eligible", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-01-01" });
    const [bbHeader] = await pool.execute("INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status) VALUES (?, 'AR', '2026-01-01', 'PHP', 'PHILIPPINE PESO', 'TEST4', 'Posted')", [companyId]);
    const [bbLine] = await pool.execute(
      `INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, account_code, account_title, account_id, reference_no, due_date, debit, credit, balance_amount, paid_amount, status, currency_id, foreign_original_amount, foreign_paid_amount, foreign_balance_amount)
       VALUES (?, ?, 'TEST4 BB Customer', 'TEST4AR', 'AR', ?, 'TEST4-BB-1', '2026-01-31', 57000, 0, 57000, 0, 'Unpaid', ?, 1000, 0, 1000)`,
      [bbHeader.insertId, testCustomerId, arAccountId, usdId]
    );
    await insertSnapshot({ transactionType: "AR_BEGINNING", transactionId: bbLine.insertId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-01-01", foreignTotal: 1000, baseTotal: 57000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-10-31" });
    const { items } = await calc("2026-10-31");
    const item = await findItem(items, bbLine.insertId);
    expect(item).toBeDefined();
    expect(item.ar_ap_type).toBe("AR");
    expect(Number(item.unrealized_difference)).toBeCloseTo(1000, 2);

    await pool.execute("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'AR_BEGINNING' AND transaction_id = ?", [bbLine.insertId]);
    await pool.execute("DELETE FROM arap_beginning_balance_lines WHERE id = ?", [bbLine.insertId]);
    await pool.execute("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [bbHeader.insertId]);
  });

  test("19/20. Historical rate on the source snapshot is NEVER modified by revaluation", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-11-01" });
    const invId = await makeInvoice({ transactionDate: "2026-11-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-11-01", foreignTotal: 1000, baseTotal: 57000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 60.0, effectiveDate: "2026-11-30" });
    const { items } = await calc("2026-11-30");
    const item = await findItem(items, invId);
    expect(Number(item.closing_rate)).toBeCloseTo(60.0, 4);

    const [snapRows] = await pool.execute("SELECT exchange_rate AS rate FROM transaction_currency_snapshots WHERE transaction_type='INV' AND transaction_id = ?", [invId]);
    expect(Number(snapRows[0].rate)).toBe(57.0); // unchanged
    const [invRows] = await pool.execute("SELECT total_debit AS totalDebit FROM invoice_headers WHERE id = ?", [invId]);
    expect(Number(invRows[0].totalDebit)).toBe(57000); // unchanged
  });
});

describe("Posting", () => {
  test("21-25. Balanced JV posted with correct AR/AP direction and gain/loss accounts", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-12-01" });
    const invId = await makeInvoice({ transactionDate: "2026-12-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-12-01", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2026-12-31" });

    const { session } = await calc("2026-12-31");
    expect(session.status).toBe("CALCULATED");
    const result = await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });
    expect(result.status).toBe("POSTED");
    expect(result.jvId).toBeTruthy();

    const [lines] = await pool.execute("SELECT * FROM jv_lines WHERE jv_id = ?", [result.jvId]);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2); // balanced

    const arLine = lines.find((l) => l.account_id === arAccountId);
    const gainLine = lines.find((l) => l.account_id === unrealizedGainAccountId);
    expect(Number(arLine.debit)).toBeCloseTo(1000, 2); // Dr AR
    expect(Number(gainLine.credit)).toBeCloseTo(1000, 2); // Cr Gain

    const [jvHeader] = await pool.execute("SELECT source_module AS sourceModule, source_reference_id AS sourceReferenceId, status FROM jv_headers WHERE id = ?", [result.jvId]);
    expect(jvHeader[0].sourceModule).toBe("FX_REVALUATION");
    expect(jvHeader[0].sourceReferenceId).toBe(session.id);
    expect(jvHeader[0].status).toBe("Posted");
  });

  test("26. Missing Unrealized FX account blocks posting", async () => {
    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId, unrealizedGainAccountId: null, unrealizedLossAccountId: null });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-12-05" });
    const invId = await makeInvoice({ transactionDate: "2026-12-05", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2026-12-05", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-01-15" });

    const { session } = await calc("2027-01-15");
    await expect(FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId })).rejects.toMatchObject({ statusCode: 422 });

    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId, unrealizedGainAccountId, unrealizedLossAccountId });
  });

  test("28. Duplicate posting: posting an already-POSTED session returns the SAME journal, no duplicate", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-02-01" });
    const invId = await makeInvoice({ transactionDate: "2027-02-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-02-01", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-02-28" });

    const { session } = await calc("2027-02-28");
    const first = await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });
    const second = await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });
    expect(second.status).toBe("ALREADY_POSTED");
    expect(second.jvId).toBe(first.jvId);

    const [jvCount] = await pool.execute("SELECT COUNT(*) AS c FROM jv_headers WHERE source_module = 'FX_REVALUATION' AND source_reference_id = ?", [session.id]);
    expect(jvCount[0].c).toBe(1);
  });

  test("29. Concurrent posting: two simultaneous post() calls produce exactly ONE journal", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-03-01" });
    const invId = await makeInvoice({ transactionDate: "2027-03-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-03-01", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-03-31" });

    const { session } = await calc("2027-03-31");
    const [r1, r2] = await Promise.all([
      FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId }),
      FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["ALREADY_POSTED", "POSTED"]);
    const [jvCount] = await pool.execute("SELECT COUNT(*) AS c FROM jv_headers WHERE source_module = 'FX_REVALUATION' AND source_reference_id = ?", [session.id]);
    expect(jvCount[0].c).toBe(1);
  });

  test("30/31/32. Posted session is immutable, audit created, journal linkage preserved", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-04-01" });
    const invId = await makeInvoice({ transactionDate: "2027-04-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-04-01", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-04-30" });

    const { session } = await calc("2027-04-30");
    const result = await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });

    await expect(calc("2027-04-30")).rejects.toMatchObject({ statusCode: 409 }); // cannot recalculate a POSTED session

    const [auditRows] = await pool.execute(
      "SELECT action FROM audit_logs WHERE module = 'FX_REVALUATION' AND entity_id = ? AND action = 'FX_REVALUATION_POSTED'",
      [session.id]
    );
    expect(auditRows.length).toBeGreaterThan(0);

    const detail = await FxRevaluationService.getSessionDetail(session.id, companyId);
    expect(detail.session.jv_id).toBe(result.jvId);
    expect(detail.items.every((i) => i.status === "POSTED")).toBe(true);
  });

  test("Reversal: original journal preserved, reversal journal created, carrying basis reverts", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-05-01" });
    const invId = await makeInvoice({ transactionDate: "2027-05-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-05-01", foreignTotal: 1000, baseTotal: 57000 });
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-05-31" });

    const { session } = await calc("2027-05-31");
    const posted = await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });

    const carryingBefore = await FxRevaluationService.getCarryingBasis(pool, "INV", invId, "2027-06-30");
    expect(carryingBefore.rate).toBeCloseTo(58.0, 4);

    const reversed = await FxRevaluationService.reverse({ sessionId: session.id, userId: adminUser.id, companyId });
    expect(reversed.status).toBe("REVERSED");
    expect(reversed.reversalJvId).toBeTruthy();

    const [origJv] = await pool.execute("SELECT status FROM jv_headers WHERE id = ?", [posted.jvId]);
    expect(origJv[0].status).toBe("Posted"); // original journal untouched, never deleted

    const [reversalLines] = await pool.execute("SELECT * FROM jv_lines WHERE jv_id = ?", [reversed.reversalJvId]);
    const [origLines] = await pool.execute("SELECT * FROM jv_lines WHERE jv_id = ?", [posted.jvId]);
    expect(reversalLines.length).toBe(origLines.length);

    // A REVERSED session is excluded from carrying-basis lookups.
    const carryingAfter = await FxRevaluationService.getCarryingBasis(pool, "INV", invId, "2027-06-30");
    expect(carryingAfter).toBeNull();
  });
});

describe("CRITICAL: multi-period no double-counting", () => {
  test("33. Two consecutive month-ends: the second only posts the INCREMENTAL movement", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-07-01" });
    const invId = await makeInvoice({ transactionDate: "2027-07-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-07-01", foreignTotal: 1000, baseTotal: 57000 });

    // July close: 58.00 -> gain 1000.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-07-31" });
    const julyCalc = await calc("2027-07-31");
    const julyItem = await findItem(julyCalc.items, invId);
    expect(Number(julyItem.unrealized_difference)).toBeCloseTo(1000, 2);
    await FxRevaluationService.post({ sessionId: julyCalc.session.id, userId: adminUser.id, companyId });

    // August close: 58.50 -> INCREMENTAL movement from the July carrying
    // basis (58.00) must be only 500, NOT a re-posted 1500.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.5, effectiveDate: "2027-08-31" });
    const augustCalc = await calc("2027-08-31");
    const augustItem = await findItem(augustCalc.items, invId);
    expect(Number(augustItem.carrying_rate)).toBeCloseTo(58.0, 4); // carried forward from July, not the original 57
    expect(Number(augustItem.carrying_base_amount)).toBeCloseTo(58000, 2);
    expect(Number(augustItem.closing_base_amount)).toBeCloseTo(58500, 2);
    expect(Number(augustItem.unrealized_difference)).toBeCloseTo(500, 2); // NOT 1500

    const augustPost = await FxRevaluationService.post({ sessionId: augustCalc.session.id, userId: adminUser.id, companyId });
    const [augustLines] = await pool.execute("SELECT * FROM jv_lines WHERE jv_id = ?", [augustPost.jvId]);
    const arLine = augustLines.find((l) => l.account_id === arAccountId);
    expect(Number(arLine.debit)).toBeCloseTo(500, 2); // only the incremental 500, not the cumulative 1500
  });
});

describe("CRITICAL: settlement after revaluation - no double-counting of realized + unrealized FX", () => {
  test("34. Full settlement after revaluation: realized FX measures from the CARRYING rate, not the original rate", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-09-01" });
    const invId = await makeInvoice({ transactionDate: "2027-09-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-09-01", foreignTotal: 1000, baseTotal: 57000 });

    // Month-end revaluation to 58.00 -> unrealized gain 1000, POSTED.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-09-30" });
    const { session } = await calc("2027-09-30");
    await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });

    // Later, full settlement at 58.50.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceType: "INV", sourceId: invId, amount: 1000, applicationDate: "2027-10-15" },
        appliedType: "OR", appliedId: 900010, paymentCurrencyCode: "USD", paymentExchangeRate: 58.5,
        baseCurrencyCode: "PHP", isPosting: true, companyId,
      });
      await conn.commit();

      // Realized FX must be measured from the CARRYING rate (58.00, from
      // the September revaluation), NOT the original historical rate
      // (57.00) - otherwise the 1000 already recognized as unrealized
      // gain in September would be recognized AGAIN here.
      expect(result.sourceExchangeRate).toBeCloseTo(58.0, 4);
      expect(result.sourceBaseAmount).toBeCloseTo(58000, 2); // 1000 * 58 (carrying), not 57000
      expect(result.fxDifference).toBeCloseTo(500, 2); // (58.50 - 58.00) * 1000, NOT (58.50-57.00)*1000=1500
      expect(result.fxDirection).toBe("REALIZED_GAIN");

      // Combined: September unrealized (1000) + October realized (500) = 1500 total,
      // matching the TRUE total movement from 57.00 to 58.50 - not 2500 (double-counted).
      const totalRecognized = Number(session.total_gain) - Number(session.total_loss) + result.fxDifference;
      expect(totalRecognized).toBeCloseTo(1500, 2);
    } finally {
      conn.release();
    }

    // The invoice's own historical rate/base never changed.
    const [snapRows] = await pool.execute("SELECT exchange_rate AS rate FROM transaction_currency_snapshots WHERE transaction_type='INV' AND transaction_id = ?", [invId]);
    expect(Number(snapRows[0].rate)).toBe(57.0);
  });

  test("35. Partial settlement after revaluation: remaining balance correctly excludes the settled portion for future revaluation", async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2027-11-01" });
    const invId = await makeInvoice({ transactionDate: "2027-11-01", totalDebit: 57000, currencyId: usdId });
    await insertSnapshot({ transactionType: "INV", transactionId: invId, currencyId: usdId, currencyCode: "USD", rate: 57.0, rateDate: "2027-11-01", foreignTotal: 1000, baseTotal: 57000 });

    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58.0, effectiveDate: "2027-11-30" });
    const { session } = await calc("2027-11-30");
    await FxRevaluationService.post({ sessionId: session.id, userId: adminUser.id, companyId });

    // Partial settlement of $400 at 58.50.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceType: "INV", sourceId: invId, amount: 400, applicationDate: "2027-12-05" },
        appliedType: "OR", appliedId: 900011, paymentCurrencyCode: "USD", paymentExchangeRate: 58.5,
        baseCurrencyCode: "PHP", isPosting: true, companyId,
      });
      await conn.commit();
      expect(result.sourceExchangeRate).toBeCloseTo(58.0, 2); // carrying rate, not original
    } finally {
      conn.release();
    }

    // Next revaluation only sees the remaining $600.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 59.0, effectiveDate: "2027-12-31" });
    const decCalc = await calc("2027-12-31");
    const decItem = await findItem(decCalc.items, invId);
    expect(Number(decItem.foreign_balance)).toBeCloseTo(600, 2);
    expect(Number(decItem.carrying_rate)).toBeCloseTo(58.0, 2);
    expect(Number(decItem.carrying_base_amount)).toBeCloseTo(34800, 2); // 600 * 58
    expect(Number(decItem.closing_base_amount)).toBeCloseTo(35400, 2); // 600 * 59
    expect(Number(decItem.unrealized_difference)).toBeCloseTo(600, 2); // NOT counting the settled 400 again
  });
});