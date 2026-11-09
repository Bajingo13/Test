const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Global report date standard: every report must actually answer differently
// for RANGE and DATE / AS OF, and reject an invalid selection. The ledger
// fixture is deliberately spread around the June 2026 test period:
//
//   2025-12-15   50  before the current year
//   2026-01-15  100  this year, before June
//   2026-06-15  200  inside June
//   2026-07-15  400  after June
//
// So for June 2026: RANGE reads 200, AS OF June 30 reads 350 (and the Income
// Statement's calendar-year AS OF reads 300).

jest.setTimeout(120000);

let companyId, adminId, token;
const coaIds = [];
let bankCodeId, customerId, supplierId, prepaidId;

const JUNE = { dateMode: "range", from: "2026-06-01", to: "2026-06-30" };
const AS_OF_JUNE = { dateMode: "asof", asOf: "2026-06-30" };

async function makeCoa(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  coaIds.push(r.insertId);
}

async function makeJv(voucherNo, date, amount) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'Report period fixture', ?, ?, 'Posted')`,
    [companyId, voucherNo, date, amount, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_code, account_title, particulars, debit, credit) VALUES (?, 'RPT-CASH', 'RPT Cash', 'x', ?, 0), (?, 'RPT-REV', 'RPT Revenue', 'x', 0, ?)",
    [h.insertId, amount, h.insertId, amount]
  );
}

async function makeInvoice(voucherNo, date, dueDate, amount) {
  await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'RPT Customer', ?, ?, ?, ?, 0, ?, 'Unpaid', 'Posted')`,
    [companyId, voucherNo, customerId, date, dueDate, amount, amount, amount]
  );
}

