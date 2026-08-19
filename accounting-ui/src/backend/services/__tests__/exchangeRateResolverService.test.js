const pool = require("../../db");
const CurrencyService = require("../currencyService");
const Resolver = require("../exchangeRateResolverService");
const { getProvider } = require("../exchangeRateProviders");

jest.setTimeout(30000);

let companyPhp, companyUsd;
let adminPhp, adminUsd;
const createdUserIds = [];

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
  createdUserIds.push(userId);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyId]);
  return { id: userId, roleCode: "ADMIN" };
}

beforeAll(async () => {
  companyPhp = await makeCompany("TEST CO PHP - Exchange Rate Phase 2");
  companyUsd = await makeCompany("TEST CO USD - Exchange Rate Phase 2");
  adminPhp = await makeUser("test_admin_php_fx", companyPhp);
  adminUsd = await makeUser("test_admin_usd_fx", companyUsd);
});

afterAll(async () => {
  await pool.execute("DELETE FROM currency_rate_derivations WHERE currency_rate_id IN (SELECT id FROM currency_rates WHERE company_id IN (?, ?))", [companyPhp, companyUsd]);
  await pool.execute("DELETE FROM currency_rates WHERE company_id IN (?, ?)", [companyPhp, companyUsd]);
  await pool.execute("DELETE FROM company_rate_policies WHERE company_id IN (?, ?)", [companyPhp, companyUsd]);
  await pool.execute("DELETE FROM currencies WHERE company_id IN (?, ?)", [companyPhp, companyUsd]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id IN (?, ?)", [companyPhp, companyUsd]);
  await pool.end();
});

describe("Provider classes", () => {
  test("1. BAP provider configuration: no automated source, honest MANUAL_ONLY health, real basis labels", async () => {
    const bap = getProvider("BAP");
    expect(bap.code).toBe("BAP");
    const health = await bap.healthCheck();
    expect(health.status).toBe("MANUAL_ONLY");
    expect(await bap.getSupportedCurrencies()).toEqual(["USD"]);
    expect(await bap.getSupportedRateTypes()).toContain("DAILY_WEIGHTED_AVERAGE");
  });

  test("2. BSP provider configuration: no automated source (robots.txt), honest MANUAL_ONLY health", async () => {
    const bsp = getProvider("BSP");
    expect(bsp.code).toBe("BSP");
    const health = await bsp.healthCheck();
    expect(health.status).toBe("MANUAL_ONLY");
    expect(await bsp.getSupportedCurrencies()).toContain("JPY");
  });

  test("12. Provider unavailable: BAP/BSP getLatestRate never fakes a rate", async () => {
    const bapResult = await getProvider("BAP").getLatestRate({ foreignCurrencyCode: "USD", baseCurrencyCode: "PHP" });
    expect(bapResult.rate).toBeNull();
    expect(bapResult.status).toBe("MANUAL_ONLY");
    expect(bapResult.errorMessage).toMatch(/Bloomberg/);

    const bspResult = await getProvider("BSP").getLatestRate({ foreignCurrencyCode: "JPY", baseCurrencyCode: "PHP" });
    expect(bspResult.rate).toBeNull();
    expect(bspResult.status).toBe("MANUAL_ONLY");
    expect(bspResult.errorMessage).toMatch(/robots\.txt/);
  });

  test("11. External provider: unconfigured short-circuits with no network attempt (no hang, no fake success)", async () => {
    delete process.env.EXCHANGE_RATE_API_URL;
    const health = await getProvider("EXTERNAL").healthCheck();
    expect(health.status).toBe("UNAVAILABLE");
  });
});

describe("buildPriorityChain", () => {
  test("3. USD/PHP resolution: BAP first, BSP second", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "PHP", foreignCurrencyCode: "USD", policy: { preferredUsdPhpProvider: "BAP" } });
    expect(chain[0]).toEqual({ tier: "DIRECT", provider: "BAP" });
    expect(chain[1]).toEqual({ tier: "DIRECT", provider: "BSP" });
  });

  test("4. JPY/PHP: direct BSP cross-rate tier first, then derived-via-USD", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "PHP", foreignCurrencyCode: "JPY", policy: { preferredCrossRateProvider: "BSP" } });
    expect(chain[0]).toEqual({ tier: "DIRECT", provider: "BSP" });
    expect(chain[1]).toEqual({ tier: "DERIVED_VIA_USD" });
  });

  test("5. EUR/PHP: same direct-cross-then-derived shape as other non-USD PHP pairs", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "PHP", foreignCurrencyCode: "EUR", policy: { preferredCrossRateProvider: "BSP" } });
    expect(chain[0].provider).toBe("BSP");
    expect(chain[1].tier).toBe("DERIVED_VIA_USD");
  });

  test("28. Same currency as base: BASE tier only, rate always 1", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "PHP", foreignCurrencyCode: "PHP", policy: {} });
    expect(chain).toEqual([{ tier: "BASE" }]);
  });

  test("29. Base currency other than PHP: BAP/BSP never appear for a pair not involving PHP", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "USD", foreignCurrencyCode: "EUR", policy: {} });
    expect(chain.some((s) => s.provider === "BAP" || s.provider === "BSP")).toBe(false);
    expect(chain[0]).toEqual({ tier: "DIRECT", provider: "EXTERNAL" });
  });

  test("29b. Base currency other than PHP, but PHP is the foreign currency: BAP/BSP still apply (pair involves PHP)", () => {
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "USD", foreignCurrencyCode: "PHP", policy: { preferredUsdPhpProvider: "BAP" } });
    expect(chain[0]).toEqual({ tier: "DIRECT", provider: "BAP" });
  });
});

