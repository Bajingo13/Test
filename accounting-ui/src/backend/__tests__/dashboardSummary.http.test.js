// GET /api/dashboard/summary - the dashboard is a view over the report
// services: every figure must equal what the matching report returns for the
// same company and period, sections are gated server-side on the report
// permissions, company scope is enforced, and a failure is reported as an
// error, never as zero. Local test database only.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const AgingReportService = require("../services/agingReportService");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "dash-";
const ACC = "DASH-";
const GRP = "DASHG-";
const PASSWORD = "DashPass!1";

const co = {};
const cur = {};
const acc = {};
const users = {};
const tokens = {};
let bankId;

async function makeUser(tag, roleCode, companyIds = [], overrides = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, (SELECT id FROM roles WHERE code = ?), 'ACTIVE')",
    [`${P}${tag}`, hash, roleCode]
  );
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  for (const [moduleKey, action, granted] of overrides) {
    await pool.execute(
      `INSERT INTO user_permissions (user_id, permission_id, granted, reason)
       SELECT ?, id, ?, 'dashboard test' FROM permissions WHERE module_key = ? AND action = ?`,
      [u.insertId, granted, moduleKey, action]
    );
  }
  users[tag] = u.insertId;
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function account(key, title, cls, group, section) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [`${ACC}${key}`, title, cls]
  );
  acc[key] = { id: r.insertId, code: `${ACC}${key}` };
  await pool.execute(
    `INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status)
     VALUES (?, ?, ?, ?, 10, 'ACTIVE')`,
    [`${GRP}${key}`, `${title} group`, cls, section]
  );
  await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [r.insertId, `${GRP}${key}`, `${title} group`]);
}

