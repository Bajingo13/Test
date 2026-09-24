const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Fixed Asset Lapsing Report - the last of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/fixed-asset-lapsing is a period depreciation
// roll-forward (Beginning Accumulated Depreciation -> Depreciation
// Expense for the Period -> Ending Accumulated Depreciation) for every
// ACTIVE fixed asset, reusing the EXISTING fixed-asset-register route's
// own straight-line formula unchanged (FixedAssetLapsingService.js),
// evaluated at two as-of dates (From/To) instead of one. Not a new
// depreciation method, not a schema change, not a new permission.
//
// IMPORTANT ARCHITECTURAL NOTE (confirmed during investigation, not
// invented here): fixed_assets has no company_id/branch_id column, and
// neither this route nor the pre-existing fixed-asset-register/CRUD
// routes accept any scoping filter (no partyId-equivalent). That means
// this suite CANNOT safely assume the shared test database's
// `fixed_assets` table is empty of other rows (dev/demo seed data,
// collaborator-created rows, etc.) - unlike every company-scoped report
// suite in this codebase. Per-row assertions below always locate rows by
// this suite's own unique 'FAL-' asset_code prefix rather than asserting
// on the full, unscoped response body. The one exception is the "empty
// result" test, which is run LAST and proves emptiness only for this
// suite's own fixtures (by deleting them first), never for the table as
// a whole - deleting unrelated rows to force a clean-table assertion
// would violate collaborator safety and is deliberately not done.

jest.setTimeout(120000);

const FROM = "2025-01-01";
const TO = "2025-12-31";