describe("deriveViaUsd (pure)", () => {
  test("6. Derives EUR/PHP via EUR/USD x USD/PHP correctly", () => {
    const result = Resolver.deriveViaUsd({
      foreignUsdLeg: { rate: 1.17, currencyCode: "EUR", provider: "EXTERNAL", rateBasis: null, effectiveDate: "2026-08-07", publicationTimestamp: null },
      usdBaseLeg: { rate: 57.25, baseCurrencyCode: "PHP", provider: "BAP", rateBasis: "DAILY_WEIGHTED_AVERAGE", effectiveDate: "2026-08-07", publicationTimestamp: null },
    });
    expect(result.status).toBe("FINAL");
    expect(result.rate).toBeCloseTo(66.9825, 4);
    expect(result.derivationMethod).toBe("CROSS_VIA_USD");
    expect(result.components).toHaveLength(2);
    expect(result.components[0].currencyPair).toBe("EUR/USD");
    expect(result.components[1].currencyPair).toBe("USD/PHP");
  });

  test("27. Different-date derivation protection: mismatched leg dates are rejected, not silently mixed", () => {
    const result = Resolver.deriveViaUsd({
      foreignUsdLeg: { rate: 1.17, currencyCode: "EUR", provider: "EXTERNAL", effectiveDate: "2026-08-07" },
      usdBaseLeg: { rate: 57.25, baseCurrencyCode: "PHP", provider: "BAP", effectiveDate: "2026-08-06" },
    });
    expect(result.rate).toBeNull();
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toMatch(/different dates|dated/);
  });

  test("missing leg fails cleanly", () => {
    const result = Resolver.deriveViaUsd({ foreignUsdLeg: null, usdBaseLeg: { rate: 57.25 } });
    expect(result.status).toBe("FAILED");
  });
});