async function jv(companyId, voucherNo, date, dr, cr, amount, status = "Posted") {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'dashboard test', ?, ?, ?)`,
    [companyId, voucherNo, date, amount, amount, status]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, 0)",
    [h.insertId, acc[dr].id, acc[dr].code, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, ?)",
    [h.insertId, acc[cr].id, acc[cr].code, amount]
  );
}

async function invoice(companyId, voucherNo, date, due, amount, customer = "Dash Customer One") {
  await pool.execute(
    `INSERT INTO invoice_headers (company_id, voucher_no, customer_id, customer_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, 'Unpaid', 'Posted')`,
    [companyId, voucherNo, customer, date, due, amount, amount]
  );
}

async function apv(companyId, voucherNo, date, due, amount, status = "Posted") {
  await pool.execute(
    `INSERT INTO apv_headers (company_id, voucher_no, supplier_id, supplier_name, transaction_date, due_date, total_debit, total_credit, paid_amount, balance_amount, payment_status, status)
     VALUES (?, ?, NULL, 'Dash Supplier', ?, ?, 0, ?, 0, ?, 'Unpaid', ?)`,
    [companyId, voucherNo, date, due, amount, amount, status]
  );
}

const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const summary = (who, query) => request(app).get("/api/dashboard/summary").query(query).set(auth(who));
const A = (extra = {}) => ({ companyId: String(co.A), from: "2096-01-01", to: "2096-02-28", ...extra });

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const [tag, code] of [["A", "PHP"], ["B", "USD"], ["C", "PHP"]]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'ACTIVE')", [`${P}Co ${tag}`]);
    co[tag] = c.insertId;
    const [k] = await pool.execute(
      "INSERT INTO currencies (company_id, currency_code, currency_name, currency_symbol, is_base_currency, is_active) VALUES (?, ?, ?, ?, 1, 1)",
      [co[tag], code, code, code === "PHP" ? "₱" : "$"]
    );
    cur[tag] = k.insertId;
  }

  await account("BANK", "Dash Cash in Bank", "ASSET", "BANK", "CURRENT_ASSET");
  await account("AR", "Dash Receivable", "ASSET", "AR", "CURRENT_ASSET");
  await account("AP", "Dash Payable", "LIABILITY", "AP", "CURRENT_LIABILITY");
  await account("EQ", "Dash Capital", "EQUITY", "EQ", "EQUITY");
  await account("REV", "Dash Sales", "INCOME", "REV", "REVENUE");
  await account("EXP", "Dash Rent", "EXPENSE", "EXP", "OPERATING_EXPENSE");
  const [b] = await pool.execute(
    "INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, coa_account_id, coa_code, status) VALUES (?, 'Dash Bank', '000123456789', 'Dash Operating', ?, ?, 'ACTIVE')",
    [`${P}BANK`, acc.BANK.id, acc.BANK.code]
  );
  bankId = b.insertId;

  // Company A
  await jv(co.A, `${P}A-OPEN`, "2095-12-31", "BANK", "EQ", 2000);
  await jv(co.A, `${P}A-1`, "2096-01-10", "BANK", "REV", 1000);
  await jv(co.A, `${P}A-2`, "2096-02-15", "EXP", "BANK", 300);
  await jv(co.A, `${P}A-3`, "2096-02-20", "BANK", "REV", 500);
  await jv(co.A, `${P}A-DRAFT`, "2096-02-25", "BANK", "REV", 9999, "Draft");
  await jv(co.A, `${P}A-VOID`, "2096-02-26", "BANK", "REV", 7777, "Void");
  await invoice(co.A, `${P}A-INV-OVERDUE`, "2096-01-05", "2096-02-01", 700);
  await invoice(co.A, `${P}A-INV-SOON`, "2096-02-20", "2096-03-03", 250, "Dash Customer Two");
  await apv(co.A, `${P}A-APV-1`, "2096-01-20", "2096-02-10", 400);
  await apv(co.A, `${P}A-APV-DRAFT`, "2096-02-21", "2096-03-31", 90, "Draft");
  // Company B - must never reach Company A's figures
  await jv(co.B, `${P}B-1`, "2096-01-15", "BANK", "REV", 50000);
  await invoice(co.B, `${P}B-INV`, "2096-01-05", "2096-01-20", 8888);

  await makeUser("super", "SUPER_ADMIN");
  await makeUser("acctA", "ACCOUNTANT", [co.A], [["REPORTS.FINANCIAL", "VIEW", 1], ["REPORTS.AR", "VIEW", 1], ["REPORTS.AP", "VIEW", 1]]);
  await makeUser("acctAB", "ACCOUNTANT", [co.A, co.B], [["REPORTS.FINANCIAL", "VIEW", 1]]);
  await makeUser("noDash", "ACCOUNTANT", [co.A], [["DASHBOARD", "VIEW", 0]]);
  await makeUser("noFin", "ACCOUNTANT", [co.A], [["REPORTS.FINANCIAL", "VIEW", 0], ["REPORTS.AR", "VIEW", 1], ["REPORTS.AP", "VIEW", 0]]);
  await makeUser("noJv", "ACCOUNTANT", [co.A], [["TRANSACTIONS.JV", "VIEW", 0]]);
  await makeUser("auditA", "ADMIN", [co.A], [["ADMIN.AUDIT_LOGS", "VIEW", 1]]);
  await makeUser("adminA", "ADMIN", [co.A]);
  await makeUser("noActivity", "ACCOUNTANT", [co.A], [["DASHBOARD.ACTIVITY", "VIEW", 0]]);

  // One record in each of the other transaction modules (Company A), plus a
  // Company B memo that must never show for A.
  await pool.execute("INSERT INTO petty_cash_headers (company_id, voucher_no, payee_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'Dash Payee', '2096-02-22', 75, 75, 'Draft')", [co.A, `${P}A-PCV`]);
  await pool.execute("INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'DEBIT', 'Dash Customer One', '2096-02-23', 60, 60, 'Draft')", [co.A, `${P}A-DM`]);
  await pool.execute("INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'CREDIT', 'Dash Customer One', '2096-02-23', 40, 40, 'Draft')", [co.A, `${P}A-CM`]);
  await pool.execute("INSERT INTO purchase_order_headers (company_id, voucher_no, supplier_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'Dash Supplier', '2096-02-24', 500, 500, 'Open')", [co.A, `${P}A-PO`]);
  await pool.execute("INSERT INTO rfp_headers (company_id, rfp_no, rfp_date, requester_user_id, supplier_name, total_amount, status) VALUES (?, ?, '2096-02-24', ?, 'Dash Supplier', 120, 'SUBMITTED')", [co.A, `${P}A-RFP`, users.acctA]);
  await pool.execute("INSERT INTO quotation_headers (company_id, quotation_no, customer_name, quotation_date, status, total_amount) VALUES (?, ?, 'Dash Customer One', '2096-02-25', 'Draft', 900)", [co.A, `${P}A-QUO`]);
  await pool.execute("INSERT INTO memo_headers (company_id, voucher_no, memo_type, party_name, transaction_date, total_debit, total_credit, status) VALUES (?, ?, 'DEBIT', 'B customer', '2096-02-23', 1, 1, 'Draft')", [co.B, `${P}B-DM`]);
});

afterAll(async () => {
  const companies = Object.values(co);
  const userIds = Object.values(users);
  try {
    if (companies.length) {
      await pool.query("DELETE ln FROM jv_lines ln JOIN jv_headers h ON h.id = ln.jv_id WHERE h.company_id IN (?)", [companies]);
      await pool.query("DELETE FROM jv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM invoice_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM apv_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM petty_cash_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM memo_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM purchase_order_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM rfp_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM quotation_headers WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM currencies WHERE company_id IN (?)", [companies]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_permissions WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [userIds]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [userIds]);
    }
    if (bankId) await pool.query("DELETE FROM bank_codes WHERE id = ?", [bankId]);
    if (companies.length) await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    await pool.query(`DELETE FROM coa_groups WHERE group_code LIKE '${GRP}%'`);
    await pool.query(`DELETE FROM account_group_codes WHERE group_code LIKE '${GRP}%'`);
    await pool.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${ACC}%'`);
  } finally {
    await pool.end();
  }
});

