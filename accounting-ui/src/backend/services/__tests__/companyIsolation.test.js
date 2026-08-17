const pool = require("../../db");
const CurrencyService = require("../currencyService");
const AgingReportService = require("../agingReportService");
const FxRevaluationService = require("../fxRevaluationService");
const FxAccountService = require("../fxAccountService");
const PaymentApplicationService = require("../paymentApplicationService");
const LedgerReportService = require("../LedgerReportService");
const TrialBalanceDifferenceService = require("../trialBalanceDifferenceService");
const TemplateService = require("../recurringTemplateService");
const TransactionCurrencyService = require("../transactionCurrencyService");

// Checkpoint 4H: Company Isolation & Accounting Report Integrity Hardening.
// Two fully independent companies (A/B) are built from scratch so every
// test below can assert the actual regression this checkpoint fixes:
// Company B's dirty/incomplete data must have ZERO effect on Company A's
// calculations, and vice versa. Section 34's exact scenario (a missing
// closing rate in one company blocking another company's revaluation) is
// reproduced as an automated test, not just documented.

jest.setTimeout(90000);

let companyAId, companyBId;
let adminA, adminB;
let phpA, usdA, phpB, usdB;
let arA, apA, arB, apB;
let gainA, lossA, ugainA, ulossA, gainB, lossB, ugainB, ulossB;
const createdInvoiceIds = [];
const createdApvIds = [];
const createdOrIds = [];
const createdCvIds = [];
const createdJvIds = [];
const createdAccountIds = [];
const createdPartyIds = [];
const createdTemplateIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', 2, 'ACTIVE')",
    [username]
  );
  const userId = result.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return { id: userId, roleCode: "NON_SUPER" };
}

async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  createdAccountIds.push(result.insertId);
  return result.insertId;
}

async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  createdPartyIds.push(result.insertId);
  return result.insertId;
}

let seq = 0;
async function makeInvoice({ companyId, customerId, arAccountId, transactionDate, totalDebit, currencyId = null }) {
  seq++;
  const [inv] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, 'TEST4H Customer', ?, ?, 0, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TEST4H-INV-${Date.now()}-${seq}`, customerId, transactionDate, totalDebit, totalDebit, currencyId]
  );
  createdInvoiceIds.push(inv.insertId);
  await pool.execute(
    `INSERT INTO invoice_lines (invoice_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4HAR', 'Accounts Receivable (Test)', 'x', ?, 0, ?, 0)`,
    [inv.insertId, arAccountId, totalDebit, currencyId ? totalDebit : null]
  );
  return inv.insertId;
}

async function makeApv({ companyId, supplierId, apAccountId, transactionDate, totalCredit, currencyId = null }) {
  seq++;
  const [apv] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, ?, 'TEST4H Supplier', ?, 0, ?, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TEST4H-APV-${Date.now()}-${seq}`, supplierId, transactionDate, totalCredit, totalCredit, currencyId]
  );
  createdApvIds.push(apv.insertId);
  await pool.execute(
    `INSERT INTO apv_lines (apv_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, 'TEST4HAP', 'Accounts Payable (Test)', 'x', 0, ?, 0, ?)`,
    [apv.insertId, apAccountId, totalCredit, currencyId ? totalCredit : null]
  );
  return apv.insertId;
}

async function insertSnapshot({ companyId, transactionType, transactionId, currencyId, currencyCode, baseCurrencyId, rate, rateDate, foreignTotal, baseTotal }) {
  await pool.execute(
    `INSERT INTO transaction_currency_snapshots
      (company_id, transaction_type, transaction_id, currency_id, currency_code, base_currency_id, base_currency_code, exchange_rate, rate_date, rate_source, rate_locked, foreign_total, base_total)
     VALUES (?, ?, ?, ?, ?, ?, 'PHP', ?, ?, 'MANUAL', 1, ?, ?)`,
    [companyId, transactionType, transactionId, currencyId, currencyCode, baseCurrencyId, rate, rateDate, foreignTotal, baseTotal]
  );
}

async function makeJv({ companyId, transactionDate, accountId, amount }) {
  const voucherNo = `TEST4H-JV-${Date.now()}-${++seq}`;
  const [jv] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, reference_no, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, '', 'Isolation test JV', ?, ?, 'Posted')`,
    [companyId, voucherNo, transactionDate, amount, amount]
  );
  createdJvIds.push(jv.insertId);
  await pool.execute(
    `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
     VALUES (?, ?, 'TEST4HJVACC', 'JV Test Account', 'x', ?, 0)`,
    [jv.insertId, accountId, amount]
  );
  await pool.execute(
    `INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit)
     VALUES (?, ?, 'TEST4HJVACC2', 'JV Test Contra Account', 'x', 0, ?)`,
    [jv.insertId, accountId, amount]
  );
  return jv.insertId;
}

