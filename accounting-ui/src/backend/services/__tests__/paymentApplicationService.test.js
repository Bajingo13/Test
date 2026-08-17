const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");
const PaymentApplicationService = require("../paymentApplicationService");

// Checkpoint 3B: OR->Invoice and CV->APV payment application tests.
// applyInvoicePayment/applyApvPayment don't need a real or_headers/cv_headers
// row - they only need the SOURCE document (Invoice/APV) to be real (for
// its own locked currency snapshot) plus a payment currency/rate passed
// directly, exactly like the real OR/CV route handlers supply them from
// their own resolveTransactionCurrency() result. `appliedId` is a
// synthetic incrementing id standing in for a real OR/CV id.

jest.setTimeout(30000);

let companyId, adminUser;
let phpId, usdId;
const createdUserIds = [];
let nextAppliedId = 900001;

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

// Mimics what the real Invoice POST handler does: insert a header at the
// given foreign total/rate, then save+lock a currency snapshot for it -
// same two steps, same functions, no shortcuts.
async function createInvoice({ currencyId, exchangeRate, foreignTotal, baseCurrencyId, baseCurrencyCode, currencyCode, locked = true }) {
  const baseTotal = TransactionCurrencyService.roundMoney(foreignTotal * exchangeRate);
  const [result] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, 4, 'HOME REPAIR NETWORK PHILIPPINES', CURDATE(), ?, ?, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TEST-INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, baseTotal, baseTotal, baseTotal, currencyId]
  );
  const invoiceId = result.insertId;
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "INV", transactionId: invoiceId,
    currencyId, currencyCode, baseCurrencyId, baseCurrencyCode,
    rateInfo: { exchangeRate, rateDate: new Date().toISOString().slice(0, 10), rateSource: "MANUAL", rateStatus: "MANUAL", systemRate: null, overrideRate: null, overrideReason: null },
    foreignTotals: { foreignSubtotal: foreignTotal, foreignTax: 0, foreignEwt: 0, foreignTotal },
    baseTotals: { baseSubtotal: baseTotal, baseTax: 0, baseEwt: 0, baseTotal },
    userId: adminUser.id, lockNow: locked,
  });
  return invoiceId;
}

async function createApv({ currencyId, exchangeRate, foreignTotal, baseCurrencyId, baseCurrencyCode, currencyCode, locked = true }) {
  const baseTotal = TransactionCurrencyService.roundMoney(foreignTotal * exchangeRate);
  const [result] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status, currency_id)
     VALUES (?, ?, 1, 'ABC COMPANY INC.', CURDATE(), ?, ?, 0, ?, 'Unpaid', 'Posted', ?)`,
    [companyId, `TEST-APV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, baseTotal, baseTotal, baseTotal, currencyId]
  );
  const apvId = result.insertId;
  await TransactionCurrencyService.saveSnapshot(pool, {
    companyId, transactionType: "APV", transactionId: apvId,
    currencyId, currencyCode, baseCurrencyId, baseCurrencyCode,
    rateInfo: { exchangeRate, rateDate: new Date().toISOString().slice(0, 10), rateSource: "MANUAL", rateStatus: "MANUAL", systemRate: null, overrideRate: null, overrideReason: null },
    foreignTotals: { foreignSubtotal: foreignTotal, foreignTax: 0, foreignEwt: 0, foreignTotal },
    baseTotals: { baseSubtotal: baseTotal, baseTax: 0, baseEwt: 0, baseTotal },
    userId: adminUser.id, lockNow: locked,
  });
  return apvId;
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

