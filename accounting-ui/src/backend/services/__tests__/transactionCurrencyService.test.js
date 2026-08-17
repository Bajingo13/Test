const pool = require("../../db");
const CurrencyService = require("../currencyService");
const TransactionCurrencyService = require("../transactionCurrencyService");

// Checkpoint 3A tests. `transactionType` is only ever used by this service
// as an opaque label passed through to transaction_currency_snapshots (the
// "INV"/"APV" values are server.js's convention, not something this
// service enforces) - so DB round-trip tests use dedicated fake types
// ("ZZTCSTST"/"ZZTCSTSA") that can never collide with real Invoice/APV
// snapshot rows, letting every test run safely against the real dev DB
// without touching production-shaped data.
const INV_TYPE = "ZZTCSTST";
const APV_TYPE = "ZZTCSTSA";

jest.setTimeout(30000);

let companyId, adminUser, accountantUser;
let phpId, usdId;
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

// Balanced 3-line foreign-currency invoice: AR debit 112, Sales credit 100,
// Output VAT Payable credit 12 - matches how ewtCalculationService's
// sumVatLines expects lines to be shaped (accountTitle + debit/credit).
function makeBalancedLines() {
  return [
    { accountTitle: "Accounts Receivable", debit: 112, credit: 0 },
    { accountTitle: "Sales Revenue", debit: 0, credit: 100 },
    { accountTitle: "Output VAT Payable", debit: 0, credit: 12 },
  ];
}

function makeUnbalancedLines() {
  return [
    { accountTitle: "Accounts Receivable", debit: 112, credit: 0 },
    { accountTitle: "Sales Revenue", debit: 0, credit: 100 },
    { accountTitle: "Output VAT Payable", debit: 0, credit: 11 }, // short by 1 -> unbalanced
  ];
}

beforeAll(async () => {
  companyId = await makeCompany("TEST CO - Multi-Currency Checkpoint 3A");
  adminUser = await makeUser("test_admin_tcs", 2); // ADMIN - has OVERRIDE_RATE (verified against role_permissions)
  accountantUser = await makeUser("test_accountant_tcs", 3); // ACCOUNTANT - does NOT have OVERRIDE_RATE

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
  await pool.execute("DELETE FROM transaction_currency_snapshots WHERE transaction_type IN (?, ?)", [INV_TYPE, APV_TYPE]);
  await pool.execute("DELETE FROM currency_rate_derivations WHERE currency_rate_id IN (SELECT id FROM currency_rates WHERE company_id = ?)", [companyId]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("computeBaseLines (pure, no DB)", () => {
  test("1. converts each line's foreign debit/credit to base at the given rate", () => {
    const result = TransactionCurrencyService.computeBaseLines({
      lines: [{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }],
      exchangeRate: 56,
    });
    expect(result.lines[0].baseDebit).toBe(5600);
    expect(result.lines[1].baseCredit).toBe(5600);
    expect(result.foreignTotalDebit).toBe(100);
    expect(result.baseTotalDebit).toBe(5600);
  });

  test("2. rounding drift across multiple lines is absorbed so base debit and credit totals balance EXACTLY", () => {
    const result = TransactionCurrencyService.computeBaseLines({
      lines: [
        { debit: 100, credit: 0 },
        { debit: 0, credit: 33.33 },
        { debit: 0, credit: 33.33 },
        { debit: 0, credit: 33.34 },
      ],
      exchangeRate: 56.789,
    });
    // The core GL invariant: despite per-line rounding, base debit and
    // base credit land on the exact same total.
    expect(result.baseTotalDebit).toBe(result.baseTotalCredit);
    const sumOfLineCredits = result.lines.reduce((s, l) => s + l.baseCredit, 0);
    expect(Math.round(sumOfLineCredits * 100) / 100).toBe(result.baseTotalCredit);
  });

  test("3. base-currency (rate=1) passthrough: base amounts equal foreign amounts", () => {
    const result = TransactionCurrencyService.computeBaseLines({
      lines: [{ debit: 250.5, credit: 0 }, { debit: 0, credit: 250.5 }],
      exchangeRate: 1,
    });
    expect(result.baseTotalDebit).toBe(result.foreignTotalDebit);
    expect(result.baseTotalCredit).toBe(result.foreignTotalCredit);
  });
});

describe("computeForeignTaxTotals (pure, reuses ewtCalculationService.sumVatLines)", () => {
  test("4. splits gross into subtotal/tax/ewt/total using the existing VAT-line detection, no second formula", () => {
    const totals = TransactionCurrencyService.computeForeignTaxTotals({
      lines: makeBalancedLines(),
      grossAmount: 112,
      vatKeyword: "output vat",
      taxWithheldAmount: 2.24,
    });
    expect(totals.foreignTotal).toBe(112);
    expect(totals.foreignTax).toBe(12);
    expect(totals.foreignSubtotal).toBe(100);
    expect(totals.foreignEwt).toBe(2.24);
  });

  test("5. no matching VAT line -> subtotal equals the full gross (non-VAT transaction)", () => {
    const totals = TransactionCurrencyService.computeForeignTaxTotals({
      lines: [{ accountTitle: "Accounts Receivable", debit: 50, credit: 0 }, { accountTitle: "Sales", debit: 0, credit: 50 }],
      grossAmount: 50,
      vatKeyword: "output vat",
      taxWithheldAmount: 0,
    });
    expect(totals.foreignTax).toBe(0);
    expect(totals.foreignSubtotal).toBe(50);
  });
});

describe("resolveTransactionCurrency - base currency (backward compatible default)", () => {
  test("6. no currencyPayload -> resolves to base currency, rate 1, wasLocked false", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: undefined, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.currencyCode).toBe("PHP");
    expect(result.rateInfo.exchangeRate).toBe(1);
    expect(result.rateInfo.rateSource).toBe("BASE");
    expect(result.baseTotals.baseTotal).toBe(112);
    expect(result.wasLocked).toBe(false);
  });

  test("7. explicit currencyId = base currency id -> same as no payload", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: { currencyId: phpId }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(1);
  });
});

