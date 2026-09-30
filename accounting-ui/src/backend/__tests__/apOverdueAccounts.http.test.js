const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// AP List of Overdue Accounts - eighth of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit. The exact AP
// mirror of AR List of Overdue Accounts.
// GET /api/reports/ap-overdue-accounts is NOT a new recognition query:
// ApOverdueAccountsService.js calls the UNCHANGED
// AgingReportService.getAgingRows("AP", ...) - the exact engine AP Aging
// and AP Aging Summary already use - and drops the "current" bucket. This
// suite proves: auth, REPORTS.AP enforcement, as-of-date default,
// supplier filtering, company isolation, every aging-bucket boundary
// (0/1/30/31/60/61/90/91 days), Draft-inclusion, VOID/CANCELLED/reversed-
// APV exclusion, partial payment, multiple payments, a split CV across
// two APVs, an unallocated CV that never appears, a payment applied after
// the as-of date not yet counted, a fully-paid APV excluded, an AP
// Beginning Balance line that becomes overdue, Debit/Credit Memos never
// appearing, multi-supplier summary + grand totals, empty result, no
// transaction mutation, menu/route/permission-map wiring, source guards
// proving no new recognition SQL and that agingReportService.js and its
// two existing AP routes are untouched, and regression checks against AP
// Aging/AP Aging Summary/AP List of Payables and Payments/Accounts
// Payable Book/AR Statement/AR Billings & Collections/AR Overdue
// Accounts/Summary of Books/Net Summary/Daily Cash Position, plus CSV
// safety.

jest.setTimeout(120000);

const AS_OF = "2026-09-19";

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
let suppA1Id, suppA2Id, suppA3Id, suppB1Id;
const taIds = [];
const arapBeginningHeaderIds = [];
const jvIds = [];

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}

async function makeApv(companyId, suppId, voucherNo, transactionDate, dueDate, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'APO test supplier', ?, ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, suppId, transactionDate, dueDate, amount, amount, amount, status]
  );
  return h.insertId;
}

async function makeCv(companyId, suppId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'APO test payee', ?, ?, ?, 'Posted')`,
    [companyId, voucherNo, suppId, date, amount, amount]
  );
  return h.insertId;
}

async function makeTransactionApplication(apvId, cvId, amount, applicationDate) {
  const [r] = await pool.execute(
    "INSERT INTO transaction_applications (source_type, source_id, applied_type, applied_id, amount, application_date) VALUES ('APV', ?, 'CV', ?, ?, ?)",
    [apvId, cvId, amount, applicationDate]
  );
  taIds.push(r.insertId);
}

async function makeApReversalJv(companyId, apvId, date) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status, source_module, source_reference_id)
     VALUES (?, ?, ?, 'APO test reversal', 1, 1, 'Posted', 'APV_REVERSAL', ?)`,
    [companyId, `APO-REV-${apvId}`, date, apvId]
  );
  jvIds.push(h.insertId);
  return h.insertId;
}

async function makeArapBeginningBalance(companyId, partyId, partyName, balanceDate, dueDate, status, amount) {
  const [h] = await pool.execute(
    "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AP', ?, ?)",
    [companyId, balanceDate, status]
  );
  await pool.execute(
    "INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, due_date, debit, credit) VALUES (?, ?, ?, ?, 0, ?)",
    [h.insertId, partyId, partyName, dueDate, amount]
  );
  arapBeginningHeaderIds.push(h.insertId);
  return h.insertId;
}