beforeAll(async () => {
  companyId = await makeCompany("TEST CO - Checkpoint 3B Payment Applications");
  adminUser = await makeUser("test_admin_3b", 2);

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
  await pool.query("DELETE FROM transaction_applications WHERE source_type IN ('INV', 'APV') AND source_id IN (SELECT id FROM invoice_headers WHERE customer_name = 'HOME REPAIR NETWORK PHILIPPINES' AND voucher_no LIKE 'TEST-INV-%')");
  await pool.query("DELETE FROM transaction_applications WHERE source_type = 'APV' AND source_id IN (SELECT id FROM apv_headers WHERE voucher_no LIKE 'TEST-APV-%')");
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE transaction_type IN ('INV', 'APV') AND company_id = ?", [companyId]);
  await pool.execute("DELETE FROM invoice_headers WHERE voucher_no LIKE 'TEST-INV-%'");
  await pool.execute("DELETE FROM apv_headers WHERE voucher_no LIKE 'TEST-APV-%'");
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("TransactionCurrencyService.buildApplication (pure)", () => {
  test("1. cross-currency (source USD, payment PHP) is rejected", () => {
    expect(() =>
      TransactionCurrencyService.buildApplication({
        sourceCurrencyCode: "USD", sourceExchangeRate: 56, paymentCurrencyCode: "PHP", paymentExchangeRate: 1,
        foreignAmountApplied: 100, perspective: "RECEIVABLE", isPosting: false, companyId,
      })
    ).toThrow(/Cross-currency settlement is not enabled/i);
  });

  test("2. same-rate settlement produces zero FX difference and is allowed to post", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "USD", sourceExchangeRate: 57, paymentCurrencyCode: "USD", paymentExchangeRate: 57,
      foreignAmountApplied: 400, perspective: "RECEIVABLE", isPosting: true, companyId,
    });
    expect(app.fxDifference).toBe(0);
    expect(app.fxDirection).toBe("NONE");
    expect(app.sourceBaseAmount).toBe(app.paymentBaseAmount);
  });

  // Checkpoint 3FX: buildApplication itself no longer blocks a
  // different-rate + isPosting=true combination - realized FX gain/loss
  // accounting now makes that combination valid to post. The actual
  // gatekeeping moved one layer up to
  // paymentApplicationService.applyInvoicePayment/applyApvPayment, which
  // requires a configured FX account for whichever direction is needed
  // (see realizedFxSettlement.test.js tests 15/16) - buildApplication
  // stays a pure calculator with no knowledge of account configuration.
  test("3. buildApplication itself no longer throws for a different rate at isPosting=true (blocking moved to the FX-account check)", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "USD", sourceExchangeRate: 57, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
      foreignAmountApplied: 400, perspective: "RECEIVABLE", isPosting: true, companyId,
    });
    expect(app.fxDifference).toBe(200);
    expect(app.rateMismatch).toBe(true);
    expect(app.isPosting).toBe(true);
  });

  test("4. different-rate settlement is ALLOWED when isPosting=false (Draft can hold the calculated difference)", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "USD", sourceExchangeRate: 57, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
      foreignAmountApplied: 400, perspective: "RECEIVABLE", isPosting: false, companyId,
    });
    // Section 10 worked example: 400 @ 57.00 = 22,800; 400 @ 57.50 = 23,000; diff = 200
    expect(app.sourceBaseAmount).toBe(22800);
    expect(app.paymentBaseAmount).toBe(23000);
    expect(app.fxDifference).toBe(200);
  });

  test("5. FX direction for RECEIVABLE (Invoice/OR): payment rate stronger than source rate -> GAIN", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "USD", sourceExchangeRate: 57, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
      foreignAmountApplied: 400, perspective: "RECEIVABLE", isPosting: false, companyId,
    });
    expect(app.fxDirection).toBe("REALIZED_GAIN");
  });

  test("6. FX direction for PAYABLE (APV/CV): the SAME rate movement is a LOSS (paid more base than owed)", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "USD", sourceExchangeRate: 57, paymentCurrencyCode: "USD", paymentExchangeRate: 57.5,
      foreignAmountApplied: 400, perspective: "PAYABLE", isPosting: false, companyId,
    });
    expect(app.fxDirection).toBe("REALIZED_LOSS");
  });

  test("7. base-currency-to-base-currency (legacy PHP path) behaves identically regardless of perspective", () => {
    const app = TransactionCurrencyService.buildApplication({
      sourceCurrencyCode: "PHP", sourceExchangeRate: 1, paymentCurrencyCode: "PHP", paymentExchangeRate: 1,
      foreignAmountApplied: 5000, perspective: "RECEIVABLE", isPosting: true, companyId,
    });
    expect(app.baseAmount).toBe(5000);
    expect(app.fxDifference).toBe(0);
  });
});