describe("resolveTransactionCurrency - foreign currency, first save", () => {
  const rateDate = "2026-01-10";

  beforeAll(async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 56, effectiveDate: rateDate, reason: "test seed" });
  });

  test("8. brand-new foreign-currency transaction auto-resolves a rate and converts lines correctly", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.currencyCode).toBe("USD");
    expect(result.rateInfo.exchangeRate).toBe(56);
    expect(result.foreignTotals.foreignTotal).toBe(112);
    expect(result.baseTotals.baseTotal).toBe(112 * 56);
    expect(result.baseTotalDebit).toBe(result.baseTotalCredit); // GL balances in base currency
  });

  test("9. unbalanced foreign lines are rejected before any base conversion is trusted", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
        currencyPayload: { currencyId: usdId, rateDate }, lines: makeUnbalancedLines(), grossAmount: 112,
        vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/not balanced/i);
  });

  test("10. a currency belonging to a different company is rejected", async () => {
    const otherCompanyId = await makeCompany("TEST CO - Other Company for currency isolation check");
    try {
      // Inserted directly (bypassing CurrencyService.createCurrency's own
      // company-access check, which adminUser deliberately does NOT have
      // for otherCompanyId) - this test targets
      // TransactionCurrencyService's own cross-company guard, not
      // currencyService's.
      const [insertResult] = await pool.execute(
        `INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, decimal_places, symbol_position, default_rate_mode, is_active, created_by, updated_by)
         VALUES (?, 'EUR', 'Euro', '€', 2, 'BEFORE', 'MANUAL', 1, ?, ?)`,
        [otherCompanyId, adminUser.id, adminUser.id]
      );
      const otherUsd = { id: insertResult.insertId };
      await expect(
        TransactionCurrencyService.resolveTransactionCurrency({
          user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
          currencyPayload: { currencyId: otherUsd.id }, lines: makeBalancedLines(), grossAmount: 112,
          vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
        })
      ).rejects.toThrow(/does not belong to this company/i);
    } finally {
      await pool.execute("DELETE FROM currencies WHERE company_id = ?", [otherCompanyId]);
      await pool.execute("DELETE FROM companies WHERE id = ?", [otherCompanyId]);
    }
  });

  test("11. an inactive currency is rejected", async () => {
    const inactive = await CurrencyService.createCurrency(adminUser, {
      currencyCode: "JPY", currencyName: "Japanese Yen", currencySymbol: "¥",
      decimalPlaces: 0, symbolPosition: "BEFORE", defaultRateMode: "MANUAL", companyId,
    });
    await CurrencyService.setStatus(adminUser, inactive.id, false);
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
        currencyPayload: { currencyId: inactive.id }, lines: makeBalancedLines(), grossAmount: 112,
        vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/not active/i);
    await pool.execute("DELETE FROM currencies WHERE id = ?", [inactive.id]);
  });
});