let companyAId;
let adminId, noRoleId;
let adminToken, noRoleToken;
const assetCodes = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeFixedAsset(assetCode, assetName, category, acquisitionDate, acquisitionCost, salvageValue, usefulLifeYears, status) {
  await pool.execute(
    `INSERT INTO fixed_assets (asset_code, asset_name, category, acquisition_date, acquisition_cost, salvage_value, useful_life_years, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [assetCode, assetName, category, acquisitionDate, acquisitionCost, salvageValue, usefulLifeYears, status]
  );
  assetCodes.push(assetCode);
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('FAL Co A', 'Active')");
  companyAId = ca.insertId;

  const hash = await bcrypt.hash("FalPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('fal_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("fal_admin", "FalPass!1");

  const hash2 = await bcrypt.hash("FalPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('fal_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("fal_norole", "FalPass!2");

  // ---- Asset A: plain mid-life depreciation, no cap engaged.
  // acquired 2024-01-01, cost 120000, salvage 0, life 5yr (60mo) -> monthly 2000.
  // months@FROM(2025-01-01)=12 -> beginning=24000. months@TO(2025-12-31)=23 -> ending=46000.
  // expense=22000. beginningBookValue=96000. endingBookValue=74000.
  await makeFixedAsset("FAL-A", "FAL Delivery Van", "Transportation Equipment", "2024-01-01", 120000, 0, 5, "Active");

  // ---- Asset B: salvage-value cap. cost 1000, salvage 900 (cost-salvage=100),
  // life 3yr (36mo) -> raw monthly = 100/36 = 2.7777... -> ROUND = 2.78.
  // 2.78 * 36 = 100.08, which WITHOUT the cap would exceed cost-salvage(100).
  // Acquired long before FROM so both boundaries clamp to the full 36 months.
  await makeFixedAsset("FAL-B", "FAL Fully Depreciated Cabinet", "Office Equipment", "2015-01-01", 1000, 900, 3, "Active");

  // ---- Asset C: useful-life month-clamp engaged mid-period. cost 48000,
  // salvage 0, life 2yr (24mo) -> monthly 2000. Acquired 2023-03-01: months
  // @FROM=22 (not yet capped), months@TO=33 clamped to 24 (capped mid-period).
  // beginning=44000, ending=48000 (capped), expense=4000 (only the remaining
  // 2 months' worth, not the naive 11 months' worth).
  await makeFixedAsset("FAL-C", "FAL Machine Nearing End Of Life", "Machinery", "2023-03-01", 48000, 0, 2, "Active");

  // ---- Asset D: acquired AFTER the selected period's To date (2026-03-01).
  // Both boundaries clamp to 0 months -> zero depreciation, book value stays
  // at full acquisition cost.
  await makeFixedAsset("FAL-D", "FAL Future Acquisition", "Office Equipment", "2026-03-01", 10000, 0, 5, "Active");

  // ---- Asset E: acquired DURING the selected period (2025-07-01). Beginning
  // clamps to 0 (not yet acquired as of FROM); ending reflects 5 months
  // (2025-07-01 -> 2025-12-31) of depreciation.
  await makeFixedAsset("FAL-E", "FAL Mid-Year Purchase", "Computer Equipment", "2025-07-01", 6000, 0, 5, "Active");

  // ---- Asset F: DISPOSED - must never appear in the report at all (only
  // status = 'Active' is included, matching the existing register).
  await makeFixedAsset("FAL-F", "FAL Disposed Asset", "Office Equipment", "2020-01-01", 5000, 0, 5, "Disposed");
});

afterAll(async () => {
  if (assetCodes.length) {
    await pool.query(`DELETE FROM fixed_assets WHERE asset_code IN (${assetCodes.map(() => "?").join(",")})`, assetCodes);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyAId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function findRow(report, assetCode) {
  return report.rows.find((r) => r.assetCode === assetCode);
}

describe("GET /api/reports/fixed-asset-lapsing", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-lapsing").query({ from: FROM, to: TO });
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FIXED_ASSETS - a user with no role -> 403", async () => {
    const res = await request(app)
      .get("/api/reports/fixed-asset-lapsing")
      .set(auth(noRoleToken))
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(403);
  });

  test("3. From date is required -> 400", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-lapsing").set(auth(adminToken)).query({ to: TO });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/From date is required/i);
  });

  test("4. To date is required -> 400", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-lapsing").set(auth(adminToken)).query({ from: FROM });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/To date is required/i);
  });

  test("5. invalid date range (From after To) -> 400", async () => {
    const res = await request(app)
      .get("/api/reports/fixed-asset-lapsing")
      .set(auth(adminToken))
      .query({ from: "2025-12-31", to: "2025-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/From date must not be after To date/i);
  });

  let report;
  test("6. generates successfully for an authorized user", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-lapsing").set(auth(adminToken)).query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(FROM);
    expect(res.body.to).toBe(TO);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.grandTotals).toBe("object");
    report = res.body;
  });

  test("7. monthly depreciation calculation ((cost - salvage) / (usefulLifeYears * 12))", () => {
    const row = findRow(report, "FAL-A");
    expect(row).toBeDefined();
    expect(Number(row.monthlyDepreciation)).toBe(2000);
  });

  test("8. beginning accumulated depreciation (as of From date)", () => {
    const row = findRow(report, "FAL-A");
    expect(Number(row.beginningAccumulatedDepreciation)).toBe(24000);
  });

  test("9. ending accumulated depreciation (as of To date)", () => {
    const row = findRow(report, "FAL-A");
    expect(Number(row.endingAccumulatedDepreciation)).toBe(46000);
  });

  test("10. period depreciation expense (ending - beginning)", () => {
    const row = findRow(report, "FAL-A");
    expect(Number(row.depreciationExpense)).toBe(22000);
  });

  test("11. beginning book value (acquisitionCost - beginningAccumulatedDepreciation)", () => {
    const row = findRow(report, "FAL-A");
    expect(Number(row.beginningBookValue)).toBe(96000);
  });

  test("12. ending book value (acquisitionCost - endingAccumulatedDepreciation)", () => {
    const row = findRow(report, "FAL-A");
    expect(Number(row.endingBookValue)).toBe(74000);
  });

  test("13. salvage value cap - accumulated depreciation never exceeds (cost - salvage), book value never drops below salvage value", () => {
    const row = findRow(report, "FAL-B");
    expect(row).toBeDefined();
    expect(Number(row.monthlyDepreciation)).toBe(2.78); // ROUND(100/36, 2)
    expect(Number(row.beginningAccumulatedDepreciation)).toBe(100); // capped, not 2.78*36=100.08
    expect(Number(row.endingAccumulatedDepreciation)).toBe(100);
    expect(Number(row.beginningBookValue)).toBe(900); // never below salvage value
    expect(Number(row.endingBookValue)).toBe(900);
  });

  test("14. useful-life cap engaged mid-period - depreciation stops at usefulLifeYears*12 months, not the naive elapsed-month count", () => {
    const row = findRow(report, "FAL-C");
    expect(row).toBeDefined();
    expect(Number(row.beginningAccumulatedDepreciation)).toBe(44000); // 22 months, not yet capped
    expect(Number(row.endingAccumulatedDepreciation)).toBe(48000); // capped at 24 months (usefulLife), not 33
    expect(Number(row.depreciationExpense)).toBe(4000); // only 2 more months, not 11
    expect(Number(row.endingBookValue)).toBe(0);
  });

  test("15. an asset acquired AFTER the selected period has zero depreciation at both boundaries", () => {
    const row = findRow(report, "FAL-D");
    expect(row).toBeDefined();
    expect(Number(row.beginningAccumulatedDepreciation)).toBe(0);
    expect(Number(row.endingAccumulatedDepreciation)).toBe(0);
    expect(Number(row.depreciationExpense)).toBe(0);
    expect(Number(row.beginningBookValue)).toBe(10000);
    expect(Number(row.endingBookValue)).toBe(10000);
  });

  test("16. an asset acquired DURING the selected period depreciates only from its acquisition date onward", () => {
    const row = findRow(report, "FAL-E");
    expect(row).toBeDefined();
    expect(Number(row.beginningAccumulatedDepreciation)).toBe(0);
    expect(Number(row.endingAccumulatedDepreciation)).toBe(500); // 5 months * 100
    expect(Number(row.depreciationExpense)).toBe(500);
    expect(Number(row.beginningBookValue)).toBe(6000);
    expect(Number(row.endingBookValue)).toBe(5500);
  });

  test("17. multiple assets all appear together in the same report", () => {
    expect(findRow(report, "FAL-A")).toBeDefined();
    expect(findRow(report, "FAL-B")).toBeDefined();
    expect(findRow(report, "FAL-C")).toBeDefined();
    expect(findRow(report, "FAL-D")).toBeDefined();
    expect(findRow(report, "FAL-E")).toBeDefined();
  });

  // Grand totals: fixed_assets has no company_id/branch_id and this route has
  // no scoping filter, so report.grandTotals covers EVERY active fixed asset
  // in the database, not just this suite's own fixtures - asserting an exact
  // hardcoded grand total would be unsafe (see file-header note). Instead this
  // proves (a) our own known subset sums correctly within the full response,
  // and (b) the grand totals are internally consistent (ending - beginning ==
  // expense, and the full row set reduces to the reported grand totals).
  test("18. grand totals - our own subset sums correctly, and grand totals are internally consistent across the full (unscoped) row set", () => {
    // FAL-F (Disposed) is never in report.rows at all - the SQL's own
    // WHERE status = 'Active' already excludes it, so filtering by
    // assetCode membership alone is sufficient here.
    const ours = report.rows.filter((r) => assetCodes.includes(r.assetCode));
    const ourSum = (key) => ours.reduce((acc, r) => acc + Number(r[key]), 0);
    expect(Math.round(ourSum("acquisitionCost") * 100) / 100).toBe(185000);
    expect(Math.round(ourSum("salvageValue") * 100) / 100).toBe(900);
    expect(Math.round(ourSum("beginningAccumulatedDepreciation") * 100) / 100).toBe(68100);
    expect(Math.round(ourSum("depreciationExpense") * 100) / 100).toBe(26500);
    expect(Math.round(ourSum("endingAccumulatedDepreciation") * 100) / 100).toBe(94600);
    expect(Math.round(ourSum("beginningBookValue") * 100) / 100).toBe(116900);
    expect(Math.round(ourSum("endingBookValue") * 100) / 100).toBe(90400);

    const gt = report.grandTotals;
    expect(Math.round((gt.endingAccumulatedDepreciation - gt.beginningAccumulatedDepreciation) * 100) / 100).toBe(
      Math.round(gt.depreciationExpense * 100) / 100
    );
    const allSum = (key) => report.rows.reduce((acc, r) => acc + Number(r[key]), 0);
    expect(Math.round(allSum("acquisitionCost") * 100) / 100).toBe(Math.round(gt.acquisitionCost * 100) / 100);
    expect(Math.round(allSum("depreciationExpense") * 100) / 100).toBe(Math.round(gt.depreciationExpense * 100) / 100);
    expect(Math.round(allSum("endingBookValue") * 100) / 100).toBe(Math.round(gt.endingBookValue * 100) / 100);
  });

  test("19. Active assets are included", () => {
    expect(findRow(report, "FAL-A")).toBeDefined();
  });

  test("20. Disposed assets are excluded", () => {
    expect(findRow(report, "FAL-F")).toBeUndefined();
  });

  test("21. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[row]] = await pool.query("SELECT status, acquisition_cost, salvage_value FROM fixed_assets WHERE asset_code = 'FAL-A'");
    expect(row.status).toBe("Active");
    expect(Number(row.acquisition_cost)).toBe(120000);
    expect(Number(row.salvage_value)).toBe(0);
  });

  test("22. empty result for this suite's own fixtures once they are removed (see file-header note on why this endpoint cannot assert a globally empty table)", async () => {
    await pool.query(`DELETE FROM fixed_assets WHERE asset_code IN (${assetCodes.map(() => "?").join(",")})`, assetCodes);

    const res = await request(app).get("/api/reports/fixed-asset-lapsing").set(auth(adminToken)).query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    expect(res.body.rows.some((r) => assetCodes.includes(r.assetCode))).toBe(false);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("23. Fixed Asset Lapsing now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "fixed-asset-lapsing", label: "Fixed Asset Lapsing Report", icon: FileClock, path: "\/reports\/fixed-asset-lapsing"/
    );
  });

  test("24. App.jsx routes /reports/fixed-asset-lapsing to FixedAssetLapsing", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import FixedAssetLapsing from "\.\/pages\/REPORTS\/FixedAssetLapsing\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/fixed-asset-lapsing" element={<FixedAssetLapsing \/>} \/>/);
  });

  test("25. pathPermissionMap maps the new route to REPORTS.FIXED_ASSETS (same as the existing Fixed Asset Register)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/fixed-asset-lapsing": \["REPORTS\.FIXED_ASSETS", "VIEW"\]/);
  });

  test("26. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/FIXED_ASSET_LAPSING/);
  });
});

describe("route does not mutate anything, reuses the existing formula, and leaves the existing register untouched (source guard)", () => {
  test("27. the Fixed Asset Lapsing route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/fixed-asset-lapsing"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("28. the route delegates to FixedAssetLapsingService.getFixedAssetLapsing", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/fixed-asset-lapsing"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/FixedAssetLapsingService\.getFixedAssetLapsing\(/);
  });

  test("29. FixedAssetLapsingService.js contains no writes and reuses the existing formula (same TIMESTAMPDIFF/LEAST/GREATEST shape as the register route)", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/FixedAssetLapsingService.js"), "utf8");
    expect(svcSrc).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(svcSrc).toMatch(/TIMESTAMPDIFF\(MONTH, acquisition_date, \?\)/);
    expect(svcSrc).toMatch(/useful_life_years \* 12/);
    expect(svcSrc).toMatch(/acquisition_cost - salvage_value/);
  });

  test("30. the existing fixed-asset-register route itself was not modified by this phase", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/fixed-asset-register"');
    const end = serverSrc.indexOf("\n});", start);
    const registerBody = serverSrc.slice(start, end);
    expect(registerBody).not.toMatch(/FixedAssetLapsingService/);
    expect(registerBody).toMatch(/FROM fixed_assets/);
  });

  test("31. the fixed_assets CRUD routes (GET/POST/PUT/DELETE /api/fixed-assets) were not modified by this phase", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/fixed-assets"');
    const end = serverSrc.indexOf('app.get("/api/reports/fixed-asset-register"', start);
    const crudBody = serverSrc.slice(start, end);
    expect(crudBody).not.toMatch(/FixedAssetLapsingService/);
    expect(crudBody).toMatch(/INSERT INTO fixed_assets/);
  });
});

describe("32. Fixed Asset Register, Summary of Books, Net Summary, Daily Cash Position, AR Statement, AR Billings & Collections, AR Overdue Accounts, AP List of Payables and Payments, and AP List of Overdue Accounts remain fully functional (regression check)", () => {
  test("Fixed Asset Register still returns its established shape", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-register").set(auth(adminToken)).query({ asOf: TO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2025-08-01", to: "2025-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2025-08-01", to: "2025-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: TO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });

  test("AR Statement of Accounts still enforces its own partyId requirement (route alive, unmodified)", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query({ from: "2025-08-01", to: "2025-09-19" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/partyId is required/i);
  });

  test("AR Billings & Collections still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query({ from: "2025-08-01", to: "2025-09-19" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });

  test("AR List of Overdue Accounts still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: TO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test("AP List of Payables and Payments still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query({ from: "2025-08-01", to: "2025-09-19" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suppliers)).toBe(true);
  });

  test("AP List of Overdue Accounts still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ap-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: TO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});

describe("33. CSV export stays formula-injection safe", () => {
  test("FixedAssetLapsing.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "FixedAssetLapsing.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`Fixed_Asset_Lapsing_\$\{safeFrom\}_to_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "FixedAssetLapsing.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "FixedAssetLapsing.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
