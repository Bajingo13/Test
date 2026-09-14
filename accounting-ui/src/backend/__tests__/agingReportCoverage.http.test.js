const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Batch 2: a dedicated AP/AR Aging suite (detail + summary), rather
// than relying on incidental Phase 7K coverage elsewhere. Uses the existing
// agingReportService.js unmodified - no behavior change, only coverage.
//
// Two real, pre-existing asymmetries between the AR and AP branches were
// traced from agingReportService.js before writing these tests (not
// assumed) and are NOT treated as defects, because they exactly match what
// each module actually supports:
//   - AP explicitly excludes Void/Cancelled APVs and APVs superseded by a
//     Posted APV_REVERSAL JV (Phase 7K/7K.1). AR has no equivalent clause
//     because Invoice has no Void/Cancel/Reverse lifecycle at all
//     (transactionModuleConfig.js: INV has no cancelVoid flag, and no
//     /api/invoices/:id/{cancel,void,reverse} route exists) - there is
//     structurally nothing for such a clause to exclude.
//   - Both branches deliberately do NOT exclude Draft (only VOID/CANCELLED
//     is excluded on the AP side) - this is pre-existing, documented policy
//     from Phase 7K ("Draft aging behavior preserved"), not a gap; these
//     tests do not assert Draft exclusion.

jest.setTimeout(120000);

let companyAId, companyBId;
let tokenA;
let custAId, suppAId, custBId, suppBId;
const apvIds = [];
const invIds = [];
const appIds = [];

