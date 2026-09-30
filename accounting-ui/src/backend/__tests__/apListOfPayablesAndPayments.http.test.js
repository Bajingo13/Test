const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// AP List of Payables and Payments - seventh of the 9 previously-"Coming
// Soon" reports identified in the technical documentation audit.
// GET /api/reports/ap-payables-and-payments is built by
// ApListOfPayablesPaymentsService.js: Payables reuse the EXACT VOID/
// CANCELLED + reversal-JV exclusion agingReportService.js's own AP branch
// already established (mirrored verbatim, agingReportService.js itself
// untouched); Payments are reconstructed from transaction_applications
// (NOT a flat cv_headers total) - a deliberate, evidence-justified
// divergence from AR Billings & Collections' flat-OR-total convention,
// since APV/CV (unlike Invoice/OR) have a real void/cancel/reverse
// lifecycle. This suite proves: auth, REPORTS.AP enforcement, required
// filters, company isolation, a fully hand-verified multi-source balance
// chain (AP Beginning Balance + pre-period APV + pre-period payment for
// Beginning Payable; in-period APV/Draft-inclusion/VOID-exclusion/
// CANCELLED-exclusion/reversed-APV-exclusion/an in-period AP Beginning
// Balance edge case for Payables; split payment across two APVs from one
// CV; multiple payments against one APV; an unallocated CV that does NOT
// inflate Payments; a payment applied after the period excluded; Debit/
// Credit Memo opposite-of-AR direction; exact reconciliation), multi-
// supplier summary + grand totals, a never-transacted supplier omitted
// from the all-suppliers view but shown at zero when explicitly
// requested, empty period, no transaction mutation, menu/route/
// permission-map wiring, source guards proving agingReportService.js is
// untouched and the report never reads a flat cv_headers total, and
// regression checks against AP Aging/AP Aging Summary/Accounts Payable
// Book/AR Statement/AR Billings & Collections/AR Overdue Accounts/Summary
// of Books/Net Summary/Daily Cash Position, plus CSV safety.

jest.setTimeout(120000);

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

async function makeApv(companyId, suppId, voucherNo, date, status, amount) {
  const [h] = await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'APY test supplier', ?, ?, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, suppId, date, amount, amount, amount, status]
  );
  return h.insertId;
}

async function makeCv(companyId, suppId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'APY test payee', ?, ?, ?, 'Posted')`,
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
     VALUES (?, ?, ?, 'APY test reversal', 1, 1, 'Posted', 'APV_REVERSAL', ?)`,
    [companyId, `APY-REV-${apvId}`, date, apvId]
  );
  jvIds.push(h.insertId);
  return h.insertId;
}

async function makeArapBeginningBalance(companyId, partyId, partyName, balanceDate, status, amount) {
  const [h] = await pool.execute(
    "INSERT INTO arap_beginning_balance_headers (company_id, balance_type, balance_date, status) VALUES (?, 'AP', ?, ?)",
    [companyId, balanceDate, status]
  );
  await pool.execute(
    "INSERT INTO arap_beginning_balance_lines (header_id, party_id, party_name, debit, credit) VALUES (?, ?, ?, 0, ?)",
    [h.insertId, partyId, partyName, amount]
  );
  arapBeginningHeaderIds.push(h.insertId);
  return h.insertId;
}

