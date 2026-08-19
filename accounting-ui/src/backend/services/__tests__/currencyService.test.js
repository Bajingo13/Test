const pool = require("../../db");
const CurrencyService = require("../currencyService");
const PermissionService = require("../permissionService");

// Remote Railway MySQL round-trips comfortably exceed Jest's default 5s
// hook/test timeout, especially in beforeAll's several sequential inserts.
jest.setTimeout(30000);

// Integration tests against the real dev database (this project has no
// separate test DB/mocking convention - see ConfidenceScoringService.test.js
// vs. this file for the split: pure-function services get pure unit tests,
// this service is fundamentally DB-driven, so its tests exercise the real
// schema/constraints). Everything created here lives under two throwaway
// companies and is deleted in afterAll; no real seed data is touched.

let companyA, companyB;
let superAdminUser, adminUserA, adminUserB, accountantUserA;
const createdUserIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}

async function makeUser(username, roleId, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'test-hash-not-used-for-login', ?, 'ACTIVE')",
    [username, roleId]
  );
  const userId = result.insertId;
  createdUserIds.push(userId);
  if (companyId) {
    await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  }
  return userId;
}

beforeAll(async () => {
  companyA = await makeCompany("TEST CO A - Currency Phase 1");
  companyB = await makeCompany("TEST CO B - Currency Phase 1");

  const superAdminId = await makeUser("test_super_admin_currency", 1, companyA);
  const adminAId = await makeUser("test_admin_a_currency", 2, companyA);
  const adminBId = await makeUser("test_admin_b_currency", 2, companyB);
  const accountantAId = await makeUser("test_accountant_a_currency", 3, companyA);

  superAdminUser = { id: superAdminId, roleCode: "SUPER_ADMIN" };
  adminUserA = { id: adminAId, roleCode: "ADMIN" };
  adminUserB = { id: adminBId, roleCode: "ADMIN" };
  accountantUserA = { id: accountantAId, roleCode: "ACCOUNTANT" };
});

afterAll(async () => {
  await pool.execute("DELETE FROM currency_rates WHERE company_id IN (?, ?)", [companyA, companyB]);
  await pool.execute("DELETE FROM currencies WHERE company_id IN (?, ?)", [companyA, companyB]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyA, companyB]);
  await pool.end();
});

