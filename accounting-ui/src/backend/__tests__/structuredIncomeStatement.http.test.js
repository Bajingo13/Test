const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase B: HTTP coverage for the additive, opt-in structured view of
// GET /api/reports/income-statement (?view=structured). Legacy requests
// (no view param) must keep returning today's flat array unchanged. The
// structured branch delegates all math to
// financialStatementStructureService.buildIncomeStatement - these tests
// exercise the route contract: period derivation, column ordering, mode +
// date validation, strict mode, company isolation.

jest.setTimeout(120000);

const acct = {};
const jvIds = [];
const tok = {};
const co = {};
const usr = {};

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
async function makeAccount(code, title, accountClass) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, accountClass]
  );
  acct[code] = r.insertId;
}
async function makeGroup(groupCode, description, accountClass, reportSection, displayOrder, codes) {
  await pool.execute(
    `INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [groupCode, description, accountClass, reportSection, displayOrder]
  );
  for (const c of codes) {
    await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [
      acct[c],
      groupCode,
      description,
    ]);
  }
}
async function jv(companyId, voucherNo, date, drCode, crCode, amount) {
  return jvRaw(companyId, voucherNo, date, [
    { id: acct[drCode], code: drCode, debit: amount, credit: 0 },
    { id: acct[crCode], code: crCode, debit: 0, credit: amount },
  ]);
}
async function jvRaw(companyId, voucherNo, date, lines) {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, 'Posted')`,
    [companyId, voucherNo, date, debit, credit]
  );
  for (const l of lines) {
    await pool.execute(
      "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, ?)",
      [h.insertId, l.id, l.code, l.debit, l.credit]
    );
  }
  jvIds.push(h.insertId);
  return h.insertId;
}
async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
const H = (t) => ({ Authorization: `Bearer ${t}` });
const IS = "/api/reports/income-statement";

beforeAll(async () => {
  assertNotProductionDatabase();

  for (const k of ["A", "B", "C", "D"]) {
    co[k] = await makeCompany(`PB ${k} Co`);
    usr[k] = await makeUser(`pb_${k.toLowerCase()}`, `PbPass!${k}1`, co[k]);
  }

  // ---- Company A: classified REV + EXP, one UNGROUPED income account ----
  await makeAccount("PBA-REV", "aaa", "INCOME");
  await makeAccount("PBA-EXP", "bbb", "EXPENSE");
  await makeAccount("PBA-UINC", "ungrouped income", "INCOME");
  await makeAccount("PBA-CASH", "ccc", "ASSET");
  await makeGroup("PBA-G-REV", "Bucket 1", "INCOME", "REVENUE", 10, ["PBA-REV"]);
  await makeGroup("PBA-G-EXP", "Bucket 2", "EXPENSE", "OPERATING_EXPENSE", 10, ["PBA-EXP"]);
  await makeGroup("PBA-G-CA", "Bucket 3", "ASSET", "CURRENT_ASSET", 10, ["PBA-CASH"]);
  await jv(co.A, "PBA-D26", "2026-12-15", "PBA-CASH", "PBA-REV", 1000); // prior year (only in Dec-2026 previous col)
  await jv(co.A, "PBA-J27", "2027-01-15", "PBA-CASH", "PBA-REV", 2000); // YTD + Jan current
  await jv(co.A, "PBA-M27", "2027-05-15", "PBA-CASH", "PBA-REV", 400); // previous month for a June current
  await jv(co.A, "PBA-U27", "2027-06-10", "PBA-CASH", "PBA-REV", 5000); // June current
  await jv(co.A, "PBA-E27", "2027-06-11", "PBA-EXP", "PBA-CASH", 1500); // June opex
  await jv(co.A, "PBA-X27", "2027-06-12", "PBA-CASH", "PBA-UINC", 300); // June unclassified income

  // ---- Company B: isolation, one huge distinctive amount ----
  await makeAccount("PBB-REV", "b rev", "INCOME");
  await makeAccount("PBB-CASH", "b cash", "ASSET");
  await makeGroup("PBB-G-REV", "Bucket 4", "INCOME", "REVENUE", 10, ["PBB-REV"]);
  await makeGroup("PBB-G-CA", "Bucket 5", "ASSET", "CURRENT_ASSET", 10, ["PBB-CASH"]);
  await jv(co.B, "PBB-1", "2027-06-10", "PBB-CASH", "PBB-REV", 999999);

  // ---- Company C: fully clean (every account grouped + classified) ----
  await makeAccount("PBC-REV", "c rev", "INCOME");
  await makeAccount("PBC-EXP", "c exp", "EXPENSE");
  await makeAccount("PBC-CASH", "c cash", "ASSET");
  await makeGroup("PBC-G-REV", "Bucket 6", "INCOME", "REVENUE", 10, ["PBC-REV"]);
  await makeGroup("PBC-G-EXP", "Bucket 7", "EXPENSE", "OPERATING_EXPENSE", 10, ["PBC-EXP"]);
  await makeGroup("PBC-G-CA", "Bucket 8", "ASSET", "CURRENT_ASSET", 10, ["PBC-CASH"]);
  await jv(co.C, "PBC-1", "2027-06-10", "PBC-CASH", "PBC-REV", 800);
  await jv(co.C, "PBC-2", "2027-06-11", "PBC-EXP", "PBC-CASH", 200);

  // ---- Company D: a transaction line whose account_code has no COA row ----
  await makeAccount("PBD-REV", "d rev", "INCOME");
  await makeAccount("PBD-CASH", "d cash", "ASSET");
  await makeGroup("PBD-G-REV", "Bucket 9", "INCOME", "REVENUE", 10, ["PBD-REV"]);
  await makeGroup("PBD-G-CA", "Bucket 10", "ASSET", "CURRENT_ASSET", 10, ["PBD-CASH"]);
  await jv(co.D, "PBD-1", "2027-06-10", "PBD-CASH", "PBD-REV", 600);
  await jvRaw(co.D, "PBD-GHOST", "2027-06-12", [
    { id: acct["PBD-CASH"], code: "PBD-GHOST-NOACCT", debit: 250, credit: 0 }, // no chart_of_accounts row
    { id: acct["PBD-CASH"], code: "PBD-CASH", debit: 0, credit: 250 },
  ]);

  for (const k of ["A", "B", "C", "D"]) tok[k] = await login(`pb_${k.toLowerCase()}`, `PbPass!${k}1`);
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'PB%-G-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'PB%-G-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PB%-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?, ?, ?)", [usr.A, usr.B, usr.C, usr.D]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?, ?, ?)", [usr.A, usr.B, usr.C, usr.D]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?, ?, ?)", [co.A, co.B, co.C, co.D]);
  await pool.end();
});