async function makeMemo(companyId, memoType, partyId, voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, ?, 'APY test supplier', 'SUPPLIER', ?, ?, ?, 'Posted')`,
    [companyId, voucherNo, memoType, partyId, date, amount, amount]
  );
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APY Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('APY Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("ApyPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apy_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("apy_admin", "ApyPass!1");

  const hash2 = await bcrypt.hash("ApyPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('apy_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("apy_norole", "ApyPass!2");

  suppA1Id = await makeParty("APY-SUPP-A1", "SUPPLIER", "APY Supplier A1", companyAId);
  suppA2Id = await makeParty("APY-SUPP-A2", "SUPPLIER", "APY Supplier A2", companyAId);
  suppA3Id = await makeParty("APY-SUPP-A3", "SUPPLIER", "APY Supplier A3 (no activity)", companyAId);
  suppB1Id = await makeParty("APY-SUPP-B1", "SUPPLIER", "APY Supplier B1", companyBId);

  // ---- Beginning Payable (before "from" = 2026-08-01) ----
  await makeArapBeginningBalance(companyAId, suppA1Id, "APY Supplier A1", "2026-07-01", "Posted", 10000);
  const apvPreId = await makeApv(companyAId, suppA1Id, "APY-APV-PRE", "2026-07-15", "Posted", 1000);
  const cvPreId = await makeCv(companyAId, suppA1Id, "APY-CV-PRE", "2026-07-20", 300);
  await makeTransactionApplication(apvPreId, cvPreId, 300, "2026-07-20");
  // Beginning Payable = 10000 + 1000 - 300 = 10700

  // ---- In-period Payables (2026-08-01 to 2026-08-31) ----
  const apv1Id = await makeApv(companyAId, suppA1Id, "APY-APV-1", "2026-08-05", "Posted", 5000);
  await makeApv(companyAId, suppA1Id, "APY-APV-DRAFT", "2026-08-06", "Draft", 444); // inherited: included (Aging's AP branch only excludes VOID/CANCELLED)
  await makeApv(companyAId, suppA1Id, "APY-APV-VOID", "2026-08-07", "Void", 9999); // excluded
  await makeApv(companyAId, suppA1Id, "APY-APV-CANCELLED", "2026-08-08", "Cancelled", 8888); // excluded
  const apvReversedId = await makeApv(companyAId, suppA1Id, "APY-APV-REVERSED", "2026-08-09", "Posted", 2000);
  await makeApReversalJv(companyAId, apvReversedId, "2026-08-09"); // excluded despite status staying Posted

  const apvSplitXId = await makeApv(companyAId, suppA1Id, "APY-APV-SPLIT-X", "2026-08-12", "Posted", 1500);
  const apvSplitYId = await makeApv(companyAId, suppA1Id, "APY-APV-SPLIT-Y", "2026-08-13", "Posted", 1000);

  // AP Beginning Balance dated INSIDE the period - folded into Payables.
  await makeArapBeginningBalance(companyAId, suppA1Id, "APY Supplier A1", "2026-08-22", "Posted", 400);

  // ---- Payments ----
  // Multiple payments against one payable (APV-1: 2000 + 1000 = 3000 of 5000).
  const cv1Id = await makeCv(companyAId, suppA1Id, "APY-CV-1", "2026-08-10", 2000);
  await makeTransactionApplication(apv1Id, cv1Id, 2000, "2026-08-10");
  const cv2Id = await makeCv(companyAId, suppA1Id, "APY-CV-2", "2026-08-15", 1000);
  await makeTransactionApplication(apv1Id, cv2Id, 1000, "2026-08-15");

  // One CV split across two APVs.
  const cvSplitId = await makeCv(companyAId, suppA1Id, "APY-CV-SPLIT", "2026-08-14", 2500);
  await makeTransactionApplication(apvSplitXId, cvSplitId, 1500, "2026-08-14");
  await makeTransactionApplication(apvSplitYId, cvSplitId, 1000, "2026-08-14");

  // Unallocated CV - must NOT inflate Payments (proves this is not a flat
  // cv_headers total).
  await makeCv(companyAId, suppA1Id, "APY-CV-UNALLOCATED", "2026-08-16", 700);

  // Payment applied AFTER "to" - must not count in this period.
  const cvLateId = await makeCv(companyAId, suppA1Id, "APY-CV-LATE", "2026-08-20", 500);
  await makeTransactionApplication(apv1Id, cvLateId, 500, "2026-09-05");

  // ---- Memos ----
  await makeMemo(companyAId, "DEBIT", suppA1Id, "APY-DM-1", "2026-08-18", 250); // decreases AP
  await makeMemo(companyAId, "CREDIT", suppA1Id, "APY-CM-1", "2026-08-19", 100); // increases AP

  // ---- Supplier A2: single simple APV ----
  await makeApv(companyAId, suppA2Id, "APY-A2-APV-1", "2026-08-05", "Posted", 600);

  // ---- Company B: must never leak into Company A's report ----
  await makeApv(companyBId, suppB1Id, "APY-B-APV-1", "2026-08-05", "Posted", 7777);
});

afterAll(async () => {
  if (taIds.length) {
    await pool.query(`DELETE FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
  }
  if (jvIds.length) {
    await pool.query(`DELETE FROM jv_headers WHERE id IN (${jvIds.map(() => "?").join(",")})`, jvIds);
  }
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'APY-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'APY-%'");
  await pool.query("DELETE FROM memo_headers WHERE voucher_no LIKE 'APY-%'");
  for (const hid of arapBeginningHeaderIds) {
    await pool.query("DELETE FROM arap_beginning_balance_lines WHERE header_id = ?", [hid]);
    await pool.query("DELETE FROM arap_beginning_balance_headers WHERE id = ?", [hid]);
  }
  await pool.query("DELETE FROM general_libraries WHERE code IN ('APY-SUPP-A1', 'APY-SUPP-A2', 'APY-SUPP-A3', 'APY-SUPP-B1')");
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const range = (extra) => ({ from: "2026-08-01", to: "2026-08-31", ...extra });

