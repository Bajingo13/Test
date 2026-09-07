const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Checkpoint: Companies Contact/BIR Fields - the priority fix. GET
// /api/reports/2307 (BIR Form 2307, Certificate of Creditable Tax
// Withheld) previously read its "payor" (this system's own identity as
// withholding agent) from the single global company_profile row
// (WHERE id = 1), unconditionally - regardless of which company's
// supplier/quarter was actually being reported on. The payee half of this
// same route was already company-scoped (Phase 7D.1's fix); only the
// payor half was missed. A real, filed tax certificate showing the wrong
// withholding agent's TIN/address is the highest-severity consequence of
// the single-global-row bug this checkpoint retires.
//
// This test creates two companies with DIFFERENT payor data (name, TIN,
// address, zip) and proves each company's own 2307 report shows its OWN
// payor, never the other's - the one assertion that matters most in this
// whole change.

jest.setTimeout(180000);

let companyA, companyB, userId, token;
let suppA, suppB;

async function makeCompany(name, tin, address, zip) {
  const [result] = await pool.execute(
    "INSERT INTO companies (name, tin, address, zip, status) VALUES (?, ?, ?, ?, 'Active')",
    [name, tin, address, zip]
  );
  return result.insertId;
}
async function makeSupplier(companyId, code, name, tin) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, ?, 'SUPPLIER', ?, 'ACTIVE', ?)",
    [companyId, code, name, tin]
  );
  return result.insertId;
}

async function report2307(supplierId, companyId) {
  return request(app)
    .get("/api/reports/2307")
    .set("Authorization", `Bearer ${token}`)
    .query({ supplierId, year: 2026, quarter: 3, companyId });
}

async function cleanupStaleFixtures() {
  const [companies] = await pool.query("SELECT id FROM companies WHERE name LIKE 'PH2307ISO %'");
  const companyIds = companies.map((c) => c.id);
  if (companyIds.length) {
    await pool.query("DELETE FROM general_libraries WHERE company_id IN (?)", [companyIds]);
    await pool.query("DELETE FROM companies WHERE id IN (?)", [companyIds]);
  }
  const [users] = await pool.query("SELECT id FROM users WHERE username = 'ph2307iso_admin'");
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
    await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupStaleFixtures();

  companyA = await makeCompany("PH2307ISO Company A", "111-111-111-000", "A Address, Makati", "1200");
  companyB = await makeCompany("PH2307ISO Company B", "222-222-222-000", "B Address, Cebu", "6000");

  const hash = await bcrypt.hash("Ph2307IsoPass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('ph2307iso_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyA]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [userId, companyB]);

  const loginRes = await request(app).post("/api/login").send({ username: "ph2307iso_admin", password: "Ph2307IsoPass!1" });
  token = loginRes.body.token;

  suppA = await makeSupplier(companyA, "PH2307ISO-SA", "PH2307ISO Supplier A", "333-333-333-000");
  suppB = await makeSupplier(companyB, "PH2307ISO-SB", "PH2307ISO Supplier B", "444-444-444-000");
});

afterAll(async () => {
  try {
    await cleanupStaleFixtures();
  } finally {
    await pool.end();
  }
});

describe("BIR 2307 payor isolation", () => {
  test("Company A's report shows Company A's own payor, not Company B's", async () => {
    const res = await report2307(suppA, companyA);
    expect(res.status).toBe(200);
    expect(res.body.payor.payorName).toBe("PH2307ISO Company A");
    expect(res.body.payor.payorTin).toBe("111-111-111-000");
    expect(res.body.payor.payorAddress).toBe("A Address, Makati");
    expect(res.body.payor.payorZip).toBe("1200");
  });

  test("Company B's report shows Company B's own payor, not Company A's", async () => {
    const res = await report2307(suppB, companyB);
    expect(res.status).toBe(200);
    expect(res.body.payor.payorName).toBe("PH2307ISO Company B");
    expect(res.body.payor.payorTin).toBe("222-222-222-000");
    expect(res.body.payor.payorAddress).toBe("B Address, Cebu");
    expect(res.body.payor.payorZip).toBe("6000");
  });

  test("the two companies' payor blocks are never equal to each other", async () => {
    const resA = await report2307(suppA, companyA);
    const resB = await report2307(suppB, companyB);
    expect(resA.body.payor).not.toEqual(resB.body.payor);
  });
});
