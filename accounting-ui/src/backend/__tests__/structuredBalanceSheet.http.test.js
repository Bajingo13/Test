const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase C: HTTP coverage for the additive, opt-in structured view of
// GET /api/reports/balance-sheet (?view=structured). Legacy requests (no
// view param) must keep returning today's flat array unchanged, including
// the legacy INNER-JOIN Current Year Earnings row. The structured branch
// delegates all math to financialStatementStructureService.buildBalanceSheet
// - these tests exercise the route contract: as-of / comparative /
// difference columns, mode + date validation, canonical CYE, balanceCheck,
// strict mode (classification vs out-of-balance precedence), isolation.

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
  for (const c of codes) await linkGroup(groupCode, description, c);
}
async function linkGroup(groupCode, description, code) {
  await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [
    acct[code],
    groupCode,
    description,
  ]);
}
async function jv(companyId, voucherNo, date, drCode, crCode, amount) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, 'Posted')`,
    [companyId, voucherNo, date, amount, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, 0)",
    [h.insertId, acct[drCode], drCode, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, ?)",
    [h.insertId, acct[crCode], crCode, amount]
  );
  jvIds.push(h.insertId);
}
async function login(username, password) {
  const res = await request(app).post("/api/login").send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}
const H = (t) => ({ Authorization: `Bearer ${t}` });
const BS = "/api/reports/balance-sheet";
const IS = "/api/reports/income-statement";
const colKeys = (b) => b.columns.map((c) => c.key);

beforeAll(async () => {
  assertNotProductionDatabase();
  for (const k of ["A", "B", "C", "D"]) {
    co[k] = await makeCompany(`PC ${k} Co`);
    usr[k] = await makeUser(`pc_${k.toLowerCase()}`, `PcPass!${k}1`, co[k]);
  }

  // ---- Company A: full BS, one invalid-section asset, one multi-group asset,
  // one classified income + one UNGROUPED income (only reachable via CYE) ----
  await makeAccount("PCA-CASH", "box", "ASSET");
  await makeAccount("PCA-NCASSET", "slow box", "ASSET");
  await makeAccount("PCA-CL", "owe soon", "LIABILITY");
  await makeAccount("PCA-NCL", "owe later", "LIABILITY");
  await makeAccount("PCA-EQ", "owners", "EQUITY");
  await makeAccount("PCA-UASSET", "bad section asset", "ASSET");
  await makeAccount("PCA-MG", "multi group asset", "ASSET");
  await makeAccount("PCA-REV", "classified income", "INCOME");
  await makeAccount("PCA-UINC", "ungrouped income", "INCOME");
  await makeGroup("PCA-G-CA", "Bkt 1", "ASSET", "CURRENT_ASSET", 10, ["PCA-CASH"]);
  await makeGroup("PCA-G-NCA", "Bkt 2", "ASSET", "NON_CURRENT_ASSET", 20, ["PCA-NCASSET"]);
  await makeGroup("PCA-G-CL", "Bkt 3", "LIABILITY", "CURRENT_LIABILITY", 10, ["PCA-CL"]);
  await makeGroup("PCA-G-NCL", "Bkt 4", "LIABILITY", "NON_CURRENT_LIABILITY", 20, ["PCA-NCL"]);
  await makeGroup("PCA-G-EQ", "Bkt 5", "EQUITY", "EQUITY", 10, ["PCA-EQ"]);
  await makeGroup("PCA-G-BADSEC", "Bkt 6", "ASSET", "OPERATING_EXPENSE", 15, ["PCA-UASSET"]); // invalid for ASSET
  await makeGroup("PCA-G-REV", "Bkt 7", "INCOME", "REVENUE", 10, ["PCA-REV"]);
  await makeGroup("PCA-G-MGA", "Bkt 8", "ASSET", "CURRENT_ASSET", 5, ["PCA-MG"]);
  await makeGroup("PCA-G-MGB", "Bkt 9", "ASSET", "NON_CURRENT_ASSET", 50, []);
  await linkGroup("PCA-G-MGB", "Bkt 9", "PCA-MG");
  // PCA-UINC: no coa_groups row.
  await jv(co.A, "PCA-S1", "2027-02-01", "PCA-CASH", "PCA-EQ", 100000);
  await jv(co.A, "PCA-S2", "2027-02-01", "PCA-NCASSET", "PCA-NCL", 60000);
  await jv(co.A, "PCA-S3", "2027-02-01", "PCA-CASH", "PCA-CL", 40000);
  await jv(co.A, "PCA-S4", "2027-02-01", "PCA-UASSET", "PCA-EQ", 7000);
  await jv(co.A, "PCA-S5", "2027-02-01", "PCA-MG", "PCA-CL", 5000);
  await jv(co.A, "PCA-I1", "2027-05-15", "PCA-CASH", "PCA-REV", 8000);
  await jv(co.A, "PCA-I2", "2027-05-15", "PCA-CASH", "PCA-UINC", 300); // ungrouped income -> only via CYE
  await jv(co.A, "PCA-F1", "2027-08-01", "PCA-CASH", "PCA-REV", 99); // after every as-of used below

  // ---- Company B: isolation ----
  await makeAccount("PCB-CASH", "b box", "ASSET");
  await makeAccount("PCB-EQ", "b owners", "EQUITY");
  await makeGroup("PCB-G-CA", "Bkt 10", "ASSET", "CURRENT_ASSET", 10, ["PCB-CASH"]);
  await makeGroup("PCB-G-EQ", "Bkt 11", "EQUITY", "EQUITY", 10, ["PCB-EQ"]);
  await jv(co.B, "PCB-1", "2027-06-10", "PCB-CASH", "PCB-EQ", 777777);

  // ---- Company C: fully clean + balanced ----
  await makeAccount("PCC-CASH", "c box", "ASSET");
  await makeAccount("PCC-EQ", "c owners", "EQUITY");
  await makeAccount("PCC-REV", "c income", "INCOME");
  await makeGroup("PCC-G-CA", "Bkt 12", "ASSET", "CURRENT_ASSET", 10, ["PCC-CASH"]);
  await makeGroup("PCC-G-EQ", "Bkt 13", "EQUITY", "EQUITY", 10, ["PCC-EQ"]);
  await makeGroup("PCC-G-REV", "Bkt 14", "INCOME", "REVENUE", 10, ["PCC-REV"]);
  await jv(co.C, "PCC-1", "2027-02-01", "PCC-CASH", "PCC-EQ", 5000);
  await jv(co.C, "PCC-2", "2027-05-01", "PCC-CASH", "PCC-REV", 1200);

  // ---- Company D: clean classification but OUT OF BALANCE (prior-year
  // profit not yet closed -> current-year CYE cannot cover it) ----
  await makeAccount("PCD-CASH", "d box", "ASSET");
  await makeAccount("PCD-EQ", "d owners", "EQUITY");
  await makeAccount("PCD-REV", "d income", "INCOME");
  await makeGroup("PCD-G-CA", "Bkt 15", "ASSET", "CURRENT_ASSET", 10, ["PCD-CASH"]);
  await makeGroup("PCD-G-EQ", "Bkt 16", "EQUITY", "EQUITY", 10, ["PCD-EQ"]);
  await makeGroup("PCD-G-REV", "Bkt 17", "INCOME", "REVENUE", 10, ["PCD-REV"]);
  await jv(co.D, "PCD-PY", "2026-06-01", "PCD-CASH", "PCD-REV", 500); // prior-year income
  await jv(co.D, "PCD-S1", "2027-02-01", "PCD-CASH", "PCD-EQ", 1000);

  for (const k of ["A", "B", "C", "D"]) tok[k] = await login(`pc_${k.toLowerCase()}`, `PcPass!${k}1`);
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'PC%-G-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'PC%-G-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PC%-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?, ?, ?)", [usr.A, usr.B, usr.C, usr.D]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?, ?, ?)", [usr.A, usr.B, usr.C, usr.D]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?, ?, ?)", [co.A, co.B, co.C, co.D]);
  await pool.end();
});

describe("legacy compatibility (no view param)", () => {
  test("legacy flat response shape + legacy INNER-JOIN CYE row unchanged", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const asset = res.body.find((r) => r.account_code === "PCA-CASH");
    expect(Object.keys(asset).sort()).toEqual(
      ["account_class", "account_code", "account_title", "amount", "group_name"].sort()
    );
    const cye = res.body.find((r) => r.account_code === "CURRENT-EARNINGS");
    expect(cye).toBeTruthy();
    expect(cye.account_title).toBe("Current Year Earnings");
    // legacy INNER-JOIN CYE drops the UNGROUPED income account -> 8000, not 8300
    expect(Number(cye.amount)).toBe(8000);
  });
});

describe("structured view - basic contract", () => {
  let body;
  beforeAll(async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.A));
    expect(res.status).toBe(200);
    body = res.body;
  });

  test("canonical model envelope, default mode condensed", () => {
    expect(body.statement).toBe("BALANCE_SHEET");
    expect(body.view).toBe("structured");
    expect(body.mode).toBe("condensed");
    expect(body.meta.title).toBe("BALANCE SHEET - CONDENSED");
  });

  test("without compareTo -> current column only", () => {
    expect(colKeys(body)).toEqual(["current"]);
    expect(body.columns[0]).toMatchObject({ key: "current", label: "AS OF", periodLabel: "June 30, 2027", date: "2027-06-30" });
  });

  test("current / non-current asset + liability split, equity section", () => {
    expect(body.sectionSubtotals.CURRENT_ASSET.current).toBe(153300); // CASH 148300 + MG 5000
    expect(body.sectionSubtotals.NON_CURRENT_ASSET.current).toBe(60000);
    expect(body.sectionSubtotals.CURRENT_LIABILITY.current).toBe(45000);
    expect(body.sectionSubtotals.NON_CURRENT_LIABILITY.current).toBe(60000);
    expect(body.sectionSubtotals.EQUITY.current).toBe(115300); // EQ 107000 + CYE 8300
  });

  test("CYE line exists exactly once and includes the ungrouped income account", () => {
    const cye = body.nodes.filter((n) => n.synthetic);
    expect(cye.length).toBe(1);
    expect(cye[0].label).toBe("NET INCOME/(LOSS)");
    expect(cye[0].section).toBe("EQUITY");
    expect(body.currentYearEarnings.current).toBe(8300); // 8000 classified + 300 ungrouped
  });

  test("unclassified asset balance stays inside TOTAL ASSETS", () => {
    expect(body.unclassified.ASSET.current).toBe(7000);
    expect(body.computed.TOTAL_ASSETS.current).toBe(220300);
    expect(153300 + 60000 + 7000).toBe(220300);
  });

  test("A = L + E for the current column", () => {
    expect(body.balanceCheck.balanced).toBe(true);
    expect(body.balanceCheck.byColumn.current.delta).toBe(0);
    expect(body.computed.TOTAL_LIABILITIES_AND_EQUITY.current).toBe(220300);
  });

  test("current as-of excludes transactions dated after `to`", () => {
    expect(body.computed.TOTAL_ASSETS.current).toBe(220300); // not 220399 (the 2027-08-01 JV)
    expect(body.currentYearEarnings.current).toBe(8300); // not 8399
  });

  test("multi-group asset is counted once and diagnosed", () => {
    const mg = body.readiness.multiGroupMappings.find((x) => x.accountCode === "PCA-MG");
    expect(mg).toEqual({ accountCode: "PCA-MG", chosenGroupCode: "PCA-G-MGA", shadowedGroupCodes: ["PCA-G-MGB"] });
  });

  test("deterministic structure on repeat", async () => {
    const a = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.A));
    const b = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.A));
    expect(colKeys(a.body)).toEqual(colKeys(b.body));
    expect(JSON.stringify(a.body.nodes)).toBe(JSON.stringify(b.body.nodes));
  });
});

describe("structured view - comparative + difference", () => {
  let body;
  beforeAll(async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&compareTo=2027-03-31&view=structured`).set(H(tok.A));
    expect(res.status).toBe(200);
    body = res.body;
  });

  test("compareTo present -> current, comparative, difference columns", () => {
    expect(colKeys(body)).toEqual(["current", "comparative", "difference"]);
    expect(body.columns[1]).toMatchObject({ key: "comparative", label: "AS OF", date: "2027-03-31" });
    expect(body.columns[2]).toMatchObject({ key: "difference", label: "DIFFERENCE" });
  });

  test("comparative as-of excludes transactions after compareTo", () => {
    expect(body.sectionSubtotals.CURRENT_ASSET.comparative).toBe(145000); // structural only (no May income, no Aug)
    expect(body.currentYearEarnings.comparative).toBe(0);
  });

  test("difference = current - comparative", () => {
    expect(body.computed.TOTAL_ASSETS.difference).toBe(8300); // 220300 - 212000
    expect(body.sectionSubtotals.CURRENT_ASSET.difference).toBe(8300);
    expect(body.currentYearEarnings.difference).toBe(8300);
  });

  test("A = L + E independently for current and comparative; difference is not equation-checked", () => {
    expect(body.balanceCheck.byColumn.current.delta).toBe(0);
    expect(body.balanceCheck.byColumn.comparative.delta).toBe(0);
    expect(body.balanceCheck.byColumn.difference).toBeUndefined();
  });

  test("compareTo LATER than to is accepted verbatim; negative differences are preserved", async () => {
    const res = await request(app).get(`${BS}?to=2027-03-31&compareTo=2027-06-30&view=structured`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(res.body.columns.find((c) => c.key === "comparative").date).toBe("2027-06-30");
    expect(res.body.computed.TOTAL_ASSETS.difference).toBe(-8300); // 212000 - 220300
  });
});