const JUNE = "?from=2027-06-01&to=2027-06-30";
const colKeys = (body) => body.columns.map((c) => c.key);

describe("legacy compatibility (no view param)", () => {
  test("legacy request returns the flat array shape unchanged", async () => {
    const res = await request(app).get(`${IS}${JUNE}`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((r) => r.account_code === "PBA-REV");
    expect(Object.keys(row).sort()).toEqual(
      ["account_class", "account_code", "account_title", "amount", "group_name"].sort()
    );
    expect(Number(row.amount)).toBe(5000); // June credit - debit
  });

  test("an unknown view value still uses the legacy path", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=flat`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("structured view - basic contract", () => {
  let body;
  beforeAll(async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured`).set(H(tok.A));
    expect(res.status).toBe(200);
    body = res.body;
  });

  test("canonical model envelope", () => {
    expect(body.statement).toBe("INCOME_STATEMENT");
    expect(body.view).toBe("structured");
    expect(body.mode).toBe("condensed"); // default
    expect(body.meta.title).toBe("INCOME STATEMENT - CONDENSED");
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.readiness).toBeTruthy();
  });

  test("default columns = current, previous, ytd with template band labels + date-specific periodLabel", () => {
    expect(colKeys(body)).toEqual(["current", "previous", "ytd"]);
    const [cur, prev, ytd] = body.columns;
    expect(cur).toMatchObject({ key: "current", label: "FOR THE MONTH", periodLabel: "June 2027", from: "2027-06-01", to: "2027-06-30" });
    expect(prev).toMatchObject({ key: "previous", label: "FOR THE MONTH", periodLabel: "May 2027", from: "2027-05-01", to: "2027-05-31" });
    expect(ytd).toMatchObject({ key: "ytd", label: "TOTAL TO DATE", periodLabel: "June 2027", from: "2027-01-01", to: "2027-06-30" });
  });

  test("current / previous / ytd values are correct and period-scoped", () => {
    expect(body.sectionSubtotals.REVENUE.current).toBe(5000);
    expect(body.sectionSubtotals.REVENUE.previous).toBe(400); // the May txn, not in current
    expect(body.sectionSubtotals.REVENUE.ytd).toBe(7400); // 2000 Jan + 400 May + 5000 Jun (Dec-2026's 1000 excluded)
    expect(body.sectionSubtotals.OPERATING_EXPENSE.current).toBe(-1500);
    expect(body.computed.NET_INCOME.current).toBe(3800); // 5000 - 1500 + 300 unclassified
    expect(body.crossCheck.ok).toBe(true);
  });

  test("unclassified income balance is present in the normal structured response (not dropped)", () => {
    expect(body.unclassified.present).toBe(true);
    expect(body.unclassified.INCOME.current).toBe(300);
    expect(body.readiness.ungroupedAccountsWithBalance.map((x) => x.accountCode)).toContain("PBA-UINC");
  });

  test("deterministic column ordering on repeat", async () => {
    const a = await request(app).get(`${IS}${JUNE}&view=structured`).set(H(tok.A));
    const b = await request(app).get(`${IS}${JUNE}&view=structured`).set(H(tok.A));
    expect(colKeys(a.body)).toEqual(colKeys(b.body));
    expect(colKeys(a.body)).toEqual(["current", "previous", "ytd"]);
  });
});

