const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase E.1: the IS/BS screens now render from the canonical
// structured model via statementModel.mjs. Full React rendering has no
// jsdom in this repo's jest config, so this suite covers (a) the pure
// screen-control helpers that decide the request shape + warnings, (b) the
// serializer rows that DRIVE the screen (through the real endpoints), and
// (c) source guards that the pages use the structured path and add no
// print/PDF.

jest.setTimeout(120000);

let SM;
const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const acct = {};
const jvIds = [];
const co = {};
const usr = {};
const tok = {};

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
  return r.insertId;
}
async function makeUser(u, p, companyId) {
  const hash = await bcrypt.hash(p, 10);
  const [r] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')",
    [u, hash]
  );
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, companyId]);
  return r.insertId;
}
async function makeAccount(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  acct[code] = r.insertId;
}
async function makeGroup(gc, desc, cls, section, order, codes) {
  await pool.execute(
    `INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [gc, desc, cls, section, order]
  );
  for (const c of codes) {
    await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [acct[c], gc, desc]);
  }
}
async function jv(companyId, vno, date, dr, cr, amount) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, 'Posted')`,
    [companyId, vno, date, amount, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, 0)",
    [h.insertId, acct[dr], dr, amount]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, ?)",
    [h.insertId, acct[cr], cr, amount]
  );
  jvIds.push(h.insertId);
}
async function login(u, p) {
  const res = await request(app).post("/api/login").send({ username: u, password: p });
  if (res.status !== 200) throw new Error(`login ${u}`);
  return res.body.token;
}
const H = (t) => ({ Authorization: `Bearer ${t}` });
const IDX = (rows, label) => rows.findIndex((r) => (r.label || "").trim() === label);

beforeAll(async () => {
  assertNotProductionDatabase();
  SM = await import("../../pages/REPORTS/statementModel.mjs");

  co.A = await makeCompany("E1 Screen Co");
  usr.A = await makeUser("e1_a", "E1Pass!1", co.A);
  co.OOB = await makeCompany("E1 OutOfBalance Co");
  usr.OOB = await makeUser("e1_oob", "E1Pass!2", co.OOB);

  // Company A: IS with a whole June-2027 month + one ungrouped income
  // (drives the Unclassified section/warning); a small BS too.
  await makeAccount("E1-CASH", "cash", "ASSET");
  await makeAccount("E1-REV", "rev", "INCOME");
  await makeAccount("E1-OPEX", "opex", "EXPENSE");
  await makeAccount("E1-UINC", "ungrouped income", "INCOME");
  await makeAccount("E1-EQ", "equity", "EQUITY");
  await makeGroup("E1-G-CA", "Cash Group", "ASSET", "CURRENT_ASSET", 10, ["E1-CASH"]);
  await makeGroup("E1-G-REV", "Rev Group", "INCOME", "REVENUE", 10, ["E1-REV"]);
  await makeGroup("E1-G-OPEX", "Opex Group", "EXPENSE", "OPERATING_EXPENSE", 10, ["E1-OPEX"]);
  await makeGroup("E1-G-EQ", "Equity Group", "EQUITY", "EQUITY", 10, ["E1-EQ"]);
  await jv(co.A, "E1-S1", "2027-02-01", "E1-CASH", "E1-EQ", 50000);
  await jv(co.A, "E1-I1", "2027-06-05", "E1-CASH", "E1-REV", 9000);
  await jv(co.A, "E1-I2", "2027-06-06", "E1-OPEX", "E1-CASH", 2000);
  await jv(co.A, "E1-I3", "2027-06-07", "E1-CASH", "E1-UINC", 400); // ungrouped -> Unclassified

  // Out-of-balance company: prior-year income not closed -> current-year CYE
  // cannot cover it, so structured BS is legitimately out of balance.
  await makeAccount("E1O-CASH", "cash", "ASSET");
  await makeAccount("E1O-EQ", "equity", "EQUITY");
  await makeAccount("E1O-REV", "rev", "INCOME");
  await makeGroup("E1O-G-CA", "Cash Group", "ASSET", "CURRENT_ASSET", 10, ["E1O-CASH"]);
  await makeGroup("E1O-G-EQ", "Equity Group", "EQUITY", "EQUITY", 10, ["E1O-EQ"]);
  await makeGroup("E1O-G-REV", "Rev Group", "INCOME", "REVENUE", 10, ["E1O-REV"]);
  await jv(co.OOB, "E1O-PY", "2026-06-01", "E1O-CASH", "E1O-REV", 700);
  await jv(co.OOB, "E1O-S1", "2027-02-01", "E1O-CASH", "E1O-EQ", 1000);

  tok.A = await login("e1_a", "E1Pass!1");
  tok.OOB = await login("e1_oob", "E1Pass!2");
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'E1%-G-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'E1%-G-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'E1%-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [usr.A, usr.OOB]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [usr.A, usr.OOB]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [co.A, co.OOB]);
  await pool.end();
});

