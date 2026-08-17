const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");
const PaymentApplicationService = require("../paymentApplicationService");
const FxAccountService = require("../fxAccountService");

// Checkpoint 3FX: realized FX gain/loss settlement tests. Builds directly
// on the Checkpoint 3B test harness pattern (real invoice/APV rows + real
// currency snapshots, applyInvoicePayment/applyApvPayment called directly)
// and adds real or_lines/cv_lines rows so applyForeignSettlementToLines
// has a real AR/AP line to locate and correct, and a real GL to assert
// balance against.

jest.setTimeout(30000);

let companyId, adminUser;
let phpId, usdId;
let gainAccountId, lossAccountId, cashAccountId, arAccountId, apAccountId;
const createdUserIds = [];
let nextAppliedId = 950001;

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

async function createInvoice({ foreignTotal, exchangeRate }) {
  const baseTotal = TransactionCurrencyService.roundMoney(foreignTotal * exchangeRate);
  const [result] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, 4, 'HOME REPAIR NETWORK PHILIPPINES', CURDATE(), ?, ?, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TESTFX-INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, baseTotal, baseTotal, baseTotal, usdId]
  );
  const invoiceId = result.insertId;
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "INV", transactionId: invoiceId,
    currencyId: usdId, currencyCode: "USD", baseCurrencyId: phpId, baseCurrencyCode: "PHP",
    rateInfo: { exchangeRate, rateDate: new Date().toISOString().slice(0, 10), rateSource: "MANUAL", rateStatus: "MANUAL", systemRate: null, overrideRate: null, overrideReason: null },
    foreignTotals: { foreignSubtotal: foreignTotal, foreignTax: 0, foreignEwt: 0, foreignTotal },
    baseTotals: { baseSubtotal: baseTotal, baseTax: 0, baseEwt: 0, baseTotal },
    userId: adminUser.id, lockNow: true,
  });
  return invoiceId;
}

async function createApv({ foreignTotal, exchangeRate }) {
  const baseTotal = TransactionCurrencyService.roundMoney(foreignTotal * exchangeRate);
  const [result] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, 1, 'ABC COMPANY INC.', CURDATE(), ?, ?, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TESTFX-APV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, baseTotal, baseTotal, baseTotal, usdId]
  );
  const apvId = result.insertId;
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "APV", transactionId: apvId,
    currencyId: usdId, currencyCode: "USD", baseCurrencyId: phpId, baseCurrencyCode: "PHP",
    rateInfo: { exchangeRate, rateDate: new Date().toISOString().slice(0, 10), rateSource: "MANUAL", rateStatus: "MANUAL", systemRate: null, overrideRate: null, overrideReason: null },
    foreignTotals: { foreignSubtotal: foreignTotal, foreignTax: 0, foreignEwt: 0, foreignTotal },
    baseTotals: { baseSubtotal: baseTotal, baseTax: 0, baseEwt: 0, baseTotal },
    userId: adminUser.id, lockNow: true,
  });
  return apvId;
}

// Simulates the OR/CV's own two starting lines (Cash + AR, or AP + Cash),
// converted at the OR/CV's own uniform payment rate - exactly what
// server.js inserts into or_lines/cv_lines BEFORE
// applyForeignSettlementToLines runs. `foreignAmount` is the OR/CV's own
// total (matches the SUM of applied amounts in every test below).
async function seedOrLines(orId, { foreignAmount, paymentRate }) {
  const cashBase = TransactionCurrencyService.roundMoney(foreignAmount * paymentRate);
  await pool.execute(
    `INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, '110001', 'CASH IN BANK BPI', 'Collection', ?, 0, ?, 0)`,
    [orId, cashAccountId, cashBase, foreignAmount]
  );
  await pool.execute(
    `INSERT INTO or_lines (or_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, '120001', 'ACCOUNTS RECEIVABLE', 'Settlement', 0, ?, 0, ?)`,
    [orId, arAccountId, cashBase, foreignAmount]
  );
  await pool.execute("UPDATE or_headers SET total_debit = ?, total_credit = ? WHERE id = ?", [cashBase, cashBase, orId]);
}