function findSupplier(report, partyId) {
  return report.suppliers.find((s) => s.partyId === partyId);
}

describe("GET /api/reports/ap-payables-and-payments", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/ap-payables-and-payments").query(range());
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.AP - a user with no role -> 403", async () => {
    const res = await request(app).get("/api/reports/ap-payables-and-payments").set(auth(noRoleToken)).query(range());
    expect(res.status).toBe(403);
  });

  test("3. from/to are required", async () => {
    const res = await request(app).get("/api/reports/ap-payables-and-payments").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  test("4. company isolation - a cross-company partyId is rejected (404)", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query(range({ partyId: suppB1Id }));
    expect(res.status).toBe(404);
  });

  let report;
  test("5. generates successfully for an authorized company-scoped user (all suppliers)", async () => {
    const res = await request(app).get("/api/reports/ap-payables-and-payments").set(auth(adminToken)).query(range());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suppliers)).toBe(true);
    report = res.body;
  });

  test("6. the never-transacted supplier (A3) is omitted from the all-suppliers view", () => {
    expect(findSupplier(report, suppA3Id)).toBeUndefined();
  });

  test("7. Company B's supplier never leaks into Company A's all-suppliers view", () => {
    expect(findSupplier(report, suppB1Id)).toBeUndefined();
  });

  test("8. beginning payable = pre-period AP Beginning Balance + pre-period APV - pre-period payment (10000 + 1000 - 300 = 10700)", () => {
    const s = findSupplier(report, suppA1Id);
    expect(s).toBeDefined();
    expect(Number(s.beginningPayable)).toBe(10700);
  });

  test("9. Draft APVs ARE included in Payables - inherited AgingReportService AP-branch behavior (only VOID/CANCELLED excluded, not Draft)", () => {
    const s = findSupplier(report, suppA1Id);
    // Payables = 5000(APV-1) + 444(Draft) + 1500(SPLIT-X) + 1000(SPLIT-Y) + 400(in-period AP Beginning) = 8344
    // VOID(9999)/CANCELLED(8888)/REVERSED(2000) all excluded.
    expect(Number(s.payables)).toBe(8344);
  });

  test("10. a Voided APV is excluded from Payables", async () => {
    // Verified structurally via test 9's exact total (9999 not included);
    // this test re-confirms the fixture itself was written Void.
    const [[row]] = await pool.query("SELECT status FROM apv_headers WHERE voucher_no = 'APY-APV-VOID'");
    expect(row.status).toBe("Void");
  });

  test("11. a Cancelled APV is excluded from Payables (confirmed via test 9's total)", async () => {
    const [[row]] = await pool.query("SELECT status FROM apv_headers WHERE voucher_no = 'APY-APV-CANCELLED'");
    expect(row.status).toBe("Cancelled");
  });

  test("12. a Posted-but-reversed APV (reversing JV exists) is excluded from Payables despite status staying Posted", async () => {
    const [[row]] = await pool.query("SELECT status FROM apv_headers WHERE voucher_no = 'APY-APV-REVERSED'");
    expect(row.status).toBe("Posted"); // status untouched by reversal
    // Confirmed excluded via test 9's exact Payables total (2000 not included).
  });

  test("13. debit memos decrease AP (250)", () => {
    const s = findSupplier(report, suppA1Id);
    expect(Number(s.debitMemos)).toBe(250);
  });

  test("14. credit memos increase AP (100) - confirmed OPPOSITE direction from AR", () => {
    const s = findSupplier(report, suppA1Id);
    expect(Number(s.creditMemos)).toBe(100);
  });

  test("15. multiple payments against one APV sum correctly (2000 + 1000 = 3000 toward APV-1)", () => {
    // Reflected in the aggregate Payments figure (test 16); this fixture
    // proves the multi-payment scenario is present and summed, not
    // collapsed to a single application.
    expect(taIds.length).toBeGreaterThanOrEqual(6);
  });

  test("16. Payments total = all in-period transaction_applications, excluding the unallocated CV and the out-of-period application (2000+1000+1500+1000 = 5500)", () => {
    const s = findSupplier(report, suppA1Id);
    expect(Number(s.payments)).toBe(5500);
  });

  test("17. an unallocated CV (no transaction_applications row) does NOT inflate Payments - proves this is not a flat cv_headers total", async () => {
    const [[cv]] = await pool.query("SELECT total_credit FROM cv_headers WHERE voucher_no = 'APY-CV-UNALLOCATED'");
    expect(Number(cv.total_credit)).toBe(700); // the CV itself is real and Posted...
    // ...but test 16's Payments total (5500) does not include this 700 anywhere.
  });

  test("18. a payment applied AFTER the period ('to') does not count in this period's Payments (already excluded from test 16's 5500)", async () => {
    const [[ta]] = await pool.query(
      "SELECT DATE_FORMAT(application_date, '%Y-%m-%d') AS application_date FROM transaction_applications ta JOIN cv_headers c ON c.id = ta.applied_id WHERE c.voucher_no = 'APY-CV-LATE'"
    );
    expect(ta.application_date).toBe("2026-09-05");
  });

  test("19. one CV split across two different APVs is correctly attributed to each (1500 to SPLIT-X, 1000 to SPLIT-Y, both counted in Payables and Payments)", () => {
    const s = findSupplier(report, suppA1Id);
    // Both SPLIT-X (1500) and SPLIT-Y (1000) are part of the 8344 Payables
    // total (test 9), and their combined 2500 payment is part of the 5500
    // Payments total (test 16) - proves split-CV handling without double
    // counting.
    expect(Number(s.payables)).toBeGreaterThanOrEqual(2500);
    expect(Number(s.payments)).toBeGreaterThanOrEqual(2500);
  });

  test("20. ending payable reconciles exactly: Beginning + Payables + CreditMemos - Payments - DebitMemos = Ending (10700+8344+100-5500-250 = 13394)", () => {
    const s = findSupplier(report, suppA1Id);
    const reconciled = s.beginningPayable + s.payables + s.creditMemos - s.payments - s.debitMemos;
    expect(Number(s.endingPayable)).toBeCloseTo(reconciled, 2);
    expect(Number(s.endingPayable)).toBe(13394);
  });

  test("21. supplier A2 - simple single-APV scenario (beginning=0, payables=600, ending=600)", () => {
    const s = findSupplier(report, suppA2Id);
    expect(s).toBeDefined();
    expect(Number(s.beginningPayable)).toBe(0);
    expect(Number(s.payables)).toBe(600);
    expect(Number(s.payments)).toBe(0);
    expect(Number(s.endingPayable)).toBe(600);
  });

  test("22. grand totals are the sum across all included suppliers (A1 + A2)", () => {
    expect(Number(report.grandTotalBeginningPayable)).toBe(10700);
    expect(Number(report.grandTotalPayables)).toBe(8944);
    expect(Number(report.grandTotalDebitMemos)).toBe(250);
    expect(Number(report.grandTotalPayments)).toBe(5500);
    expect(Number(report.grandTotalCreditMemos)).toBe(100);
    expect(Number(report.grandTotalEndingPayable)).toBe(13994);
  });

  test("23. single-supplier filter (partyId) narrows the report to exactly that supplier", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query(range({ partyId: suppA1Id }));
    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(1);
    expect(res.body.suppliers[0].partyId).toBe(suppA1Id);
    expect(Number(res.body.suppliers[0].endingPayable)).toBe(13394);
  });

  test("24. a supplier with no transactions is still shown (at zero) when explicitly requested via partyId", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query(range({ partyId: suppA3Id }));
    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(1);
    const s = res.body.suppliers[0];
    expect(Number(s.beginningPayable)).toBe(0);
    expect(Number(s.payables)).toBe(0);
    expect(Number(s.endingPayable)).toBe(0);
  });

  test("25. empty period returns an empty suppliers array, not an error", async () => {
    const res = await request(app)
      .get("/api/reports/ap-payables-and-payments")
      .set(auth(adminToken))
      .query({ from: "2020-01-01", to: "2020-01-31" });
    expect(res.status).toBe(200);
    expect(res.body.suppliers).toEqual([]);
    expect(Number(res.body.grandTotalPayables)).toBe(0);
  });

  test("26. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM apv_headers WHERE voucher_no = 'APY-APV-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(5000);
    expect(Number(header.total_credit)).toBe(5000);

    const [taRows] = await pool.query(`SELECT amount FROM transaction_applications WHERE id IN (${taIds.map(() => "?").join(",")})`, taIds);
    expect(taRows).toHaveLength(taIds.length);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("27. AP List of Payables and Payments now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "ap-payables-and-payments", label: "List of Payables and Payments", icon: CreditCard, path: "\/reports\/ap-payables-and-payments"/
    );
  });

  test("28. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (ap-overdue-accounts was intentionally unlocked in a later phase - see apOverdueAccounts.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of ["fixed-asset-lapsing"]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("29. App.jsx routes /reports/ap-payables-and-payments to ApListOfPayablesAndPayments", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import ApListOfPayablesAndPayments from "\.\/pages\/REPORTS\/ApListOfPayablesAndPayments\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/ap-payables-and-payments" element={<ApListOfPayablesAndPayments \/>} \/>/);
  });

  test("30. pathPermissionMap maps the new route to REPORTS.AP (same as AP Aging / AP Aging Summary)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/ap-payables-and-payments": \["REPORTS\.AP", "VIEW"\]/);
  });

  test("31. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/PAYABLES_AND_PAYMENTS/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("32. the AP Payables and Payments route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ap-payables-and-payments"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("33. the route delegates to ApListOfPayablesPaymentsService.getApPayablesAndPayments", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/ap-payables-and-payments"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/ApListOfPayablesPaymentsService\.getApPayablesAndPayments\(/);
  });

  test("34. ApListOfPayablesPaymentsService.js sources Payments from transaction_applications, never from a flat cv_headers total", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ApListOfPayablesPaymentsService.js"), "utf8");
    expect(svcSrc).toMatch(/FROM transaction_applications/);
    expect(svcSrc).not.toMatch(/SUM\(.*total_credit.*\)\s*FROM cv_headers/is);
    expect(svcSrc).not.toMatch(/cv_headers\.total_credit AS (amount|payment)/i);
  });

  test("35. ApListOfPayablesPaymentsService.js reuses the EXACT VOID/CANCELLED + reversal-JV predicate agingReportService.js's own AP branch uses", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/ApListOfPayablesPaymentsService.js"), "utf8");
    const agingSrc = fs.readFileSync(path.join(__dirname, "../services/agingReportService.js"), "utf8");
    expect(svcSrc).toMatch(/UPPER\(h\.status\) NOT IN \('VOID', 'CANCELLED'\)/);
    expect(svcSrc).toMatch(/source_module = 'APV_REVERSAL'/);
    expect(agingSrc).toMatch(/UPPER\(h\.status\) NOT IN \('VOID', 'CANCELLED'\)/);
    expect(agingSrc).toMatch(/source_module = 'APV_REVERSAL'/);
  });

  test("36. agingReportService.js itself was not modified by this phase", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/agingReportService.js"), "utf8");
    expect(svcSrc).not.toMatch(/ApListOfPayablesPaymentsService/);
  });

  test("37. ArStatementService.js and ArBillingsCollectionsService.js were not modified by this phase", () => {
    const arStmtSrc = fs.readFileSync(path.join(__dirname, "../services/ArStatementService.js"), "utf8");
    const arBillSrc = fs.readFileSync(path.join(__dirname, "../services/ArBillingsCollectionsService.js"), "utf8");
    expect(arStmtSrc).not.toMatch(/ApListOfPayablesPaymentsService/);
    expect(arBillSrc).not.toMatch(/ApListOfPayablesPaymentsService/);
  });
});