describe("resolveTransactionCurrency - draft persistence, refresh, and locking", () => {
  const rateDate = "2026-01-11";
  let transactionId;

  beforeAll(async () => {
    transactionId = 1;
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 57, effectiveDate: rateDate, reason: "initial" });
  });

  test("12. first save persists a snapshot at the resolved rate", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(57);
    await TransactionCurrencyService.saveSnapshot(pool, {
      companyId, transactionType: INV_TYPE, transactionId, currencyId: result.currencyId, currencyCode: result.currencyCode,
      baseCurrencyId: result.baseCurrencyId, baseCurrencyCode: result.baseCurrencyCode, rateInfo: result.rateInfo,
      foreignTotals: result.foreignTotals, baseTotals: result.baseTotals, userId: adminUser.id, lockNow: false,
    });
    const snapshot = await TransactionCurrencyService.getSnapshot(INV_TYPE, transactionId);
    expect(snapshot.exchangeRate).toBe(57);
    expect(snapshot.rateLocked).toBe(false);
  });

  test("13. reopening the SAME draft (no refresh/override) keeps the stored rate even after a newer market rate is recorded", async () => {
    // A newer rate for the exact same date is now on file - the draft must
    // NOT silently pick it up just because it exists.
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 60, effectiveDate: rateDate, reason: "newer market rate" });

    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId,
      currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(57); // unchanged - still the original stored rate
  });

  test("14. an explicit refresh DOES pick up the newer rate", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId,
      currencyPayload: { currencyId: usdId, rateDate, isRefresh: true }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(60);
    // A resolve-only call never writes anything by itself (section 27's
    // "store only happens when the caller decides to save") - the real
    // Invoice/APV route handlers persist via saveSnapshot right after
    // resolving, so this test does the same before the next tests rely on
    // the refreshed rate being on file.
    await TransactionCurrencyService.saveSnapshot(pool, {
      companyId, transactionType: INV_TYPE, transactionId, currencyId: result.currencyId, currencyCode: result.currencyCode,
      baseCurrencyId: result.baseCurrencyId, baseCurrencyCode: result.baseCurrencyCode, rateInfo: result.rateInfo,
      foreignTotals: result.foreignTotals, baseTotals: result.baseTotals, userId: adminUser.id, lockNow: false,
    });
  });

  test("15. posting locks the snapshot", async () => {
    await TransactionCurrencyService.lockSnapshot(pool, INV_TYPE, transactionId);
    const snapshot = await TransactionCurrencyService.getSnapshot(INV_TYPE, transactionId);
    expect(snapshot.rateLocked).toBe(true);
  });

  test("16. a locked (posted) transaction rejects a currency change", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId,
        currencyPayload: { currencyId: phpId }, lines: makeBalancedLines(), grossAmount: 112,
        vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/cannot be changed/i);
  });

  test("17. a locked (posted) transaction rejects a rate change", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId,
        currencyPayload: { currencyId: usdId, exchangeRate: 999 }, lines: makeBalancedLines(), grossAmount: 112,
        vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/cannot be changed/i);
  });

  test("18. re-submitting a locked transaction with its OWN unchanged currency/rate succeeds (idempotent open/view)", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId,
      currencyPayload: { currencyId: usdId }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.wasLocked).toBe(true);
    expect(result.rateInfo.exchangeRate).toBe(60);
  });
});

describe("resolveTransactionCurrency - posting-rate policy enforcement", () => {
  const rateDate = "2026-01-12";

  beforeAll(async () => {
    await CurrencyService.recordRate(adminUser, usdId, {
      rateMode: "MANUAL", rate: 55, effectiveDate: rateDate, status: "PROVISIONAL", reason: "provisional test rate",
    });
  });

  test("19. posting is blocked when the default (FINAL) posting policy meets a PROVISIONAL rate", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
        currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
        vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: true,
      })
    ).rejects.toThrow(/provisional/i);
  });

  test("20. saving as a DRAFT with the same provisional rate is allowed (only posting is blocked)", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(55);
  });
});