async function seedCvLines(cvId, { foreignAmount, paymentRate }) {
  const cashBase = TransactionCurrencyService.roundMoney(foreignAmount * paymentRate);
  await pool.execute(
    `INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, '200001', 'ACCOUNTS PAYABLE', 'Settlement', ?, 0, ?, 0)`,
    [cvId, apAccountId, cashBase, foreignAmount]
  );
  await pool.execute(
    `INSERT INTO cv_lines (cv_id, account_id, account_code, account_title, particulars, debit, credit, foreign_debit, foreign_credit)
     VALUES (?, ?, '110001', 'CASH IN BANK BPI', 'Disbursement', 0, ?, 0, ?)`,
    [cvId, cashAccountId, cashBase, foreignAmount]
  );
  await pool.execute("UPDATE cv_headers SET total_debit = ?, total_credit = ? WHERE id = ?", [cashBase, cashBase, cvId]);
}

async function createOrHeader() {
  const [result] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status, currency_id)
     VALUES (?, ?, 4, 'HOME REPAIR NETWORK PHILIPPINES', CURDATE(), 0, 0, 'Draft', ?)`,
    [companyId, `TESTFX-OR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, usdId]
  );
  return result.insertId;
}

async function createCvHeader() {
  const [result] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status, currency_id)
     VALUES (?, ?, 1, 'ABC COMPANY INC.', CURDATE(), 0, 0, 'Draft', ?)`,
    [companyId, `TESTFX-CV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, usdId]
  );
  return result.insertId;
}

async function withConn(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function glBalance(lineTable, lineIdCol, transactionId) {
  const [rows] = await pool.execute(
    `SELECT COALESCE(SUM(debit),0) AS totalDebit, COALESCE(SUM(credit),0) AS totalCredit FROM ${lineTable} WHERE ${lineIdCol} = ?`,
    [transactionId]
  );
  return { totalDebit: Number(rows[0].totalDebit), totalCredit: Number(rows[0].totalCredit) };
}

beforeAll(async () => {
  companyId = await makeCompany("TEST CO - Checkpoint 3FX Realized FX Settlement");
  adminUser = await makeUser("test_admin_3fx", 2);

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

  gainAccountId = await makeAccount("TESTFXGAIN", "Realized FX Gain (Test)", "INCOME");
  lossAccountId = await makeAccount("TESTFXLOSS", "Realized FX Loss (Test)", "EXPENSE");
  cashAccountId = await makeAccount("TESTFXCASH", "Cash In Bank (Test)", "ASSET");
  arAccountId = await makeAccount("TESTFXAR", "Accounts Receivable (Test)", "ASSET");
  apAccountId = await makeAccount("TESTFXAP", "Accounts Payable (Test)", "LIABILITY");

  await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId });
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_applications WHERE source_type IN ('INV','APV') AND source_id IN (SELECT id FROM invoice_headers WHERE voucher_no LIKE 'TESTFX-INV-%')");
  await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (SELECT id FROM apv_headers WHERE voucher_no LIKE 'TESTFX-APV-%')");
  await pool.query("DELETE FROM or_lines WHERE or_id IN (SELECT id FROM or_headers WHERE voucher_no LIKE 'TESTFX-OR-%')");
  await pool.query("DELETE FROM cv_lines WHERE cv_id IN (SELECT id FROM cv_headers WHERE voucher_no LIKE 'TESTFX-CV-%')");
  await pool.execute("DELETE FROM or_headers WHERE voucher_no LIKE 'TESTFX-OR-%'");
  await pool.execute("DELETE FROM cv_headers WHERE voucher_no LIKE 'TESTFX-CV-%'");
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE transaction_type IN ('INV','APV') AND company_id = ?", [companyId]);
  await pool.execute("DELETE FROM invoice_headers WHERE voucher_no LIKE 'TESTFX-INV-%'");
  await pool.execute("DELETE FROM apv_headers WHERE voucher_no LIKE 'TESTFX-APV-%'");
  await pool.execute("DELETE FROM company_fx_accounts WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.execute("DELETE FROM chart_of_accounts WHERE id IN (?, ?, ?, ?, ?)", [gainAccountId, lossAccountId, cashAccountId, arAccountId, apAccountId]);
  await pool.end();
});