async function makeMemo(companyId, memoType, partyId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'APO test supplier', 'SUPPLIER', ?, ?, ?, 'Posted')`,
    [companyId, voucherNo, memoType, partyId, date, amount, amount]
  );
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APO Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APO Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("ApoPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apo_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("apo_admin", "ApoPass!1");

  const hash2 = await bcrypt.hash("ApoPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apo_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("apo_norole", "ApoPass!2");

  suppA1Id = await makeParty("APO-SUPP-A1", "SUPPLIER", "APO Supplier A1", companyAId);
  suppA2Id = await makeParty("APO-SUPP-A2", "SUPPLIER", "APO Supplier A2", companyAId);
  suppA3Id = await makeParty("APO-SUPP-A3", "SUPPLIER", "APO Supplier A3 (no activity)", companyAId);
  suppB1Id = await makeParty("APO-SUPP-B1", "SUPPLIER", "APO Supplier B1", companyBId);

  // ---- Bucket-boundary APVs (Supplier A1), all Posted, all unpaid ----
  // Days = AS_OF("2026-09-19") - dueDate, clamped at 0.
  await makeApv(companyAId, suppA1Id, "APO-APV-CURRENT", "2026-08-01", "2026-09-19", "Posted", 1000); // 0 days -> current (excluded)
  await makeApv(companyAId, suppA1Id, "APO-APV-1DAY", "2026-08-01", "2026-09-18", "Posted", 2000); // 1 day -> days1to30
  await makeApv(companyAId, suppA1Id, "APO-APV-30DAY", "2026-08-01", "2026-08-20", "Posted", 500); // 30 days -> days1to30 (upper)
  await makeApv(companyAId, suppA1Id, "APO-APV-31DAY", "2026-08-01", "2026-08-19", "Posted", 600); // 31 days -> days31to60 (lower)
  await makeApv(companyAId, suppA1Id, "APO-APV-60DAY", "2026-08-01", "2026-07-21", "Posted", 700); // 60 days -> days31to60 (upper)
  await makeApv(companyAId, suppA1Id, "APO-APV-61DAY", "2026-08-01", "2026-07-20", "Posted", 800); // 61 days -> days61to90 (lower)
  await makeApv(companyAId, suppA1Id, "APO-APV-90DAY", "2026-08-01", "2026-06-21", "Posted", 900); // 90 days -> days61to90 (upper)
  await makeApv(companyAId, suppA1Id, "APO-APV-91DAY", "2026-08-01", "2026-06-20", "Posted", 1000); // 91 days -> over90 (lower)

  // ---- Draft APV, overdue (due 2026-08-01, 49 days) - inherited
  // AgingReportService behavior: the AP branch only excludes VOID/
  // CANCELLED (plus reversed), so this MUST still appear.
  await makeApv(companyAId, suppA1Id, "APO-APV-DRAFT", "2026-08-01", "2026-08-01", "Draft", 9999); // 49 days -> days31to60

  // ---- Void/Cancelled/Reversed APVs - all excluded by AgingReportService's
  // own AP-branch predicate (mirrored unchanged in ApOverdueAccountsService.js
  // only insofar as it reuses getAgingRows("AP", ...) verbatim).
  await makeApv(companyAId, suppA1Id, "APO-APV-VOID", "2026-08-01", "2026-08-01", "Void", 8888);
  await makeApv(companyAId, suppA1Id, "APO-APV-CANCELLED", "2026-08-01", "2026-08-01", "Cancelled", 7777);
  const apvReversedId = await makeApv(companyAId, suppA1Id, "APO-APV-REVERSED", "2026-08-01", "2026-08-01", "Posted", 6666);
  await makeApReversalJv(companyAId, apvReversedId, "2026-08-09"); // excluded despite status staying Posted

  // ---- Partial payment, before AS_OF - balance = 1000 - 400 = 600.
  const apvPartialId = await makeApv(companyAId, suppA1Id, "APO-APV-PARTIAL", "2026-08-01", "2026-08-01", "Posted", 1000);
  const cvPartialId = await makeCv(companyAId, suppA1Id, "APO-CV-PARTIAL", "2026-09-01", 400);
  await makeTransactionApplication(apvPartialId, cvPartialId, 400, "2026-09-01");

  // ---- Multiple payments, both before AS_OF - balance = 1000 - 300 - 200 = 500.
  const apvMultiId = await makeApv(companyAId, suppA1Id, "APO-APV-MULTI", "2026-08-01", "2026-08-01", "Posted", 1000);
  const cvMulti1Id = await makeCv(companyAId, suppA1Id, "APO-CV-MULTI-1", "2026-09-01", 300);
  const cvMulti2Id = await makeCv(companyAId, suppA1Id, "APO-CV-MULTI-2", "2026-09-10", 200);
  await makeTransactionApplication(apvMultiId, cvMulti1Id, 300, "2026-09-01");
  await makeTransactionApplication(apvMultiId, cvMulti2Id, 200, "2026-09-10");

  // ---- Payment applied AFTER AS_OF - must NOT count as of AS_OF, so the
  // full 1000 balance remains outstanding (as-of-date correctness proof).
  const apvFuturePayId = await makeApv(companyAId, suppA1Id, "APO-APV-FUTUREPAY", "2026-08-01", "2026-08-01", "Posted", 1000);
  const cvFutureId = await makeCv(companyAId, suppA1Id, "APO-CV-FUTURE", "2026-09-25", 700);
  await makeTransactionApplication(apvFuturePayId, cvFutureId, 700, "2026-09-25");

  // ---- Fully paid before AS_OF - balance = 0 - excluded by default
  // status=OPEN filtering.
  const apvFullyPaidId = await makeApv(companyAId, suppA1Id, "APO-APV-FULLYPAID", "2026-08-01", "2026-08-01", "Posted", 1000);
  const cvFullyPaidId = await makeCv(companyAId, suppA1Id, "APO-CV-FULLYPAID", "2026-09-01", 1000);
  await makeTransactionApplication(apvFullyPaidId, cvFullyPaidId, 1000, "2026-09-01");

  // ---- One CV split across two different APVs, both before AS_OF.
  const apvSplitXId = await makeApv(companyAId, suppA1Id, "APO-APV-SPLIT-X", "2026-08-01", "2026-08-01", "Posted", 800);
  const apvSplitYId = await makeApv(companyAId, suppA1Id, "APO-APV-SPLIT-Y", "2026-08-01", "2026-08-01", "Posted", 700);
  const cvSplitId = await makeCv(companyAId, suppA1Id, "APO-CV-SPLIT", "2026-09-05", 900);
  await makeTransactionApplication(apvSplitXId, cvSplitId, 500, "2026-09-05"); // X: 800-500=300
  await makeTransactionApplication(apvSplitYId, cvSplitId, 400, "2026-09-05"); // Y: 700-400=300

  // ---- Unallocated CV - never appears as its own row (Aging's AP branch
  // never reads cv_headers directly), and does not inflate any APV's
  // balance since it has zero transaction_applications rows.
  await makeCv(companyAId, suppA1Id, "APO-CV-UNALLOCATED", "2026-08-16", 650);

  // ---- AP Beginning Balance line, overdue (due 2026-08-01, 49 days),
  // unpaid - proves a beginning-balance item can become overdue too.
  await makeArapBeginningBalance(companyAId, suppA1Id, "APO Supplier A1", "2026-07-01", "2026-08-01", "Posted", 1500);

  // ---- Debit/Credit Memos - must NEVER appear anywhere in the overdue
  // report (AgingReportService's row source never joins memo_headers).
  await makeMemo(companyAId, "DEBIT", suppA1Id, "APO-DM-1", "2026-08-05", 250);
  await makeMemo(companyAId, "CREDIT", suppA1Id, "APO-CM-1", "2026-08-05", 100);

  // ---- Supplier A2: one simple overdue APV (31 days -> days31to60).
  await makeApv(companyAId, suppA2Id, "APO-A2-APV-1", "2026-08-01", "2026-08-19", "Posted", 300);

  // ---- Company B: must never leak into Company A's report.
  await makeApv(companyBId, suppB1Id, "APO-B-APV-1", "2026-08-01", "2026-08-01", "Posted", 9999);
});

afterAll(async () => {
  if (taIds.length) {
    await pool.query(`DELETE FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
  }
  if (jvIds.length) {
    await pool.query(`DELETE FROM jv_headers WHERE id IN (${jvIds.map(() => "?").join(",")})`, jvIds);
  }
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'APO-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'APO-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'APO-%'");
  for (const hid of arapBeginningHeaderIds) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [hid]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [hid]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('APO-SUPP-A1', 'APO-SUPP-A2', 'APO-SUPP-A3', 'APO-SUPP-B1')");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function findRow(report, referenceNo) {
  return report.rows.find((r) => r.referenceNo === referenceNo);
}
function findParty(report, partyId) {
  return report.parties.find((p) => p.partyId === partyId);
}

