const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Batch 2: EWT Audit gains a frontend (EwtAudit.jsx) and, to back
// its Document Date/Payee/TIN columns and From/To/ATC filters, the backend
// route gained a safe read-only projection (transaction_date, party name,
// party TIN via a company-pinned LEFT JOIN to general_libraries) plus
// additive, optional WHERE conditions. This suite proves those additions
// are additive only: the mismatch/recompute algorithm, its 0.01 tolerance,
// and Batch 9's company isolation are all unchanged (company isolation
// itself is already covered end-to-end by phase9CompanyIsolationAttack.
// http.test.js and is not re-proven here).

jest.setTimeout(120000);

let companyAId;
let tokenA;
let suppAId;
const ATC1 = "PH-RB2-EWT1";
const ATC2 = "PH-RB2-EWT2";
const apvIds = [];

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(username, password, companyId) {
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')",
    [username, hash]
  );
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
// A raw APV header whose stored taxable_base deliberately disagrees with
// its gross amount (no lines -> the legacy fallback computes base ==
// gross, exactly like phase9CompanyIsolationAttack's own fixture) - the
// simplest, already-proven way to guarantee a flag without needing
// structured transaction_tax_entries rows.
async function tamperedApv(companyId, voucherNo, date, atc, gross, storedBase, storedAmount) {
  const [r] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_credit, total_debit, status, atc_code, tax_type, tax_rate, tax_withheld_amount, taxable_base)
     VALUES (?, ?, ?, 'x', ?, ?, ?, 'Posted', ?, 'EWT', 10, ?, ?)`,
    [companyId, voucherNo, suppAId, date, gross, gross, atc, storedAmount, storedBase]
  );
  apvIds.push(r.insertId);
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  companyAId = await makeCompany("RB2 EWT Audit Co");
  const adminAId = await makeUser("rb2_ewt_admin", "Rb2EwtPass!1", companyAId);
  const [s] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status, tin) VALUES (?, 'RB2-SUPP', 'SUPPLIER', 'RB2 Supplier', 'ACTIVE', '123-456-789-000')",
    [companyAId]
  );
  suppAId = s.insertId;

  // In-range, ATC1, tampered (must appear for the default/date/ATC-match cases).
  await tamperedApv(companyAId, "RB2-APV-IN-RANGE", "2027-05-15", ATC1, 10000, 111, 500);
  // Out-of-range (before the `from` filter used below), ATC1, tampered.
  await tamperedApv(companyAId, "RB2-APV-OUT-OF-RANGE", "2027-01-05", ATC1, 20000, 222, 600);
  // In-range, different ATC (must be excluded when filtering by ATC1).
  await tamperedApv(companyAId, "RB2-APV-OTHER-ATC", "2027-05-20", ATC2, 30000, 333, 700);

  tokenA = await loginAs("rb2_ewt_admin", "Rb2EwtPass!1");
});

afterAll(async () => {
  await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [apvIds.length ? apvIds : [0]]);
  await pool.query("DELETE FROM general_libraries WHERE id = ?", [suppAId]);
  await pool.query(
    "DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username = 'rb2_ewt_admin')"
  );
  await pool.query("DELETE FROM users WHERE username = 'rb2_ewt_admin'");
  await pool.query("DELETE FROM companies WHERE id = ?", [companyAId]);
  await pool.end();
});

const H = (t) => ({ Authorization: `Bearer ${t}` });

describe("EWT Audit - additive read-only projection (Reports Batch 2)", () => {
  test("no filters: flagged rows now carry transactionDate, partyName, and partyTin", async () => {
    const res = await request(app).get("/api/reports/ewt-audit").set(H(tokenA));
    expect(res.status).toBe(200);
    const row = res.body.flagged.find((f) => f.voucherNo === "RB2-APV-IN-RANGE");
    expect(row).toBeTruthy();
    expect(row.transactionDate).toBe("2027-05-15");
    expect(row.partyName).toBe("x");
    expect(row.partyTin).toBe("123-456-789-000");
  });

  test("no filters: all 3 tampered vouchers (across dates/ATCs) are flagged - unfiltered behavior unchanged", async () => {
    const res = await request(app).get("/api/reports/ewt-audit").set(H(tokenA));
    const vouchers = res.body.flagged.map((f) => f.voucherNo);
    expect(vouchers).toEqual(
      expect.arrayContaining(["RB2-APV-IN-RANGE", "RB2-APV-OUT-OF-RANGE", "RB2-APV-OTHER-ATC"])
    );
  });

  test("mismatch/recompute algorithm and 0.01 tolerance are unchanged: stored vs computed values are exact, not altered by the new columns", async () => {
    const res = await request(app).get("/api/reports/ewt-audit").set(H(tokenA));
    const row = res.body.flagged.find((f) => f.voucherNo === "RB2-APV-IN-RANGE");
    expect(row.storedTaxableBase).toBe(111);
    expect(row.computedTaxableBase).toBe(10000); // no lines -> legacy fallback == gross
    expect(row.storedTaxWithheldAmount).toBe(500);
    expect(row.grossAmount).toBe(10000);
  });
});

describe("EWT Audit - additive date range filter (Reports Batch 2)", () => {
  test("from/to narrows the checked population to the canonical transaction_date field", async () => {
    const res = await request(app)
      .get("/api/reports/ewt-audit?from=2027-05-01&to=2027-05-31")
      .set(H(tokenA));
    expect(res.status).toBe(200);
    const vouchers = res.body.flagged.map((f) => f.voucherNo);
    expect(vouchers).toContain("RB2-APV-IN-RANGE");
    expect(vouchers).toContain("RB2-APV-OTHER-ATC");
    expect(vouchers).not.toContain("RB2-APV-OUT-OF-RANGE"); // dated 2027-01-05
  });

  test("from alone (no to) still narrows correctly", async () => {
    const res = await request(app).get("/api/reports/ewt-audit?from=2027-05-01").set(H(tokenA));
    const vouchers = res.body.flagged.map((f) => f.voucherNo);
    expect(vouchers).not.toContain("RB2-APV-OUT-OF-RANGE");
  });
});

describe("EWT Audit - additive ATC filter (Reports Batch 2)", () => {
  test("atcCode narrows to an exact ATC match only", async () => {
    const res = await request(app).get(`/api/reports/ewt-audit?atcCode=${ATC1}`).set(H(tokenA));
    expect(res.status).toBe(200);
    const vouchers = res.body.flagged.map((f) => f.voucherNo);
    expect(vouchers).toEqual(
      expect.arrayContaining(["RB2-APV-IN-RANGE", "RB2-APV-OUT-OF-RANGE"])
    );
    expect(vouchers).not.toContain("RB2-APV-OTHER-ATC");
  });

  test("date range + ATC combine (both are additive AND conditions)", async () => {
    const res = await request(app)
      .get(`/api/reports/ewt-audit?from=2027-05-01&to=2027-05-31&atcCode=${ATC1}`)
      .set(H(tokenA));
    const vouchers = res.body.flagged.map((f) => f.voucherNo);
    expect(vouchers).toEqual(["RB2-APV-IN-RANGE"]);
  });
});