describe("structured view - CYE == canonical IS YTD Net Income", () => {
  test("current as-of", async () => {
    const bs = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.A));
    const is = await request(app)
      .get(`${IS}?from=2027-01-01&to=2027-06-30&view=structured&comparePrev=0&ytd=0`)
      .set(H(tok.A));
    expect(is.status).toBe(200);
    expect(bs.body.currentYearEarnings.current).toBe(is.body.computed.NET_INCOME.current);
    expect(bs.body.currentYearEarnings.current).toBe(8300);
  });

  test("comparative as-of", async () => {
    const bs = await request(app).get(`${BS}?to=2027-06-30&compareTo=2027-03-31&view=structured`).set(H(tok.A));
    const is = await request(app)
      .get(`${IS}?from=2027-01-01&to=2027-03-31&view=structured&comparePrev=0&ytd=0`)
      .set(H(tok.A));
    expect(is.status).toBe(200);
    expect(bs.body.currentYearEarnings.comparative).toBe(is.body.computed.NET_INCOME.current);
    expect(bs.body.currentYearEarnings.comparative).toBe(0);
  });
});

describe("structured view - mode", () => {
  test("mode=detailed exposes account lines + DETAILED title; multi-group asset appears once", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured&mode=detailed`).set(H(tok.A));
    expect(res.status).toBe(200);
    expect(res.body.meta.title).toBe("BALANCE SHEET - DETAILED");
    const mg = res.body.nodes.filter((n) => n.kind === "account-line" && n.accountCode === "PCA-MG");
    expect(mg.length).toBe(1);
    expect(mg[0].section).toBe("CURRENT_ASSET");
  });
  test("invalid mode -> 400 INVALID_REPORT_MODE", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured&mode=summary`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REPORT_MODE");
  });
  test("condensed / detailed subtotal + total + balanceCheck parity", async () => {
    const c = await request(app).get(`${BS}?to=2027-06-30&compareTo=2027-03-31&view=structured&mode=condensed`).set(H(tok.A));
    const d = await request(app).get(`${BS}?to=2027-06-30&compareTo=2027-03-31&view=structured&mode=detailed`).set(H(tok.A));
    expect(d.body.sectionSubtotals).toEqual(c.body.sectionSubtotals);
    expect(d.body.computed).toEqual(c.body.computed);
    expect(d.body.balanceCheck).toEqual(c.body.balanceCheck);
    expect(d.body.currentYearEarnings).toEqual(c.body.currentYearEarnings);
  });
});

