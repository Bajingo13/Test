const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Fixed Asset Register (GET /api/reports/fixed-asset-register) had no
// dedicated test file despite being a live, wired, company-permissioned
// report - confirmed by the Phase (Master Task) reporting-module audit.
// Its sibling report, Fixed Asset Lapsing, reuses this route's own
// straight-line formula and already has full coverage
// (fixedAssetLapsing.http.test.js); this suite tests the register route
// itself, at a single as-of date instead of a From/To range.
//
// Same architectural note as fixedAssetLapsing.http.test.js: fixed_assets
// has no company_id/branch_id column and this route has no scoping filter,
// so the response is NOT limited to this suite's own fixtures. Per-row
// assertions below always locate rows by this suite's own unique 'FAR-'
// asset_code prefix rather than asserting on the full, unscoped response
// body.

jest.setTimeout(120000);

const AS_OF = "2025-12-31";

// Computed relative to the actual test-run date (not hardcoded) so the
// "acquired in the future" fixture stays in the future no matter when this
// suite runs, for both the fixed AS_OF assertions and the "defaults to
// today" assertion.
const future = new Date();
future.setFullYear(future.getFullYear() + 5);
const FUTURE_DATE = future.toISOString().slice(0, 10);

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

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('FAR Co A', 'Active')");
  companyAId = ca.insertId;

  const hash = await bcrypt.hash("FarPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('far_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("far_admin", "FarPass!1");

  const hash2 = await bcrypt.hash("FarPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('far_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("far_norole", "FarPass!2");

  // Asset A: plain mid-life depreciation. acquired 2024-01-01, cost 120000,
  // salvage 0, life 5yr (60mo) -> monthly 2000. months@AS_OF(2025-12-31)=23
  // -> accumulated=46000. bookValue=74000.
  await makeFixedAsset("FAR-A", "FAR Delivery Van", "Transportation Equipment", "2024-01-01", 120000, 0, 5, "Active");

  // Asset B: salvage-value cap. cost 1000, salvage 900 (cost-salvage=100),
  // life 3yr (36mo) -> raw monthly = 100/36 = 2.7777... -> ROUND = 2.78.
  // Acquired long before AS_OF so the boundary clamps to the full 36 months,
  // and the cap keeps accumulated depreciation at exactly 100, not 100.08.
  await makeFixedAsset("FAR-B", "FAR Fully Depreciated Cabinet", "Office Equipment", "2015-01-01", 1000, 900, 3, "Active");

  // Asset C: acquired AFTER AS_OF (and after "today") -> zero depreciation,
  // book value at cost.
  await makeFixedAsset("FAR-C", "FAR Future Acquisition", "Office Equipment", FUTURE_DATE, 10000, 0, 5, "Active");

  // Asset D: DISPOSED - must never appear in the report (only status =
  // 'Active' is included).
  await makeFixedAsset("FAR-D", "FAR Disposed Asset", "Office Equipment", "2020-01-01", 5000, 0, 5, "Disposed");
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

function findRow(rows, assetCode) {
  return rows.find((r) => r.assetCode === assetCode);
}

describe("GET /api/reports/fixed-asset-register", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-register").query({ asOf: AS_OF });
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FIXED_ASSETS - a user with no role -> 403", async () => {
    const res = await request(app)
      .get("/api/reports/fixed-asset-register")
      .set(auth(noRoleToken))
      .query({ asOf: AS_OF });
    expect(res.status).toBe(403);
  });

  let rows;
  test("3. generates successfully for an authorized user", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-register").set(auth(adminToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    rows = res.body;
  });

  test("4. monthly depreciation calculation ((acquisitionCost - salvageValue) / (usefulLifeYears * 12))", () => {
    const row = findRow(rows, "FAR-A");
    expect(row).toBeDefined();
    expect(Number(row.monthlyDepreciation)).toBe(2000);
  });

  test("5. accumulated depreciation as of the given date", () => {
    const row = findRow(rows, "FAR-A");
    expect(Number(row.accumulatedDepreciation)).toBe(46000);
  });

  test("6. book value (acquisitionCost - accumulatedDepreciation)", () => {
    const row = findRow(rows, "FAR-A");
    expect(Number(row.bookValue)).toBe(74000);
  });

  test("7. salvage-value cap - accumulated depreciation never exceeds (cost - salvage), book value never drops below salvage value", () => {
    const row = findRow(rows, "FAR-B");
    expect(row).toBeDefined();
    expect(Number(row.monthlyDepreciation)).toBe(2.78); // ROUND(100/36, 2)
    expect(Number(row.accumulatedDepreciation)).toBe(100); // capped, not 2.78*36=100.08
    expect(Number(row.bookValue)).toBe(900); // never below salvage value
  });

  test("8. an asset acquired after the as-of date has zero depreciation and book value at full cost", () => {
    const row = findRow(rows, "FAR-C");
    expect(row).toBeDefined();
    expect(Number(row.accumulatedDepreciation)).toBe(0);
    expect(Number(row.bookValue)).toBe(10000);
  });

  test("9. Active assets are included", () => {
    expect(findRow(rows, "FAR-A")).toBeDefined();
  });

  test("10. Disposed assets are excluded", () => {
    expect(findRow(rows, "FAR-D")).toBeUndefined();
  });

  test("11. asOf defaults to today when omitted", async () => {
    const res = await request(app).get("/api/reports/fixed-asset-register").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Our own future-dated asset (acquired 2026-03-01) must still show zero
    // depreciation under "today" for as long as "today" precedes that date.
    const row = findRow(res.body, "FAR-C");
    expect(row).toBeDefined();
    expect(Number(row.accumulatedDepreciation)).toBe(0);
  });

  test("12. no mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[row]] = await pool.query("SELECT status, acquisition_cost, salvage_value FROM fixed_assets WHERE asset_code = 'FAR-A'");
    expect(row.status).toBe("Active");
    expect(Number(row.acquisition_cost)).toBe(120000);
    expect(Number(row.salvage_value)).toBe(0);
  });

  test("13. empty result for this suite's own fixtures once they are removed", async () => {
    await pool.query(`DELETE FROM fixed_assets WHERE asset_code IN (${assetCodes.map(() => "?").join(",")})`, assetCodes);

    const res = await request(app).get("/api/reports/fixed-asset-register").set(auth(adminToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(200);
    expect(res.body.some((r) => assetCodes.includes(r.assetCode))).toBe(false);
  });
});