describe("structured view - previous month & YTD derivation", () => {
  test("January current -> previous month crosses into December of the prior year", async () => {
    const res = await request(app)
      .get(`${IS}?from=2027-01-01&to=2027-01-31&view=structured`)
      .set(H(tok.A));
    expect(res.status).toBe(200);
    const prev = res.body.columns.find((c) => c.key === "previous");
    expect(prev).toMatchObject({ from: "2026-12-01", to: "2026-12-31", periodLabel: "December 2026" });
    expect(res.body.sectionSubtotals.REVENUE.previous).toBe(1000); // the Dec-2026 txn
    expect(res.body.sectionSubtotals.REVENUE.current).toBe(2000); // the Jan-2027 txn
    const ytd = res.body.columns.find((c) => c.key === "ytd");
    expect(ytd.from).toBe("2027-01-01");
  });
});

describe("structured view - column toggles", () => {
  test("comparePrev=0 removes the previous column", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&comparePrev=0`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(colKeys(res.body)).toEqual(["current", "ytd"]);
  });
  test("ytd=0 removes the ytd column", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&ytd=0`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(colKeys(res.body)).toEqual(["current", "previous"]);
  });
  test("comparePrev=0 & ytd=0 -> current only", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&comparePrev=0&ytd=0`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(colKeys(res.body)).toEqual(["current"]);
  });
});

describe("structured view - non-whole-month range", () => {
  test("comparePrev=1 (default) on a partial month -> controlled 400", async () => {
    const res = await request(app)
      .get(`${IS}?from=2027-06-01&to=2027-06-15&view=structured`)
      .set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMPARISON_REQUIRES_FULL_MONTH");
  });
  test("comparePrev=0 on a partial month -> allowed (current + ytd)", async () => {
    const res = await request(app)
      .get(`${IS}?from=2027-06-01&to=2027-06-15&view=structured&comparePrev=0`)
      .set(H(tok.A));
    expect(res.status).toBe(200);
    expect(colKeys(res.body)).toEqual(["current", "ytd"]);
    expect(res.body.columns[0].periodLabel).toBe("2027-06-01 to 2027-06-15");
  });
});

describe("structured view - mode", () => {
  test("mode=detailed exposes account lines and the DETAILED title", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&mode=detailed`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("detailed");
    expect(res.body.meta.title).toBe("INCOME STATEMENT - DETAILED");
    expect(res.body.nodes.some((n) => n.kind === "account-line")).toBe(true);
  });
  test("mode=condensed has no account lines", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&mode=condensed`).set(H(tok.A));
    expect(res.body.nodes.some((n) => n.kind === "account-line")).toBe(false);
  });
  test("invalid mode -> 400 INVALID_REPORT_MODE", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&mode=summary`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REPORT_MODE");
  });
  test("condensed / detailed subtotal + computed parity", async () => {
    const c = await request(app).get(`${IS}${JUNE}&view=structured&mode=condensed`).set(H(tok.A));
    const d = await request(app).get(`${IS}${JUNE}&view=structured&mode=detailed`).set(H(tok.A));
    expect(d.body.sectionSubtotals).toEqual(c.body.sectionSubtotals);
    expect(d.body.computed).toEqual(c.body.computed);
  });
});