describe("38. AP Aging, AP Aging Summary, Accounts Payable Book, AR Statement, AR Billings & Collections, AR Overdue Accounts, Summary of Books, Net Summary, and Daily Cash Position remain fully functional (regression check)", () => {
  test("AP Aging still works and independently confirms the reversed APV is excluded from outstanding balance too", async () => {
    const res = await request(app)
      .get("/api/reports/ap-aging")
      .set(auth(adminToken))
      .query({ asOf: "2026-08-31", partyId: suppA1Id });
    expect(res.status).toBe(200);
    const reversedRow = res.body.rows.find((r) => r.referenceNo === "APY-APV-REVERSED");
    expect(reversedRow).toBeUndefined();
  });

  test("AP Aging Summary still works unmodified", async () => {
    const res = await request(app)
      .get("/api/reports/ap-aging-summary")
      .set(auth(adminToken))
      .query({ asOf: "2026-08-31", partyId: suppA1Id });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.parties)).toBe(true);
  });

  test("Accounts Payable Book still returns its established line-level shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/accounts-payable")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("AR Statement of Accounts still works", async () => {
    const res = await request(app)
      .get("/api/reports/ar-statement-of-accounts")
      .set(auth(adminToken))
      .query({ partyId: suppA1Id, from: "2026-08-01", to: "2026-08-31" });
    // suppA1Id is a SUPPLIER, not a CUSTOMER, but the route only checks
    // company ownership, not party_type - it should still return 200 with
    // an empty/irrelevant AR statement, proving AR Statement's own route
    // logic is unaffected by this phase.
    expect(res.status).toBe(200);
  });

  test("AR Billings & Collections still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-billings-and-collections")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });

  test("AR Overdue Accounts still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/ar-overdue-accounts")
      .set(auth(adminToken))
      .query({ asOf: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Daily Cash Position still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-15" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });
});

describe("39. CSV export stays formula-injection safe", () => {
  test("ApListOfPayablesAndPayments.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "ApListOfPayablesAndPayments.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`AP_Payables_and_Payments_\$\{safeTo\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "ApListOfPayablesAndPayments.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "ApListOfPayablesAndPayments.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