describe("GET /api/reports/ap-overdue-accounts", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/ap-overdue-accounts").query({ asOf: AS_OF });
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.AP - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/ap-overdue-accounts").set(auth(noRoleToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(403);
  });

  test("3. asOf is NOT required - defaults to today, matching AP Aging's own convention (no 400)", async () => {
    const res = await request(app).get("/api/reports/ap-overdue-accounts").set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.asOfDate).toBe(new Date().toISOString().slice(0, 10));
  });

  let report;
  test("4. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app).get("/api/reports/ap-overdue-accounts").set(auth(adminToken)).query({ asOf: AS_OF });
    expect(res.status).toBe(200);
    expect(res.body.asOfDate).toBe(AS_OF);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(Array.isArray(res.body.parties)).toBe(true);
    report = res.body;
  });

  test("5. an APV due exactly on the As Of Date (0 days) is 'current' and EXCLUDED", () => {
    expect(findRow(report, "APO-APV-CURRENT")).toBeUndefined();
  });

  test("6. an APV one day overdue is included in days1to30", () => {
    const row = findRow(report, "APO-APV-1DAY");
    expect(row).toBeDefined();
    expect(row.daysOutstanding).toBe(1);
    expect(row.bucket).toBe("days1to30");
    expect(Number(row.baseBalance)).toBe(2000);
  });

  test("7. exactly 30 days overdue stays in days1to30 (upper boundary)", () => {
    const row = findRow(report, "APO-APV-30DAY");
    expect(row.daysOutstanding).toBe(30);
    expect(row.bucket).toBe("days1to30");
  });

  test("8. exactly 31 days overdue moves to days31to60 (lower boundary)", () => {
    const row = findRow(report, "APO-APV-31DAY");
    expect(row.daysOutstanding).toBe(31);
    expect(row.bucket).toBe("days31to60");
  });

  test("9. exactly 60 days overdue stays in days31to60 (upper boundary)", () => {
    const row = findRow(report, "APO-APV-60DAY");
    expect(row.daysOutstanding).toBe(60);
    expect(row.bucket).toBe("days31to60");
  });

  test("10. exactly 61 days overdue moves to days61to90 (lower boundary)", () => {
    const row = findRow(report, "APO-APV-61DAY");
    expect(row.daysOutstanding).toBe(61);
    expect(row.bucket).toBe("days61to90");
  });

  test("11. exactly 90 days overdue stays in days61to90 (upper boundary)", () => {
    const row = findRow(report, "APO-APV-90DAY");
    expect(row.daysOutstanding).toBe(90);
    expect(row.bucket).toBe("days61to90");
  });

  test("12. 91 days overdue moves to over90", () => {
    const row = findRow(report, "APO-APV-91DAY");
    expect(row.daysOutstanding).toBe(91);
    expect(row.bucket).toBe("over90");
  });

  test("13. Draft APVs ARE included - inherited AgingReportService AP-branch behavior (only VOID/CANCELLED/reversed excluded, not Draft)", () => {
    const row = findRow(report, "APO-APV-DRAFT");
    expect(row).toBeDefined();
    expect(Number(row.baseBalance)).toBe(9999);
  });

  test("14. a Voided APV is excluded", () => {
    expect(findRow(report, "APO-APV-VOID")).toBeUndefined();
  });

  test("15. a Cancelled APV is excluded", () => {
    expect(findRow(report, "APO-APV-CANCELLED")).toBeUndefined();
  });

  test("16. a Posted-but-reversed APV (reversing JV exists) is excluded despite status staying Posted", async () => {
    expect(findRow(report, "APO-APV-REVERSED")).toBeUndefined();
    const [[row]] = await pool.query("SELECT status FROM apv_headers WHERE voucher_no = 'APO-APV-REVERSED'");
    expect(row.status).toBe("Posted"); // status untouched by reversal
  });

  test("17. partial payment before As Of Date reduces the outstanding balance (1000 - 400 = 600)", () => {
    const row = findRow(report, "APO-APV-PARTIAL");
    expect(Number(row.baseBalance)).toBe(600);
  });

  test("18. multiple payments before As Of Date both reduce the balance (1000 - 300 - 200 = 500)", () => {
    const row = findRow(report, "APO-APV-MULTI");
    expect(Number(row.baseBalance)).toBe(500);
  });

  test("19. a payment applied AFTER As Of Date does not count yet - full balance remains outstanding", () => {
    const row = findRow(report, "APO-APV-FUTUREPAY");
    expect(Number(row.baseBalance)).toBe(1000);
  });

  test("20. a fully paid APV (balance = 0) is excluded by the default OPEN status filter", () => {
    expect(findRow(report, "APO-APV-FULLYPAID")).toBeUndefined();
  });

  test("21. one CV split across two different APVs is correctly attributed to each (SPLIT-X: 800-500=300, SPLIT-Y: 700-400=300)", () => {
    const rowX = findRow(report, "APO-APV-SPLIT-X");
    const rowY = findRow(report, "APO-APV-SPLIT-Y");
    expect(Number(rowX.baseBalance)).toBe(300);
    expect(Number(rowY.baseBalance)).toBe(300);
  });

  test("22. an unallocated CV never appears as its own row and does not inflate any APV's balance", async () => {
    const [[cv]] = await pool.query("SELECT total_credit FROM cv_headers WHERE voucher_no = 'APO-CV-UNALLOCATED'");
    expect(Number(cv.total_credit)).toBe(650); // the CV itself is real and Posted...
    expect(report.rows.some((r) => r.referenceNo === "APO-CV-UNALLOCATED")).toBe(false); // ...but never surfaces as a row
  });

  test("23. an AP Beginning Balance line with a past due date becomes overdue too", () => {
    const row = report.rows.find((r) => r.sourceType === "AP_BEGINNING" && r.partyId === suppA1Id);
    expect(row).toBeDefined();
    expect(Number(row.baseBalance)).toBe(1500);
    expect(row.bucket).toBe("days31to60");
  });

  test("24. Debit/Credit Memos never appear in the overdue report (inherited: AgingReportService's row source never joins memo_headers)", () => {
    expect(findRow(report, "APO-DM-1")).toBeUndefined();
    expect(findRow(report, "APO-CM-1")).toBeUndefined();
  });

  test("25. company isolation - Company B's overdue APV never leaks into Company A's report", () => {
    expect(findRow(report, "APO-B-APV-1")).toBeUndefined();
  });

  test("26. supplier A1's summary row totals match the hand-computed sum (14 documents, 20699 total)", () => {
    const p = findParty(report, suppA1Id);
    expect(p).toBeDefined();
    expect(p.documentCount).toBe(14);
    expect(Number(p.buckets.days1to30)).toBe(2500);
    expect(Number(p.buckets.days31to60)).toBe(15499);
    expect(Number(p.buckets.days61to90)).toBe(1700);
    expect(Number(p.buckets.over90)).toBe(1000);
    expect(Number(p.baseBalance)).toBe(20699);
  });

  test("27. supplier A2's summary row (single 300 APV)", () => {
    const p = findParty(report, suppA2Id);
    expect(p).toBeDefined();
    expect(p.documentCount).toBe(1);
    expect(Number(p.baseBalance)).toBe(300);
  });

  test("28. grand total bucketTotals equal the sum across all suppliers in scope (A1 + A2)", () => {
    expect(Number(report.bucketTotals.base.days1to30)).toBe(2500);
    expect(Number(report.bucketTotals.base.days31to60)).toBe(15799);
    expect(Number(report.bucketTotals.base.days61to90)).toBe(1700);
    expect(Number(report.bucketTotals.base.over90)).toBe(1000);
    expect(Number(report.bucketTotals.base.total)).toBe(20999);
  });

  test("29. single-supplier filter (partyId) narrows the report to exactly that supplier's overdue documents", async () => {
    const res = await request(app)
      .get("/api/reports/ap-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: suppA1Id });
    expect(res.status).toBe(200);
    expect(res.body.parties).toHaveLength(1);
    expect(res.body.parties[0].partyId).toBe(suppA1Id);
    expect(Number(res.body.parties[0].baseBalance)).toBe(20699);
  });

  test("30. empty result (a supplier with zero overdue documents) returns empty arrays, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/ap-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: suppA3Id });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.parties).toEqual([]);
    expect(Number(res.body.bucketTotals.base.total)).toBe(0);
  });

  test("31. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM apv_headers WHERE voucher_no = 'APO-APV-1DAY'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(2000);
    expect(Number(header.total_credit)).toBe(2000);

    const [taRows] = await pool.query(`SELECT amount FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
    expect(taRows).toHaveLength(taIds.length);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("32. AP List of Overdue Accounts now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "ap-overdue-accounts", label: "List of Overdue Accounts", icon: AlertCircle, path: "\/reports\/ap-overdue-accounts"/
    );
  });

  test("33. the remaining 1 Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (later implemented in its own phase - see fixedAssetLapsing.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(/id: "fixed-asset-lapsing"[^}]*path: "\/reports\/fixed-asset-lapsing"/);
  });

  test("34. App.jsx routes /reports/ap-overdue-accounts to ApOverdueAccounts", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ApOverdueAccounts from "\.\/pages\/REPORTS\/ApOverdueAccounts\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/ap-overdue-accounts" element={<ApOverdueAccounts \/>} \/>/);
  });

  test("35. pathPermissionMap maps the new route to REPORTS.AP (same as AP Aging / AP Aging Summary)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/ap-overdue-accounts": \["REPORTS\.AP", "VIEW"\]/);
  });

  test("36. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/AP_OVERDUE_ACCOUNTS/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("37. the AP Overdue Accounts route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ap-overdue-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("38. the route delegates to ApOverdueAccountsService.getOverdueAccounts", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ap-overdue-accounts"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/ApOverdueAccountsService\.getOverdueAccounts\(/);
  });

  test("39. ApOverdueAccountsService.js calls the UNCHANGED AgingReportService.getAgingRows(\"AP\", ...) - no new recognition SQL", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ApOverdueAccountsService.js"), "utf8");
    expect(svcSrc).toMatch(/require\("\.\/agingReportService"\)/);
    expect(svcSrc).toMatch(/getAgingRows\("AP",/);
    expect(svcSrc).toMatch(/bucket !== "current"/);
    expect(svcSrc).not.toMatch(/pool\.execute|pool\.query|SELECT /i);
  });

  test("40. agingReportService.js itself was not modified by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/agingReportService.js"), "utf8");
    expect(svcSrc).not.toMatch(/ApOverdueAccountsService/);
    expect(svcSrc).toMatch(/module\.exports = \{\s*getAgingRows,\s*getBucketTotals,\s*getSummaryByParty,\s*daysBetween,\s*bucketOf,?\s*\};/);
  });

  test("41. the AP Aging and AP Aging Summary routes themselves were not modified by this phase", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start1 = serverSrc.indexOf('app.get("/api/reports/ap-aging"');
    const end1 = serverSrc.indexOf('app.get("/api/reports/ap-aging-summary"');
    const bodyAging = serverSrc.slice(start1, end1);
    expect(bodyAging).not.toMatch(/ApOverdueAccountsService/);

    const start2 = serverSrc.indexOf('app.get("/api/reports/ap-aging-summary"');
    const end2 = serverSrc.indexOf("\n});", start2);
    const bodySummary = serverSrc.slice(start2, end2);
    expect(bodySummary).not.toMatch(/ApOverdueAccountsService/);
  });

  test("42. ApListOfPayablesPaymentsService.js was not modified by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ApListOfPayablesPaymentsService.js"), "utf8");
    expect(svcSrc).not.toMatch(/ApOverdueAccountsService/);
  });
});

describe("43. AP Aging, AP Aging Summary, AP List of Payables and Payments, Accounts Payable Book, AR Statement, AR Billings & Collections, AR Overdue Accounts, Summary of Books, Net Summary, and Daily Cash Position remain fully functional (regression check)", () => {
  test("AP Aging still returns Current-inclusive rows (unlike Overdue Accounts)", async () => {
    const res = await request(app)
      .get("/api/reports/ap-aging")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: suppA1Id });
    expect(res.status).toBe(200);
    const currentRow = res.body.rows.find((r) => r.referenceNo === "APO-APV-CURRENT");
    expect(currentRow).toBeDefined();
    expect(currentRow.bucket).toBe("current");
  });

  test("AP Aging Summary still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/ap-aging-summary")
      .set(auth(adminToken))
      .query({ asOf: AS_OF, partyId: suppA1Id });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.parties)).toBe(true);
  });

  test("AP List of Payables and Payments still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19", partyId: suppA1Id });
    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(1);
  });

  test("Accounts Payable Book still returns its established line-level shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/accounts-payable")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("AR Statement of Accounts still works", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query({ partyId: suppA1Id, from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
  });

  test("AR Billings & Collections still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });

  test("AR Overdue Accounts still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: AS_OF });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-09-19" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: AS_OF });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe("44. CSV export stays formula-injection safe", () => {
  test("ApOverdueAccounts.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "ApOverdueAccounts.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`AP_Overdue_Accounts_\$\{safeDate\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "ApOverdueAccounts.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "ApOverdueAccounts.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