describe("access and validation", () => {
  test("no token -> 401; DASHBOARD VIEW denied -> 403", async () => {
    expect((await request(app).get("/api/dashboard/summary").query(A())).status).toBe(401);
    expect((await summary("noDash", A())).status).toBe(403);
  });

  test.each([
    [{ from: undefined }, /from/],
    [{ to: "2096-02-30" }, /valid date/],
    [{ from: "2096-03-01" }, /on or before/],
    [{ from: "2080-01-01" }, /five years/],
    [{ companyId: "1; DROP TABLE x" }, /companyId/],
  ])("bad period / company %p -> 400", async (extra, message) => {
    const q = A(extra);
    for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
    const res = await summary("acctA", q);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  test("Super Admin must choose a company (no first/lowest-company default)", async () => {
    const res = await summary("super", { from: "2096-01-01", to: "2096-02-28" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/companyId is required/);
  });

  test("a user with several companies must choose; a user with one gets it", async () => {
    expect((await summary("acctAB", { from: "2096-01-01", to: "2096-02-28" })).status).toBe(400);
    const res = await summary("acctA", { from: "2096-01-01", to: "2096-02-28" });
    expect(res.status).toBe(200);
    expect(res.body.meta.companyId).toBe(co.A);
  });

  test("another company's dashboard is refused server-side", async () => {
    const res = await summary("acctA", A({ companyId: String(co.B) }));
    expect(res.status).toBe(403);
  });
});

describe("figures equal the reports for the same company and period", () => {
  let body;
  beforeAll(async () => {
    const res = await summary("acctA", A());
    expect(res.status).toBe(200);
    body = res.body;
  });

  test("meta: company, base currency, period, granularity", () => {
    expect(body.meta).toMatchObject({ companyId: co.A, companyName: `${P}Co A`, currency: { code: "PHP" }, from: "2096-01-01", to: "2096-02-28", granularity: "week" });
  });

  test("revenue and net income: posted only, Company A only, equal to the Income Statement", async () => {
    expect(body.sections.income).toMatchObject({ status: "ok", revenue: 1500, netIncome: 1200, netMargin: 80 });
    const is = await request(app)
      .get("/api/reports/income-statement")
      .query({ view: "structured", mode: "condensed", from: "2096-01-01", to: "2096-02-28", ytd: "0", comparePrev: "0", companyId: String(co.A) })
      .set(auth("acctA"));
    expect(is.status).toBe(200);
    expect(body.sections.income.revenue).toBe(is.body.sectionSubtotals.REVENUE.current);
    expect(body.sections.income.netIncome).toBe(is.body.computed.NET_INCOME.current);
  });

  // Buckets are contiguous Monday-Sunday weeks clipped to the period, so
  // together they cover exactly [from, to] and sum to the period total.
  function expectCoverage(series, from, to) {
    expect(series[0].from).toBe(from);
    expect(series.at(-1).to).toBe(to);
    for (let i = 1; i < series.length; i++) {
      const prev = new Date(`${series[i - 1].to}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + 1);
      expect(series[i].from).toBe(prev.toISOString().slice(0, 10));
    }
  }
  const sum = (list, key) => Math.round(list.reduce((t, p) => t + p[key], 0) * 100) / 100;

  test("revenue chart: weekly buckets covering the period and summing to the totals", () => {
    const s = body.sections.income.series;
    expectCoverage(s, "2096-01-01", "2096-02-28");
    expect(s[0]).toEqual({ from: "2096-01-01", to: "2096-01-01", revenue: 0, netIncome: 0 }); // a Sunday
    expect(sum(s, "revenue")).toBe(1500);
    expect(sum(s, "netIncome")).toBe(1200);
    expect(s.find((p) => p.from <= "2096-01-10" && p.to >= "2096-01-10")).toMatchObject({ revenue: 1000 });
  });

  test("cash: the bank balance and flows equal the Daily Cash Position report", async () => {
    const cash = body.sections.cash;
    const mine = cash.accounts.find((a) => a.id === bankId);
    expect(mine).toMatchObject({ name: "Dash Operating", bankName: "Dash Bank", accountNoLast4: "6789", accountType: "ASSET", balance: 3200 });
    expect(JSON.stringify(cash.accounts)).not.toContain("000123456789");
    const dcp = await request(app).get("/api/reports/daily-cash-position").query({ from: "2096-01-01", to: "2096-02-28", companyId: String(co.A) }).set(auth("acctA"));
    expect(dcp.status).toBe(200);
    const row = dcp.body.accounts.find((a) => a.accountCode === acc.BANK.code);
    expect(row).toMatchObject({ beginningBalance: 2000, cashReceipts: 1500, cashDisbursements: 300, endingBalance: 3200 });
    expect(cash.openingBalance).toBe(dcp.body.totalBeginningBalance);
    expect(cash.inflows).toBe(dcp.body.totalCashReceipts);
    expect(cash.outflows).toBe(dcp.body.totalCashDisbursements);
    expect(cash.endingBalance).toBe(dcp.body.totalEndingBalance);
    expectCoverage(cash.series, "2096-01-01", "2096-02-28");
    expect(sum(cash.series, "inflows")).toBe(1500);
    expect(sum(cash.series, "outflows")).toBe(300);
  });

  test("account overview equals the Balance Sheet", async () => {
    const bs = await request(app).get("/api/reports/balance-sheet").query({ view: "structured", mode: "condensed", to: "2096-02-28", companyId: String(co.A) }).set(auth("acctA"));
    expect(bs.status).toBe(200);
    const key = bs.body.columns[0].key;
    expect(body.sections.balance).toMatchObject({
      status: "ok",
      totalAssets: bs.body.computed.TOTAL_ASSETS[key],
      totalLiabilities: bs.body.computed.TOTAL_LIABILITIES[key],
      totalEquity: bs.body.computed.TOTAL_SHAREHOLDERS_EQUITY[key],
      balanced: bs.body.balanceCheck.balanced,
    });
    expect(body.sections.balance.totalAssets).toBe(3200);
  });

  test("receivables equal AR Aging as of the period end", async () => {
    const ar = await request(app).get("/api/reports/ar-aging").query({ asOf: "2096-02-28", companyId: String(co.A) }).set(auth("acctA"));
    expect(ar.status).toBe(200);
    const r = body.sections.receivables;
    expect(r.total).toBe(ar.body.bucketTotals.base.total);
    expect(r).toMatchObject({ total: 950, documentCount: 2, overdue: 700, overdueCount: 1, dueSoon: 250, dueSoonCount: 1 });
    expect(r.topParties.map((p) => p.partyName)).toEqual(["Dash Customer One", "Dash Customer Two"]);
    expect(r.largestOverdue).toMatchObject({ partyName: "Dash Customer One", balance: 700, daysOverdue: 27 });
  });

  test("payables equal AP Aging (Posted APVs only - the 90 Draft APV is not a payable)", async () => {
    const ap = await request(app).get("/api/reports/ap-aging").query({ asOf: "2096-02-28", companyId: String(co.A) }).set(auth("acctA"));
    expect(ap.status).toBe(200);
    expect(body.sections.payables.total).toBe(ap.body.bucketTotals.base.total);
    expect(body.sections.payables).toMatchObject({ total: 400, overdue: 400, overdueCount: 1, documentCount: 1 });
  });

  test("workflow counts, transactions and alerts come from Company A's records", () => {
    expect(body.sections.workflow).toMatchObject({ status: "ok", draftApv: { count: 1, amount: 90 } });
    const vouchers = body.sections.transactions.items.map((t) => t.voucherNo);
    // The latest 8 records across modules, newest first, Company A only.
    expect(vouchers.length).toBeGreaterThan(0);
    expect(vouchers.length).toBeLessThanOrEqual(8);
    expect(vouchers.every((v) => v.startsWith(`${P}A-`))).toBe(true);
    const times = body.sections.transactions.items.map((t) => t.touchedAt);
    expect([...times].sort().reverse()).toEqual(times);
    const texts = body.alerts.map((a) => a.text).join(" | ");
    expect(texts).toMatch(/1 receivable document\(s\) overdue/);
    expect(texts).toMatch(/1 payable document\(s\) past due/);
    expect(texts).toMatch(/1 APV draft\(s\) not yet posted/);
    expect(body.alerts.every((a) => typeof a.link === "string" && a.link.startsWith("/"))).toBe(true);
  });
});

describe("the period filter changes the figures", () => {
  test("January only", async () => {
    const res = await summary("acctA", A({ from: "2096-01-01", to: "2096-01-31" }));
    expect(res.body.sections.income).toMatchObject({ revenue: 1000, netIncome: 1000 });
    expect(res.body.sections.cash.accounts.find((a) => a.id === bankId).balance).toBe(3000);
    expect(res.body.meta.granularity).toBe("week");
    expect(res.body.sections.income.series[0]).toMatchObject({ from: "2096-01-01", to: "2096-01-01" });
    expect(res.body.sections.income.series.at(-1).to).toBe("2096-01-31");
  });

  test("six months use monthly buckets", async () => {
    const res = await summary("acctA", A({ from: "2096-01-01", to: "2096-06-30" }));
    expect(res.body.meta.granularity).toBe("month");
    expect(res.body.sections.income.series.map((p) => [p.from, p.to, p.revenue])).toEqual([
      ["2096-01-01", "2096-01-31", 1000],
      ["2096-02-01", "2096-02-29", 500],
      ["2096-03-01", "2096-03-31", 0],
      ["2096-04-01", "2096-04-30", 0],
      ["2096-05-01", "2096-05-31", 0],
      ["2096-06-01", "2096-06-30", 0],
    ]);
  });

  test("one day uses one daily bucket", async () => {
    const res = await summary("acctA", A({ from: "2096-02-15", to: "2096-02-15" }));
    expect(res.body.meta.granularity).toBe("day");
    expect(res.body.sections.income.series).toEqual([{ from: "2096-02-15", to: "2096-02-15", revenue: 0, netIncome: -300 }]);
  });
});

describe("other companies and empty data", () => {
  test("Super Admin sees Company B in B's own base currency, never A's records", async () => {
    const res = await summary("super", A({ companyId: String(co.B) }));
    expect(res.status).toBe(200);
    expect(res.body.meta.currency.code).toBe("USD");
    expect(res.body.sections.income.revenue).toBe(50000);
    expect(res.body.sections.receivables.total).toBe(8888);
  });

  test("a company with no records: zeros and empty lists, not errors", async () => {
    const res = await summary("super", A({ companyId: String(co.C) }));
    expect(res.status).toBe(200);
    const s = res.body.sections;
    expect(s.income).toMatchObject({ status: "ok", revenue: 0, netIncome: 0, netMargin: null });
    expect(s.receivables).toMatchObject({ status: "ok", total: 0, documentCount: 0, topParties: [] });
    expect(s.payables).toMatchObject({ status: "ok", total: 0, documentCount: 0 });
    expect(s.transactions).toMatchObject({ status: "ok", items: [] });
    expect(s.cash.accounts.find((a) => a.id === bankId).balance).toBe(0);
    expect(res.body.alerts.filter((a) => /receivable|payable|draft/i.test(a.text))).toEqual([]);
  });
});

describe("permissions are enforced per section on the server", () => {
  test("without REPORTS.FINANCIAL / REPORTS.AP: those sections are withheld, AR still shown", async () => {
    const res = await summary("noFin", A());
    expect(res.status).toBe(200);
    const s = res.body.sections;
    expect(s.income).toEqual({ status: "forbidden" });
    expect(s.balance).toEqual({ status: "forbidden" });
    expect(s.cash).toEqual({ status: "forbidden" });
    expect(s.payables).toEqual({ status: "forbidden" });
    expect(s.receivables.status).toBe("ok");
    expect(JSON.stringify(res.body)).not.toMatch(/"revenue"|"netIncome"|"endingBalance"/);
  });

  test("recent transactions leave out modules the user cannot view", async () => {
    const res = await summary("noJv", A());
    expect(res.body.sections.transactions.modules).not.toContain("JV");
    expect(res.body.sections.transactions.items.some((t) => t.type === "JV")).toBe(false);
  });

  test("recent transactions cover petty cash, memos, PO, RFP and quotations - latest records, Company A only", async () => {
    const res = await summary("super", A());
    const t = res.body.sections.transactions;
    expect(t.scope).toBe("latest");
    expect(t.modules).toEqual(expect.arrayContaining(["INV", "OR", "APV", "CV", "JV", "PCV", "DM", "CM", "PO", "RFP", "QUO"]));
    const byNo = Object.fromEntries(t.items.map((x) => [x.voucherNo, x]));
    expect(byNo[`${P}A-QUO`]).toMatchObject({ type: "QUO", amount: 900, link: "/transactions/quotation" });
    expect(byNo[`${P}A-RFP`]).toMatchObject({ type: "RFP", amount: 120, status: "SUBMITTED", transactionDate: "2096-02-24" });
    expect(byNo[`${P}A-RFP`].link).toMatch(/^\/transactions\/rfp\?id=\d+$/);
    expect(t.items.some((x) => x.voucherNo === `${P}B-DM`)).toBe(false);
    // Not period-filtered: a period that ends before every record still lists them.
    const early = await summary("super", A({ from: "2095-01-01", to: "2095-01-31" }));
    expect(early.body.sections.transactions.items.map((x) => x.voucherNo)).toEqual(t.items.map((x) => x.voucherNo));
  });

  test("each new module needs its own VIEW permission", async () => {
    const all = await summary("super", A());
    const memo = all.body.sections.transactions.items.find((x) => x.type === "DM" || x.type === "CM");
    expect(memo).toBeDefined();
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'TRANSACTIONS.DEBIT_CREDIT_MEMO' AND action = 'VIEW'");
    await pool.execute("INSERT INTO user_permissions (user_id, permission_id, granted, reason) VALUES (?, ?, 0, 'dashboard test')", [users.noJv, perm.id]);
    const res = await summary("noJv", A());
    expect(res.body.sections.transactions.modules).not.toEqual(expect.arrayContaining(["DM"]));
    expect(res.body.sections.transactions.items.some((x) => x.type === "DM" || x.type === "CM")).toBe(false);
  });

  describe("activity timeline", () => {
    beforeAll(async () => {
      const ins = (module, entityType, entityId, action, description, companyId, userId) =>
        pool.execute(
          "INSERT INTO audit_logs (module, entity_type, entity_id, action, description, company_id, user_id, before_data, after_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [module, entityType, entityId, action, description, companyId, userId, JSON.stringify({ secret: "before" }), JSON.stringify({ secret: "after" })]
        );
      await ins("TRANSACTIONS.JV", "JV", 1, "POST", "dash A jv event", co.A, users.adminA);
      await ins("TRANSACTIONS", "APV", 2, "CREATE", "dash A apv event", co.A, users.adminA);
      await ins("TRANSACTIONS.RFP", "RFP", 3, "SUBMIT", "dash A rfp event", co.A, users.acctA);
      await ins("AUTH", "LOGIN", null, "LOGIN_SUCCESS", "dash A login event", co.A, users.acctA);
      await ins("ACCESS_CONTROL", "PERMISSION", null, "ACCESS_DENIED", "dash A access event", co.A, users.acctA);
      await ins("ADMIN.USERS", "USER", 9, "UPDATE", "dash A user admin event", co.A, users.adminA);
      await ins("TRANSACTIONS.JV", "JV", 4, "POST", "dash B jv event", co.B, users.super);
    });

    const descriptions = (res) => res.body.sections.activity.items.map((i) => i.description);

    test("Accountant (default DASHBOARD.ACTIVITY) sees the company's transaction activity", async () => {
      const res = await summary("acctA", A());
      expect(res.body.sections.activity.status).toBe("ok");
      expect(res.body.sections.activity.scope).toBe("latest");
      expect(descriptions(res)).toEqual(expect.arrayContaining(["dash A jv event", "dash A apv event", "dash A rfp event"]));
    });

    test("Admin (default DASHBOARD.ACTIVITY, no Audit Logs) sees it too", async () => {
      const res = await summary("adminA", A());
      expect(res.body.sections.activity.status).toBe("ok");
      expect(descriptions(res)).toContain("dash A jv event");
    });

    test("never sign-in, access-control or user-admin events, never before/after data, never another company", async () => {
      for (const who of ["acctA", "adminA", "auditA", "super"]) {
        const res = await summary(who, A());
        const d = descriptions(res);
        expect(d).not.toEqual(expect.arrayContaining(["dash A login event"]));
        expect(d).not.toContain("dash A access event");
        expect(d).not.toContain("dash A user admin event");
        expect(d).not.toContain("dash B jv event");
        expect(JSON.stringify(res.body.sections.activity)).not.toMatch(/before_data|after_data|beforeData|afterData|secret/);
      }
    });

    test("events about a module the user cannot view are left out", async () => {
      const res = await summary("noJv", A());
      expect(descriptions(res)).not.toContain("dash A jv event");
      expect(descriptions(res)).toContain("dash A apv event");
    });

    test("DASHBOARD.ACTIVITY denied and no Audit Logs -> withheld; Audit Logs alone still works", async () => {
      expect((await summary("noActivity", A())).body.sections.activity).toEqual({ status: "forbidden" });
      const audit = await summary("auditA", A());
      expect(audit.body.sections.activity.status).toBe("ok");
      expect(descriptions(audit)).toContain("dash A jv event");
    });

    test("ADMIN.AUDIT_LOGS itself was not widened: Admin and Accountant still cannot open the Audit Logs API", async () => {
      expect((await request(app).get("/api/audit-logs").set(auth("adminA"))).status).toBe(403);
      expect((await request(app).get("/api/audit-logs").set(auth("acctA"))).status).toBe(403);
    });
  });
});

describe("failures are reported as errors, never as zero", () => {
  test("one failing section does not blank the others or leak internals", async () => {
    const spy = jest.spyOn(AgingReportService, "getAgingRows").mockRejectedValueOnce(new Error("SELECT secret FROM somewhere"));
    try {
      const res = await summary("acctA", A());
      expect(res.status).toBe(200);
      const failed = [res.body.sections.receivables, res.body.sections.payables].filter((s) => s.status === "error");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toEqual({ status: "error", message: "Unable to load this data." });
      expect(res.body.sections.income).toMatchObject({ status: "ok", revenue: 1500 });
      expect(JSON.stringify(res.body)).not.toContain("secret");
    } finally {
      spy.mockRestore();
    }
  });
});
