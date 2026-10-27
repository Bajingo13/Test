// Account Analysis company context: GET /api/reports/account-analysis
// resolves the company like the Trial Balance it is opened from
// (TrialBalanceCheckerService.resolveSelectedCompany) - an explicit,
// validated companyId, or the user's ONLY company. A Super Admin or
// multi-company user without a companyId gets 400 (never the first/lowest
// company); a company outside the user's access gets 403; malformed or
// unknown ids get 400. The drill-down link itself is covered by
// utils/__tests__/accountAnalysisCompany.test.js.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "aacc-";
const PASSWORD = "AaccPass!1";
const RANGE = { from: "2087-01-01", to: "2087-12-31" };
const ACCOUNT = "AACCDR";
const UNKNOWN_ID = 2147483000;

const co = {};
const users = [];
const tokens = {};
const jvIds = [];
let accounts = {};

async function makeUser(tag, roleId, companyIds = []) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [u] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [`${P}${tag}`, hash, roleId]);
  for (const c of companyIds) await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [u.insertId, c]);
  users.push(u.insertId);
  const res = await request(app).post("/api/login").send({ username: `${P}${tag}`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${tag}: ${res.status}`);
  tokens[tag] = res.body.token;
}

async function postedJv(companyId, amount) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, reference_no, prepared_for, description, remarks, total_debit, total_credit, status)
     VALUES (?, ?, '2087-06-15', ?, '', 'aacc', '', ?, ?, 'Posted')`,
    [companyId, `AACC-${companyId}`, `AACC-REF-${companyId}`, amount, amount]
  );
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'AACCDR', 'AACC Dr', '', ?, 0)", [h.insertId, accounts.dr, amount]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'AACCCR', 'AACC Cr', '', 0, ?)", [h.insertId, accounts.cr, amount]);
  jvIds.push(h.insertId);
}

const analysis = (who, query = {}) =>
  request(app).get("/api/reports/account-analysis").query({ ...RANGE, accountCode: ACCOUNT, ...query }).set("Authorization", `Bearer ${tokens[who]}`);
const trialBalance = (who, query = {}) =>
  request(app).get("/api/reports/trial-balance").query({ ...RANGE, ...query }).set("Authorization", `Bearer ${tokens[who]}`);
const totalDebit = (rows) => rows.reduce((s, r) => s + Number(r.debit || 0), 0);

beforeAll(async () => {
  assertNotProductionDatabase();
  // Decoy first: the lowest company id of this suite, assigned to nobody.
  for (const tag of ["Decoy", "A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`AACC Co ${tag}`]);
    co[tag] = c.insertId;
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('AACCDR', 'AACCCR')");
  const [dr] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('AACCDR', CURDATE(), 'AACC Dr', 'EXPENSE')");
  const [cr] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('AACCCR', CURDATE(), 'AACC Cr', 'LIABILITY')");
  accounts = { dr: dr.insertId, cr: cr.insertId };
  await postedJv(co.Decoy, 999);
  await postedJv(co.A, 100);
  await postedJv(co.B, 250);

  const [roleRows] = await pool.execute("SELECT id, code FROM roles");
  const roles = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
  await makeUser("super", roles.SUPER_ADMIN);
  await makeUser("adminA", roles.ADMIN, [co.A]);
  await makeUser("multi", roles.ADMIN, [co.A, co.B]);
});

afterAll(async () => {
  const companies = [co.Decoy, co.A, co.B].filter(Boolean);
  try {
    if (jvIds.length) {
      await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds]);
      await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('AACCDR', 'AACCCR')");
    if (users.length) {
      await pool.query("DELETE FROM audit_logs WHERE user_id IN (?)", [users]);
      await pool.query("DELETE FROM user_companies WHERE user_id IN (?)", [users]);
      await pool.query("DELETE FROM users WHERE id IN (?)", [users]);
    }
    if (companies.length) {
      await pool.query("DELETE FROM audit_logs WHERE company_id IN (?)", [companies]);
      await pool.query("DELETE FROM companies WHERE id IN (?)", [companies]);
    }
  } finally {
    await pool.end();
  }
});

describe("single-company user", () => {
  test("companyId may be omitted - their only company is used", async () => {
    const res = await analysis("adminA");
    expect(res.status).toBe(200);
    expect(totalDebit(res.body)).toBe(100);
  });

  test("their own company explicitly -> allowed; another company -> 403 without its data", async () => {
    expect(totalDebit((await analysis("adminA", { companyId: co.A })).body)).toBe(100);
    const cross = await analysis("adminA", { companyId: co.B });
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toMatch(/AACC-REF|250/);
  });
});

describe("multi-company user", () => {
  test("missing companyId -> 400 (no first-company fallback)", async () => {
    const res = await analysis("multi");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Select a company to continue/);
    expect(JSON.stringify(res.body)).not.toMatch(/AACC-REF/);
  });

  test("Company A stays A, Company B stays B; an unassigned company is 403", async () => {
    const a = await analysis("multi", { companyId: co.A });
    expect(a.status).toBe(200);
    expect(totalDebit(a.body)).toBe(100);
    expect(a.body.every((r) => r.reference_no !== `AACC-REF-${co.B}`)).toBe(true);
    const b = await analysis("multi", { companyId: co.B });
    expect(totalDebit(b.body)).toBe(250);
    expect((await analysis("multi", { companyId: co.Decoy })).status).toBe(403);
  });
});

describe("Super Admin", () => {
  test("missing companyId -> 400, never the lowest company's ledger", async () => {
    const res = await analysis("super");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/AACC-REF|999/);
  });

  test("explicit A -> A, explicit B -> B", async () => {
    expect(totalDebit((await analysis("super", { companyId: co.A })).body)).toBe(100);
    expect(totalDebit((await analysis("super", { companyId: co.B })).body)).toBe(250);
  });
});

describe("malformed / unknown companyId", () => {
  test.each([["abc"], ["1 OR 1=1"], ["-5"], ["0"], [String(UNKNOWN_ID)]])("companyId=%s -> 400", async (companyId) => {
    const res = await analysis("super", { companyId });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/AACC-REF/);
  });

  test("missing accountCode is still 400 (unchanged)", async () => {
    const res = await request(app).get("/api/reports/account-analysis").query({ ...RANGE, companyId: co.A }).set("Authorization", `Bearer ${tokens.super}`);
    expect(res.status).toBe(400);
  });
});

describe("Trial Balance -> Account Analysis with the same companyId", () => {
  test.each([["A", 100], ["B", 250]])("Company %s: the Account Analysis total matches that company's Trial Balance line", async (tag, amount) => {
    const tb = await trialBalance("multi", { companyId: co[tag] });
    const tbLine = tb.body.find((r) => r.account_code === ACCOUNT);
    expect(Number(tbLine.debit)).toBe(amount);
    const aa = await analysis("multi", { companyId: co[tag] });
    expect(totalDebit(aa.body)).toBe(amount);
  });
});