describe("structured view - date validation", () => {
  test("missing from/to -> 400 INVALID_DATE_RANGE", async () => {
    const res = await request(app).get(`${IS}?view=structured`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
  test("malformed date -> 400", async () => {
    const res = await request(app).get(`${IS}?view=structured&from=garbage&to=2027-06-30`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
  test("impossible date -> 400", async () => {
    const res = await request(app).get(`${IS}?view=structured&from=2027-13-40&to=2027-06-30`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
  test("from after to -> 400", async () => {
    const res = await request(app).get(`${IS}?view=structured&from=2027-06-30&to=2027-06-01`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
});

describe("structured view - strict mode", () => {
  test("strict=1 with an unclassified/ungrouped balance -> 409, no statement body", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&strict=1`).set(H(tok.A));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
    expect(res.body.readiness).toBeTruthy();
    expect(Array.isArray(res.body.reasons)).toBe(true);
    expect(res.body.nodes).toBeUndefined();
  });

  test("strict=1 on a fully-clean company -> 200 structured", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&strict=1`).set(H(tok.C));
    expect(res.status).toBe(200);
    expect(res.body.statement).toBe("INCOME_STATEMENT");
    expect(res.body.unclassified.present).toBe(false);
    expect(res.body.sectionSubtotals.REVENUE.current).toBe(800);
  });

  test("unmapped account code (no chart_of_accounts row) is surfaced and blocks strict", async () => {
    const open = await request(app).get(`${IS}${JUNE}&view=structured`).set(H(tok.D));
    expect(open.status).toBe(200);
    expect(open.body.readiness.unmappedAccountCodesWithBalance.length).toBeGreaterThan(0);

    const strict = await request(app).get(`${IS}${JUNE}&view=structured&strict=1`).set(H(tok.D));
    expect(strict.status).toBe(409);
    expect(strict.body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
    expect(strict.body.reasons.join(" ")).toMatch(/chart-of-accounts/i);
  });
});

describe("structured view - company isolation", () => {
  test("Company A never sees Company B's 999999", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(res.body.sectionSubtotals.REVENUE.current).toBe(5000);
    expect(JSON.stringify(res.body)).not.toContain("999999");
  });
  test("Company B sees only its own revenue", async () => {
    const res = await request(app).get(`${IS}${JUNE}&view=structured&comparePrev=0&ytd=0`).set(H(tok.B));
    expect(res.status).toBe(200);
    expect(res.body.sectionSubtotals.REVENUE.current).toBe(999999);
  });
});

describe("frontend uses the structured IS path (Phase B endpoint; wired in D/E.1)", () => {
  // Phase B added the structured IS endpoint with NO frontend change. Phase D
  // wired the CSV export to it; Phase E.1 replaced the visible IS/BS
  // rendering with the shared serializer (StatementView). This guard just
  // confirms the pages use the structured path and the CSV primitive stayed
  // backward compatible.
  const base = path.join(__dirname, "../../pages/REPORTS");
  const read = (f) => fs.readFileSync(path.join(base, f), "utf8");

  test("IS/BS pages fetch the structured report (via the screen-param helpers) and render via the shared serializer", () => {
    for (const f of ["IncomeStatement.jsx", "BalanceSheet.jsx"]) {
      const src = read(f);
      expect(src).toMatch(/statementModel\.mjs/);
      expect(src).toMatch(/StatementView/);
      expect(src).toMatch(/statementToCsv/);
      expect(src).toMatch(/ScreenParams/); // incomeStatementScreenParams / balanceSheetScreenParams
    }
    // the request helper pins view=structured
    expect(read("statementModel.mjs")).toMatch(/view:\s*"structured"/);
  });

  test("reportCsv.mjs keeps its original primitives (additive changes only)", () => {
    const src = read("reportCsv.mjs");
    for (const fn of ["export function csvCell", "export function rowsToCsv", "export function downloadCsv"]) {
      expect(src).toContain(fn);
    }
  });
});