describe("Receivable settlement (Invoice -> OR)", () => {
  test("1. same-rate USD Invoice -> OR: no FX lines, GL balanced, behaves exactly like Checkpoint 3B", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(0);
    expect(fxResult.totalLossAmount).toBe(0);
    const [lines] = await pool.execute("SELECT COUNT(*) c FROM or_lines WHERE or_id = ?", [orId]);
    expect(lines[0].c).toBe(2); // no FX line added
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("2. higher payment rate -> realized GAIN, GL balances exactly, invoice/OR rates both preserved", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57.5 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.fxDirection).toBe("REALIZED_GAIN");
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(50); // 100 * (57.5 - 57)
    expect(fxResult.totalLossAmount).toBe(0);

    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
    expect(bal.totalDebit).toBe(5750); // Cash Dr 100*57.5

    const [gainLine] = await pool.execute(
      "SELECT credit FROM or_lines WHERE or_id = ? AND account_id = ?", [orId, gainAccountId]
    );
    expect(Number(gainLine[0].credit)).toBe(50);

    const arSnapshot = await TransactionCurrencyService.getSnapshot("INV", invoiceId);
    expect(arSnapshot.exchangeRate).toBe(57); // Invoice rate untouched
  });

  test("3. lower payment rate -> realized LOSS, GL balances exactly", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57.5 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.fxDirection).toBe("REALIZED_LOSS");
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalLossAmount).toBe(50);
    expect(fxResult.totalGainAmount).toBe(0);

    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);

    const [lossLine] = await pool.execute(
      "SELECT debit FROM or_lines WHERE or_id = ? AND account_id = ?", [orId, lossAccountId]
    );
    expect(Number(lossLine[0].debit)).toBe(50);
  });

  test("4. partial settlement gain matches the worked example (400 @ 57.00 vs 57.50 -> gain 200)", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 1000, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 400, paymentRate: 57.5 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 400 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.sourceBaseAmount).toBe(22800);
    expect(app.paymentBaseAmount).toBe(23000);
    expect(app.fxDifference).toBe(200);

    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(200);

    const [rows] = await pool.execute("SELECT foreign_balance_amount AS b FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(Number(rows[0].b)).toBe(600); // remaining USD 600, not revalued
  });

  test("5. partial settlement loss", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 1000, exchangeRate: 57.5 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 400, paymentRate: 57 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 400 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.fxDifference).toBe(-200);
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalLossAmount).toBe(200);
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("6. multiple partial payments at different rates - each keeps its own rate, no averaging", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 1000, exchangeRate: 57 });
    const results = [];
    for (const { amount, rate } of [{ amount: 300, rate: 57.25 }, { amount: 200, rate: 57.5 }, { amount: 500, rate: 56.8 }]) {
      const orId = await createOrHeader();
      await seedOrLines(orId, { foreignAmount: amount, paymentRate: rate });
      const app = await withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount }, appliedType: "OR", appliedId: orId,
          paymentCurrencyCode: "USD", paymentExchangeRate: rate, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      );
      await withConn((conn) =>
        PaymentApplicationService.applyForeignSettlementToLines(conn, {
          headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
          transactionId: orId, applications: [app], perspective: "RECEIVABLE",
        })
      );
      results.push(app);
    }
    expect(results.map((a) => a.paymentExchangeRate)).toEqual([57.25, 57.5, 56.8]);
    const [rows] = await pool.execute(
      "SELECT foreign_balance_amount AS b, payment_status AS s FROM invoice_headers WHERE id = ?", [invoiceId]
    );
    expect(Number(rows[0].b)).toBe(0);
    expect(rows[0].s).toBe("Paid");
  }, 60000);

  test("7. full payment at a different rate - Paid status, GL balanced", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 250, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 250, paymentRate: 58 });
    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 250 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 58, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    const [rows] = await pool.execute("SELECT payment_status AS s FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(rows[0].s).toBe("Paid");
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("8. one OR paying two invoices at once - per-application FX, aggregated correctly", async () => {
    const invoiceA = await createInvoice({ foreignTotal: 400, exchangeRate: 57 });
    const invoiceB = await createInvoice({ foreignTotal: 600, exchangeRate: 56.5 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 1000, paymentRate: 57.5 });

    const appA = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceA, amount: 400 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const appB = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceB, amount: 600 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    // A: 400*(57.5-57)=200 gain. B: 600*(57.5-56.5)=600 gain. Total 800.
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [appA, appB], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(800);
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("9. mixed gain AND loss applications on the same OR post as two separate lines, not netted", async () => {
    const invoiceGain = await createInvoice({ foreignTotal: 300, exchangeRate: 57 }); // payment @ 58 -> gain
    const invoiceLoss = await createInvoice({ foreignTotal: 300, exchangeRate: 59 }); // payment @ 58 -> loss
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 600, paymentRate: 58 });

    const appGain = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceGain, amount: 300 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 58, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const appLoss = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceLoss, amount: 300 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 58, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [appGain, appLoss], perspective: "RECEIVABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(300); // 300*(58-57)
    expect(fxResult.totalLossAmount).toBe(300); // 300*(59-58)
    const [gainLine] = await pool.execute("SELECT COUNT(*) c FROM or_lines WHERE or_id = ? AND account_id = ?", [orId, gainAccountId]);
    const [lossLine] = await pool.execute("SELECT COUNT(*) c FROM or_lines WHERE or_id = ? AND account_id = ?", [orId, lossAccountId]);
    expect(gainLine[0].c).toBe(1);
    expect(lossLine[0].c).toBe(1);
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("10. exact GL balance holds for an odd/rounding-prone rate", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 333.33, exchangeRate: 56.789 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 333.33, paymentRate: 57.123 });
    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 333.33 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.123, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    const bal = await glBalance("or_lines", "or_id", orId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("11-12. source rate and payment rate are both independently preserved after settlement", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57.5 });
    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    expect(app.sourceExchangeRate).toBe(57);
    expect(app.paymentExchangeRate).toBe(57.5);
    const invSnapshot = await TransactionCurrencyService.getSnapshot("INV", invoiceId);
    expect(invSnapshot.exchangeRate).toBe(57);
  });

  test("13-14. foreign balance and FX metadata are both correct after settlement", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 500, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 200, paymentRate: 57.5 });
    const app = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 200 }, appliedType: "OR", appliedId: orId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
        transactionId: orId, applications: [app], perspective: "RECEIVABLE",
      })
    );
    const [rows] = await pool.execute("SELECT foreign_balance_amount AS b FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(Number(rows[0].b)).toBe(300);

    const [appRows] = await pool.execute(
      "SELECT fx_difference AS fxDiff, fx_direction AS fxDir, fx_account_id AS fxAccountId FROM transaction_applications WHERE applied_type='OR' AND applied_id = ?",
      [orId]
    );
    expect(Number(appRows[0].fxDiff)).toBe(100); // 200 * 0.5
    expect(appRows[0].fxDir).toBe("REALIZED_GAIN");
    expect(appRows[0].fxAccountId).toBe(gainAccountId);
  });

  test("15. posting is blocked with a clear message when the Gain account is not configured", async () => {
    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId: null, lossAccountId });
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57.5 }); // gain direction
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
          paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      )
    ).rejects.toThrow(/Realized FX Gain account is not configured/i);
    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId }); // restore
  });

  test("16. posting is blocked with a clear message when the Loss account is not configured", async () => {
    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId: null });
    const invoiceId = await createInvoice({ foreignTotal: 100, exchangeRate: 57.5 });
    const orId = await createOrHeader();
    await seedOrLines(orId, { foreignAmount: 100, paymentRate: 57 }); // loss direction
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 100 }, appliedType: "OR", appliedId: orId,
          paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      )
    ).rejects.toThrow(/Realized FX Loss account is not configured/i);
    await FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId, lossAccountId }); // restore
  });

  test("17. a nonexistent account id is rejected at configuration time", async () => {
    await expect(
      FxAccountService.upsertFxAccounts(adminUser, companyId, { gainAccountId: 999999999, lossAccountId })
    ).rejects.toThrow(/does not exist/i);
  });

  test("18. a user without CONFIGURE_FX_ACCOUNTS permission cannot change the configuration", async () => {
    const accountantUser = { id: (await makeUser("test_accountant_3fx", 3)).id, roleCode: "NON_SUPER" };
    const PermissionService = require("../permissionService");
    const allowed = await PermissionService.can(accountantUser.id, "FILESETUP.CURRENCY_SETUP", "CONFIGURE_FX_ACCOUNTS");
    expect(allowed).toBe(false); // ACCOUNTANT role was never granted this permission by the migration
  });
});

