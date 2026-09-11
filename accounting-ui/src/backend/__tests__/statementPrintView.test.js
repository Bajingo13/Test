const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase E.2: printable IS/BS. The print view (StatementPrintView.jsx)
// renders the SAME serializeStatement(model) rows as the screen - no jsdom
// in this repo's jest config, so this suite covers: (a) the pure
// statementPrintNotes helper, (b) the serialized rows the print view emits
// (via real endpoints), (c) print CSS + source guards.

jest.setTimeout(120000);

let SM;
const REPORTS = path.join(__dirname, "../../pages/REPORTS");
const read = (f) => fs.readFileSync(path.join(REPORTS, f), "utf8");
const acct = {};
const jvIds = [];
const co = {};
const usr = {};
const tok = {};

async function mkCompany(n) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [n]);
  return r.insertId;
}
async function mkUser(u, p, c) {
  const h = await bcrypt.hash(p, 10);
  const [r] = await pool.execute("INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')", [u, h]);
  await pool.execute("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [r.insertId, c]);
  return r.insertId;
}
async function mkAcct(code, title, cls) {
  const [r] = await pool.execute(
    "INSERT INTO chart_of_accounts (code, account_date, title, account_class) VALUES (?, CURDATE(), ?, ?)",
    [code, title, cls]
  );
  acct[code] = r.insertId;
}
async function mkGroup(gc, desc, cls, section, order, codes) {
  await pool.execute(
    `INSERT INTO account_group_codes (group_code, group_description, account_class, report_section, display_order, status)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [gc, desc, cls, section, order]
  );
  for (const c of codes) {
    await pool.execute("INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)", [acct[c], gc, desc]);
  }
}
async function jv(c, vno, date, dr, cr, amt) {
  const [h] = await pool.execute(
    `INSERT INTO jv_headers (company_id, voucher_no, transaction_date, description, total_debit, total_credit, status)
     VALUES (?, ?, ?, 'x', ?, ?, 'Posted')`,
    [c, vno, date, amt, amt]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', ?, 0)",
    [h.insertId, acct[dr], dr, amt]
  );
  await pool.execute(
    "INSERT INTO jv_lines (jv_id, account_id, account_code, account_title, particulars, debit, credit) VALUES (?, ?, ?, 'x', 'x', 0, ?)",
    [h.insertId, acct[cr], cr, amt]
  );
  jvIds.push(h.insertId);
}
async function login(u, p) {
  const r = await request(app).post("/api/login").send({ username: u, password: p });
  if (r.status !== 200) throw new Error(`login ${u}`);
  return r.body.token;
}
const H = (t) => ({ Authorization: `Bearer ${t}` });
const IDX = (rows, label) => rows.findIndex((r) => (r.label || "").trim() === label);
const q = (params) => new URLSearchParams(params).toString();

beforeAll(async () => {
  assertNotProductionDatabase();
  SM = await import("../../pages/REPORTS/statementModel.mjs");

  co.U = await mkCompany("E2 Unclassified Co");
  usr.U = await mkUser("e2_u", "E2Pass!1", co.U);
  co.OOB = await mkCompany("E2 OutOfBalance Co");
  usr.OOB = await mkUser("e2_oob", "E2Pass!2", co.OOB);
  co.OK = await mkCompany("E2 Clean Co");
  usr.OK = await mkUser("e2_ok", "E2Pass!3", co.OK);

  // U: whole June-2027 month, one ungrouped income -> Unclassified on IS
  await mkAcct("E2U-CASH", "cash", "ASSET");
  await mkAcct("E2U-REV", "rev", "INCOME");
  await mkAcct("E2U-OPEX", "opex", "EXPENSE");
  await mkAcct("E2U-UINC", "ungrouped income", "INCOME");
  await mkAcct("E2U-EQ", "equity", "EQUITY");
  await mkGroup("E2U-G-CA", "Cash Grp", "ASSET", "CURRENT_ASSET", 10, ["E2U-CASH"]);
  await mkGroup("E2U-G-REV", "Rev Grp", "INCOME", "REVENUE", 10, ["E2U-REV"]);
  await mkGroup("E2U-G-OPEX", "Opex Grp", "EXPENSE", "OPERATING_EXPENSE", 10, ["E2U-OPEX"]);
  await mkGroup("E2U-G-EQ", "Equity Grp", "EQUITY", "EQUITY", 10, ["E2U-EQ"]);
  await jv(co.U, "E2U-S1", "2027-02-01", "E2U-CASH", "E2U-EQ", 40000);
  await jv(co.U, "E2U-I1", "2027-06-05", "E2U-CASH", "E2U-REV", 9000);
  await jv(co.U, "E2U-I2", "2027-06-06", "E2U-OPEX", "E2U-CASH", 2000);
  await jv(co.U, "E2U-I3", "2027-06-07", "E2U-CASH", "E2U-UINC", 500); // ungrouped -> Unclassified

  // OOB: prior-year income not closed -> current-year CYE can't cover it.
  await mkAcct("E2O-CASH", "cash", "ASSET");
  await mkAcct("E2O-EQ", "equity", "EQUITY");
  await mkAcct("E2O-REV", "rev", "INCOME");
  await mkGroup("E2O-G-CA", "Cash Grp", "ASSET", "CURRENT_ASSET", 10, ["E2O-CASH"]);
  await mkGroup("E2O-G-EQ", "Equity Grp", "EQUITY", "EQUITY", 10, ["E2O-EQ"]);
  await mkGroup("E2O-G-REV", "Rev Grp", "INCOME", "REVENUE", 10, ["E2O-REV"]);
  await jv(co.OOB, "E2O-PY", "2026-06-01", "E2O-CASH", "E2O-REV", 900);
  await jv(co.OOB, "E2O-S1", "2027-02-01", "E2O-CASH", "E2O-EQ", 1000);

  // OK: fully classified, balanced, all 2027.
  await mkAcct("E2K-CASH", "cash", "ASSET");
  await mkAcct("E2K-EQ", "equity", "EQUITY");
  await mkAcct("E2K-REV", "rev", "INCOME");
  await mkGroup("E2K-G-CA", "Cash Grp", "ASSET", "CURRENT_ASSET", 10, ["E2K-CASH"]);
  await mkGroup("E2K-G-EQ", "Equity Grp", "EQUITY", "EQUITY", 10, ["E2K-EQ"]);
  await mkGroup("E2K-G-REV", "Rev Grp", "INCOME", "REVENUE", 10, ["E2K-REV"]);
  await jv(co.OK, "E2K-S1", "2027-02-01", "E2K-CASH", "E2K-EQ", 3000);
  await jv(co.OK, "E2K-I1", "2027-05-01", "E2K-CASH", "E2K-REV", 1200);

  tok.U = await login("e2_u", "E2Pass!1");
  tok.OOB = await login("e2_oob", "E2Pass!2");
  tok.OK = await login("e2_ok", "E2Pass!3");
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'E2%-G-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'E2%-G-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'E2%-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?, ?)", [usr.U, usr.OOB, usr.OK]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?, ?)", [usr.U, usr.OOB, usr.OK]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?, ?)", [co.U, co.OOB, co.OK]);
  await pool.end();
});

describe("statementPrintNotes (pure)", () => {
  test("clean model -> no notes", () => {
    expect(SM.statementPrintNotes({ unclassified: { present: false }, balanceCheck: { balanced: true, byColumn: {} } })).toEqual([]);
  });

  test("unclassified present -> restrained note (no alarming wording)", () => {
    const notes = SM.statementPrintNotes({ unclassified: { present: true }, balanceCheck: null });
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/Unclassified/);
    expect(notes[0]).not.toMatch(/corrupt|database failure|system error/i);
  });

  test("out of balance -> note with formatted delta + as-of label", () => {
    const notes = SM.statementPrintNotes({
      unclassified: { present: false },
      columns: [{ key: "current", periodLabel: "June 30, 2027" }],
      balanceCheck: { balanced: false, byColumn: { current: { delta: -1234.5 } } },
    });
    expect(notes.some((n) => /out of balance by -1,234\.50 as of June 30, 2027/.test(n))).toBe(true);
    expect(notes.join(" ")).not.toMatch(/corrupt|failure|error/i);
  });
});

describe("printed rows come from serializeStatement (real endpoints)", () => {
  test("IS: hierarchy order, condensed has no account rows, dynamic header, signatures blank", async () => {
    const res = await request(app)
      .get(`/api/reports/income-statement?${q(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: "condensed" }).params)}`)
      .set(H(tok.U));
    expect(res.status).toBe(200);
    const s = SM.serializeStatement(res.body);
    const order = ["REVENUE", "LESS: OPERATING EXPENSES", "TOTAL OPERATING EXPENSES", "INCOME/(LOSS) BEFORE TAX", "NET INCOME/(LOSS)"];
    const pos = order.map((l) => IDX(s.rows, l));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(s.rows.some((r) => r.type === "account")).toBe(false);
    expect(s.companyName).toBe("E2 Unclassified Co");
    expect(s.subtitleLines[0]).toMatch(/For the period ended/);
    expect(s.signatures).toEqual(["Prepared By:", "Checked By:", "Approved By:"]);
  });

  test("IS Detailed exposes account rows; NET INCOME identical to Condensed", async () => {
    const p = (m) => q(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30", mode: m }).params);
    const c = SM.serializeStatement((await request(app).get(`/api/reports/income-statement?${p("condensed")}`).set(H(tok.U))).body);
    const d = SM.serializeStatement((await request(app).get(`/api/reports/income-statement?${p("detailed")}`).set(H(tok.U))).body);
    expect(d.rows.some((r) => r.type === "account")).toBe(true);
    const net = (x) => x.rows.find((r) => (r.label || "").trim() === "NET INCOME/(LOSS)").values.current;
    expect(net(d)).toBe(net(c));
  });

  test("IS Unclassified fixture -> print note; clean fixture -> no note", async () => {
    const uRes = await request(app)
      .get(`/api/reports/income-statement?${q(SM.incomeStatementScreenParams({ from: "2027-06-01", to: "2027-06-30" }).params)}`)
      .set(H(tok.U));
    expect(SM.statementPrintNotes(uRes.body).some((n) => /Unclassified/.test(n))).toBe(true);

    const okRes = await request(app)
      .get(`/api/reports/income-statement?${q(SM.incomeStatementScreenParams({ from: "2027-05-01", to: "2027-05-31" }).params)}`)
      .set(H(tok.OK));
    expect(SM.statementPrintNotes(okRes.body)).toEqual([]);
  });

  test("BS: no comparison -> current only; comparison -> current/comparative/difference; CYE once", async () => {
    const one = SM.serializeStatement(
      (await request(app).get(`/api/reports/balance-sheet?${q(SM.balanceSheetScreenParams({ to: "2027-06-30" }).params)}`).set(H(tok.OK))).body
    );
    expect(one.columns.map((c) => c.key)).toEqual(["current"]);
    expect(one.rows.filter((r) => r.synthetic).length).toBe(1);

    const cmp = SM.serializeStatement(
      (
        await request(app)
          .get(`/api/reports/balance-sheet?${q(SM.balanceSheetScreenParams({ to: "2027-06-30", compareTo: "2027-03-31" }).params)}`)
          .set(H(tok.OK))
      ).body
    );
    expect(cmp.columns.map((c) => c.key)).toEqual(["current", "comparative", "difference"]);
    expect(cmp.rows.filter((r) => r.synthetic).length).toBe(1);
    const bsOrder = ["ASSETS", "TOTAL ASSETS", "LIABILITIES & SHAREHOLDERS' EQUITY", "TOTAL LIABILITIES & SHAREHOLDERS' EQUITY"];
    const pos = bsOrder.map((l) => IDX(cmp.rows, l));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  test("BS out-of-balance company -> statement still returned, print note carries the delta + date", async () => {
    const res = await request(app)
      .get(`/api/reports/balance-sheet?${q(SM.balanceSheetScreenParams({ to: "2027-06-30" }).params)}`)
      .set(H(tok.OOB));
    expect(res.status).toBe(200);
    expect(res.body.balanceCheck.balanced).toBe(false);
    const notes = SM.statementPrintNotes(res.body);
    expect(notes.some((n) => /out of balance by 900\.00 as of/.test(n))).toBe(true);
    expect(notes.join(" ")).not.toMatch(/corrupt|database|system error/i);
  });
});

describe("StatementPrintView.jsx source guards", () => {
  const src = () => read("StatementPrintView.jsx");

  test("consumes the shared serializer, no duplicate financial calculation", () => {
    expect(src()).toMatch(/serializeStatement/);
    expect(src()).toMatch(/createPortal/);
    expect(src()).not.toMatch(/GROSS_PROFIT\s*=|TOTAL_ASSETS\s*=|\.reduce\(/);
    expect(src()).not.toMatch(/revenueRows|assetRows|liabilityRows|capitalRows/);
  });

  test("renders the signature block from the serializer, blank names", () => {
    expect(src()).toMatch(/s\.signatures\.map/);
    expect(src()).not.toMatch(/Juan|Approver|John Doe/i);
  });

  test("no rasterisation / screenshot / heavy PDF dependency", () => {
    expect(src()).not.toMatch(/toDataURL|toCanvas|html2canvas|jsPDF|pdf-lib|puppeteer/i);
  });

  test("no hard-coded sample company / dates / amounts", () => {
    for (const f of ["StatementPrintView.jsx", "StatementPrintView.css", "statementModel.mjs"]) {
      const s = read(f);
      expect(s).not.toMatch(/CARGOHAUS/i);
      expect(s).not.toMatch(/\b20(23|24)\b/);
      expect(s).not.toMatch(/39234323|51301516/);
    }
  });
});

describe("StatementPrintView.css page setup", () => {
  const css = () => read("StatementPrintView.css");

  test("A4 portrait @page with report margins", () => {
    expect(css()).toMatch(/@page\s*{[^}]*size:\s*A4 portrait/);
    expect(css()).toMatch(/@page\s*{[^}]*margin:/);
  });

  test("dedicated print root gated by a body class (not fragile global hiding)", () => {
    expect(css()).toMatch(/#statement-print-root\s*{\s*display:\s*none/);
    expect(css()).toMatch(/body\.printing-statement > \*:not\(#statement-print-root\)\s*{\s*display:\s*none/);
  });

  test("repeating column header + page-break control for Detailed", () => {
    expect(css()).toMatch(/thead\s*{\s*display:\s*table-header-group/);
    expect(css()).toMatch(/break-inside:\s*avoid/);
  });

  test("signature block styling present", () => {
    expect(css()).toMatch(/\.spv-signatures/);
    expect(css()).toMatch(/\.spv-sig-line/);
  });
});

describe("Phase E.2 / G does not disturb screen / CSV / backend", () => {
  test("IS/BS still render the screen via StatementView and export via statementToCsv on the shown model", () => {
    for (const f of ["IncomeStatement.jsx", "BalanceSheet.jsx"]) {
      const s = read(f);
      expect(s).toMatch(/<StatementView model={model}/);
      expect(s).toMatch(/statementToCsv\(model\)/);
      expect(s).toMatch(/<StatementPrintView model={model}/);
      // Phase G: print is invoked through the unified <ReportExportMenu>
      // (onPrint), not a dedicated button.
      expect(s).toMatch(/<ReportExportMenu/);
      expect(s).toMatch(/onPrint={\(\) => window\.print\(\)}/);
      expect(s).toMatch(/onExportCsv={exportCSV}/);
    }
  });

  test("no backend / migration / transaction-print change", () => {
    const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
    expect(server).toMatch(/getIncomeStatementRows\(\{ companyId, from, to \}\)/);
    expect(server).toMatch(/getBalanceSheetRows\(\{ companyId, to \}\)/);
    // print view does not reach into the transaction document pipeline
    expect(read("StatementPrintView.jsx")).not.toMatch(/print\/pdf|documentPdfBuilder|pdfKit/);
  });
});