describe("currencyService", () => {
  let phpId, usdId, jpyId;

  test("1. Create PHP (non-base initially)", async () => {
    const php = await CurrencyService.createCurrency(adminUserA, {
      companyId: companyA,
      currencyCode: "php",
      currencyName: "Philippine Peso",
      currencySymbol: "₱",
      isoNumericCode: "608",
      symbolPosition: "BEFORE",
      spaceAfterSymbol: false,
      decimalPlaces: 2,
      decimalSeparator: ".",
      thousandSeparator: ",",
      defaultRateMode: "MANUAL",
    });
    expect(php.currencyCode).toBe("PHP"); // lowercased input normalized to uppercase
    expect(php.isBaseCurrency).toBe(false);
    phpId = php.id;
  });

  test("2. Create USD", async () => {
    const usd = await CurrencyService.createCurrency(adminUserA, {
      companyId: companyA,
      currencyCode: "USD",
      currencyName: "US Dollar",
      currencySymbol: "$",
      decimalPlaces: 2,
      symbolPosition: "BEFORE",
      defaultRateMode: "MANUAL",
    });
    expect(usd.currencyCode).toBe("USD");
    usdId = usd.id;
  });

  test("3. Create JPY (0 decimal places)", async () => {
    const jpy = await CurrencyService.createCurrency(adminUserA, {
      companyId: companyA,
      currencyCode: "JPY",
      currencyName: "Japanese Yen",
      currencySymbol: "¥",
      decimalPlaces: 0,
      symbolPosition: "BEFORE",
      defaultRateMode: "MANUAL",
    });
    expect(jpy.decimalPlaces).toBe(0);
    jpyId = jpy.id;
  });

  test("4. Duplicate currency code rejected", async () => {
    await expect(
      CurrencyService.createCurrency(adminUserA, {
        companyId: companyA,
        currencyCode: "USD",
        currencyName: "US Dollar Duplicate",
        currencySymbol: "$",
        decimalPlaces: 2,
        symbolPosition: "BEFORE",
        defaultRateMode: "MANUAL",
      })
    ).rejects.toThrow(/already exists/i);
  });

  test("5. Set PHP as base currency", async () => {
    const php = await CurrencyService.setBaseCurrency(adminUserA, phpId);
    expect(php.isBaseCurrency).toBe(true);
    expect(php.defaultRateMode).toBe("BASE");
  });

  test("6. Attempt to create a second base currency is rejected", async () => {
    await expect(
      CurrencyService.createCurrency(adminUserA, {
        companyId: companyA,
        currencyCode: "EUR",
        currencyName: "Euro",
        currencySymbol: "€",
        decimalPlaces: 2,
        symbolPosition: "BEFORE",
        defaultRateMode: "BASE",
        isBaseCurrency: true,
      })
    ).rejects.toThrow(/already has a base currency/i);
  });

  test("7. Base currency rate is always exactly 1", async () => {
    const php = await CurrencyService.getCurrencyById(adminUserA, phpId);
    expect(php.currentRate).toBe(1);
  });

  test("8. Manual USD rate", async () => {
    const usd = await CurrencyService.recordRate(adminUserA, usdId, {
      rateMode: "MANUAL",
      rate: 57.25,
      effectiveDate: "2026-08-06",
      reason: "Initial manual rate",
    });
    expect(usd.currentRate).toBe(57.25);
    expect(usd.defaultRateMode).toBe("MANUAL");
  });

  test("9. Fixed USD rate", async () => {
    const usd = await CurrencyService.recordRate(adminUserA, usdId, {
      rateMode: "FIXED",
      rate: 57.5,
      effectiveDate: "2026-08-07",
      reason: "Switched to fixed rate",
    });
    expect(usd.currentRate).toBe(57.5);
    expect(usd.defaultRateMode).toBe("FIXED");
  });

  test("10. Rate history was created for both changes, oldest last, chain intact", async () => {
    const history = await CurrencyService.getRateHistory(adminUserA, usdId);
    expect(history.length).toBe(2);
    const [fixedEntry, manualEntry] = history; // ORDER BY created_at DESC
    expect(fixedEntry.rateMode).toBe("FIXED");
    expect(fixedEntry.oldRate).toBe(57.25);
    expect(fixedEntry.newRate).toBe(57.5);
    expect(manualEntry.rateMode).toBe("MANUAL");
    expect(manualEntry.oldRate).toBeNull();
    expect(manualEntry.newRate).toBe(57.25);
  });

  test("11. Invalid zero rate rejected", async () => {
    await expect(
      CurrencyService.recordRate(adminUserA, usdId, { rateMode: "MANUAL", rate: 0, effectiveDate: "2026-08-07" })
    ).rejects.toThrow(/greater than zero/i);
  });

  test("12. Negative rate rejected", async () => {
    await expect(
      CurrencyService.recordRate(adminUserA, usdId, { rateMode: "MANUAL", rate: -5, effectiveDate: "2026-08-07" })
    ).rejects.toThrow(/greater than zero/i);
  });

  test("13. Unauthorized rate modification: ACCOUNTANT lacks MANUAL_RATE/FIXED_RATE by default", async () => {
    const canManual = await PermissionService.can(accountantUserA.id, "FILESETUP.CURRENCY_SETUP", "MANUAL_RATE");
    const canFixed = await PermissionService.can(accountantUserA.id, "FILESETUP.CURRENCY_SETUP", "FIXED_RATE");
    const canView = await PermissionService.can(accountantUserA.id, "FILESETUP.CURRENCY_SETUP", "VIEW");
    expect(canManual).toBe(false);
    expect(canFixed).toBe(false);
    expect(canView).toBe(true); // ACCOUNTANT can view, per spec
  });

  test("14. Company isolation: Company B's admin cannot read Company A's currency", async () => {
    await expect(CurrencyService.getCurrencyById(adminUserB, usdId)).rejects.toThrow(/do not have access/i);
  });

  test("14b. Company isolation: Company B's admin cannot list Company A's currencies via explicit companyId", async () => {
    await expect(CurrencyService.listCurrencies(adminUserB, { companyId: companyA })).rejects.toThrow(/do not have access/i);
  });

  test("14c. SUPER_ADMIN bypasses company isolation", async () => {
    const currency = await CurrencyService.getCurrencyById(superAdminUser, usdId);
    expect(currency.id).toBe(usdId);
  });

  test("15. Currency activation", async () => {
    await CurrencyService.setStatus(adminUserA, jpyId, false);
    const reactivated = await CurrencyService.setStatus(adminUserA, jpyId, true);
    expect(reactivated.isActive).toBe(true);
  });

  test("16. Currency deactivation (non-base)", async () => {
    const deactivated = await CurrencyService.setStatus(adminUserA, jpyId, false);
    expect(deactivated.isActive).toBe(false);
    await CurrencyService.setStatus(adminUserA, jpyId, true); // restore for later tests
  });

  test("17. Attempt to deactivate the base currency is rejected", async () => {
    await expect(CurrencyService.setStatus(adminUserA, phpId, false)).rejects.toThrow(/cannot deactivate the company's base currency/i);
  });

  test("21. Base-currency change protection: blocked once real transactions exist in the system", async () => {
    // hasExistingTransactions() checks across the whole database, not a
    // single company (see currencyService.js) - so this test creates its
    // own throwaway transaction row rather than relying on ambient data
    // being present, which made this non-deterministic against an
    // isolated test database (Infrastructure Checkpoint fix).
    const [inv] = await pool.execute(
      "INSERT INTO invoice_headers (company_id, voucher_no, customer_name, transaction_date, total_debit, total_credit, status) VALUES (?, 'TESTCURR-HASTXN', 'x', CURDATE(), 0, 0, 'Draft')",
      [companyA]
    );
    try {
      const hasTransactions = await CurrencyService.hasExistingTransactions();
      expect(hasTransactions).toBe(true);
      await expect(CurrencyService.setBaseCurrency(adminUserA, usdId)).rejects.toThrow(/controlled migration process/i);
    } finally {
      await pool.execute("DELETE FROM invoice_headers WHERE id = ?", [inv.insertId]);
    }
  });

  test("22. Base currency remains active and correctly flagged after the earlier set-base-currency test", async () => {
    // Was hardcoded to company_id = 1 (the real production company) and
    // asserted its specific historical seed data - broken against an
    // isolated test database. Rewritten to check this test file's own
    // companyA/phpId fixture (set as base currency in test 5 above),
    // which is deterministic regardless of what other data exists
    // (Infrastructure Checkpoint fix).
    const [rows] = await pool.execute(
      "SELECT currency_code AS currencyCode, is_base_currency AS isBaseCurrency, is_active AS isActive FROM currencies WHERE company_id = ? AND is_base_currency = 1",
      [companyA]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].currencyCode).toBe("PHP");
    expect(!!rows[0].isActive).toBe(true);
  });

  test("23. getRateHistory() ordering is deterministic even when two rate changes share the exact same created_at second", async () => {
    // Reproduces the Infrastructure Checkpoint bug directly rather than
    // hoping two real inserts happen to land in the same wall-clock
    // second (which is exactly what "do not use artificial sleeps"
    // rules out as a way to prove this) - two real rate changes are
    // recorded normally, then their created_at values are forced to be
    // byte-identical via a raw UPDATE, deterministically reconstructing
    // the tie condition. id DESC (added to getRateHistory()'s ORDER BY)
    // must then consistently resolve it to actual insertion order.
    const older = await CurrencyService.recordRate(adminUserA, usdId, {
      rateMode: "MANUAL", rate: 58.1, effectiveDate: "2026-08-10", reason: "tie test - older",
    });
    const newer = await CurrencyService.recordRate(adminUserA, usdId, {
      rateMode: "MANUAL", rate: 58.2, effectiveDate: "2026-08-10", reason: "tie test - newer",
    });

    const [historyRows] = await pool.query(
      "SELECT id, new_rate FROM currency_rates WHERE currency_id = ? ORDER BY id DESC LIMIT 2",
      [usdId]
    );
    const [olderRow, newerRow] = [historyRows[1], historyRows[0]];
    expect(Number(newerRow.new_rate)).toBe(58.2);

    const forcedTimestamp = "2026-08-10 12:00:00";
    await pool.execute("UPDATE currency_rates SET created_at = ? WHERE id IN (?, ?)", [forcedTimestamp, olderRow.id, newerRow.id]);
    const [tiedCheck] = await pool.query("SELECT DISTINCT created_at FROM currency_rates WHERE id IN (?, ?)", [olderRow.id, newerRow.id]);
    expect(tiedCheck.length).toBe(1); // confirms the tie was genuinely forced, not assumed

    for (let attempt = 0; attempt < 3; attempt++) {
      const history = await CurrencyService.getRateHistory(adminUserA, usdId);
      const tiedEntries = history.filter((h) => h.id === olderRow.id || h.id === newerRow.id);
      expect(tiedEntries.length).toBe(2);
      expect(tiedEntries[0].id).toBe(newerRow.id); // higher id (genuinely later) must sort first
      expect(tiedEntries[1].id).toBe(olderRow.id);
    }
  });
});