describe("incomeStatementScreenParams", () => {
  test("defaults: structured, condensed, ytd on, strict off; whole month -> comparePrev on", () => {
    const r = SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: "condensed" });
    expect(r.wholeMonth).toBe(true);
    expect(r.comparePrevActive).toBe(true);
    expect(r.comparePrevDisabledReason).toBeNull();
    expect(r.params).toMatchObject({ view: "structured", mode: "condensed", comparePrev: "1", ytd: "1", strict: "0" });
  });

  test("non-whole-month range force-disables previous-month comparison (no 400)", () => {
    const r = SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-15", mode: "condensed" });
    expect(r.wholeMonth).toBe(false);
    expect(r.comparePrevActive).toBe(false);
    expect(r.params.comparePrev).toBe("0");
    // Phase G.1: compact helper wording for the disabled state
    expect(r.comparePrevDisabledReason).toBe("Previous-month comparison requires a full calendar month.");
  });

  test("user can switch previous-month comparison off for a whole month", () => {
    const r = SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: "detailed", comparePrevWanted: false });
    expect(r.params.comparePrev).toBe("0");
    expect(r.params.mode).toBe("detailed");
  });

  test("mode is validated to condensed | detailed", () => {
    expect(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: "weird" }).params.mode).toBe("condensed");
  });
});

describe("balanceSheetScreenParams", () => {
  test("no compareTo -> current only", () => {
    const r = SM.balanceSheetScreenParams({ to: "2027-06-30", mode: "condensed" });
    expect(r.hasComparative).toBe(false);
    expect(r.params.compareTo).toBeUndefined();
    expect(r.params).toMatchObject({ view: "structured", mode: "condensed", to: "2027-06-30", strict: "0" });
  });

  test("compareTo passed through verbatim - even when later than `to` (no reorder, no reject)", () => {
    const r = SM.balanceSheetScreenParams({ to: "2027-03-31", compareTo: "2027-12-31", mode: "detailed" });
    expect(r.hasComparative).toBe(true);
    expect(r.params.to).toBe("2027-03-31");
    expect(r.params.compareTo).toBe("2027-12-31");
    expect(r.params.mode).toBe("detailed");
  });
});

describe("isWholeCalendarMonth", () => {
  test("month vs non-month vs leap", () => {
    expect(SM.isWholeCalendarMonth("2027-06-01", "2027-06-30")).toBe(true);
    expect(SM.isWholeCalendarMonth("2024-02-01", "2024-02-29")).toBe(true);
    expect(SM.isWholeCalendarMonth("2027-06-01", "2027-06-29")).toBe(false);
    expect(SM.isWholeCalendarMonth("2027-06-01", "2027-07-31")).toBe(false);
  });
});

describe("formatScreenAmount", () => {
  test("grouped thousands, 2dp, sign kept, no currency symbol; blank for empty", () => {
    expect(SM.formatScreenAmount(1500)).toBe("1,500.00");
    expect(SM.formatScreenAmount(-400)).toBe("-400.00");
    expect(SM.formatScreenAmount(0)).toBe("0.00");
    expect(SM.formatScreenAmount(-0)).toBe("0.00");
    expect(SM.formatScreenAmount(1234567.891)).toBe("1,234,567.89");
    expect(SM.formatScreenAmount(null)).toBe("");
    expect(SM.formatScreenAmount("")).toBe("");
    expect(SM.formatScreenAmount(1500)).not.toMatch(/[₱$]/);
  });
});