describe("applyInvoicePayment - Invoice/OR (RECEIVABLE)", () => {
  test("8. PHP Invoice -> PHP OR: base case is completely unaffected (legacy behavior)", async () => {
    const invoiceId = await createInvoice({
      currencyId: phpId, exchangeRate: 1, foreignTotal: 5000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "PHP",
    });
    const appliedId = nextAppliedId++;
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 5000 },
        appliedType: "OR", appliedId,
        paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP",
        isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute("SELECT payment_status AS paymentStatus, balance_amount AS balanceAmount FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(rows[0].paymentStatus).toBe("Paid");
    expect(Number(rows[0].balanceAmount)).toBe(0);
  });

  test("9. USD Invoice -> USD OR at the SAME rate: partial payment updates foreign paid/balance correctly", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    const appliedId = nextAppliedId++;
    const application = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 400 },
        appliedType: "OR", appliedId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP",
        isPosting: true, companyId,
      })
    );
    expect(application.fxDifference).toBe(0);
    const [rows] = await pool.execute(
      "SELECT payment_status AS paymentStatus, foreign_paid_amount AS foreignPaid, foreign_balance_amount AS foreignBalance FROM invoice_headers WHERE id = ?",
      [invoiceId]
    );
    expect(rows[0].paymentStatus).toBe("Partially Paid");
    expect(Number(rows[0].foreignPaid)).toBe(400);
    expect(Number(rows[0].foreignBalance)).toBe(600);
  });

  test("10. USD full payment marks Paid using the FOREIGN balance, not a rounded base coincidence", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 56.789, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 1000 },
        appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 56.789, baseCurrencyCode: "PHP",
        isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute(
      "SELECT payment_status AS paymentStatus, foreign_balance_amount AS foreignBalance FROM invoice_headers WHERE id = ?",
      [invoiceId]
    );
    expect(rows[0].paymentStatus).toBe("Paid");
    expect(Number(rows[0].foreignBalance)).toBe(0);
  });

  test("11. multiple USD partial payments at different rates accumulate correctly and each retains its own rate", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    // Draft applications (isPosting: false) so different payment rates are allowed to be recorded.
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 300 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: false, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 200 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 58, baseCurrencyCode: "PHP", isPosting: false, companyId,
      })
    );
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 500 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: false, companyId,
      })
    );

    const [rows] = await pool.execute(
      "SELECT payment_status AS paymentStatus, foreign_paid_amount AS foreignPaid, foreign_balance_amount AS foreignBalance FROM invoice_headers WHERE id = ?",
      [invoiceId]
    );
    expect(Number(rows[0].foreignPaid)).toBe(1000);
    expect(Number(rows[0].foreignBalance)).toBe(0);
    expect(rows[0].paymentStatus).toBe("Paid");

    const [apps] = await pool.execute(
      "SELECT payment_exchange_rate AS rate, foreign_amount_applied AS amt, fx_difference AS fxDiff FROM transaction_applications WHERE source_type='INV' AND source_id = ? ORDER BY id ASC",
      [invoiceId]
    );
    expect(apps.map((a) => Number(a.rate))).toEqual([57, 58, 57]);
    expect(Number(apps[1].fxDiff)).toBe(200); // 200 * (58-57)
  });

  test("12. source Invoice rate is NEVER modified by an application, no matter the payment rate", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 400 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 60, baseCurrencyCode: "PHP", isPosting: false, companyId,
      })
    );
    const snapshot = await TransactionCurrencyService.getSnapshot("INV", invoiceId);
    expect(snapshot.exchangeRate).toBe(57); // unchanged - still the Invoice's own historical rate
  });

  test("13. overpayment (foreign amount exceeds foreign balance) is rejected", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 600,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 650 }, appliedType: "OR", appliedId: nextAppliedId++,
          paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: false, companyId,
        })
      )
    ).rejects.toThrow(/cannot exceed invoice balance/i);
  });

  test("14. cross-currency application (Invoice USD, OR PHP) is rejected", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 400 }, appliedType: "OR", appliedId: nextAppliedId++,
          paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", isPosting: false, companyId,
        })
      )
    ).rejects.toThrow(/Cross-currency settlement is not enabled/i);
  });

  test("15. a posted (locked) Invoice's rate is still readable and usable for a later application", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD", locked: true,
    });
    const application = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 1000 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    expect(application.sourceExchangeRate).toBe(57);
  });

  test("16. application history is fully reconstructable (source rate, payment rate, base amounts, FX fields all stored)", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    const appliedId = nextAppliedId++;
    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 400 }, appliedType: "OR", appliedId,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute(
      `SELECT source_type, source_id, applied_type, applied_id, amount, source_currency_code, payment_currency_code,
              foreign_amount_applied, source_exchange_rate, payment_exchange_rate, source_base_amount, payment_base_amount,
              fx_difference, fx_direction
       FROM transaction_applications WHERE applied_type = 'OR' AND applied_id = ?`,
      [appliedId]
    );
    const row = rows[0];
    expect(row.source_type).toBe("INV");
    expect(Number(row.source_id)).toBe(invoiceId);
    expect(row.source_currency_code).toBe("USD");
    expect(row.payment_currency_code).toBe("USD");
    expect(Number(row.foreign_amount_applied)).toBe(400);
    expect(Number(row.source_exchange_rate)).toBe(57);
    expect(Number(row.payment_exchange_rate)).toBe(57);
    expect(Number(row.amount)).toBe(Number(row.payment_base_amount));
  });

  test("17. payment status transitions Unpaid -> Partially Paid -> Paid as foreign balance is paid down", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    let [rows] = await pool.execute("SELECT payment_status AS s FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(rows[0].s).toBe("Unpaid");

    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 300 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    [rows] = await pool.execute("SELECT payment_status AS s FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(rows[0].s).toBe("Partially Paid");

    await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 700 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    [rows] = await pool.execute("SELECT payment_status AS s FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(rows[0].s).toBe("Paid");
  });

  test("18. concurrent payment protection: two simultaneous applications for the full remaining balance - only one succeeds", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 600,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });

    const attempt = () =>
      withConn((conn) =>
        PaymentApplicationService.applyInvoicePayment(conn, {
          appItem: { sourceId: invoiceId, amount: 600 }, appliedType: "OR", appliedId: nextAppliedId++,
          paymentCurrencyCode: "USD", paymentExchangeRate: 57, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason.message).toMatch(/cannot exceed invoice balance/i);

    const [rows] = await pool.execute("SELECT foreign_balance_amount AS b FROM invoice_headers WHERE id = ?", [invoiceId]);
    expect(Number(rows[0].b)).toBe(0); // exactly one payment landed, balance is not negative
  });
});