describe("resolveRate (DB-backed integration)", () => {
  let usdCurrencyId;

  test("setup: PHP base + USD foreign currency for companyPhp", async () => {
    const php = await CurrencyService.createCurrency(adminPhp, {
      companyId: companyPhp, currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true,
    });
    expect(php.isBaseCurrency).toBe(true);

    const usd = await CurrencyService.createCurrency(adminPhp, {
      companyId: companyPhp, currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL",
    });
    usdCurrencyId = usd.id;
  });

  test("28b. Base currency resolveRate: rate is always exactly 1, provider BASE", async () => {
    const phpCurrency = (await CurrencyService.listCurrencies(adminPhp, { companyId: companyPhp })).find((c) => c.isBaseCurrency);
    const result = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: phpCurrency.id, transactionDate: "2026-08-07" });
    expect(result.rate).toBe(1);
    expect(result.provider).toBe("BASE");
  });

  test("14. Manual-required fallback: no rate recorded yet, policy set to MANUAL_REQUIRED", async () => {
    await Resolver.upsertCompanyPolicy(companyPhp, { fallbackMode: "MANUAL_REQUIRED" });
    const result = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdCurrencyId, transactionDate: "2026-08-07" });
    expect(result.rate).toBeNull();
    expect(result.status).toBe("MANUAL_REQUIRED");
    expect(result.fallbackApplied).toBe("MANUAL_REQUIRED");
  });

  test("16. Block-transaction fallback", async () => {
    await Resolver.upsertCompanyPolicy(companyPhp, { fallbackMode: "BLOCK_TRANSACTION" });
    const result = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdCurrencyId, transactionDate: "2026-08-07" });
    expect(result.status).toBe("BLOCKED");
    expect(result.fallbackApplied).toBe("BLOCK_TRANSACTION");
  });

  test("19. Provider metadata persistence: recordRate stores provider/basis/ingestion/status", async () => {
    const currency = await CurrencyService.recordRate(adminPhp, usdCurrencyId, {
      rateMode: "MANUAL", rate: 57.25, effectiveDate: "2026-08-07",
      provider: "MANUAL", rateBasis: null, ingestionMethod: "MANUAL_ENTRY", status: "MANUAL",
    });
    expect(currency.currentRate).toBe(57.25);

    const history = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);
    expect(history[0].provider).toBe("MANUAL");
    expect(history[0].ingestionMethod).toBe("MANUAL_ENTRY");
    expect(history[0].status).toBe("MANUAL");
  });

  test("20. Manual BAP official rate entry: provider=BAP, ingestionMethod=MANUAL_ENTRY - distinguishable from an automated fetch", async () => {
    const currency = await CurrencyService.recordRate(adminPhp, usdCurrencyId, {
      rateMode: "MANUAL", rate: 57.3, effectiveDate: "2026-08-07",
      provider: "BAP", rateBasis: "DAILY_WEIGHTED_AVERAGE", ingestionMethod: "MANUAL_ENTRY", status: "FINAL",
      sourceReference: "BAP FX Historical Data Summary, Aug 7 2026",
    });
    expect(currency.currentRate).toBe(57.3);

    const history = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);
    const entry = history.find((h) => h.newRate === 57.3);
    expect(entry.provider).toBe("BAP");
    expect(entry.ingestionMethod).toBe("MANUAL_ENTRY"); // never indistinguishable from an automated API fetch
    expect(entry.sourceReference).toMatch(/BAP FX Historical/);
  });

  test("13. Last approved fallback: LAST_APPROVED_RATE policy returns the most recently stored rate", async () => {
    await Resolver.upsertCompanyPolicy(companyPhp, { fallbackMode: "LAST_APPROVED_RATE" });
    const result = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdCurrencyId, transactionDate: "2026-08-07" });
    expect(result.rate).toBe(57.3);
    expect(result.provider).toBe("BAP");
  });

  test("17. Weekend/previous-business-day lookup: a later date reuses the latest prior stored rate, dates kept distinct", async () => {
    const result = await Resolver.lookupLastApproved({ currencyId: usdCurrencyId, transactionDate: "2026-08-09", allowPreviousBusinessDay: true, maxRateAgeDays: 5 });
    expect(result.rate).toBe(57.3);
    expect(result.effectiveDate).toBe("2026-08-07"); // rate_effective_date
    expect(result.usedPreviousBusinessDay).toBe(true);
    expect(result.transactionDate).toBe("2026-08-09"); // transaction_date stays distinct, never overwritten
  });

  test("17b. Previous-business-day lookup respects allowPreviousBusinessDay=false", async () => {
    const result = await Resolver.lookupLastApproved({ currencyId: usdCurrencyId, transactionDate: "2026-08-09", allowPreviousBusinessDay: false, maxRateAgeDays: 5 });
    expect(result).toBeNull();
  });

  test("regression: refreshing after a manual official BAP entry must NOT be reported as a genuine live BAP fetch", async () => {
    // Caught by live Playwright verification, not by the unit tests above
    // in isolation: resolveRate()'s LAST_APPROVED tier can return
    // provider="BAP" (whatever provider was on the historical row it read
    // back - here, a manually entered rate), and the refresh endpoint
    // originally keyed off provider alone, so it wrongly reported
    // "Updated from BAP" for a row that was never automatically fetched.
    await Resolver.upsertCompanyPolicy(companyPhp, { fallbackMode: "LAST_APPROVED_RATE" });
    const historyBefore = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);

    const ExchangeRateController = require("../../controllers/exchangeRate.controller");
    const result = await ExchangeRateController.refreshOneForJob(adminPhp, usdCurrencyId, { transactionDate: "2026-08-07" });

    expect(result.stored).toBe(false); // must not claim a fresh fetch happened
    expect(result.resolvedTier).toBe("LAST_APPROVED");

    const historyAfter = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);
    expect(historyAfter.length).toBe(historyBefore.length); // no phantom "refresh" row written
  });

  test("15. Fixed-rate fallback", async () => {
    await CurrencyService.recordRate(adminPhp, usdCurrencyId, { rateMode: "FIXED", rate: 58, effectiveDate: "2026-08-07", provider: "FIXED" });
    await Resolver.upsertCompanyPolicy(companyPhp, { fallbackMode: "FIXED_RATE" });
    const fixedResult = await getProvider("FIXED").getLatestRate({ currencyId: usdCurrencyId });
    expect(fixedResult.rate).toBe(58);
    expect(fixedResult.status).toBe("FIXED");
  });

  test("24/25. Rate refresh does not write a duplicate row when the resolved tier isn't a live one (duplicate refresh protection)", async () => {
    const before = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);
    // Resolving again right now can only reach MANUAL/FIXED/LAST_APPROVED
    // (no live BAP/BSP/EXTERNAL data exists) - a "refresh" against those
    // tiers must not fabricate a new stored row each time it's called.
    const result1 = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdCurrencyId, transactionDate: "2026-08-07" });
    const result2 = await Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdCurrencyId, transactionDate: "2026-08-07" });
    expect(["MANUAL", "FIXED"]).toContain(result1.provider);
    expect(result1.provider).toBe(result2.provider);
    const after = await CurrencyService.getRateHistory(adminPhp, usdCurrencyId);
    expect(after.length).toBe(before.length); // resolving (reading) never itself writes
  });

  test("26. Derived-rate component storage round-trip", async () => {
    const updated = await CurrencyService.recordRate(adminPhp, usdCurrencyId, {
      rateMode: "MANUAL", rate: 66.9825, effectiveDate: "2026-08-07",
      provider: "DERIVED", ingestionMethod: "DERIVED", status: "FINAL", derivationMethod: "CROSS_VIA_USD",
    });
    await Resolver.saveDerivationComponents(updated.rateId, [
      { currencyPair: "EUR/USD", rate: 1.17, provider: "EXTERNAL", rateBasis: null, effectiveDate: "2026-08-07" },
      { currencyPair: "USD/PHP", rate: 57.25, provider: "BAP", rateBasis: "DAILY_WEIGHTED_AVERAGE", effectiveDate: "2026-08-07" },
    ]);
    const components = await Resolver.getDerivationComponents(updated.rateId);
    expect(components).toHaveLength(2);
    expect(components[0].currencyPair).toBe("EUR/USD");
    expect(components[1].rate).toBe(57.25);
  });

  test("9/10. Invalid rates (zero/negative) rejected by recordRate, same Phase 1 validation reused for official/derived entries", async () => {
    await expect(
      CurrencyService.recordRate(adminPhp, usdCurrencyId, { rateMode: "MANUAL", rate: 0, effectiveDate: "2026-08-07", provider: "BAP" })
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      CurrencyService.recordRate(adminPhp, usdCurrencyId, { rateMode: "MANUAL", rate: -1, effectiveDate: "2026-08-07", provider: "BSP" })
    ).rejects.toThrow(/greater than zero/i);
  });

  test("22. Company isolation: a currency from another company cannot be resolved through this company's id", async () => {
    const usdForOtherCompany = await CurrencyService.createCurrency(adminUsd, {
      companyId: companyUsd, currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true,
    });
    await expect(
      Resolver.resolveRate({ companyId: companyPhp, foreignCurrencyId: usdForOtherCompany.id, transactionDate: "2026-08-07" })
    ).rejects.toThrow(/does not belong/i);
  });

  test("23. Permission denial: ACCOUNTANT lacks REFRESH_RATE/IMPORT_RATES/ENTER_OFFICIAL_RATE/CONFIGURE_PROVIDER by default", async () => {
    const PermissionService = require("../permissionService");
    const [accountantRole] = await pool.execute("SELECT id FROM roles WHERE code = 'ACCOUNTANT'");
    const testAccountantId = await (async () => {
      const [result] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, 'x', ?, 'ACTIVE')",
        ["test_accountant_fx_perm", accountantRole[0].id]
      );
      createdUserIds.push(result.insertId);
      return result.insertId;
    })();

    expect(await PermissionService.can(testAccountantId, "FILESETUP.CURRENCY_SETUP", "REFRESH_RATE")).toBe(false);
    expect(await PermissionService.can(testAccountantId, "FILESETUP.CURRENCY_SETUP", "IMPORT_RATES")).toBe(false);
    expect(await PermissionService.can(testAccountantId, "FILESETUP.CURRENCY_SETUP", "ENTER_OFFICIAL_RATE")).toBe(false);
    expect(await PermissionService.can(testAccountantId, "FILESETUP.CURRENCY_SETUP", "CONFIGURE_PROVIDER")).toBe(false);
    expect(await PermissionService.can(testAccountantId, "FILESETUP.CURRENCY_SETUP", "VIEW_PROVIDER_STATUS")).toBe(true);
  });

  test("29c. Company whose base currency is USD (not PHP): USD's own rate resolves to 1, PHP resolves via BAP/BSP tier", async () => {
    const usdBase = (await CurrencyService.listCurrencies(adminUsd, { companyId: companyUsd })).find((c) => c.isBaseCurrency);
    const result = await Resolver.resolveRate({ companyId: companyUsd, foreignCurrencyId: usdBase.id, transactionDate: "2026-08-07" });
    expect(result.rate).toBe(1);

    const phpForUsdCompany = await CurrencyService.createCurrency(adminUsd, {
      companyId: companyUsd, currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
      decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL",
    });
    const chain = Resolver.buildPriorityChain({ baseCurrencyCode: "USD", foreignCurrencyCode: "PHP", policy: await Resolver.getCompanyPolicy(companyUsd) });
    expect(chain[0].provider).toBe("BAP"); // PHP/USD pair -> BAP is still the preferred USD/PHP tier
    void phpForUsdCompany;
  });

  test("30. lookupLastApproved() is deterministic even when two same-effective-date rate rows share the exact same created_at second", async () => {
    // Same reproduction technique as currencyService.test.js's equivalent
    // test: force a real tie via a raw UPDATE rather than hoping two
    // real inserts land in the same wall-clock second. id DESC (added to
    // lookupLastApproved()'s ORDER BY) must consistently resolve it to
    // actual insertion order - the newer row's rate must win, every time.
    const older = await CurrencyService.recordRate(adminPhp, usdCurrencyId, {
      rateMode: "MANUAL", rate: 61.1, effectiveDate: "2026-08-11", reason: "tie test - older",
    });
    const newer = await CurrencyService.recordRate(adminPhp, usdCurrencyId, {
      rateMode: "MANUAL", rate: 61.2, effectiveDate: "2026-08-11", reason: "tie test - newer",
    });
    void older;
    expect(newer.currentRate).toBe(61.2);

    const [tieRows] = await pool.query(
      "SELECT id FROM currency_rates WHERE currency_id = ? AND effective_date = '2026-08-11' ORDER BY id DESC LIMIT 2",
      [usdCurrencyId]
    );
    const [newerId, olderId] = [tieRows[0].id, tieRows[1].id];

    const forcedTimestamp = "2026-08-11 09:30:00";
    await pool.execute("UPDATE currency_rates SET created_at = ? WHERE id IN (?, ?)", [forcedTimestamp, olderId, newerId]);
    const [tiedCheck] = await pool.query("SELECT DISTINCT created_at FROM currency_rates WHERE id IN (?, ?)", [olderId, newerId]);
    expect(tiedCheck.length).toBe(1); // confirms the tie was genuinely forced, not assumed

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await Resolver.lookupLastApproved({
        currencyId: usdCurrencyId, transactionDate: "2026-08-11", allowPreviousBusinessDay: false, maxRateAgeDays: 5,
      });
      expect(result.rate).toBe(61.2); // the genuinely later (higher id) row must win every time
    }
  });
});