describe("resolveTransactionCurrency - manual override", () => {
  const rateDate = "2026-01-13";

  beforeAll(async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 58, effectiveDate: rateDate, reason: "system rate" });
  });

  test("21. override without a reason is rejected", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
        currencyPayload: { currencyId: usdId, rateDate, isOverride: true, exchangeRate: 59.9 },
        lines: makeBalancedLines(), grossAmount: 112, vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/reason is required/i);
  });

  test("22. a user without OVERRIDE_RATE permission is rejected", async () => {
    await expect(
      TransactionCurrencyService.resolveTransactionCurrency({
        user: accountantUser, companyId, transactionType: INV_TYPE, transactionId: null,
        currencyPayload: { currencyId: usdId, rateDate, isOverride: true, exchangeRate: 59.9, overrideReason: "test" },
        lines: makeBalancedLines(), grossAmount: 112, vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
      })
    ).rejects.toThrow(/do not have permission/i);
  });

  test("23. an authorized override with a reason records the override rate alongside the system rate", async () => {
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: INV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate, isOverride: true, exchangeRate: 59.9, overrideReason: "Client-negotiated rate" },
      lines: makeBalancedLines(), grossAmount: 112, vatKeyword: "output vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.rateInfo.exchangeRate).toBe(59.9);
    expect(result.rateInfo.overrideRate).toBe(59.9);
    expect(result.rateInfo.systemRate).toBe(58);
    expect(result.rateInfo.overrideReason).toBe("Client-negotiated rate");
    expect(result.baseTotals.baseTotal).toBe(Math.round(112 * 59.9 * 100) / 100);
  });
});

describe("APV parity - the same service drives APV with an 'input vat' keyword and its own transaction type", () => {
  const rateDate = "2026-01-14";

  beforeAll(async () => {
    await CurrencyService.recordRate(adminUser, usdId, { rateMode: "MANUAL", rate: 56.5, effectiveDate: rateDate, reason: "APV parity test" });
  });

  test("24. APV-style purchase lines (input VAT) convert and balance correctly under the same code path", async () => {
    const lines = [
      { accountTitle: "Purchases", debit: 100, credit: 0 },
      { accountTitle: "Input VAT Receivable", debit: 12, credit: 0 },
      { accountTitle: "Accounts Payable", debit: 0, credit: 112 },
    ];
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: APV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate }, lines, grossAmount: 112,
      vatKeyword: "input vat", taxWithheldAmount: 0, isPosting: false,
    });
    expect(result.currencyCode).toBe("USD");
    expect(result.foreignTotals.foreignTax).toBe(12);
    expect(result.foreignTotals.foreignSubtotal).toBe(100);
    expect(result.baseTotals.baseTotal).toBe(112 * 56.5);
    expect(result.baseTotalDebit).toBe(result.baseTotalCredit);
  });

  test("25. APV snapshot round-trips through its own transaction type independently of INV's snapshot for the same numeric transactionId", async () => {
    const apvTransactionId = 1; // deliberately reuses INV_TYPE's id=1 to prove type-scoping, not id-scoping
    const result = await TransactionCurrencyService.resolveTransactionCurrency({
      user: adminUser, companyId, transactionType: APV_TYPE, transactionId: null,
      currencyPayload: { currencyId: usdId, rateDate }, lines: makeBalancedLines(), grossAmount: 112,
      vatKeyword: "input vat", taxWithheldAmount: 0, isPosting: false,
    });
    await TransactionCurrencyService.saveSnapshot(pool, {
      companyId, transactionType: APV_TYPE, transactionId: apvTransactionId, currencyId: result.currencyId, currencyCode: result.currencyCode,
      baseCurrencyId: result.baseCurrencyId, baseCurrencyCode: result.baseCurrencyCode, rateInfo: result.rateInfo,
      foreignTotals: result.foreignTotals, baseTotals: result.baseTotals, userId: adminUser.id, lockNow: false,
    });
    const apvSnapshot = await TransactionCurrencyService.getSnapshot(APV_TYPE, apvTransactionId);
    const invSnapshot = await TransactionCurrencyService.getSnapshot(INV_TYPE, apvTransactionId);
    expect(apvSnapshot.exchangeRate).toBe(56.5);
    expect(invSnapshot.exchangeRate).toBe(60); // INV_TYPE/id=1's snapshot from the earlier describe block, untouched
  });
});