async function makeApv(voucherNo, date, dueDate, amount) {
  await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, ?, 'RPT Supplier', ?, ?, ?, ?, 0, ?, 'Unpaid', 'Posted')`,
    [companyId, voucherNo, supplierId, date, dueDate, amount, amount, amount]
  );
}

const get = (path, query) =>
  request(app).get(path).query({ companyId, ...query }).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  assertNotProductionDatabase();

  const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES ('RPT Period Co', 'Active')");
  companyId = c.insertId;

  const hash = await bcrypt.hash("RptPass!1", 10);
  const [admin] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('rpt_period_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  adminId = admin.insertId;
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyId]);
  const login = await request(app).post("/api/login").send({ username: "rpt_period_admin", password: "RptPass!1" });
  token = login.body.token;

  await makeCoa("RPT-CASH", "RPT Cash", "ASSET");
  await makeCoa("RPT-REV", "RPT Revenue", "INCOME");

  const [bc] = await pool.execute(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES ('RPT-BC', 'RPT Bank', 'RPT-1', 'RPT Cash', ?, 'RPT-CASH', 'ACTIVE')",
    [coaIds[0]]
  );
  bankCodeId = bc.insertId;

  const [cust] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'RPT-CUST', 'CUSTOMER', 'RPT Customer', 'ACTIVE')",
    [companyId]
  );
  customerId = cust.insertId;
  const [supp] = await pool.execute(
    "INSERT INTO general_libraries (company_id, code, party_type, name, status) VALUES (?, 'RPT-SUPP', 'SUPPLIER', 'RPT Supplier', 'ACTIVE')",
    [companyId]
  );
  supplierId = supp.insertId;

  await makeJv("RPT-JV-PRIOR", "2025-12-15", 50);
  await makeJv("RPT-JV-JAN", "2026-01-15", 100);
  await makeJv("RPT-JV-JUN", "2026-06-15", 200);
  await makeJv("RPT-JV-JUL", "2026-07-15", 400);

  await makeInvoice("RPT-INV-MAY", "2026-05-10", "2026-05-20", 1000);
  await makeInvoice("RPT-INV-JUN", "2026-06-10", "2026-06-20", 2000);
  await makeInvoice("RPT-INV-JUL", "2026-07-10", "2026-07-20", 4000);
  await makeApv("RPT-APV-MAY", "2026-05-10", "2026-05-20", 1000);
  await makeApv("RPT-APV-JUN", "2026-06-10", "2026-06-20", 2000);

  await pool.execute(
    `INSERT INTO fixed_assets (asset_code, asset_name, category, acquisition_date, acquisition_cost, salvage_value, useful_life_years, status)
     VALUES ('RPT-FA-JAN', 'RPT Asset Jan', 'Equipment', '2026-01-01', 1200, 0, 1, 'Active'),
            ('RPT-FA-JUN', 'RPT Asset Jun', 'Equipment', '2026-06-01', 1200, 0, 1, 'Active')`
  );

  const [pp] = await pool.execute(
    `INSERT INTO prepaid_accounts (prepaid_code, description, party_name, account_code, expense_account_code, start_date, amount, term_months, status)
     VALUES ('RPT-PP-JAN', 'RPT Prepaid Jan', 'RPT Party', 'RPT-CASH', 'RPT-REV', '2026-01-01', 1200, 12, 'Active')`
  );
  prepaidId = pp.insertId;
  await pool.execute(
    `INSERT INTO prepaid_accounts (prepaid_code, description, party_name, account_code, expense_account_code, start_date, amount, term_months, status)
     VALUES ('RPT-PP-JUN', 'RPT Prepaid Jun', 'RPT Party', 'RPT-CASH', 'RPT-REV', '2026-06-01', 1200, 12, 'Active')`
  );
});

afterAll(async () => {
  await pool.query("DELETE l FROM jv_lines l JOIN jv_headers h ON h.id = l.jv_id WHERE h.voucher_no LIKE 'RPT-JV-%'");
  await pool.query("DELETE FROM jv_headers WHERE voucher_no LIKE 'RPT-JV-%'");
  await pool.query("DELETE FROM invoice_headers WHERE voucher_no LIKE 'RPT-INV-%'");
  await pool.query("DELETE FROM apv_headers WHERE voucher_no LIKE 'RPT-APV-%'");
  await pool.query("DELETE FROM fixed_assets WHERE asset_code LIKE 'RPT-FA-%'");
  await pool.query("DELETE FROM prepaid_accounts WHERE prepaid_code LIKE 'RPT-PP-%'");
  await pool.query("DELETE FROM general_libraries WHERE code IN ('RPT-CUST', 'RPT-SUPP')");
  await pool.query("DELETE FROM bank_codes WHERE id = ?", [bankCodeId]);
  await pool.query(`DELETE FROM chart_of_accounts WHERE id IN (${coaIds.map(() => "?").join(",")})`, coaIds);
  await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
  await pool.query("DELETE FROM users WHERE id = ?", [adminId]);
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

describe("invalid selections are rejected by the server", () => {
  test.each([
    ["Date From later than Date To", { dateMode: "range", from: "2026-06-30", to: "2026-06-01" }, "INVALID_DATE_RANGE", /cannot be later/],
    ["missing Date From", { dateMode: "range", to: "2026-06-30" }, "INVALID_DATE_RANGE", /Date From is required/],
    ["missing Date To", { dateMode: "range", from: "2026-06-01" }, "INVALID_DATE_RANGE", /Date To is required/],
    ["an impossible date", { dateMode: "range", from: "2026-02-31", to: "2026-06-30" }, "INVALID_DATE_RANGE", /valid/],
    ["missing As Of Date", { dateMode: "asof" }, "INVALID_AS_OF_DATE", /As Of Date is required/],
    ["a malformed As Of Date", { dateMode: "asof", asOf: "June 30" }, "INVALID_AS_OF_DATE", /valid/],
    ["a third date mode", { dateMode: "rangeWithBeginningBalance", from: "2026-06-01", to: "2026-06-30" }, "INVALID_DATE_MODE", /'range' or 'asof'/],
  ])("%s -> 400", async (_label, query, code, message) => {
    for (const path of ["/api/reports/trial-balance", "/api/reports/ar-aging", "/api/reports/balance-sheet"]) {
      const res = await get(path, query);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(res.body.message).toMatch(message);
    }
  });
});

describe("requests without dateMode are untouched", () => {
  test("Trial Balance still reads plain from/to", async () => {
    const res = await get("/api/reports/trial-balance", { from: "2026-06-01", to: "2026-06-30" });
    expect(res.status).toBe(200);
    expect(Number(res.body.find((r) => r.account_code === "RPT-CASH").debit)).toBe(200);
  });

  test("Daily Cash Position still reads plain date", async () => {
    const res = await get("/api/reports/daily-cash-position", { date: "2026-06-15" });
    const acct = res.body.accounts.find((a) => a.accountCode === "RPT-CASH");
    expect(res.body.asOfDate).toBe("2026-06-15");
    expect(acct.cashReceipts).toBe(200);
  });

  test("Aging still reads plain asOf with every open document", async () => {
    const res = await get("/api/reports/ar-aging", { asOf: "2026-07-31", status: "OPEN" });
    const refs = res.body.rows.map((r) => r.referenceNo);
    expect(refs).toEqual(expect.arrayContaining(["RPT-INV-MAY", "RPT-INV-JUN", "RPT-INV-JUL"]));
  });
});

describe("Trial Balance", () => {
  const cash = (body) => Number(body.find((r) => r.account_code === "RPT-CASH")?.debit ?? 0);

  test("RANGE reads only the period's activity", async () => {
    expect(cash((await get("/api/reports/trial-balance", JUNE)).body)).toBe(200);
  });

  test("AS OF reads everything recorded up to the date", async () => {
    expect(cash((await get("/api/reports/trial-balance", AS_OF_JUNE)).body)).toBe(350);
    expect(cash((await get("/api/reports/trial-balance", { dateMode: "asof", asOf: "2026-07-31" })).body)).toBe(750);
  });

  test("AS OF ignores a stray from/to left in the query", async () => {
    const res = await get("/api/reports/trial-balance", { ...AS_OF_JUNE, from: "2026-07-01", to: "2026-07-31" });
    expect(cash(res.body)).toBe(350);
  });
});

describe("activity reports", () => {
  test("General Ledger: RANGE has the opening balance, AS OF has the full history", async () => {
    const range = (await get("/api/reports/general-ledger", { ...JUNE, accountCode: "RPT-CASH" })).body;
    expect(range.map((r) => r.reference_no)).toEqual(["RPT-JV-JUN"]);
    expect(Number(range[0].beginning_balance)).toBe(150);

    const asOf = (await get("/api/reports/general-ledger", { ...AS_OF_JUNE, accountCode: "RPT-CASH" })).body;
    expect(asOf.map((r) => r.reference_no)).toEqual(["RPT-JV-PRIOR", "RPT-JV-JAN", "RPT-JV-JUN"]);
    expect(Number(asOf[0].beginning_balance)).toBe(0);
  });

  test("Account Analysis: running balance continues from the opening balance in both modes", async () => {
    const range = (await get("/api/reports/account-analysis", { ...JUNE, accountCode: "RPT-CASH" })).body;
    expect(range).toHaveLength(1);
    expect(Number(range[0].running_balance)).toBe(350);

    const asOf = (await get("/api/reports/account-analysis", { ...AS_OF_JUNE, accountCode: "RPT-CASH" })).body;
    expect(asOf).toHaveLength(3);
    expect(Number(asOf[2].running_balance)).toBe(350);
  });

  test("Bank & Cash Movement: both modes end at the same balance, from different beginnings", async () => {
    const range = (await get("/api/reports/cash-flow-statement", JUNE)).body.accounts.find((a) => a.accountCode === "RPT-CASH");
    expect(Number(range.beginningBalance)).toBe(150);
    expect(Number(range.endingBalance)).toBe(350);

    const asOf = (await get("/api/reports/cash-flow-statement", AS_OF_JUNE)).body.accounts.find((a) => a.accountCode === "RPT-CASH");
    expect(Number(asOf.beginningBalance)).toBe(0);
    expect(Number(asOf.endingBalance)).toBe(350);
  });

  test("Journal Book, Books Summary and Net Summary follow the mode", async () => {
    const refs = (body) => [...new Set(body.map((r) => r.reference_no))].filter((v) => v.startsWith("RPT-"));
    expect(refs((await get("/api/reports/books/journal", JUNE)).body)).toEqual(["RPT-JV-JUN"]);
    expect(refs((await get("/api/reports/books/journal", AS_OF_JUNE)).body)).toEqual(["RPT-JV-PRIOR", "RPT-JV-JAN", "RPT-JV-JUN"]);

    const debitOf = (body) => {
      const row = (body.books || body.rows || []).find((b) => /journal/i.test(b.book || b.label || b.title || b.key || ""));
      return Number(row?.totalDebit ?? row?.debit ?? 0);
    };
    expect(debitOf((await get("/api/reports/books/summary-totals", JUNE)).body)).toBe(200);
    expect(debitOf((await get("/api/reports/books/summary-totals", AS_OF_JUNE)).body)).toBe(350);

    expect((await get("/api/reports/books/net-summary", JUNE)).status).toBe(200);
    expect((await get("/api/reports/books/net-summary", AS_OF_JUNE)).status).toBe(200);
  });

  test.each([
    ["/api/reports/books/income"],
    ["/api/reports/books/cash-receipt"],
    ["/api/reports/books/cash-disbursement"],
    ["/api/reports/books/accounts-payable"],
    ["/api/reports/books/petty-cash"],
    ["/api/reports/books/debit-credit-memo"],
    ["/api/reports/output-vat"],
    ["/api/reports/ewt-audit"],
    ["/api/reports/ar-billings-and-collections"],
    ["/api/reports/ap-payables-and-payments"],
    ["/api/reports/fixed-asset-lapsing"],
  ])("%s answers both modes", async (path) => {
    expect((await get(path, JUNE)).status).toBe(200);
    expect((await get(path, AS_OF_JUNE)).status).toBe(200);
  });

  test("AR Billings: RANGE counts June's invoice, AS OF counts every invoice to June 30", async () => {
    const total = (body) => Number(body.customers.find((r) => r.partyId === customerId)?.billings ?? 0);
    expect(total((await get("/api/reports/ar-billings-and-collections", JUNE)).body)).toBe(2000);
    expect(total((await get("/api/reports/ar-billings-and-collections", AS_OF_JUNE)).body)).toBe(3000);
  });

  test("AR Statement of Accounts: AS OF starts from zero, RANGE from the opening balance", async () => {
    const range = (await get("/api/reports/ar-statement-of-accounts", { ...JUNE, partyId: customerId })).body;
    expect(Number(range.beginningBalance)).toBe(1000);
    const asOf = (await get("/api/reports/ar-statement-of-accounts", { ...AS_OF_JUNE, partyId: customerId })).body;
    expect(Number(asOf.beginningBalance)).toBe(0);
    expect(Number(asOf.endingBalance)).toBe(Number(range.endingBalance));
  });

  test("Subsidiary Ledger follows the mode", async () => {
    const refs = (body) => (Array.isArray(body) ? body : body.rows || []).map((r) => r.reference_no || r.referenceNo);
    const range = await get("/api/reports/subsidiary-ledger", { ...JUNE, type: "AR", partyId: customerId });
    const asOf = await get("/api/reports/subsidiary-ledger", { ...AS_OF_JUNE, type: "AR", partyId: customerId });
    expect(range.status).toBe(200);
    expect(asOf.status).toBe(200);
    expect(refs(asOf.body).length).toBeGreaterThanOrEqual(refs(range.body).length);
  });

  test("Fixed Asset Lapsing: AS OF rolls forward from acquisition", async () => {
    const line = (body) => body.rows.flatMap((g) => g.assets || [g]).find((a) => a.assetCode === "RPT-FA-JAN");
    const range = line((await get("/api/reports/fixed-asset-lapsing", JUNE)).body);
    const asOf = line((await get("/api/reports/fixed-asset-lapsing", AS_OF_JUNE)).body);
    expect(Number(range.beginningAccumulatedDepreciation)).toBeGreaterThan(0);
    expect(Number(asOf.beginningAccumulatedDepreciation)).toBe(0);
  });
});

describe("Income Statement", () => {
  const revenue = (body) =>
    body.nodes.find((n) => n.kind === "account-line" && n.accountCode === "RPT-REV")?.values?.current;
  const STRUCTURED = { view: "structured", mode: "detailed", strict: "0", comparePrev: "0", ytd: "0" };

  test("RANGE reads the period", async () => {
    const res = await get("/api/reports/income-statement", { ...STRUCTURED, ...JUNE });
    expect(res.status).toBe(200);
    expect(Number(revenue(res.body))).toBe(200);
  });

  test("AS OF reads the calendar year to date, excluding the prior year", async () => {
    const res = await get("/api/reports/income-statement", { ...STRUCTURED, ...AS_OF_JUNE });
    expect(res.status).toBe(200);
    expect(res.body.columns[0]).toMatchObject({ from: "2026-01-01", to: "2026-06-30", label: "FOR THE PERIOD" });
    expect(Number(revenue(res.body))).toBe(300);
  });
});

describe("Balance Sheet", () => {
  const cash = (body, key) =>
    Number(body.nodes.find((n) => n.kind === "account-line" && n.accountCode === "RPT-CASH")?.values?.[key] ?? 0);
  const STRUCTURED = { view: "structured", mode: "detailed", strict: "0" };

  test("AS OF is one column of balances at the date", async () => {
    const res = await get("/api/reports/balance-sheet", { ...STRUCTURED, ...AS_OF_JUNE });
    expect(res.status).toBe(200);
    expect(res.body.columns.map((c) => c.date).filter(Boolean)).toEqual(["2026-06-30"]);
    expect(cash(res.body, "current")).toBe(350);
  });

  test("AS OF keeps an explicit Compare To", async () => {
    const res = await get("/api/reports/balance-sheet", { ...STRUCTURED, ...AS_OF_JUNE, compareTo: "2026-01-31" });
    expect(res.body.columns.map((c) => c.date).filter(Boolean)).toEqual(["2026-06-30", "2026-01-31"]);
  });

  test("RANGE shows Date To against the day before Date From, with the movement", async () => {
    const res = await get("/api/reports/balance-sheet", { ...STRUCTURED, ...JUNE, compareTo: "2020-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.columns.map((c) => c.date).filter(Boolean)).toEqual(["2026-06-30", "2026-05-31"]);
    expect(cash(res.body, "current")).toBe(350);
    expect(cash(res.body, "comparative")).toBe(150);
    expect(cash(res.body, "difference")).toBe(200);
  });
});

describe("open-item reports", () => {
  const refs = (rows) => rows.map((r) => r.referenceNo).filter((v) => v.startsWith("RPT-")).sort();

  test("AR Aging: AS OF is every document open at the date, not later ones", async () => {
    const res = await get("/api/reports/ar-aging", { ...AS_OF_JUNE, status: "OPEN" });
    expect(res.body.asOfDate).toBe("2026-06-30");
    expect(refs(res.body.rows)).toEqual(["RPT-INV-JUN", "RPT-INV-MAY"]);
  });

  test("AR Aging: RANGE is limited to documents dated in the period, aged at Date To", async () => {
    const res = await get("/api/reports/ar-aging", { ...JUNE, status: "OPEN" });
    expect(res.body.asOfDate).toBe("2026-06-30");
    expect(refs(res.body.rows)).toEqual(["RPT-INV-JUN"]);
    expect(res.body.rows.find((r) => r.referenceNo === "RPT-INV-JUN").daysOutstanding).toBe(10);
    expect(Number(res.body.bucketTotals.base.total)).toBe(2000);
  });

  test("AP Aging follows the same rule", async () => {
    expect(refs((await get("/api/reports/ap-aging", { ...AS_OF_JUNE, status: "OPEN" })).body.rows)).toEqual(["RPT-APV-JUN", "RPT-APV-MAY"]);
    expect(refs((await get("/api/reports/ap-aging", { ...JUNE, status: "OPEN" })).body.rows)).toEqual(["RPT-APV-JUN"]);
  });

  test("Aging Summaries total differently by mode", async () => {
    const balance = (body, id) => Number(body.parties.find((p) => p.partyId === id)?.baseBalance ?? 0);
    expect(balance((await get("/api/reports/ar-aging-summary", { ...AS_OF_JUNE, status: "OPEN" })).body, customerId)).toBe(3000);
    expect(balance((await get("/api/reports/ar-aging-summary", { ...JUNE, status: "OPEN" })).body, customerId)).toBe(2000);
    expect(balance((await get("/api/reports/ap-aging-summary", { ...AS_OF_JUNE, status: "OPEN" })).body, supplierId)).toBe(3000);
    expect(balance((await get("/api/reports/ap-aging-summary", { ...JUNE, status: "OPEN" })).body, supplierId)).toBe(2000);
  });

  test("Overdue lists follow the same rule", async () => {
    expect(refs((await get("/api/reports/ar-overdue-accounts", AS_OF_JUNE)).body.rows)).toEqual(["RPT-INV-JUN", "RPT-INV-MAY"]);
    expect(refs((await get("/api/reports/ar-overdue-accounts", JUNE)).body.rows)).toEqual(["RPT-INV-JUN"]);
    expect(refs((await get("/api/reports/ap-overdue-accounts", AS_OF_JUNE)).body.rows)).toEqual(["RPT-APV-JUN", "RPT-APV-MAY"]);
    expect(refs((await get("/api/reports/ap-overdue-accounts", JUNE)).body.rows)).toEqual(["RPT-APV-JUN"]);
  });
});

describe("Daily Cash Position", () => {
  const acct = (body) => body.accounts.find((a) => a.accountCode === "RPT-CASH");

  test("AS OF is that day's movement", async () => {
    const body = (await get("/api/reports/daily-cash-position", { dateMode: "asof", asOf: "2026-06-15" })).body;
    expect(body.asOfDate).toBe("2026-06-15");
    expect(acct(body)).toMatchObject({ beginningBalance: 150, cashReceipts: 200, endingBalance: 350 });
  });

  test("RANGE is the movement across the period", async () => {
    const body = (await get("/api/reports/daily-cash-position", { dateMode: "range", from: "2026-06-01", to: "2026-07-31" })).body;
    expect(body.asOfDate).toBe("2026-07-31");
    expect(acct(body)).toMatchObject({ beginningBalance: 150, cashReceipts: 600, endingBalance: 750 });
  });
});

describe("registers", () => {
  const assets = (body) => body.map((r) => r.assetCode).filter((c) => c.startsWith("RPT-")).sort();
  const prepaids = (body) => body.map((r) => r.prepaidCode).filter((c) => c.startsWith("RPT-")).sort();

  test("Fixed Asset Register: RANGE lists assets acquired in the period, valued at Date To", async () => {
    const asOf = (await get("/api/reports/fixed-asset-register", AS_OF_JUNE)).body;
    expect(assets(asOf)).toEqual(["RPT-FA-JAN", "RPT-FA-JUN"]);
    const range = (await get("/api/reports/fixed-asset-register", JUNE)).body;
    expect(assets(range)).toEqual(["RPT-FA-JUN"]);
  });

  test("Fixed Asset Register: AS OF values assets at the date", async () => {
    const at = async (asOf) =>
      Number((await get("/api/reports/fixed-asset-register", { dateMode: "asof", asOf })).body.find((r) => r.assetCode === "RPT-FA-JAN").accumulatedDepreciation);
    expect(await at("2026-06-30")).toBeLessThan(await at("2026-09-30"));
  });

  test.each([["/api/reports/prepaid-list"], ["/api/reports/prepayment-lapsing"]])("%s: RANGE lists prepayments started in the period", async (path) => {
    expect(prepaids((await get(path, AS_OF_JUNE)).body)).toEqual(["RPT-PP-JAN", "RPT-PP-JUN"]);
    expect(prepaids((await get(path, JUNE)).body)).toEqual(["RPT-PP-JUN"]);
  });

  test("Lapsed Prepayments answers both modes", async () => {
    expect((await get("/api/reports/lapsed-prepayments", AS_OF_JUNE)).status).toBe(200);
    expect((await get("/api/reports/lapsed-prepayments", JUNE)).status).toBe(200);
  });

  test("Prepaid Subsidiary: RANGE narrows the schedule, AS OF keeps all of it", async () => {
    const asOf = (await get("/api/reports/prepaid-subsidiary", { ...AS_OF_JUNE, prepaidId })).body;
    expect(asOf.schedule).toHaveLength(12);
    const range = (await get("/api/reports/prepaid-subsidiary", { ...JUNE, prepaidId })).body;
    expect(range.schedule.map((s) => s.period)).toEqual(["2026-06"]);
  });
});