describe("structured view - date validation", () => {
  test("missing to -> 400", async () => {
    const res = await request(app).get(`${BS}?view=structured`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
  test("malformed to -> 400", async () => {
    const res = await request(app).get(`${BS}?view=structured&to=nope`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
  test("malformed compareTo -> 400", async () => {
    const res = await request(app).get(`${BS}?view=structured&to=2027-06-30&compareTo=2027-13-40`).set(H(tok.A));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_RANGE");
  });
});

describe("structured view - balanceCheck + strict mode", () => {
  test("out-of-balance company: normal response surfaces balanceCheck.balanced = false", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.D));
    expect(res.status).toBe(200);
    expect(res.body.balanceCheck.balanced).toBe(false);
    expect(res.body.balanceCheck.byColumn.current.delta).toBe(500); // prior-year 500 not covered by 2027 CYE
  });

  test("strict=1 + out of balance (classification clean) -> 409 BALANCE_SHEET_OUT_OF_BALANCE", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured&strict=1`).set(H(tok.D));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BALANCE_SHEET_OUT_OF_BALANCE");
    expect(res.body.balanceCheck.balanced).toBe(false);
    expect(res.body.nodes).toBeUndefined();
  });

  test("strict=1 + unclassified classification -> 409 REPORT_CLASSIFICATION_INCOMPLETE (precedence over balance)", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured&strict=1`).set(H(tok.A));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REPORT_CLASSIFICATION_INCOMPLETE");
    expect(Array.isArray(res.body.reasons)).toBe(true);
    expect(res.body.readiness).toBeTruthy();
  });

  test("strict=1 + clean + balanced -> 200 structured", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured&strict=1`).set(H(tok.C));
    expect(res.status).toBe(200);
    expect(res.body.statement).toBe("BALANCE_SHEET");
    expect(res.body.balanceCheck.balanced).toBe(true);
    expect(res.body.unclassified.present).toBe(false);
    expect(res.body.computed.TOTAL_ASSETS.current).toBe(6200);
  });
});

describe("structured view - company isolation", () => {
  test("Company A never sees Company B's 777777", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.A));
    expect(JSON.stringify(res.body)).not.toContain("777777");
  });
  test("Company B sees only its own equity/assets", async () => {
    const res = await request(app).get(`${BS}?to=2027-06-30&view=structured`).set(H(tok.B));
    expect(res.body.computed.TOTAL_ASSETS.current).toBe(777777);
    expect(res.body.sectionSubtotals.EQUITY.current).toBe(777777);
  });
});

describe("frontend uses the structured BS path (Phase C endpoint; wired in D/E.1)", () => {
  // Phase C added the structured BS endpoint with NO frontend change. Phase D
  // wired the CSV export; Phase E.1 replaced the visible IS/BS rendering with
  // the shared serializer (StatementView) and added the Compare To control.
  const base = path.join(__dirname, "../../pages/REPORTS");
  const read = (f) => fs.readFileSync(path.join(base, f), "utf8");

  test("BS page fetches the structured report, renders via the serializer, and exposes a Compare To control", () => {
    const src = read("BalanceSheet.jsx");
    expect(src).toMatch(/balanceSheetScreenParams/);
    expect(src).toMatch(/StatementView/);
    expect(src).toMatch(/statementToCsv/);
    expect(src).toMatch(/compareTo/);
    expect(read("statementModel.mjs")).toMatch(/view:\s*"structured"/);
  });

  test("reportCsv.mjs keeps its original primitives (additive changes only)", () => {
    const src = read("reportCsv.mjs");
    for (const fn of ["export function csvCell", "export function rowsToCsv", "export function downloadCsv"]) {
      expect(src).toContain(fn);
    }
  });
});
