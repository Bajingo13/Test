const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Batch 2: Subsidiary Ledger previously had no Debit/Credit Memo
// (memo_headers) branch at all - a confirmed gap, since DM/CM's own stated
// purpose is an AR/AP adjustment. Direction is NOT guessed: it follows the
// "Approved convention" DebitMemo.jsx / CreditMemo.jsx document in their
// own source comments (Checkpoint 6) - a Debit Memo increases AR / decreases
// AP; a Credit Memo decreases AR / increases AP. Verified here against the
// AR ledger's SUM(debit-credit) and the AP ledger's SUM(credit-debit)
// running-balance formulas (both pre-existing, unchanged by this batch).

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA;
let custAId, suppAId, custBId;
const memoIds = [];

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
async function makeParty(code, partyType, name, companyId) {
  const [r] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return r.insertId;
}
async function loginAs(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
async function memo(companyId, voucherNo, memoType, partyId, partyType, date, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
    [companyId, voucherNo, memoType, partyId, partyType, date, amount, amount, status]
  );
  memoIds.push(h.insertId);
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  companyAId = await makeCompany("RB2 SL Company A");
  companyBId = await makeCompany("RB2 SL Company B");
  const adminAId = await makeUser("rb2_sl_admin_a", "Rb2SlPass!A1", companyAId);
  custAId = await makeParty("RB2SL-CUSTA", "CUSTOMER", "RB2 SL Customer A", companyAId);
  suppAId = await makeParty("RB2SL-SUPPA", "SUPPLIER", "RB2 SL Supplier A", companyAId);
  custBId = await makeParty("RB2SL-CUSTB", "CUSTOMER", "RB2 SL Customer B", companyBId);

  // ---- Customer A: DM +500 (increases AR), CM -150 (decreases AR) ----
  await memo(companyAId, "RB2SL-DM-CUST", "DEBIT", custAId, "CUSTOMER", "2027-06-05", 500);
  await memo(companyAId, "RB2SL-CM-CUST", "CREDIT", custAId, "CUSTOMER", "2027-06-06", 150);

  // ---- Supplier A: DM -200 (decreases AP), CM +80 (increases AP) ----
  await memo(companyAId, "RB2SL-DM-SUPP", "DEBIT", suppAId, "SUPPLIER", "2027-06-07", 200);
  await memo(companyAId, "RB2SL-CM-SUPP", "CREDIT", suppAId, "SUPPLIER", "2027-06-08", 80);

  // ---- Draft: must never appear ----
  await memo(companyAId, "RB2SL-DM-DRAFT", "DEBIT", custAId, "CUSTOMER", "2027-06-09", 99999, "Draft");

  // ---- Cancelled: must never appear ----
  await memo(companyAId, "RB2SL-CM-CANCELLED", "CREDIT", custAId, "CUSTOMER", "2027-06-10", 88888, "Cancelled");

  // ---- Wrong party (a different Company A customer): must not leak into custAId's ledger ----
  const otherCustAId = await makeParty("RB2SL-CUSTA2", "CUSTOMER", "RB2 SL Other Customer A", companyAId);
  await memo(companyAId, "RB2SL-DM-OTHERPARTY", "DEBIT", otherCustAId, "CUSTOMER", "2027-06-11", 77777);

  // ---- Company B: same-shaped memo, isolation-only ----
  await memo(companyBId, "RB2SL-DM-COMPANYB", "DEBIT", custBId, "CUSTOMER", "2027-06-05", 66666);

  tokenA = await loginAs("rb2_sl_admin_a", "Rb2SlPass!A1");
});

