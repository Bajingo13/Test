const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Daily Cash Position Report - third of the 9 previously-"Coming Soon"
// reports identified in the technical documentation audit.
// GET /api/reports/daily-cash-position is NOT a new recognition query: it
// reuses the exact same LedgerReportService.getBeginningBalances/
// getLedgerRows calls the existing Cash Flow Statement route
// (GET /api/reports/cash-flow-statement) already makes, scoped to accounts
// flagged BANK / CASH via the `bank_codes` table (same mechanism Cash Flow
// Statement and Bank Reconciliation already rely on), just narrowed to a
// single reporting date (from = to = date) with debit/credit split into
// explicit Cash Receipts / Cash Disbursements totals instead of exposing
// full transaction-level rows.
//
// `bank_codes` and `chart_of_accounts` are BOTH global tables (no
// company_id column - confirmed by reading their migration schema), so
// this suite never asserts exact array length or grand totals (the shared
// test database may already contain other bank/cash accounts from other
// fixtures or seed data); it only asserts on the ONE account it creates
// (found via .find()), proving company isolation is enforced at the
// transaction level (company_id on jv_headers/or_headers/cv_headers), not
// by bank_codes itself - exactly how the existing Cash Flow Statement
// route already behaves.

jest.setTimeout(120000);

let companyAId, companyBId;
let adminId, noRoleId;
let adminToken, noRoleToken;
let cashCoaId;
const coaIds = [];
let bankCodeId;

async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

async function makeCoa(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  coaIds.push(r.insertId);
  return r.insertId;
}

async function makeParty(code, partyType, name, companyId) {
  const [result] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [companyId, code, partyType, name]
  );
  return result.insertId;
}