beforeAll(async () => {
  companyAId = await makeCompany("TEST CO 4H - Company A");
  companyBId = await makeCompany("TEST CO 4H - Company B");
  adminA = await makeUser("test_admin_4h_a", companyAId);
  adminB = await makeUser("test_admin_4h_b", companyBId);

  const phpAObj = await CurrencyService.createCurrency(adminA, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyAId,
  });
  phpA = phpAObj.id;
  const usdAObj = await CurrencyService.createCurrency(adminA, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyAId,
  });
  usdA = usdAObj.id;

  const phpBObj = await CurrencyService.createCurrency(adminB, {
    currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true, companyId: companyBId,
  });
  phpB = phpBObj.id;
  const usdBObj = await CurrencyService.createCurrency(adminB, {
    currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId: companyBId,
  });
  usdB = usdBObj.id;

  arA = await makeAccount("TEST4HAR-A", "Accounts Receivable A (Test)", "ASSET");
  apA = await makeAccount("TEST4HAP-A", "Accounts Payable A (Test)", "LIABILITY");
  gainA = await makeAccount("TEST4HRGAIN-A", "Realized FX Gain A (Test)", "INCOME");
  lossA = await makeAccount("TEST4HRLOSS-A", "Realized FX Loss A (Test)", "EXPENSE");
  ugainA = await makeAccount("TEST4HUGAIN-A", "Unrealized FX Gain A (Test)", "INCOME");
  ulossA = await makeAccount("TEST4HULOSS-A", "Unrealized FX Loss A (Test)", "EXPENSE");

  arB = await makeAccount("TEST4HAR-B", "Accounts Receivable B (Test)", "ASSET");
  apB = await makeAccount("TEST4HAP-B", "Accounts Payable B (Test)", "LIABILITY");
  gainB = await makeAccount("TEST4HRGAIN-B", "Realized FX Gain B (Test)", "INCOME");
  lossB = await makeAccount("TEST4HRLOSS-B", "Realized FX Loss B (Test)", "EXPENSE");
  ugainB = await makeAccount("TEST4HUGAIN-B", "Unrealized FX Gain B (Test)", "INCOME");
  ulossB = await makeAccount("TEST4HULOSS-B", "Unrealized FX Loss B (Test)", "EXPENSE");

  await FxAccountService.upsertFxAccounts(adminA, companyAId, {
    gainAccountId: gainA, lossAccountId: lossA, unrealizedGainAccountId: ugainA, unrealizedLossAccountId: ulossA,
  });
  await FxAccountService.upsertFxAccounts(adminB, companyBId, {
    gainAccountId: gainB, lossAccountId: lossB, unrealizedGainAccountId: ugainB, unrealizedLossAccountId: ulossB,
  });
});