afterAll(async () => {
  await pool.query("DELETE FROM memo_headers WHERE id IN (?)", [memoIds.length ? memoIds : [0]]);
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'RB2SL-%'");
  await pool.query(
    "DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username = 'rb2_sl_admin_a')"
  );
  await pool.query("DELETE FROM users WHERE username = 'rb2_sl_admin_a'");
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

const H = (t) => ({ Authorization: `Bearer ${t}` });

describe("Subsidiary Ledger - Debit/Credit Memo AR direction (Reports Batch 2)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app)
      .get(`/api/reports/subsidiary-ledger?type=AR&partyId=${custAId}&from=2027-06-01&to=2027-06-30`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body;
  });

  test("Debit Memo increases the customer's receivable (posts as a debit)", () => {
    const dm = rows.find((r) => r.reference_no === "RB2SL-DM-CUST");
    expect(dm).toBeTruthy();
    expect(dm.source_type).toBe("DEBIT MEMO");
    expect(Number(dm.debit)).toBe(500);
    expect(Number(dm.credit)).toBe(0);
  });

  test("Credit Memo decreases the customer's receivable (posts as a credit)", () => {
    const cm = rows.find((r) => r.reference_no === "RB2SL-CM-CUST");
    expect(cm).toBeTruthy();
    expect(cm.source_type).toBe("CREDIT MEMO");
    expect(Number(cm.credit)).toBe(150);
    expect(Number(cm.debit)).toBe(0);
  });

  test("running balance reflects DM increasing then CM decreasing AR (SUM(debit-credit))", () => {
    const dm = rows.find((r) => r.reference_no === "RB2SL-DM-CUST");
    const cm = rows.find((r) => r.reference_no === "RB2SL-CM-CUST");
    expect(Number(dm.running_balance)).toBe(500);
    expect(Number(cm.running_balance)).toBe(350); // 500 - 150
  });

  test("Draft and Cancelled memos never appear", () => {
    expect(rows.find((r) => r.reference_no === "RB2SL-DM-DRAFT")).toBeUndefined();
    expect(rows.find((r) => r.reference_no === "RB2SL-CM-CANCELLED")).toBeUndefined();
  });

  test("a different party's memo is excluded from this party's ledger", () => {
    expect(rows.find((r) => r.reference_no === "RB2SL-DM-OTHERPARTY")).toBeUndefined();
  });

  test("no duplicate memo rows (exactly one row per posted memo)", () => {
    const refs = rows.map((r) => r.reference_no).filter((r) => r && r.startsWith("RB2SL-"));
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("Subsidiary Ledger - Debit/Credit Memo AP direction (Reports Batch 2)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app)
      .get(`/api/reports/subsidiary-ledger?type=AP&partyId=${suppAId}&from=2027-06-01&to=2027-06-30`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body;
  });

  test("Debit Memo decreases the supplier's payable (posts as a debit, per the module's own approved convention)", () => {
    const dm = rows.find((r) => r.reference_no === "RB2SL-DM-SUPP");
    expect(dm).toBeTruthy();
    expect(dm.source_type).toBe("DEBIT MEMO");
    expect(Number(dm.debit)).toBe(200);
    expect(Number(dm.credit)).toBe(0);
  });

  test("Credit Memo increases the supplier's payable (posts as a credit)", () => {
    const cm = rows.find((r) => r.reference_no === "RB2SL-CM-SUPP");
    expect(cm).toBeTruthy();
    expect(cm.source_type).toBe("CREDIT MEMO");
    expect(Number(cm.credit)).toBe(80);
    expect(Number(cm.debit)).toBe(0);
  });

  test("running balance reflects DM decreasing then CM increasing AP (SUM(credit-debit))", () => {
    const dm = rows.find((r) => r.reference_no === "RB2SL-DM-SUPP");
    const cm = rows.find((r) => r.reference_no === "RB2SL-CM-SUPP");
    expect(Number(dm.running_balance)).toBe(-200);
    expect(Number(cm.running_balance)).toBe(-120); // -200 + 80
  });

  test("a customer-targeted memo never appears on the supplier's AP ledger", () => {
    const refs = rows.map((r) => r.reference_no);
    expect(refs).not.toContain("RB2SL-DM-CUST");
    expect(refs).not.toContain("RB2SL-CM-CUST");
  });
});

describe("Subsidiary Ledger - Memo company isolation (Reports Batch 2)", () => {
  test("Company A's AR ledger never contains Company B's memo", async () => {
    const res = await request(app)
      .get(`/api/reports/subsidiary-ledger?type=AR&partyId=${custAId}&from=2027-06-01&to=2027-06-30`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.find((r) => r.reference_no === "RB2SL-DM-COMPANYB")).toBeUndefined();
  });

  test("Company A cannot read Company B's party ledger by id (404, existing ownership check preserved)", async () => {
    const res = await request(app)
      .get(`/api/reports/subsidiary-ledger?type=AR&partyId=${custBId}&from=2027-06-01&to=2027-06-30`)
      .set(H(tokenA));
    expect(res.status).toBe(404);
  });
});

describe("Subsidiary Ledger - Memo date filtering (Reports Batch 2)", () => {
  test("a memo dated outside the requested range is excluded", async () => {
    const res = await request(app)
      .get(`/api/reports/subsidiary-ledger?type=AR&partyId=${custAId}&from=2027-06-05&to=2027-06-05`)
      .set(H(tokenA));
    expect(res.status).toBe(200);
    const refs = res.body.map((r) => r.reference_no);
    expect(refs).toContain("RB2SL-DM-CUST"); // 2027-06-05, in range
    expect(refs).not.toContain("RB2SL-CM-CUST"); // 2027-06-06, out of range
  });
});
