const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");
const GLBeginningBalanceService = require("../GLBeginningBalanceService");
const BeginningBalanceCurrencyService = require("../beginningBalanceCurrencyService");
const PaymentApplicationService = require("../paymentApplicationService");
const FxAccountService = require("../fxAccountService");

// Checkpoint 3D Part A: GL/AR/AP Beginning Balance multi-currency, plus
// foreign AR/AP beginning balance settlement via the SAME buildApplication/
// realized-FX engine Checkpoint 3FX already built and verified - no second
// FX engine here.

jest.setTimeout(45000);

let companyId, adminUser;
let phpId, usdId, eurId;
let expenseAccountId, liabilityAccountId, arAccountId, apAccountId, cashAccountId, gainAccountId, lossAccountId;
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
  return { id: userId, roleCode: "NON_SUPER" };
}

async function makeAccount(code, title, accountClass) {
  const [result] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  return result.insertId;
}

beforeAll(async () => {
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3D%'");

  companyId = await makeCompany("TEST CO - Checkpoint 3D Beginning Balance");
  adminUser = await makeUser("test_admin_3d_bb", 2);

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

  await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57.0, effectiveDate: "2026-01-01" });
  await CurrencyService.recordRate(adminUser, eurId, { rateMode: "MANUAL", rate: 63.0, effectiveDate: "2026-01-01" });

  expenseAccountId = await makeAccount("TEST3DEXP", "Expense (Test)", "EXPENSE");
  liabilityAccountId = await makeAccount("TEST3DLIA", "Accrued Liability (Test)", "LIABILITY");
  arAccountId = await makeAccount("TEST3DAR", "Accounts Receivable (Test)", "ASSET");
  apAccountId = await makeAccount("TEST3DAP", "Accounts Payable (Test)", "LIABILITY");
  cashAccountId = await makeAccount("TEST3DCASH", "Cash In Bank (Test)", "ASSET");
  gainAccountId = await makeAccount("TEST3DGAIN", "Realized FX Gain (Test)", "INCOME");
  lossAccountId = await makeAccount("TEST3DLOSS", "Realized FX Loss (Test)", "EXPENSE");

  await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId });
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_applications WHERE source_type IN ('AR_BEGINNING','AP_BEGINNING') AND source_id IN (SELECT id FROM arap_beginning_balance_lines WHERE header_id IN (SELECT id FROM arap_beginning_balance_headers WHERE remarks LIKE 'TEST3D%' OR balance_date >= '2026-01-01'))");
  await pool.execute("DELETE FROM arap_payment_schedules WHERE beginning_balance_line_id IN (SELECT id FROM arap_beginning_balance_lines WHERE header_id IN (SELECT id FROM arap_beginning_balance_headers WHERE balance_date >= '2026-01-01' AND balance_date <= '2026-01-31'))");
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM arap_beginning_balance_lines WHERE header_id IN (SELECT id FROM arap_beginning_balance_headers WHERE balance_date >= '2026-01-01' AND balance_date <= '2026-01-31')");
  await pool.execute("DELETE FROM arap_beginning_balance_headers WHERE balance_date >= '2026-01-01' AND balance_date <= '2026-01-31'");
  await pool.execute("DELETE FROM gl_beginning_balance_lines WHERE header_id IN (SELECT id FROM gl_beginning_balance_headers WHERE balance_date >= '2026-01-01' AND balance_date <= '2026-01-31')");
  await pool.execute("DELETE FROM gl_beginning_balance_headers WHERE balance_date >= '2026-01-01' AND balance_date <= '2026-01-31'");
  await pool.execute("DELETE FROM company_fx_accounts WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM chart_of_accounts WHERE code LIKE 'TEST3D%'");
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("GL Beginning Balance multi-currency", () => {
  test("1. PHP GL opening: rate is 1, base amount unchanged", async () => {
    const { headerId } = await GLBeginningBalanceService.createGLBeginningBalance({
      header: { date: "2026-01-05", filterCode: "T3D" },
      rows: [
        { code: "TEST3DEXP", title: "Expense (Test)", debit: 1000, credit: 0, currencyId: phpId },
        { code: "TEST3DLIA", title: "Accrued Liability (Test)", debit: 0, credit: 1000, currencyId: phpId },
      ],
      user: adminUser,
      companyId,
    });
    const [lines] = await pool.execute("SELECT othrdebit, othrcredit, currency_id FROM gl_beginning_balance_lines WHERE header_id = ?", [headerId]);
    expect(Number(lines[0].othrdebit)).toBe(1000);
    expect(lines[0].currency_id).toBe(phpId);
  });

  test("2. USD GL opening: converts to base at the opening rate", async () => {
    const { headerId } = await GLBeginningBalanceService.createGLBeginningBalance({
      header: { date: "2026-01-06" },
      rows: [
        { code: "TEST3DEXP", title: "Expense (Test)", debit: 100, credit: 0, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-06" },
        { code: "TEST3DLIA", title: "Accrued Liability (Test)", debit: 0, credit: 100, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-06" },
      ],
      user: adminUser,
      companyId,
    });
    const [lines] = await pool.execute("SELECT othrdebit, othrcredit, foreign_debit, foreign_credit FROM gl_beginning_balance_lines WHERE header_id = ? ORDER BY id", [headerId]);
    expect(Number(lines[0].othrdebit)).toBeCloseTo(5700, 2);
    expect(Number(lines[0].foreign_debit)).toBe(100);
  });

  test("3. Mixed USD + EUR + PHP GL batch balances correctly in BASE currency", async () => {
    // USD 50 debit (@57 = 2850), EUR 20 debit (@63 = 1260), PHP 4110 credit -> balanced in base.
    // Distinct account codes per currency line - gl_beginning_balance_lines
    // has a pre-existing UNIQUE(header_id, account_code) constraint (one
    // account per date-batch), so two currency lines can't legitimately
    // share one account code within the same header anyway - matches how
    // a real chart of accounts would carry separate USD/EUR cash accounts.
    const usdExpenseAccount = await pool.execute(
      "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TEST3DEXPUSD', CURDATE(), 'Expense USD (Test)', 'EXPENSE')"
    );
    const { headerId } = await GLBeginningBalanceService.createGLBeginningBalance({
      header: { date: "2026-01-07" },
      rows: [
        { code: "TEST3DEXP", title: "Expense (Test)", debit: 50, credit: 0, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-07" },
        { code: "TEST3DEXPUSD", title: "Expense USD (Test)", debit: 20, credit: 0, currencyId: eurId, isManualRate: true, exchangeRate: 63.0, rateDate: "2026-01-07" },
        { code: "TEST3DLIA", title: "Accrued Liability (Test)", debit: 0, credit: 4110, currencyId: phpId },
      ],
      user: adminUser,
      companyId,
    });
    void usdExpenseAccount;
    const [lines] = await pool.execute("SELECT COALESCE(SUM(othrdebit),0) AS d, COALESCE(SUM(othrcredit),0) AS c FROM gl_beginning_balance_lines WHERE header_id = ?", [headerId]);
    expect(Number(lines[0].d)).toBeCloseTo(4110, 2);
    expect(Number(lines[0].c)).toBeCloseTo(4110, 2);
  });

  test("4. Unbalanced mixed-currency batch is rejected (base-currency check)", async () => {
    await expect(
      GLBeginningBalanceService.createGLBeginningBalance({
        header: { date: "2026-01-08" },
        rows: [
          { code: "TEST3DEXP", title: "Expense (Test)", debit: 50, credit: 0, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-08" },
          { code: "TEST3DLIA", title: "Accrued Liability (Test)", debit: 0, credit: 4000, currencyId: phpId }, // should be 2850, not 4000
        ],
        user: adminUser,
        companyId,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("5. Missing opening rate for a foreign row is rejected", async () => {
    await expect(
      BeginningBalanceCurrencyService.resolveLineCurrency({
        user: adminUser, companyId, transactionType: "GL_BEGINNING", transactionId: null,
        currencyPayload: { currencyId: usdId }, // no isManualRate, no exchangeRate, no historical rate for this date
        rateDate: "2019-01-01",
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  test("6. Opening rate snapshot locks after creation - cannot be silently changed", async () => {
    const { headerId } = await GLBeginningBalanceService.createGLBeginningBalance({
      header: { date: "2026-01-09" },
      rows: [
        { code: "TEST3DEXP", title: "Expense (Test)", debit: 10, credit: 0, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-09" },
        { code: "TEST3DLIA", title: "Accrued Liability (Test)", debit: 0, credit: 10, currencyId: usdId, isManualRate: true, exchangeRate: 57.0, rateDate: "2026-01-09" },
      ],
      user: adminUser,
      companyId,
    });
    const [lines] = await pool.execute("SELECT id FROM gl_beginning_balance_lines WHERE header_id = ? ORDER BY id LIMIT 1", [headerId]);
    await expect(
      BeginningBalanceCurrencyService.resolveLineCurrency({
        user: adminUser, companyId, transactionType: "GL_BEGINNING", transactionId: lines[0].id,
        currencyPayload: { currencyId: usdId, exchangeRate: 999 },
        rateDate: "2026-01-09",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// Helper mirroring server.js's POST/PUT /api/arap-beginning-balances
// currency wiring (kept minimal here - the real route is exercised by live
// Playwright verification; this proves the underlying service contract).
async function createArapBeginningBalance({ balanceType, balanceDate, partyName, accountCode, accountTitle, amount, currencyId, exchangeRate, dueDate }) {
  const isAR = balanceType === "AR";
  const txnType = isAR ? "AR_BEGINNING" : "AP_BEGINNING";
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const currencyResult = await BeginningBalanceCurrencyService.resolveLineCurrency({
      user: adminUser, companyId, transactionType: txnType, transactionId: null,
      currencyPayload: currencyId ? { currencyId, isManualRate: true, exchangeRate } : null,
      rateDate: balanceDate,
    });
    const converted = BeginningBalanceCurrencyService.convertLineAmount({
      debit: isAR ? amount : 0, credit: isAR ? 0 : amount, exchangeRate: currencyResult.rateInfo.exchangeRate,
    });
    const foreignOriginal = converted.foreignDebit || converted.foreignCredit;

    const [headerResult] = await conn.execute(
      `INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status) VALUES (?, ?, ?, 'PHP', 'PHILIPPINE PESO', 'TEST3D', 'Posted')`,
      [companyId, balanceType, balanceDate]
    );
    const headerId = headerResult.insertId;
    const [lineResult] = await conn.execute(
      `INSERT INTO arap_beginning_balance_lines
        (header_id, party_id, party_code, party_name, account_id, account_code, account_title, reference_no, due_date, debit, credit, balance_amount, paid_amount, status, currency_id, foreign_original_amount, foreign_paid_amount, foreign_balance_amount)
       VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 'Unpaid', ?, ?, 0, ?)`,
      [
        headerId, partyName, partyName, accountCode, accountTitle, `TEST3D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, dueDate || balanceDate,
        isAR ? converted.baseDebit : 0, isAR ? 0 : converted.baseCredit, converted.baseDebit || converted.baseCredit,
        currencyResult.currencyId, foreignOriginal, foreignOriginal,
      ]
    );
    const lineId = lineResult.insertId;
    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: txnType, transactionId: lineId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrency.id, baseCurrencyCode: currencyResult.baseCurrency.currencyCode,
      rateInfo: currencyResult.rateInfo,
      foreignTotals: { foreignSubtotal: 0, foreignTax: 0, foreignEwt: 0, foreignTotal: foreignOriginal },
      baseTotals: { baseSubtotal: 0, baseTax: 0, baseEwt: 0, baseTotal: converted.baseDebit || converted.baseCredit },
      userId: adminUser.id, lockNow: true,
    });
    await conn.commit();
    return lineId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

describe("AR Beginning Balance multi-currency + foreign settlement", () => {
  test("7. PHP AR opening", async () => {
    const lineId = await createArapBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-10", partyName: "Test Customer PHP",
      accountCode: "TEST3DAR", accountTitle: "Accounts Receivable (Test)", amount: 5000, currencyId: null,
    });
    const [rows] = await pool.execute("SELECT debit, currency_id FROM arap_beginning_balance_lines WHERE id = ?", [lineId]);
    expect(Number(rows[0].debit)).toBe(5000);
  });

  test("8. USD AR opening with foreign original/balance correctly stored", async () => {
    const lineId = await createArapBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-11", partyName: "Test Customer USD",
      accountCode: "TEST3DAR", accountTitle: "Accounts Receivable (Test)", amount: 1000, currencyId: usdId, exchangeRate: 57.0,
    });
    const [rows] = await pool.execute(
      "SELECT debit, foreign_original_amount AS foreignOriginal, foreign_balance_amount AS foreignBalance FROM arap_beginning_balance_lines WHERE id = ?",
      [lineId]
    );
    expect(Number(rows[0].debit)).toBeCloseTo(57000, 2);
    expect(Number(rows[0].foreignOriginal)).toBe(1000);
    expect(Number(rows[0].foreignBalance)).toBe(1000);
  });

  test("9. USD OR settling AR beginning balance at the SAME rate: no FX, correct base amount", async () => {
    const lineId = await createArapBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-12", partyName: "Test Customer Same Rate",
      accountCode: "TEST3DAR", accountTitle: "Accounts Receivable (Test)", amount: 500, currencyId: usdId, exchangeRate: 57.0,
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceType: "AR_BEGINNING", sourceId: lineId, amount: 500, applicationDate: "2026-01-15" },
        appliedType: "OR", appliedId: 900001, paymentCurrencyCode: "USD", paymentExchangeRate: 57.0,
        baseCurrencyCode: "PHP", isPosting: true, companyId,
      });
      await conn.commit();
      expect(result.fxDifference).toBe(0);
      expect(result.baseAmount).toBeCloseTo(28500, 2);
    } finally {
      conn.release();
    }
  });

  test("10. USD OR settling AR beginning balance at a DIFFERENT rate: realized FX gain matches the worked example", async () => {
    // $100 @ 57.00 opening, OR pays $100 @ 57.50 -> Gain 50, matching the
    // exact Checkpoint 3FX worked example, now sourced from a beginning
    // balance instead of a regular Invoice.
    const lineId = await createArapBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-13", partyName: "Test Customer Diff Rate",
      accountCode: "TEST3DAR", accountTitle: "Accounts Receivable (Test)", amount: 100, currencyId: usdId, exchangeRate: 57.0,
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceType: "AR_BEGINNING", sourceId: lineId, amount: 100, applicationDate: "2026-01-16" },
        appliedType: "OR", appliedId: 900002, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
        baseCurrencyCode: "PHP", isPosting: true, companyId,
      });
      await conn.commit();
      expect(result.sourceBaseAmount).toBeCloseTo(5700, 2);
      expect(result.paymentBaseAmount).toBeCloseTo(5750, 2);
      expect(result.fxDifference).toBeCloseTo(50, 2);
      expect(result.fxDirection).toBe("REALIZED_GAIN");
      expect(result.fxAccount.accountId).toBe(gainAccountId);

      const [rows] = await pool.execute(
        "SELECT foreign_balance_amount AS foreignBalance, status FROM arap_beginning_balance_lines WHERE id = ?",
        [lineId]
      );
      expect(Number(rows[0].foreignBalance)).toBe(0);
      expect(rows[0].status).toBe("Paid");
    } finally {
      conn.release();
    }
  });

  test("11. Cross-currency settlement against a foreign AR beginning balance is blocked", async () => {
    const lineId = await createArapBeginningBalance({
      balanceType: "AR", balanceDate: "2026-01-17", partyName: "Test Customer Cross",
      accountCode: "TEST3DAR", accountTitle: "Accounts Receivable (Test)", amount: 100, currencyId: usdId, exchangeRate: 57.0,
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await expect(
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceType: "AR_BEGINNING", sourceId: lineId, amount: 100, applicationDate: "2026-01-18" },
          appliedType: "OR", appliedId: 900003, paymentCurrencyCode: "PHP", paymentExchangeRate: 1,
          baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      ).rejects.toThrow(/currency differs/i);
    } finally {
      await conn.rollback();
      conn.release();
    }
  });
});

describe("AP Beginning Balance multi-currency + foreign settlement", () => {
  test("12. USD CV settling AP beginning balance at a DIFFERENT rate: realized FX loss matches the worked example", async () => {
    // $100 @ 57.00 opening, CV pays $100 @ 57.50 -> Loss 50 (payable
    // direction is inverted from receivable - never reuse receivable sign
    // logic blindly).
    const lineId = await createArapBeginningBalance({
      balanceType: "AP", balanceDate: "2026-01-14", partyName: "Test Supplier Diff Rate",
      accountCode: "TEST3DAP", accountTitle: "Accounts Payable (Test)", amount: 100, currencyId: usdId, exchangeRate: 57.0,
    });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceType: "AP_BEGINNING", sourceId: lineId, amount: 100, applicationDate: "2026-01-19" },
        appliedType: "CV", appliedId: 900004, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
        baseCurrencyCode: "PHP", isPosting: true, companyId,
      });
      await conn.commit();
      expect(result.fxDifference).toBeCloseTo(50, 2);
      expect(result.fxDirection).toBe("REALIZED_LOSS");
      expect(result.fxAccount.accountId).toBe(lossAccountId);
    } finally {
      conn.release();
    }
  });
});