describe("statementWarnings (pure)", () => {
  test("unclassified.present -> non-blocking warning", () => {
    const w = SM.statementWarnings({ unclassified: { present: true }, balanceCheck: null });
    expect(w.unclassified.show).toBe(true);
    expect(w.unclassified.message).toMatch(/Unclassified/i);
    expect(w.balance.show).toBe(false);
  });

  test("balanceCheck.balanced === false -> out-of-balance warning with per-column delta + label", () => {
    const w = SM.statementWarnings({
      unclassified: { present: false },
      columns: [{ key: "current", periodLabel: "June 30, 2027" }],
      balanceCheck: { balanced: false, byColumn: { current: { delta: 500 } } },
    });
    expect(w.balance.show).toBe(true);
    expect(w.balance.columns).toEqual([{ key: "current", label: "June 30, 2027", delta: 500 }]);
    expect(w.balance.message).not.toMatch(/corrupt|error/i);
  });

  test("balanced BS -> no warning; IS model (balanceCheck null) -> no balance warning", () => {
    expect(SM.statementWarnings({ balanceCheck: { balanced: true, byColumn: {} } }).balance.show).toBe(false);
    expect(SM.statementWarnings({ balanceCheck: null }).balance.show).toBe(false);
  });
});

describe("serializer rows drive the screen (real structured endpoints)", () => {
  test("IS: structured endpoint + hierarchy order + condensed has no account rows", async () => {
    const res = await request(app)
      .get(`/api/reports/income-statement?${SM.toQueryString(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: "condensed" }).params)}`)
      .set(H(tok.A));
    expect(res.status).toBe(200);
    expect(res.body.view).toBe("structured");
    const s = SM.serializeStatement(res.body);
    const order = ["REVENUE", "LESS: OPERATING EXPENSES", "TOTAL OPERATING EXPENSES", "INCOME/(LOSS) BEFORE TAX", "NET INCOME/(LOSS)"];
    const pos = order.map((l) => IDX(s.rows, l));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(s.rows.some((r) => r.type === "account")).toBe(false);
    expect(s.companyName).toBe("E1 Screen Co");
    expect(s.subtitleLines[0]).toMatch(/For the period ended/);
  });

  test("IS: detailed mode exposes account rows; totals identical to condensed", async () => {
    const q = (m) => SM.toQueryString(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: m }).params);
    const c = SM.serializeStatement((await request(app).get(`/api/reports/income-statement?${q("condensed")}`).set(H(tok.A))).body);
    const d = SM.serializeStatement((await request(app).get(`/api/reports/income-statement?${q("detailed")}`).set(H(tok.A))).body);
    expect(d.rows.some((r) => r.type === "account")).toBe(true);
    const net = (x) => x.rows.find((r) => (r.label || "").trim() === "NET INCOME/(LOSS)").values.current;
    expect(net(d)).toBe(net(c));
  });

  test("IS: Unclassified income stays visible as its own rows + warning fires", async () => {
    const res = await request(app)
      .get(`/api/reports/income-statement?${SM.toQueryString(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30" }).params)}`)
      .set(H(tok.A));
    const s = SM.serializeStatement(res.body);
    expect(IDX(s.rows, "UNCLASSIFIED — INCOME")).toBeGreaterThan(-1);
    expect(SM.statementWarnings(res.body).unclassified.show).toBe(true);
  });

  test("BS: structured endpoint; comparative + difference columns; CYE row once", async () => {
    const r = SM.balanceSheetScreenParams({ to: "2027-06-30", compareTo: "2027-03-31", mode: "condensed" });
    const res = await request(app).get(`/api/reports/balance-sheet?${SM.toQueryString(r.params)}`).set(H(tok.A));
    expect(res.status).toBe(200);
    const s = SM.serializeStatement(res.body);
    expect(s.columns.map((c) => c.key)).toEqual(["current", "comparative", "difference"]);
    expect(s.rows.filter((row) => row.synthetic).length).toBe(1);
    const bsOrder = ["ASSETS", "TOTAL ASSETS", "LIABILITIES & SHAREHOLDERS' EQUITY", "TOTAL LIABILITIES", "TOTAL LIABILITIES & SHAREHOLDERS' EQUITY"];
    const pos = bsOrder.map((l) => IDX(s.rows, l));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  test("BS: out-of-balance company surfaces a non-blocking warning with the delta (statement still returned)", async () => {
    const res = await request(app)
      .get(`/api/reports/balance-sheet?${SM.toQueryString(SM.balanceSheetScreenParams({ to: "2027-06-30", mode: "condensed" }).params)}`)
      .set(H(tok.OOB));
    expect(res.status).toBe(200); // strict=0 -> body returned
    expect(res.body.balanceCheck.balanced).toBe(false);
    const w = SM.statementWarnings(res.body);
    expect(w.balance.show).toBe(true);
    expect(w.balance.columns.find((c) => c.key === "current").delta).toBe(700);
  });
});