afterAll(async () => {
  if (createdInvoiceIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'INV' AND source_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'INV' AND transaction_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM fx_revaluation_items WHERE source_type = 'INV' AND source_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM invoice_lines WHERE invoice_id IN (?)", [createdInvoiceIds]);
    await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [createdInvoiceIds]);
  }
  if (createdApvIds.length) {
    await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM transaction_currency_snapshots WHERE transaction_type = 'APV' AND transaction_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM fx_revaluation_items WHERE source_type = 'APV' AND source_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM apv_lines WHERE apv_id IN (?)", [createdApvIds]);
    await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [createdApvIds]);
  }
  if (createdOrIds.length) {
    await pool.query("DELETE FROM or_lines WHERE or_id IN (?)", [createdOrIds]);
    await pool.query("DELETE FROM or_headers WHERE id IN (?)", [createdOrIds]);
  }
  if (createdCvIds.length) {
    await pool.query("DELETE FROM cv_lines WHERE cv_id IN (?)", [createdCvIds]);
    await pool.query("DELETE FROM cv_headers WHERE id IN (?)", [createdCvIds]);
  }
  if (createdJvIds.length) {
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [createdJvIds]);
    await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [createdJvIds]);
  }
  await pool.execute("DELETE FROM fx_revaluation_items WHERE session_id IN (SELECT id FROM fx_revaluation_sessions WHERE company_id IN (?, ?))", [companyAId, companyBId]);
  const [fxSessionsForCleanup] = await pool.execute("SELECT id, jv_id, reversal_jv_id FROM fx_revaluation_sessions WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.execute("DELETE FROM fx_revaluation_sessions WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  const fxSessionJvIds = fxSessionsForCleanup.flatMap((s) => [s.jv_id, s.reversal_jv_id]).filter(Boolean);
  if (fxSessionJvIds.length) {
    await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [fxSessionJvIds]);
    await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [fxSessionJvIds]);
  }
  await pool.execute("DELETE FROM company_fx_accounts WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  if (createdTemplateIds.length) {
    await pool.query("DELETE FROM recurring_transaction_occurrences WHERE schedule_id IN (SELECT id FROM recurring_transaction_schedules WHERE template_id IN (?))", [createdTemplateIds]);
    await pool.query("DELETE FROM recurring_transaction_schedules WHERE template_id IN (?)", [createdTemplateIds]);
    await pool.query("DELETE FROM recurring_transaction_template_lines WHERE template_id IN (?)", [createdTemplateIds]);
    await pool.query("DELETE FROM recurring_transaction_templates WHERE id IN (?)", [createdTemplateIds]);
  }
  if (createdPartyIds.length) {
    await pool.query("DELETE FROM general_libraries WHERE id IN (?)", [createdPartyIds]);
  }
  await pool.execute("DELETE FROM currency_rates WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  await pool.execute("DELETE FROM currencies WHERE company_id IN (?, ?)", [companyAId, companyBId]);
  if (createdAccountIds.length) {
    await pool.query("DELETE FROM chart_of_accounts WHERE id IN (?)", [createdAccountIds]);
  }
  await pool.execute("DELETE FROM user_companies WHERE user_id IN (?, ?)", [adminA.id, adminB.id]);
  await pool.execute("DELETE FROM users WHERE id IN (?, ?)", [adminA.id, adminB.id]);
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

describe("AR/AP Aging isolation", () => {
  test("33. Company A aging never includes Company B invoices/APVs", async () => {
    const custA = await makeParty("TEST4H-CUSTA", "CUSTOMER", "Company A Customer", companyAId);
    const custB = await makeParty("TEST4H-CUSTB", "CUSTOMER", "Company B Customer", companyBId);
    const invA = await makeInvoice({ companyId: companyAId, customerId: custA, arAccountId: arA, transactionDate: "2026-06-01", totalDebit: 1000 });
    const invB = await makeInvoice({ companyId: companyBId, customerId: custB, arAccountId: arB, transactionDate: "2026-06-01", totalDebit: 2000 });

    const rowsA = await AgingReportService.getAgingRows("AR", { companyId: companyAId, asOfDate: "2026-06-30", status: "OPEN" });
    const rowsB = await AgingReportService.getAgingRows("AR", { companyId: companyBId, asOfDate: "2026-06-30", status: "OPEN" });

    expect(rowsA.some((r) => r.sourceId === invA)).toBe(true);
    expect(rowsA.some((r) => r.sourceId === invB)).toBe(false);
    expect(rowsB.some((r) => r.sourceId === invB)).toBe(true);
    expect(rowsB.some((r) => r.sourceId === invA)).toBe(false);
  });

  test("getAgingRows throws rather than silently returning all companies when companyId is omitted", async () => {
    await expect(AgingReportService.getAgingRows("AR", { asOfDate: "2026-06-30" })).rejects.toThrow(/companyId/);
  });
});

describe("CRITICAL: FX revaluation isolation (the exact Checkpoint 4 regression)", () => {
  test("34. Company B's missing closing rate does not block Company A's revaluation; Company B correctly becomes RATE_REQUIRED on its own", async () => {
    const custA = await makeParty("TEST4H-FXCUSTA", "CUSTOMER", "FX Company A Customer", companyAId);
    const custB = await makeParty("TEST4H-FXCUSTB", "CUSTOMER", "FX Company B Customer", companyBId);

    // Company A: a valid USD invoice with BOTH a historical rate and a closing rate available.
    await CurrencyService.recordRate(adminA, usdA, { rateMode: "MANUAL", rate: 56.0, effectiveDate: "2026-05-01" });
    const invA = await makeInvoice({ companyId: companyAId, customerId: custA, arAccountId: arA, transactionDate: "2026-05-01", totalDebit: 56000, currencyId: usdA });
    await insertSnapshot({ companyId: companyAId, transactionType: "INV", transactionId: invA, currencyId: usdA, currencyCode: "USD", baseCurrencyId: phpA, rate: 56.0, rateDate: "2026-05-01", foreignTotal: 1000, baseTotal: 56000 });
    await CurrencyService.recordRate(adminA, usdA, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-05-31" });

    // Company B: a USD invoice with NO closing rate ever recorded - this
    // is exactly what broke the original Checkpoint 4 regression (an
    // unrelated company's rate-less foreign document leaking into every
    // company's revaluation via an unscoped aging query).
    const invB = await makeInvoice({ companyId: companyBId, customerId: custB, arAccountId: arB, transactionDate: "2026-05-01", totalDebit: 114000, currencyId: usdB });
    await insertSnapshot({ companyId: companyBId, transactionType: "INV", transactionId: invB, currencyId: usdB, currencyCode: "USD", baseCurrencyId: phpB, rate: 57.0, rateDate: "2026-05-01", foreignTotal: 2000, baseTotal: 114000 });
    // Deliberately NO CurrencyService.recordRate call for usdB at all.

    const resultA = await FxRevaluationService.calculate({ companyId: companyAId, revaluationDate: "2026-05-31", userId: adminA.id });
    expect(resultA.session.status).toBe("CALCULATED");

    const resultB = await FxRevaluationService.calculate({ companyId: companyBId, revaluationDate: "2026-05-31", userId: adminB.id });
    expect(resultB.session.status).toBe("RATE_REQUIRED");

    // Company A's own session must be postable and unaffected by B.
    const postResult = await FxRevaluationService.post({ sessionId: resultA.session.id, userId: adminA.id, companyId: companyAId });
    expect(postResult.status).toBe("POSTED");
  });

  test("20. Posting/reversing/viewing a session from the wrong company is rejected as not-found", async () => {
    const custA = await makeParty("TEST4H-FXCUSTA2", "CUSTOMER", "FX Company A Customer 2", companyAId);
    await CurrencyService.recordRate(adminA, usdA, { rateMode: "MANUAL", rate: 56.0, effectiveDate: "2026-06-01" });
    const invA = await makeInvoice({ companyId: companyAId, customerId: custA, arAccountId: arA, transactionDate: "2026-06-01", totalDebit: 56000, currencyId: usdA });
    await insertSnapshot({ companyId: companyAId, transactionType: "INV", transactionId: invA, currencyId: usdA, currencyCode: "USD", baseCurrencyId: phpA, rate: 56.0, rateDate: "2026-06-01", foreignTotal: 1000, baseTotal: 56000 });
    await CurrencyService.recordRate(adminA, usdA, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-06-30" });

    const { session } = await FxRevaluationService.calculate({ companyId: companyAId, revaluationDate: "2026-06-30", userId: adminA.id });

    await expect(FxRevaluationService.post({ sessionId: session.id, userId: adminB.id, companyId: companyBId })).rejects.toMatchObject({ statusCode: 404 });
    await expect(FxRevaluationService.getSessionDetail(session.id, companyBId)).rejects.toMatchObject({ statusCode: 404 });

    const postedA = await FxRevaluationService.post({ sessionId: session.id, userId: adminA.id, companyId: companyAId });
    expect(postedA.status).toBe("POSTED");
    await expect(FxRevaluationService.reverse({ sessionId: session.id, userId: adminB.id, companyId: companyBId })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Cross-company payment application rejection", () => {
  test("13. An OR cannot be applied against another company's invoice", async () => {
    const custB = await makeParty("TEST4H-PAYCUSTB", "CUSTOMER", "Pay Company B Customer", companyBId);
    const invB = await makeInvoice({ companyId: companyBId, customerId: custB, arAccountId: arB, transactionDate: "2026-06-01", totalDebit: 1000 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await expect(
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invB, amount: 500 },
          appliedType: "OR",
          appliedId: 999999,
          paymentCurrencyCode: "PHP",
          paymentExchangeRate: 1,
          baseCurrencyCode: "PHP",
          isPosting: false,
          companyId: companyAId, // Company A's OR trying to pay Company B's invoice.
        })
      ).rejects.toThrow(/does not belong to this company/);
      await conn.rollback();
    } finally {
      conn.release();
    }
  });

  test("13. A CV cannot be applied against another company's APV", async () => {
    const suppB = await makeParty("TEST4H-PAYSUPPB", "SUPPLIER", "Pay Company B Supplier", companyBId);
    const apvB = await makeApv({ companyId: companyBId, supplierId: suppB, apAccountId: apB, transactionDate: "2026-06-01", totalCredit: 1000 });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await expect(
        PaymentApplicationService.applyApvPayment(conn, {
          appItem: { sourceId: apvB, amount: 500 },
          appliedType: "CV",
          appliedId: 999999,
          paymentCurrencyCode: "PHP",
          paymentExchangeRate: 1,
          baseCurrencyCode: "PHP",
          isPosting: false,
          companyId: companyAId, // Company A's CV trying to pay Company B's APV.
        })
      ).rejects.toThrow(/does not belong to this company/);
      await conn.rollback();
    } finally {
      conn.release();
    }
  });
});

describe("General Ledger / Trial Balance report isolation", () => {
  test("23/24. GL and Trial Balance for Company A contain zero Company B activity", async () => {
    const jvA = await makeJv({ companyId: companyAId, transactionDate: "2026-06-15", accountId: arA, amount: 777 });
    const jvB = await makeJv({ companyId: companyBId, transactionDate: "2026-06-15", accountId: arB, amount: 888 });

    const [ledgerA, ledgerB] = await Promise.all([
      LedgerReportService.getLedgerRows({ from: "2026-06-01", to: "2026-06-30", accountCodes: null, companyId: companyAId }),
      LedgerReportService.getLedgerRows({ from: "2026-06-01", to: "2026-06-30", accountCodes: null, companyId: companyBId }),
    ]);
    expect(ledgerA.some((r) => Number(r.debit) === 777 || Number(r.credit) === 777)).toBe(true);
    expect(ledgerA.some((r) => Number(r.debit) === 888 || Number(r.credit) === 888)).toBe(false);
    expect(ledgerB.some((r) => Number(r.debit) === 888 || Number(r.credit) === 888)).toBe(true);
    expect(ledgerB.some((r) => Number(r.debit) === 777 || Number(r.credit) === 777)).toBe(false);

    const [tbA, tbB] = await Promise.all([
      TrialBalanceDifferenceService.getTrialBalanceRows({ from: "2026-06-01", to: "2026-06-30", companyId: companyAId }),
      TrialBalanceDifferenceService.getTrialBalanceRows({ from: "2026-06-01", to: "2026-06-30", companyId: companyBId }),
    ]);
    expect(tbA.some((r) => r.account_code === "TEST4HJVACC" && Number(r.debit) === 777)).toBe(true);
    expect(tbB.some((r) => r.account_code === "TEST4HJVACC" && Number(r.debit) === 777)).toBe(false);
    expect(tbB.some((r) => r.account_code === "TEST4HJVACC" && Number(r.debit) === 888)).toBe(true);
  });
});

describe("Recurring template isolation", () => {
  test("21/38. A template created for Company A is invisible and inaccessible from Company B's context", async () => {
    const custA = await makeParty("TEST4H-RECCUSTA", "CUSTOMER", "Rec Company A Customer", companyAId);
    const created = await TemplateService.createTemplate(
      {
        moduleType: "invoice",
        templateName: `TEST4H Recurring ${Date.now()}`,
        partyId: custA,
        partyName: "Rec Company A Customer",
        descriptionTemplate: "x",
        currency: "PHP",
        currencyId: null,
        amountMode: "FIXED",
        amountConfig: {},
        dueDateRule: { mode: "SAME_AS_TRANSACTION_DATE" },
        lines: [
          { accountId: arA, accountCode: "TEST4HAR-A", accountTitle: "AR", particularsTemplate: "x", debit: 100, credit: 0 },
          { accountId: arA, accountCode: "TEST4HAR-A", accountTitle: "AR", particularsTemplate: "x", debit: 0, credit: 100 },
        ],
        schedule: { frequency: "MONTHLY", startDate: "2026-07-01", dateAdjustmentRule: "KEEP_ORIGINAL" },
      },
      adminA.id,
      companyAId
    );
    createdTemplateIds.push(created.templateId);

    await expect(TemplateService.getTemplateById(created.templateId, companyBId)).rejects.toMatchObject({ statusCode: 404 });
    const detailA = await TemplateService.getTemplateById(created.templateId, companyAId);
    expect(detailA.template.id).toBe(created.templateId);

    const listB = await TemplateService.listTemplates({ companyId: companyBId });
    expect(listB.some((t) => t.id === created.templateId)).toBe(false);
    const listA = await TemplateService.listTemplates({ companyId: companyAId });
    expect(listA.some((t) => t.id === created.templateId)).toBe(true);
  });
});