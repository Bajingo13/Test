// Account Analysis consumers (Phase 8): the company each entry point hands
// to Account Analysis, checked at the API boundary.
//  - Balance Sheet / Income Statement drill-downs use model.meta.companyId,
//    the company the server built the displayed statement for.
//  - Input VAT calls the Account Analysis endpoint with its selected
//    companyId.
//  - Source-transaction views (GET /api/<module>/:id) already validate a
//    supplied companyId; another company's transaction is never returned.
//  - The account list (/api/coa) is global by design (chart_of_accounts has
//    no company column) - documented, not changed.
// Strict company resolution of the Account Analysis endpoint itself is
// covered by accountAnalysisCompanyContext.http.test.js.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "aacs-";
const PASSWORD = "AacsPass!1";
const UNKNOWN_ID = 2147483000;

const co = {};
const users = [];
const tokens = {};
const jv = {};
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
     VALUES (?, ?, '2086-06-15', ?, '', 'aacs', '', ?, ?, 'Posted')`,
    [companyId, `AACS-${companyId}`, `AACS-REF-${companyId}`, amount, amount]
  );
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'AACSIVAT', 'AACS Input VAT', '', ?, 0)", [h.insertId, accounts.ivat, amount]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'AACSCASH', 'AACS Cash', '', 0, ?)", [h.insertId, accounts.cash, amount]);
  return h.insertId;
}

const get = (who, url, query = {}) => request(app).get(url).query(query).set("Authorization", `Bearer ${tokens[who]}`);
const inputVat = (who, query = {}) =>
  get(who, "/api/reports/account-analysis", { from: "2086-01-01", to: "2086-12-31", accountCode: "AACSIVAT", ...query });
const totalDebit = (rows) => rows.reduce((s, r) => s + Number(r.debit || 0), 0);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const tag of ["Decoy", "A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`AACS Co ${tag}`]);
    co[tag] = c.insertId;
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('AACSIVAT', 'AACSCASH')");
  const [ivat] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('AACSIVAT', CURDATE(), 'AACS Input VAT', 'ASSET')");
  const [cash] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('AACSCASH', CURDATE(), 'AACS Cash', 'ASSET')");
  accounts = { ivat: ivat.insertId, cash: cash.insertId };
  jv.Decoy = await postedJv(co.Decoy, 999);
  jv.A = await postedJv(co.A, 100);
  jv.B = await postedJv(co.B, 250);

  const [roleRows] = await pool.execute("SELECT id, code FROM roles");
  const roles = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
  await makeUser("super", roles.SUPER_ADMIN);
  await makeUser("adminA", roles.ADMIN, [co.A]);
  await makeUser("adminB", roles.ADMIN, [co.B]);
  await makeUser("multi", roles.ADMIN, [co.A, co.B]);
});

afterAll(async () => {
  const companies = [co.Decoy, co.A, co.B].filter(Boolean);
  const jvIds = Object.values(jv);
  try {
    if (jvIds.length) {
      await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds]);
      await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('AACSIVAT', 'AACSCASH')");
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

describe("Balance Sheet / Income Statement -> Account Analysis", () => {
  const statement = (who, path, query) => get(who, path, { view: "structured", mode: "condensed", strict: "0", ...query });

  test.each([["A", "adminA", 100], ["B", "adminB", 250]])(
    "Company %s: the statement names its company, and Account Analysis for that company matches",
    async (tag, who, amount) => {
      const bs = await statement(who, "/api/reports/balance-sheet", { to: "2086-12-31" });
      expect(bs.status).toBe(200);
      expect(bs.body.meta.companyId).toBe(co[tag]);
      const is = await statement(who, "/api/reports/income-statement", { from: "2086-01-01", to: "2086-12-31", comparePrev: "0", ytd: "1" });
      expect(is.status).toBe(200);
      expect(is.body.meta.companyId).toBe(co[tag]);
      // the drill-down link carries meta.companyId; Account Analysis honours it
      const aa = await inputVat(who, { companyId: bs.body.meta.companyId });
      expect(totalDebit(aa.body)).toBe(amount);
    }
  );

  test("explicit companyId on the statement is echoed in meta (multi-company user, A and B)", async () => {
    for (const tag of ["A", "B"]) {
      const bs = await statement("multi", "/api/reports/balance-sheet", { to: "2086-12-31", companyId: co[tag] });
      expect(bs.body.meta.companyId).toBe(co[tag]);
    }
  });
});

describe("Input VAT -> Account Analysis endpoint", () => {
  test("Company A -> A only; Company B -> B only", async () => {
    const a = await inputVat("multi", { companyId: co.A });
    expect(totalDebit(a.body)).toBe(100);
    expect(a.body.length).toBeGreaterThan(0);
    expect(a.body.every((r) => r.reference_no === `AACS-${co.A}`)).toBe(true);
    const b = await inputVat("multi", { companyId: co.B });
    expect(totalDebit(b.body)).toBe(250);
  });

  test("unauthorized 403, unknown 400, multi-company and Super Admin without a company 400", async () => {
    const cross = await inputVat("adminA", { companyId: co.B });
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toMatch(/AACS-REF/);
    expect((await inputVat("super", { companyId: UNKNOWN_ID })).status).toBe(400);
    expect((await inputVat("multi")).status).toBe(400);
    expect((await inputVat("super")).status).toBe(400);
  });
});

describe("source transaction view keeps company isolation", () => {
  test("a supplied companyId opens that company's transaction; another company's id is never returned", async () => {
    const own = await get("super", `/api/jv/${jv.B}`, { companyId: co.B });
    expect(own.status).toBe(200);
    expect(own.body.voucherNo || own.body.voucher_no).toBe(`AACS-${co.B}`);

    const wrongCompany = await get("super", `/api/jv/${jv.B}`, { companyId: co.A });
    expect(wrongCompany.status).toBe(404);
    expect(JSON.stringify(wrongCompany.body)).not.toMatch(/AACS-REF/);

    // A company the user isn't assigned to is refused with no data. (The JV
    // route reports it as a generic 500 rather than 403 - existing
    // behaviour of the transaction routes, not changed in this phase.)
    const unauthorized = await get("adminA", `/api/jv/${jv.B}`, { companyId: co.B });
    expect([403, 500]).toContain(unauthorized.status);
    expect(JSON.stringify(unauthorized.body)).not.toMatch(/AACS/);
    expect((await get("adminA", `/api/jv/${jv.B}`)).status).toBe(404);
  });
});

describe("account list (/api/coa)", () => {
  test("is global by design: no company column, same list for every company's user", async () => {
    const [cols] = await pool.query(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chart_of_accounts' AND COLUMN_NAME = 'company_id'"
    );
    expect(cols[0].c).toBe(0);
    const codes = async (who) => (await get(who, "/api/coa")).body.map((a) => a.code).filter((c) => /^AACS/.test(c)).sort();
    expect(await codes("adminA")).toEqual(["AACSCASH", "AACSIVAT"]);
    expect(await codes("adminB")).toEqual(await codes("adminA"));
  });
});
