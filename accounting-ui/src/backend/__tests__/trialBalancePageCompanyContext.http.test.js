// Trial Balance page company context: GET /api/reports/trial-balance and
// GET /api/reports/trial-balance-checker/status resolve the company the
// same way a checker run does (TrialBalanceCheckerService.
// resolveSelectedCompany) - an explicit, validated companyId, or the
// user's ONLY company. A Super Admin or multi-company user without a
// companyId gets 400, never the first/lowest company; a company the user
// isn't assigned to gets 403. Checker-run isolation itself is covered by
// trialBalanceCheckerCompanyIsolation.http.test.js and not repeated here.
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

jest.setTimeout(180000);

const P = "tbpg-";
const PASSWORD = "TbpgPass!1";
const RANGE = { from: "2088-01-01", to: "2088-12-31" };
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

// A posted, balanced JV of `amount` in `companyId` (debit TBPGDR / credit TBPGCR).
async function postedJv(companyId, amount) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, reference_no, prepared_for, description, remarks, total_debit, total_credit, status)
     VALUES (?, ?, '2088-06-15', '', '', 'tbpg', '', ?, ?, 'Posted')`,
    [companyId, `TBPG-${companyId}-${amount}`, amount, amount]
  );
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TBPGDR', 'TBPG Dr', '', ?, 0)", [h.insertId, accounts.dr, amount]);
  await pool.execute("INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, 'TBPGCR', 'TBPG Cr', '', 0, ?)", [h.insertId, accounts.cr, amount]);
  jvIds.push(h.insertId);
}

const report = (who, query = {}) => request(app).get("/api/reports/trial-balance").query({ ...RANGE, ...query }).set("Authorization", `Bearer ${tokens[who]}`);
const status = (who, query = {}) =>
  request(app).get("/api/reports/trial-balance-checker/status").query({ ...RANGE, tolerance: "0.01", ...query }).set("Authorization", `Bearer ${tokens[who]}`);
const checkerRun = (who, body = {}) =>
  request(app).post("/api/reports/trial-balance-checker/check").send({ ...RANGE, ...body }).set("Authorization", `Bearer ${tokens[who]}`);

// The debit on TBPGDR in a report response = that company's posted amount.
const tbpgDebit = (rows) => Number(rows.find((r) => r.account_code === "TBPGDR")?.debit || 0);

beforeAll(async () => {
  assertNotProductionDatabase();
  // Decoy first: the lowest company id of this suite. Nothing may fall back to it.
  for (const tag of ["Decoy", "A", "B"]) {
    const [c] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [`TBPG Co ${tag}`]);
    co[tag] = c.insertId;
  }
  await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('TBPGDR', 'TBPGCR')");
  const [dr] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TBPGDR', CURDATE(), 'TBPG Dr', 'EXPENSE')");
  const [cr] = await pool.execute("INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES ('TBPGCR', CURDATE(), 'TBPG Cr', 'LIABILITY')");
  accounts = { dr: dr.insertId, cr: cr.insertId };
  await postedJv(co.Decoy, 999);
  await postedJv(co.A, 100);
  await postedJv(co.B, 250);

  const [roleRows] = await pool.execute("SELECT id, code FROM roles");
  const roles = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));
  await makeUser("super", roles.SUPER_ADMIN);
  await makeUser("adminA", roles.ADMIN, [co.A]);
  await makeUser("adminB", roles.ADMIN, [co.B]);
  await makeUser("multi", roles.ADMIN, [co.A, co.B]);
});

afterAll(async () => {
  const companies = [co.Decoy, co.A, co.B].filter(Boolean);
  try {
    if (jvIds.length) {
      await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds]);
      await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds]);
    }
    if (companies.length) {
      await pool.query(
        "DELETE f FROM trial_balance_checker_findings f JOIN trial_balance_checker_runs r ON r.id = f.run_id WHERE r.company_id IN (?)",
        [companies]
      );
      await pool.query("DELETE FROM trial_balance_checker_runs WHERE company_id IN (?)", [companies]);
    }
    await pool.execute("DELETE FROM chart_of_accounts WHERE code IN ('TBPGDR', 'TBPGCR')");
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

describe("single-company user: automatic company", () => {
  test("report and status without companyId use the only company", async () => {
    const r = await report("adminA");
    expect(r.status).toBe(200);
    expect(tbpgDebit(r.body)).toBe(100);
    const s = await status("adminA");
    expect(s.status).toBe(200);
    expect(s.body.companyId).toBe(co.A);
  });
});

describe("company isolation with an explicit companyId", () => {
  test("Company A report and status contain only Company A", async () => {
    const r = await report("adminA", { companyId: co.A });
    expect(tbpgDebit(r.body)).toBe(100);
    const s = await status("adminA", { companyId: co.A });
    expect(s.body.companyId).toBe(co.A);
    expect(Number(s.body.totalDebit)).toBeGreaterThanOrEqual(100);
  });

  test("Company B report and status contain only Company B", async () => {
    const r = await report("adminB", { companyId: co.B });
    expect(tbpgDebit(r.body)).toBe(250);
    const s = await status("adminB", { companyId: co.B });
    expect(s.body.companyId).toBe(co.B);
  });
});

describe("cross-company requests are rejected", () => {
  test("Company A user asking for Company B: report, status and checker -> 403", async () => {
    const r = await report("adminA", { companyId: co.B });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/TBPGDR|250/);
    expect((await status("adminA", { companyId: co.B })).status).toBe(403);
    expect((await checkerRun("adminA", { companyId: co.B })).status).toBe(403);
  });

  test("invalid or unknown companyId -> 400 (report and status)", async () => {
    expect((await report("super", { companyId: "abc" })).status).toBe(400);
    expect((await status("super", { companyId: "abc" })).status).toBe(400);
    expect((await report("super", { companyId: UNKNOWN_ID })).status).toBe(400);
    expect((await status("super", { companyId: UNKNOWN_ID })).status).toBe(400);
  });
});

describe("multi-company user: explicit selection, no first-company fallback", () => {
  test("no companyId -> 400 for report, status and checker", async () => {
    const r = await report("multi");
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Select a company to continue/);
    expect((await status("multi")).status).toBe(400);
    expect((await checkerRun("multi")).status).toBe(400);
  });

  test("assigned A and B are reachable; unassigned (decoy) company is 403", async () => {
    expect(tbpgDebit((await report("multi", { companyId: co.A })).body)).toBe(100);
    expect(tbpgDebit((await report("multi", { companyId: co.B })).body)).toBe(250);
    expect((await status("multi", { companyId: co.B })).body.companyId).toBe(co.B);
    expect((await report("multi", { companyId: co.Decoy })).status).toBe(403);
    expect((await status("multi", { companyId: co.Decoy })).status).toBe(403);
  });
});

describe("Super Admin: explicit selection, no lowest-company fallback", () => {
  test("no companyId -> 400, never the lowest company's data", async () => {
    const r = await report("super");
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/TBPGDR/);
    const s = await status("super");
    expect(s.status).toBe(400);
    expect(s.body.companyId).toBeUndefined();
  });

  test("selecting A gives A everywhere; selecting B gives B everywhere", async () => {
    expect(tbpgDebit((await report("super", { companyId: co.A })).body)).toBe(100);
    expect((await status("super", { companyId: co.A })).body.companyId).toBe(co.A);
    const runA = await checkerRun("super", { companyId: co.A });
    expect(runA.body.companyId).toBe(co.A);

    expect(tbpgDebit((await report("super", { companyId: co.B })).body)).toBe(250);
    expect((await status("super", { companyId: co.B })).body.companyId).toBe(co.B);
    const runB = await checkerRun("super", { companyId: co.B });
    expect(runB.body.companyId).toBe(co.B);
  });
});
