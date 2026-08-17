const pool = require("../../db");
const CurrencyService = require("../currencyService");
const ImportService = require("../exchangeRateImportService");

jest.setTimeout(30000);

let companyId, adminUser, usdCurrencyId, phpCurrencyId;
const createdUserIds = [];

async function makeCompany(name) {
  const [result] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return result.insertId;
}
async function makeUser(username, cid) {
  const [result] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, 'x', 2, 'ACTIVE')",
    [username]
  );
  createdUserIds.push(result.insertId);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [result.insertId, cid]);
  return { id: result.insertId, roleCode: "ADMIN" };
}

beforeAll(async () => {
  companyId = await makeCompany("TEST CO - Exchange Rate Import Phase 2");
  adminUser = await makeUser("test_admin_import_fx", companyId);
  const php = await CurrencyService.createCurrency(adminUser, {
    companyId, currencyCode: "PHP", currencyName: "Philippine Peso", currencySymbol: "₱",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "BASE", isBaseCurrency: true,
  });
  phpCurrencyId = php.id;
  const usd = await CurrencyService.createCurrency(adminUser, {
    companyId, currencyCode: "USD", currencyName: "US Dollar", currencySymbol: "$",
    decimalPlaces: 2, symbolPosition: "BEFORE", defaultRateMode: "MANUAL",
  });
  usdCurrencyId = usd.id;
});

afterAll(async () => {
  await pool.execute("DELETE FROM currency_rates WHERE company_id = ?", [companyId]);
  await pool.execute("DELETE FROM currencies WHERE company_id = ?", [companyId]);
  if (createdUserIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [createdUserIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [createdUserIds]);
  }
  await pool.execute("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

function csvBuffer(rows) {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
}

describe("21. Official-rate file import", () => {
  test("valid CSV row parses and previews without writing anything", async () => {
    const buffer = csvBuffer([
      ["Currency Pair", "Rate", "Rate Type", "Effective Date", "Source"],
      ["USD/PHP", "57.25", "Daily Weighted Average", "2026-08-07", "BAP"],
    ]);
    const preview = await ImportService.parsePreview({ buffer, filename: "rates.csv", companyId });
    expect(preview.totalCount).toBe(1);
    expect(preview.validCount).toBe(1);
    expect(preview.rows[0].currencyCode).toBe("USD");
    expect(preview.rows[0].rateBasis).toBe("DAILY_WEIGHTED_AVERAGE");

    const historyBefore = await CurrencyService.getRateHistory(adminUser, usdCurrencyId);
    expect(historyBefore.length).toBe(0); // preview never writes
  });

  test("invalid rows are flagged, not silently dropped: zero rate, unknown currency, bad source, base currency", async () => {
    const buffer = csvBuffer([
      ["Currency Pair", "Rate", "Rate Type", "Effective Date", "Source"],
      ["USD/PHP", "0", "Daily Weighted Average", "2026-08-07", "BAP"], // zero rate
      ["XYZ/PHP", "10", "Daily Weighted Average", "2026-08-07", "BAP"], // unknown currency
      ["USD/PHP", "57.25", "Daily Weighted Average", "2026-08-07", "YAHOO_FINANCE"], // invalid source
      ["PHP/PHP", "1", "Daily Weighted Average", "2026-08-07", "BSP"], // base currency
      ["USD/PHP", "not-a-number", "Daily Weighted Average", "2026-08-07", "BAP"], // invalid rate
    ]);
    const preview = await ImportService.parsePreview({ buffer, filename: "rates.csv", companyId });
    expect(preview.rows.every((r) => r.validationStatus === "INVALID")).toBe(true);
    expect(preview.rows[0].validationMessages.join(" ")).toMatch(/greater than zero/);
    expect(preview.rows[1].validationMessages.join(" ")).toMatch(/Unknown currency/);
    expect(preview.rows[2].validationMessages.join(" ")).toMatch(/Source must be/);
    expect(preview.rows[3].validationMessages.join(" ")).toMatch(/base currency/);
    expect(preview.rows[4].validationMessages.join(" ")).toMatch(/not a valid number/);
  });

  test("duplicate rows within the same file are flagged as conflicting", async () => {
    const buffer = csvBuffer([
      ["Currency Pair", "Rate", "Rate Type", "Effective Date", "Source"],
      ["USD/PHP", "57.25", "Daily Weighted Average", "2026-08-07", "BAP"],
      ["USD/PHP", "57.30", "Daily Weighted Average", "2026-08-07", "BAP"],
    ]);
    const preview = await ImportService.parsePreview({ buffer, filename: "rates.csv", companyId });
    expect(preview.rows[1].validationStatus).toBe("INVALID");
    expect(preview.rows[1].validationMessages.join(" ")).toMatch(/Duplicate row/);
  });

  test("confirmImport only writes VALID rows, records ingestionMethod=FILE_IMPORT, and audits provider distinctly from manual entry", async () => {
    const buffer = csvBuffer([
      ["Currency Pair", "Rate", "Rate Type", "Effective Date", "Source"],
      ["USD/PHP", "57.40", "Daily Weighted Average", "2026-08-07", "BSP"],
    ]);
    const preview = await ImportService.parsePreview({ buffer, filename: "rates.csv", companyId });
    const result = await ImportService.confirmImport({ user: adminUser, companyId, rows: preview.rows });
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);

    const history = await CurrencyService.getRateHistory(adminUser, usdCurrencyId);
    const imported = history.find((h) => h.newRate === 57.4);
    expect(imported.provider).toBe("BSP");
    expect(imported.ingestionMethod).toBe("FILE_IMPORT"); // distinct from MANUAL_ENTRY
    expect(imported.status).toBe("FINAL");
  });

  test("missing required columns rejected with a clear error before any parsing succeeds", async () => {
    const buffer = csvBuffer([["Foo", "Bar"], ["1", "2"]]);
    await expect(ImportService.parsePreview({ buffer, filename: "rates.csv", companyId })).rejects.toThrow(/Missing required column/);
  });

  test("cannot import a rate for the base currency", async () => {
    const buffer = csvBuffer([
      ["Currency Pair", "Rate", "Rate Type", "Effective Date", "Source"],
      ["PHP/PHP", "1", "Daily Weighted Average", "2026-08-07", "BAP"],
    ]);
    const preview = await ImportService.parsePreview({ buffer, filename: "rates.csv", companyId });
    expect(preview.rows[0].validationStatus).toBe("INVALID");
    void phpCurrencyId;
  });
});