describe("source guards - Phase E.1 scope", () => {
  const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");

  test("IS/BS pages render via StatementView + the shared serializer, using the structured request helpers", () => {
    const is = read("IncomeStatement.jsx");
    const bs = read("BalanceSheet.jsx");
    for (const src of [is, bs]) {
      expect(src).toMatch(/StatementView/);
      expect(src).toMatch(/statementModel\.mjs/);
      expect(src).toMatch(/Condensed/);
      expect(src).toMatch(/Detailed/);
    }
    expect(is).toMatch(/incomeStatementScreenParams/); // builds view=structured&mode&comparePrev&ytd
    expect(bs).toMatch(/balanceSheetScreenParams/);
    // the helper itself pins view=structured
    expect(read("statementModel.mjs")).toMatch(/view:\s*"structured"/);
  });

  test("no client-side financial recomputation left in the pages (no name-matched buckets / manual totals)", () => {
    for (const f of ["IncomeStatement.jsx", "BalanceSheet.jsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/revenueRows|expenseRows|assetRows|liabilityRows|capitalRows/);
      expect(src).not.toMatch(/\.reduce\(\(s, r\) =>/);
    }
  });

  test("print stays browser-print only - no heavy PDF dependency, no rasterisation (Phase E.2 / G)", () => {
    for (const f of [
      "IncomeStatement.jsx",
      "BalanceSheet.jsx",
      "StatementView.jsx",
      "StatementPrintView.jsx",
      "StatementPrintView.css",
      "statementModel.mjs",
      "ReportExportMenu.jsx",
      "ReportExportMenu.css",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/jsPDF|html2canvas|pdf-lib|@react-pdf|puppeteer|toDataURL|toCanvas/i);
    }
    // window.print() is the only print mechanism, wired from the two pages
    // through the unified menu's onPrint.
    expect(read("IncomeStatement.jsx")).toMatch(/window\.print\(\)/);
    expect(read("BalanceSheet.jsx")).toMatch(/window\.print\(\)/);
    expect(read("StatementView.jsx")).not.toMatch(/window\.print/);
  });

  test("no hard-coded sample company / dates / amounts in the new screen files", () => {
    for (const f of ["StatementView.jsx", "statementModel.mjs"]) {
      const src = read(f);
      expect(src).not.toMatch(/CARGOHAUS/i);
      expect(src).not.toMatch(/\b20(23|24)\b/);
      expect(src).not.toMatch(/39234323|51301516/);
    }
  });

  test("legacy backend income-statement / balance-sheet flat routes are untouched", () => {
    const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    expect(server).toMatch(/getIncomeStatementRows\(\{ companyId, from, to \}\)/);
    expect(server).toMatch(/getBalanceSheetRows\(\{ companyId, to \}\)/);
  });
});