describe("applyApvPayment - APV/CV (PAYABLE)", () => {
  test("19. PHP APV -> PHP CV: base case is completely unaffected (legacy behavior)", async () => {
    const apvId = await createApv({
      currencyId: phpId, exchangeRate: 1, foreignTotal: 3000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "PHP",
    });
    await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 3000 }, appliedType: "CV", appliedId: nextAppliedId++,
        paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute("SELECT payment_status AS s, balance_amount AS b FROM apv_headers WHERE id = ?", [apvId]);
    expect(rows[0].s).toBe("Paid");
    expect(Number(rows[0].b)).toBe(0);
  });

  test("20. USD APV -> USD CV partial payment tracks foreign paid/balance", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 56.5, foreignTotal: 800,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 300 }, appliedType: "CV", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 56.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute(
      "SELECT payment_status AS s, foreign_paid_amount AS paid, foreign_balance_amount AS bal FROM apv_headers WHERE id = ?",
      [apvId]
    );
    expect(rows[0].s).toBe("Partially Paid");
    expect(Number(rows[0].paid)).toBe(300);
    expect(Number(rows[0].bal)).toBe(500);
  });

  test("21. USD APV full payment marks Paid using the foreign balance", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 56.5, foreignTotal: 800,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 800 }, appliedType: "CV", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 56.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    const [rows] = await pool.execute("SELECT payment_status AS s FROM apv_headers WHERE id = ?", [apvId]);
    expect(rows[0].s).toBe("Paid");
  });

  test("22. overpayment on an APV is rejected", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 56.5, foreignTotal: 300,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyApvPayment(conn, {
          appItem: { sourceId: apvId, amount: 350 }, appliedType: "CV", appliedId: nextAppliedId++,
          paymentCurrencyCode: "USD", paymentExchangeRate: 56.5, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      )
    ).rejects.toThrow(/cannot exceed APV balance/i);
  });

  test("23. cross-currency application (APV USD, CV PHP) is rejected", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 56.5, foreignTotal: 300,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyApvPayment(conn, {
          appItem: { sourceId: apvId, amount: 100 }, appliedType: "CV", appliedId: nextAppliedId++,
          paymentCurrencyCode: "PHP", paymentExchangeRate: 1, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      )
    ).rejects.toThrow(/Cross-currency settlement is not enabled/i);
  });

  test("24. paying an APV at a WEAKER rate than its source rate is a REALIZED_GAIN (paid fewer pesos than owed)", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 500,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    const application = await withConn((conn) =>
      PaymentApplicationService.applyApvPayment(conn, {
        appItem: { sourceId: apvId, amount: 500 }, appliedType: "CV", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 56, baseCurrencyCode: "PHP", isPosting: false, companyId,
      })
    );
    expect(application.fxDirection).toBe("REALIZED_GAIN");
    expect(application.fxDifference).toBeLessThan(0);
  });

  // Checkpoint 3FX: this test's company never configures
  // company_fx_accounts, so a different-rate post is now blocked by the
  // FX-account check (fxAccountService.requireFxAccount) rather than by
  // buildApplication itself - realizedFxSettlement.test.js covers the
  // full posting-succeeds-once-configured path this test used to block
  // entirely.
  test("25. paying an APV at a different rate is blocked when no FX account is configured for this company", async () => {
    const apvId = await createApv({
      currencyId: usdId, exchangeRate: 57, foreignTotal: 500,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    await expect(
      withConn((conn) =>
        PaymentApplicationService.applyApvPayment(conn, {
          appItem: { sourceId: apvId, amount: 500 }, appliedType: "CV", appliedId: nextAppliedId++,
          paymentCurrencyCode: "USD", paymentExchangeRate: 56, baseCurrencyCode: "PHP", isPosting: true, companyId,
        })
      )
    ).rejects.toThrow(/account is not configured/i);
  });
});

describe("GL balance verification for allowed (same-rate) postings", () => {
  test("26. a same-rate foreign settlement's base amount is internally consistent (no phantom FX)", async () => {
    const invoiceId = await createInvoice({
      currencyId: usdId, exchangeRate: 58, foreignTotal: 1000,
      baseCurrencyId: phpId, baseCurrencyCode: "PHP", currencyCode: "USD",
    });
    const application = await withConn((conn) =>
      PaymentApplicationService.applyInvoicePayment(conn, {
        appItem: { sourceId: invoiceId, amount: 1000 }, appliedType: "OR", appliedId: nextAppliedId++,
        paymentCurrencyCode: "USD", paymentExchangeRate: 58, baseCurrencyCode: "PHP", isPosting: true, companyId,
      })
    );
    // What actually gets recorded as the base-currency application amount
    // must equal both the source and payment base conversions (they're
    // identical at the same rate) - this is the value the OR's own AR
    // settlement line and the Invoice's balance reduction both rely on.
    expect(application.baseAmount).toBe(application.sourceBaseAmount);
    expect(application.baseAmount).toBe(application.paymentBaseAmount);
    expect(application.baseAmount).toBe(58000);
  });
});