async function insertLines(table, idCol, headerId, lines) {
  for (const l of lines) {
    await pool.execute(
      `INSERT INTO ${table} (${idCol}, account_code, account_title, particulars, debit, credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [headerId, l.code, l.title, l.particulars || "test line", l.debit || 0, l.credit || 0]
    );
  }
}

async function makeJv(companyId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'DCP test fixture', ?, ?, ?)`,
    [companyId, voucherNo, date, totalDebit, totalCredit, status]
  );
  await insertLines("jv_lines", "jv_id", h.insertId, lines);
  return h.insertId;
}

async function makeOr(companyId, customerId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO or_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'DCP test customer', ?, ?, ?, ?)`,
    [companyId, voucherNo, customerId, date, totalDebit, totalCredit, status]
  );
  await insertLines("or_lines", "or_id", h.insertId, lines);
  return h.insertId;
}

async function makeCv(companyId, payeeId, voucherNo, date, status, lines) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const [h] = await pool.execute(
    `INSERT INTO cv_headers (company_id, voucher_no, payee_id, payee_name, transaction_date, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'DCP test payee', ?, ?, ?, ?)`,
    [companyId, voucherNo, payeeId, date, totalDebit, totalCredit, status]
  );
  await insertLines("cv_lines", "cv_id", h.insertId, lines);
  return h.insertId;
}

beforeAll(async () => {
  assertNotProductionDatabase();

  const [ca] = await pool.execute("INSERT INTO companies (name, status) VALUES ('DCP Co A', 'Active')");
  companyAId = ca.insertId;
  const [cb] = await pool.execute("INSERT INTO companies (name, status) VALUES ('DCP Co B', 'Active')");
  companyBId = cb.insertId;

  const hash = await bcrypt.hash("DcpPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('dcp_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyAId]);
  adminToken = await login("dcp_admin", "DcpPass!1");

  const hash2 = await bcrypt.hash("DcpPass!2", 10);
  const [noRole] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('dcp_norole', ?, NULL, 'ACTIVE')",
    [hash2]
  );
  noRoleId = noRole.insertId;
  noRoleToken = await login("dcp_norole", "DcpPass!2");

  cashCoaId = await makeCoa("DCP-CASH", "DCP Cash in Bank", "ASSET");
  await makeCoa("DCP-REV", "DCP Revenue", "INCOME");
  await makeCoa("DCP-EXP", "DCP Expense", "EXPENSE");
  await makeCoa("DCP-AR", "DCP AR", "ASSET");

  // Register DCP-CASH as an ACTIVE Cash/Bank account - the same table
  // syncBankCodeForAccount populates when a COA account is tagged
  // "BANK / CASH" in the real app; inserted directly here since this
  // report reads bank_codes directly, not coa_validations.
  const [bc] = await pool.execute(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES ('DCP-BC', 'DCP Test Bank', '000-DCP', 'DCP Cash in Bank', ?, 'DCP-CASH', 'ACTIVE')",
    [cashCoaId]
  );
  bankCodeId = bc.insertId;

  const customer = await makeParty("DCP-CUST", "CUSTOMER", "DCP Customer", companyAId);
  const supplier = await makeParty("DCP-SUPP", "SUPPLIER", "DCP Supplier", companyAId);

  // 1. Opening balance JV, Posted, before every "as of" date used below.
  await makeJv(companyAId, "DCP-JV-OPEN", "2026-08-01", "Posted", [
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 5000, credit: 0 },
    { code: "DCP-REV", title: "DCP Revenue", debit: 0, credit: 5000 },
  ]);
  // 2. Draft JV before 2026-08-15 - must be excluded from beginning balance.
  await makeJv(companyAId, "DCP-JV-DRAFT", "2026-08-02", "Draft", [
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 9999, credit: 0 },
    { code: "DCP-REV", title: "DCP Revenue", debit: 0, credit: 9999 },
  ]);
  // 3. Cash receipt ON 2026-08-15, Posted - Receipts = 2000.
  await makeOr(companyAId, customer, "DCP-OR-1", "2026-08-15", "Posted", [
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 2000, credit: 0 },
    { code: "DCP-AR", title: "DCP AR", debit: 0, credit: 2000 },
  ]);
  // 4. Cash disbursement ON 2026-08-15, Posted - Disbursements = 800.
  await makeCv(companyAId, supplier, "DCP-CV-1", "2026-08-15", "Posted", [
    { code: "DCP-EXP", title: "DCP Expense", debit: 800, credit: 0 },
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 0, credit: 800 },
  ]);
  // 5. Draft CV ON 2026-08-15 - must be excluded from receipts/disbursements.
  await makeCv(companyAId, supplier, "DCP-CV-DRAFT", "2026-08-15", "Draft", [
    { code: "DCP-EXP", title: "DCP Expense", debit: 500, credit: 0 },
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 0, credit: 500 },
  ]);
  // 6. CV ON 2026-08-16 (day after) - counts toward 08-20's beginning
  // balance but must be excluded from 08-15's report entirely.
  await makeCv(companyAId, supplier, "DCP-CV-2", "2026-08-16", "Posted", [
    { code: "DCP-EXP", title: "DCP Expense", debit: 700, credit: 0 },
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 0, credit: 700 },
  ]);
  // 7. Large disbursement ON 2026-08-20 - proves negative net movement.
  await makeCv(companyAId, supplier, "DCP-CV-3", "2026-08-20", "Posted", [
    { code: "DCP-EXP", title: "DCP Expense", debit: 3000, credit: 0 },
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 0, credit: 3000 },
  ]);
  // 8. Small receipt ON 2026-08-20 alongside it.
  await makeOr(companyAId, customer, "DCP-OR-2", "2026-08-20", "Posted", [
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 500, credit: 0 },
    { code: "DCP-AR", title: "DCP AR", debit: 0, credit: 500 },
  ]);

  // --- Company B: Posted JV on the SAME cash account, SAME date as the
  // Company A 08-15 scenario - must never leak into Company A's report,
  // proving isolation is enforced at the transaction level even though
  // bank_codes/chart_of_accounts are global tables. ---
  await makeJv(companyBId, "DCP-B-JV-1", "2026-08-15", "Posted", [
    { code: "DCP-CASH", title: "DCP Cash in Bank", debit: 9999, credit: 0 },
    { code: "DCP-REV", title: "DCP Revenue", debit: 0, credit: 9999 },
  ]);
});

afterAll(async () => {
  await pool.query("DELETE jl FROM jv_lines jl JOIN jv_headers jh ON jh.id = jl.jv_id WHERE jh.voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE ol FROM or_lines ol JOIN or_headers oh ON oh.id = ol.or_id WHERE oh.voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE FROM or_headers WHERE voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE cl FROM cv_lines cl JOIN cv_headers ch ON ch.id = cl.cv_id WHERE ch.voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE FROM cv_headers WHERE voucher_no LIKE 'DCP-%'");
  await pool.query("DELETE FROM general_libraries WHERE code IN ('DCP-CUST', 'DCP-SUPP')");
  if (bankCodeId) {
    await pool.query("DELETE FROM bank_codes WHERE id = ?", [bankCodeId]);
  }
  if (coaIds.length) {
    await pool.query(`DELETE FROM chart_of_accounts WHERE id IN (${coaIds.map(() => "?").join(",")})`, coaIds);
  }
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [adminId, noRoleId]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function findAcct(report) {
  return report.accounts.find((a) => a.accountCode === "DCP-CASH");
}

describe("GET /api/reports/daily-cash-position", () => {
  test("1. requires authentication - no token -> 401", async () => {
    const res = await request(app).get("/api/reports/daily-cash-position").query({ date: "2026-08-15" });
    expect(res.status).toBe(401);
  });

  test("2. enforces REPORTS.FINANCIAL - a user with no role -> 403", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(noRoleToken))
      .query({ date: "2026-08-15" });
    expect(res.status).toBe(403);
  });

  test("3. date is required", async () => {
    const res = await request(app).get("/api/reports/daily-cash-position").set(auth(adminToken));
    expect(res.status).toBe(400);
  });

  let report815;
  test("4. generates successfully for an authorized company-scoped user", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-15" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(res.body.asOfDate).toBe("2026-08-15");
    report815 = res.body;
  });

  test("5. the registered Cash/Bank account (DCP-CASH) appears in the report", () => {
    expect(findAcct(report815)).toBeDefined();
  });

  test("6. beginning balance = sum of Posted transactions strictly before the as-of date (Draft excluded)", () => {
    const acct = findAcct(report815);
    expect(Number(acct.beginningBalance)).toBe(5000); // DCP-JV-OPEN only; DCP-JV-DRAFT excluded
  });

  test("7. cash receipts = sum of debit on the as-of date (Draft excluded)", () => {
    const acct = findAcct(report815);
    expect(Number(acct.cashReceipts)).toBe(2000); // DCP-OR-1 only
  });

  test("8. cash disbursements = sum of credit on the as-of date (Draft excluded)", () => {
    const acct = findAcct(report815);
    expect(Number(acct.cashDisbursements)).toBe(800); // DCP-CV-1 only; DCP-CV-DRAFT excluded
  });

  test("9. net movement = receipts - disbursements", () => {
    const acct = findAcct(report815);
    expect(Number(acct.netMovement)).toBe(1200); // 2000 - 800
  });

  test("10. ending cash = beginning + net movement", () => {
    const acct = findAcct(report815);
    expect(Number(acct.endingBalance)).toBe(6200); // 5000 + 1200
  });

  test("11. company isolation - Company B's Posted JV on the same date/account never leaks into Company A's report", () => {
    const acct = findAcct(report815);
    expect(Number(acct.beginningBalance)).toBe(5000); // not 5000 + 9999
    expect(Number(acct.cashReceipts)).toBe(2000); // Company B's JV never counted as a receipt either
  });

  test("12. transactions the day after the as-of date do not leak backward into it", () => {
    const acct = findAcct(report815);
    // DCP-CV-2 (2026-08-16, -700) must not reduce the 08-15 ending balance.
    expect(Number(acct.endingBalance)).toBe(6200);
  });

  let report820;
  test("13. multiple cash transactions and negative net movement (a later date, larger disbursements than receipts)", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-20" });
    expect(res.status).toBe(200);
    report820 = res.body;
    const acct = findAcct(report820);
    // Beginning(08-20) = 5000 (open) + 2000 (08-15 receipt) - 800 (08-15
    // disbursement) - 700 (08-16 disbursement, DCP-CV-2) = 5500.
    expect(Number(acct.beginningBalance)).toBe(5500);
    expect(Number(acct.cashReceipts)).toBe(500); // DCP-OR-2
    expect(Number(acct.cashDisbursements)).toBe(3000); // DCP-CV-3
  });

  test("14. negative net movement value is exactly receipts - disbursements (500 - 3000 = -2500)", () => {
    const acct = findAcct(report820);
    expect(Number(acct.netMovement)).toBe(-2500);
    expect(Number(acct.endingBalance)).toBe(3000); // 5500 - 2500
  });

  test("15. a date with no transactions still returns the account with zero movement, ending = beginning (not omitted)", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2026-08-25" });
    expect(res.status).toBe(200);
    const acct = findAcct(res.body);
    expect(acct).toBeDefined();
    expect(Number(acct.cashReceipts)).toBe(0);
    expect(Number(acct.cashDisbursements)).toBe(0);
    expect(Number(acct.netMovement)).toBe(0);
    expect(Number(acct.beginningBalance)).toBe(Number(acct.endingBalance));
    expect(Number(acct.beginningBalance)).toBe(3000); // = 08-20's ending balance
  });

  test("16. a date before the first beginning balance returns zero for everything, account still present", async () => {
    const res = await request(app)
      .get("/api/reports/daily-cash-position")
      .set(auth(adminToken))
      .query({ date: "2020-01-01" });
    expect(res.status).toBe(200);
    const acct = findAcct(res.body);
    expect(acct).toBeDefined();
    expect(Number(acct.beginningBalance)).toBe(0);
    expect(Number(acct.cashReceipts)).toBe(0);
    expect(Number(acct.cashDisbursements)).toBe(0);
    expect(Number(acct.endingBalance)).toBe(0);
  });

  test("17. no transaction mutation occurs - source rows are byte-identical after the report ran", async () => {
    const [[header]] = await pool.query(
      "SELECT status, total_debit, total_credit FROM or_headers WHERE voucher_no = 'DCP-OR-1'"
    );
    expect(header.status).toBe("Posted");
    expect(Number(header.total_debit)).toBe(2000);
    expect(Number(header.total_credit)).toBe(2000);
  });
});

// -------------------------------------------------------------- source-level

const FRONTEND = path.join(__dirname, "../../pages/REPORTS");
const SIDEBAR = path.join(__dirname, "../../components/sidebar");
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

describe("menu / route wiring", () => {
  test("18. Daily Cash Position Report now routes to a real page", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    expect(menuSrc).toMatch(
      /id: "daily-cash-position", label: "Daily Cash Position Report", icon: Banknote, path: "\/reports\/daily-cash-position"/
    );
  });

  test("19. the remaining Coming Soon report (Fixed Asset Lapsing) was NOT touched by this phase (ar-statement-of-accounts, ar-billings-and-collections, ar-overdue-accounts, ap-payables-and-payments, and ap-overdue-accounts were intentionally unlocked in later phases - see arStatementOfAccounts.http.test.js, arBillingsAndCollections.http.test.js, arOverdueAccounts.http.test.js, apListOfPayablesAndPayments.http.test.js, and apOverdueAccounts.http.test.js)", () => {
    const menuSrc = read(SIDEBAR, "reportsMenuConfig.js");
    for (const id of [
      "fixed-asset-lapsing",
    ]) {
      const re = new RegExp(`id: "${id}"[^}]*path: "\\/reports\\/fixed-asset-lapsing"`);
      expect(menuSrc).toMatch(re);
    }
  });

  test("20. App.jsx routes /reports/daily-cash-position to DailyCashPositionReport", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "../../App.jsx"), "utf8");
    expect(appSrc).toMatch(/import DailyCashPositionReport from "\.\/pages\/REPORTS\/DailyCashPositionReport\.jsx"/);
    expect(appSrc).toMatch(/<Route path="\/reports\/daily-cash-position" element={<DailyCashPositionReport \/>} \/>/);
  });

  test("21. pathPermissionMap maps the new route to REPORTS.FINANCIAL (same as Cash Flow Statement)", () => {
    const mapSrc = read(SIDEBAR, "pathPermissionMap.js");
    expect(mapSrc).toMatch(/"\/reports\/daily-cash-position": \["REPORTS\.FINANCIAL", "VIEW"\]/);
  });

  test("22. no new permission module was introduced for this phase", () => {
    const migrationSrc = fs.readFileSync(
      path.join(__dirname, "../migrations/user_access_control_migration.sql"),
      "utf8"
    );
    expect(migrationSrc).not.toMatch(/DAILY_CASH|CASH_POSITION/);
  });
});

describe("route does not mutate anything and reuses canonical services (source guard)", () => {
  test("23. the Daily Cash Position route body contains no write statements", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/daily-cash-position"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
  });

  test("24. the route delegates to the unchanged getBeginningBalances/getLedgerRows - no new recognition SQL", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/daily-cash-position"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/LedgerReportService\.getLedgerRows\(/);
    expect(routeBody).toMatch(/LedgerReportService\.getBeginningBalances\(/);
    expect(routeBody).not.toMatch(/SELECT.*FROM.*(jv_lines|cv_lines|or_lines|apv_lines|petty_cash_lines|memo_lines)/is);
  });

  test("25. the account universe is bank_codes (status ACTIVE, coa_code set) - same query Cash Flow Statement already uses", () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    const start = serverSrc.indexOf('app.get("/api/reports/daily-cash-position"');
    const end = serverSrc.indexOf("\n});", start);
    const routeBody = serverSrc.slice(start, end);
    expect(routeBody).toMatch(/FROM bank_codes WHERE status = 'ACTIVE' AND coa_code IS NOT NULL AND coa_code != ''/);
  });

  test("26. LedgerReportService.js itself was not modified by this phase (Daily Cash Position's composition logic lives in the route, matching Cash Flow Statement's own precedent)", () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, "../services/LedgerReportService.js"), "utf8");
    expect(svcSrc).not.toMatch(/getDailyCashPosition/);
  });
});

describe("27. Summary of Books by Totals and Net Summary of Books remain fully functional (regression check)", () => {
  test("Summary of Books by Totals still returns its established shape", async () => {
    const res = await request(app)
      .get("/api/reports/books/summary-totals")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    expect(res.body.books).toHaveLength(7);
  });

  test("Net Summary of Books still returns its established shape, including grandTotalNet", () => {
    return request(app)
      .get("/api/reports/books/net-summary")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" })
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.books).toHaveLength(7);
        expect(res.body).toHaveProperty("grandTotalNet");
      });
  });

  test("Cash Flow Statement (Bank & Cash Movement Report) still works unmodified, sees the same DCP-CASH account", async () => {
    const res = await request(app)
      .get("/api/reports/cash-flow-statement")
      .set(auth(adminToken))
      .query({ from: "2026-08-01", to: "2026-08-31" });
    expect(res.status).toBe(200);
    const acct = res.body.accounts.find((a) => a.accountCode === "DCP-CASH");
    expect(acct).toBeDefined();
  });
});

describe("28. CSV export stays formula-injection safe", () => {
  test("DailyCashPositionReport.jsx exports via downloadCsvText + typedRowsToCsv (same shared utility as its siblings)", () => {
    const src = read(FRONTEND, "DailyCashPositionReport.jsx");
    expect(src).toMatch(/import { downloadCsvText, typedRowsToCsv } from "\.\/reportCsv\.mjs"/);
    expect(src).toMatch(/downloadCsvText\(`Daily_Cash_Position_\$\{safeDate\}\.csv`, typedRowsToCsv\(csvRows\)\)/);
  });

  test("amount cells in the export are typed numeric (t: \"num\"), not run through the text guard", () => {
    const src = read(FRONTEND, "DailyCashPositionReport.jsx");
    expect(src).toMatch(/const N = \(v\) => \(\{ t: "num", v: Number\(v \|\| 0\)\.toFixed\(2\) \}\)/);
  });

  test("no heavy PDF dependency was introduced, and Print/CSV go through the shared ReportExportMenu", () => {
    const src = read(FRONTEND, "DailyCashPositionReport.jsx");
    expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer/i);
    expect(src).toMatch(/window\.print\(\)/);
    expect(src).toMatch(/import ReportExportMenu from "\.\/ReportExportMenu\.jsx"/);
  });
});