const ASOF = "2027-06-30";

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
async function apv(companyId, voucherNo, supplierId, txnDate, dueDate, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, supplierId, txnDate, dueDate, amount, amount, amount, status]
  );
  apvIds.push(h.insertId);
  return h.insertId;
}
async function inv(companyId, voucherNo, customerId, txnDate, dueDate, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, customerId, txnDate, dueDate, amount, amount, amount, status]
  );
  invIds.push(h.insertId);
  return h.insertId;
}
async function applyPayment(sourceType, sourceId, amount, date) {
  const [r] = await pool.execute(
    `INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date)
     VALUES (?, ?, 'CV', 999999, ?, ?)`,
    [sourceType, sourceId, amount, date]
  );
  appIds.push(r.insertId);
  return r.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();
  companyAId = await makeCompany("RB2 Aging Company A");
  companyBId = await makeCompany("RB2 Aging Company B");
  const adminAId = await makeUser("rb2_aging_admin_a", "Rb2AgingPass!A1", companyAId);
  custAId = await makeParty("RB2AG-CUSTA", "CUSTOMER", "RB2 Aging Customer A", companyAId);
  suppAId = await makeParty("RB2AG-SUPPA", "SUPPLIER", "RB2 Aging Supplier A", companyAId);
  custBId = await makeParty("RB2AG-CUSTB", "CUSTOMER", "RB2 Aging Customer B", companyBId);
  suppBId = await makeParty("RB2AG-SUPPB", "SUPPLIER", "RB2 Aging Supplier B", companyBId);

  // ---- AP bucket coverage (due_date relative to ASOF 2027-06-30) ----
  await apv(companyAId, "RB2AG-APV-CURRENT", suppAId, "2027-06-01", "2027-06-30", 1000); // 0 days -> current
  await apv(companyAId, "RB2AG-APV-1-30", suppAId, "2027-06-01", "2027-06-15", 2000); // 15 days
  await apv(companyAId, "RB2AG-APV-31-60", suppAId, "2027-05-01", "2027-05-15", 3000); // 46 days
  await apv(companyAId, "RB2AG-APV-61-90", suppAId, "2027-04-01", "2027-04-15", 4000); // 76 days
  await apv(companyAId, "RB2AG-APV-OVER90", suppAId, "2027-01-01", "2027-01-01", 5000); // 180 days

  // Partial payment: 6000 original, 2500 paid as-of ASOF -> balance 3500 (open).
  const partialApvId = await apv(companyAId, "RB2AG-APV-PARTIAL", suppAId, "2027-06-01", "2027-06-10", 6000);
  await applyPayment("APV", partialApvId, 2500, "2027-06-20");

  // Fully paid -> excluded from the default OPEN view.
  const paidApvId = await apv(companyAId, "RB2AG-APV-PAID", suppAId, "2027-06-01", "2027-06-05", 7000);
  await applyPayment("APV", paidApvId, 7000, "2027-06-10");

  // Cancelled / Void -> excluded entirely.
  await apv(companyAId, "RB2AG-APV-CANCELLED", suppAId, "2027-06-01", "2027-06-10", 8888, "Cancelled");
  await apv(companyAId, "RB2AG-APV-VOID", suppAId, "2027-06-01", "2027-06-10", 9999, "Void");

  // Reversed: Posted APV + a Posted APV_REVERSAL JV linked to it -> excluded.
  const reversedApvId = await apv(companyAId, "RB2AG-APV-REVERSED", suppAId, "2027-06-01", "2027-06-10", 7777);
  await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, 'RB2AG-JV-REVERSAL', '2027-06-15', 'reversal', 7777, 7777, 'Posted', 'APV_REVERSAL', ?)`,
    [companyAId, reversedApvId]
  );

  // As-of filtering: dated after ASOF -> excluded from an as-of-2027-06-30 report.
  await apv(companyAId, "RB2AG-APV-FUTURE", suppAId, "2027-07-15", "2027-07-15", 6543);

  // ---- AR mirror (fewer cases - the bucket math is identical to AP) ----
  await inv(companyAId, "RB2AG-INV-CURRENT", custAId, "2027-06-01", "2027-06-30", 1500);
  await inv(companyAId, "RB2AG-INV-OVER90", custAId, "2027-01-01", "2027-01-01", 2500);
  const partialInvId = await inv(companyAId, "RB2AG-INV-PARTIAL", custAId, "2027-06-01", "2027-06-10", 4000);
  await applyPayment("INV", partialInvId, 1000, "2027-06-20");

  // ---- Company B mirror: isolation-only ----
  await apv(companyBId, "RB2AG-APV-COMPANYB", suppBId, "2027-06-01", "2027-06-15", 321);
  await inv(companyBId, "RB2AG-INV-COMPANYB", custBId, "2027-06-01", "2027-06-15", 654);

  tokenA = await loginAs("rb2_aging_admin_a", "Rb2AgingPass!A1");
});

afterAll(async () => {
  await pool.query("DELETE FROM transaction_applications WHERE id IN (?)", [appIds.length ? appIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE voucher_no = 'RB2AG-JV-REVERSAL'");
  await pool.query("DELETE FROM apv_headers WHERE id IN (?)", [apvIds.length ? apvIds : [0]]);
  await pool.query("DELETE FROM invoice_headers WHERE id IN (?)", [invIds.length ? invIds : [0]]);
  await pool.query("DELETE FROM general_libraries WHERE code LIKE 'RB2AG-%'");
  await pool.query(
    "DELETE FROM user_companies WHERE user_id IN (SELECT id FROM users WHERE username = 'rb2_aging_admin_a')"
  );
  await pool.query("DELETE FROM users WHERE username = 'rb2_aging_admin_a'");
  await pool.query("DELETE FROM companies WHERE id IN (?,?)", [companyAId, companyBId]);
  await pool.end();
});

const H = (t) => ({ Authorization: `Bearer ${t}` });
const byRef = (rows, ref) => rows.find((r) => r.referenceNo === ref);

describe("AP Aging detail (Reports Batch 2)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get(`/api/reports/ap-aging?asOf=${ASOF}`).set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body.rows;
  });

  test("current bucket (due date == as-of)", () => {
    expect(byRef(rows, "RB2AG-APV-CURRENT").bucket).toBe("current");
  });
  test("1-30 days bucket", () => {
    expect(byRef(rows, "RB2AG-APV-1-30").bucket).toBe("days1to30");
  });
  test("31-60 days bucket", () => {
    expect(byRef(rows, "RB2AG-APV-31-60").bucket).toBe("days31to60");
  });
  test("61-90 days bucket", () => {
    expect(byRef(rows, "RB2AG-APV-61-90").bucket).toBe("days61to90");
  });
  test("over 90 days bucket", () => {
    expect(byRef(rows, "RB2AG-APV-OVER90").bucket).toBe("over90");
  });

  test("partial payment: balance = original - paid, still open", () => {
    const r = byRef(rows, "RB2AG-APV-PARTIAL");
    expect(r).toBeTruthy();
    expect(Number(r.baseBalance)).toBeCloseTo(3500, 2);
  });

  test("fully paid is excluded from the default (OPEN) view", () => {
    expect(byRef(rows, "RB2AG-APV-PAID")).toBeUndefined();
  });

  test("cancelled and void are excluded", () => {
    expect(byRef(rows, "RB2AG-APV-CANCELLED")).toBeUndefined();
    expect(byRef(rows, "RB2AG-APV-VOID")).toBeUndefined();
  });

  test("reversal handling: an APV superseded by a Posted APV_REVERSAL JV is excluded", () => {
    expect(byRef(rows, "RB2AG-APV-REVERSED")).toBeUndefined();
  });

  test("as-of filtering: a transaction dated after the as-of date is excluded", () => {
    expect(byRef(rows, "RB2AG-APV-FUTURE")).toBeUndefined();
  });

  test("company isolation: Company B's APV never appears", () => {
    expect(byRef(rows, "RB2AG-APV-COMPANYB")).toBeUndefined();
  });
});

describe("AP Aging summary (Reports Batch 2)", () => {
  test("groups by party with correct bucket totals", async () => {
    const res = await request(app).get(`/api/reports/ap-aging-summary?asOf=${ASOF}`).set(H(tokenA));
    expect(res.status).toBe(200);
    const party = res.body.parties.find((p) => String(p.partyId) === String(suppAId));
    expect(party).toBeTruthy();
    // current 1000 + 1-30 (2000 + partial's 3500, due 2027-06-10 = 20 days)
    // + 31-60 3000 + 61-90 4000 + over90 5000 = 18500
    expect(Number(party.baseBalance)).toBeCloseTo(18500, 2);
    expect(party.buckets.current).toBeCloseTo(1000, 2);
    expect(party.buckets.days1to30).toBeCloseTo(2000 + 3500, 2);
    expect(party.buckets.days31to60).toBeCloseTo(3000, 2);
    expect(party.buckets.days61to90).toBeCloseTo(4000, 2);
    expect(party.buckets.over90).toBeCloseTo(5000, 2);
  });
});

describe("AR Aging detail (Reports Batch 2)", () => {
  let rows;
  beforeAll(async () => {
    const res = await request(app).get(`/api/reports/ar-aging?asOf=${ASOF}`).set(H(tokenA));
    expect(res.status).toBe(200);
    rows = res.body.rows;
  });

  test("current and over-90 buckets", () => {
    expect(byRef(rows, "RB2AG-INV-CURRENT").bucket).toBe("current");
    expect(byRef(rows, "RB2AG-INV-OVER90").bucket).toBe("over90");
  });

  test("partial payment balance is correct", () => {
    const r = byRef(rows, "RB2AG-INV-PARTIAL");
    expect(Number(r.baseBalance)).toBeCloseTo(3000, 2);
  });

  test("company isolation: Company B's Invoice never appears", () => {
    expect(byRef(rows, "RB2AG-INV-COMPANYB")).toBeUndefined();
  });
});

describe("AR Aging summary (Reports Batch 2)", () => {
  test("groups by party with correct total", async () => {
    const res = await request(app).get(`/api/reports/ar-aging-summary?asOf=${ASOF}`).set(H(tokenA));
    expect(res.status).toBe(200);
    const party = res.body.parties.find((p) => String(p.partyId) === String(custAId));
    expect(party).toBeTruthy();
    // current 1500 + over90 2500 + partial 3000 = 7000
    expect(Number(party.baseBalance)).toBeCloseTo(7000, 2);
  });
});