describe("Payable settlement (APV -> CV) - inverted direction", () => {
  test("19. higher payment rate on a payable is a LOSS (paid more pesos than owed)", async () => {
    const apvId = await createApv({ foreignTotal: 100, exchangeRate: 57 });
    const cvId = await createCvHeader();
    await seedCvLines(cvId, { foreignAmount: 100, paymentRate: 57.5 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 100 }, appliedType: "CV", appliedId: cvId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.fxDirection).toBe("REALIZED_LOSS");
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
        transactionId: cvId, applications: [app], perspective: "PAYABLE",
      })
    );
    expect(fxResult.totalLossAmount).toBe(50);
    const bal = await glBalance("cv_lines", "cv_id", cvId);
    expect(bal.totalDebit).toBe(bal.totalCredit);

    const [apLine] = await pool.execute("SELECT debit FROM cv_lines WHERE cv_id = ? AND account_id = ?", [cvId, apAccountId]);
    expect(Number(apLine[0].debit)).toBe(5700); // historical AP carrying amount
  });

  test("20. lower payment rate on a payable is a GAIN (paid fewer pesos than owed)", async () => {
    const apvId = await createApv({ foreignTotal: 100, exchangeRate: 57.5 });
    const cvId = await createCvHeader();
    await seedCvLines(cvId, { foreignAmount: 100, paymentRate: 57 });

    const app = await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 100 }, appliedType: "CV", appliedId: cvId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(app.fxDirection).toBe("REALIZED_GAIN");
    const fxResult = await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
        transactionId: cvId, applications: [app], perspective: "PAYABLE",
      })
    );
    expect(fxResult.totalGainAmount).toBe(50);
    const bal = await glBalance("cv_lines", "cv_id", cvId);
    expect(bal.totalDebit).toBe(bal.totalCredit);
  });

  test("21. APV source rate is preserved after a different-rate CV settlement", async () => {
    const apvId = await createApv({ foreignTotal: 100, exchangeRate: 57 });
    const cvId = await createCvHeader();
    await seedCvLines(cvId, { foreignAmount: 100, paymentRate: 57.5 });
    await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 100 }, appliedType: "CV", appliedId: cvId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    ).then((app) =>
      withConn((conn) =>
        PaymentApplicationService.applyForeignSettlementToLines(conn, {
          headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
          transactionId: cvId, applications: [app], perspective: "PAYABLE",
        })
      )
    );
    const apvSnapshot = await TransactionCurrencyService.getSnapshot("APV", apvId);
    expect(apvSnapshot.exchangeRate).toBe(57);
  });

  test("22. one partial payable payment - APV balance and status correct", async () => {
    const apvId = await createApv({ foreignTotal: 500, exchangeRate: 57 });
    const cvId = await createCvHeader();
    await seedCvLines(cvId, { foreignAmount: 150, paymentRate: 57.5 });
    const app = await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 150 }, appliedType: "CV", appliedId: cvId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyForeignSettlementToLines(conn, {
        headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
        transactionId: cvId, applications: [app], perspective: "PAYABLE",
      })
    );
    const [rows] = await pool.execute(
      "SELECT foreign_balance_amount AS b, payment_status AS s FROM apv_headers WHERE id = ?", [apvId]
    );
    expect(Number(rows[0].b)).toBe(350);
    expect(rows[0].s).toBe("Partially Paid");
  });
});

describe("Concurrency: different-rate settlements", () => {
  test("23. two simultaneous different-rate settlements against the same invoice - only one succeeds, GL stays balanced", async () => {
    const invoiceId = await createInvoice({ foreignTotal: 600, exchangeRate: 57 });
    const orA = await createOrHeader();
    const orB = await createOrHeader();
    await seedOrLines(orA, { foreignAmount: 600, paymentRate: 57.5 });
    await seedOrLines(orB, { foreignAmount: 600, paymentRate: 57.5 });

    const attempt = (orId) =>
      withConn(async (conn) => {
        const app = await PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 600 }, appliedType: "OR", appliedId: orId,
          paymentCurrencyCode: "USD", paymentExchangeRate: 57.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
        });
        return PaymentApplicationService.applyForeignSettlementToLines(conn, {
          headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
          transactionId: orId, applications: [app], perspective: "RECEIVABLE",
        });
      });

    const results = await Promise.allSettled([attempt(orA), attempt(orB)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const [rows] = await pool.execute("SELECT foreign_balance_amount AS b FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(Number(rows[0].b)).toBe(0);
  });
});
