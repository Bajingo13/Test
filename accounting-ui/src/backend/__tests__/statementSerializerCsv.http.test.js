const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Reports Phase D: the shared statement serializer (src/pages/REPORTS/
// statementModel.mjs) + its CSV output. The serializer is a pure frontend
// ESM module - loaded here by dynamic import(). Real structured IS/BS
// responses are fetched from the Phase B/C endpoints and serialized;
// hand-built minimal models cover CSV escaping / numeric formatting /
// filename / no-hard-coding.

jest.setTimeout(120000);

let SM; // statementModel.mjs
const acct = {};
const jvIds = [];
const co = {};
const usr = {};
const tok = {};

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
async function login(u, p) {
  const res = await request(app).post("/api/login").send({ username: u, password: p });
  if (res.status !== 200) throw new Error(`login ${u}: ${res.status}`);
  return res.body.token;
}
const H = (t) => ({ Authorization: `Bearer ${t}` });
const IS_CO_NAME = "PD IncomeStmt Co";
const BS_CO_NAME = "PD BalanceSheet Co";

beforeAll(async () => {
  assertNotProductionDatabase();
  SM = await import("../../pages/REPORTS/statementModel.mjs");

  co.IS = await makeCompany(IS_CO_NAME);
  usr.IS = await makeUser("pd_is", "PdPass!1", co.IS);
  co.BS = await makeCompany(BS_CO_NAME);
  usr.BS = await makeUser("pd_bs", "PdPass!2", co.BS);

  // ---- Income Statement company: whole-month June 2027 activity ----
  await makeAccount("PD-CASH", "cash", "ASSET");
  await makeAccount("PD-REV1", "rev one", "INCOME");
  await makeAccount("PD-REV2", "rev two", "INCOME");
  await makeAccount("PD-DC1", "direct cost", "EXPENSE");
  await makeAccount("PD-OPEX1", "opex one", "EXPENSE");
  await makeAccount("PD-OPEX2", "opex two", "EXPENSE");
  await makeAccount("PD-OI1", "other income", "INCOME");
  await makeAccount("PD-TAX1", "tax", "EXPENSE");
  await makeAccount("PD-UINC1", "ungrouped income", "INCOME");
  await makeGroup("PD-G-REV1", "Bucket R1", "INCOME", "REVENUE", 10, ["PD-REV1"]);
  await makeGroup("PD-G-REV2", "Bucket R2", "INCOME", "REVENUE", 20, ["PD-REV2"]);
  await makeGroup("PD-G-DC", "Bucket DC", "EXPENSE", "DIRECT_COST", 10, ["PD-DC1"]);
  await makeGroup("PD-G-OPEX1", "Bucket OE1", "EXPENSE", "OPERATING_EXPENSE", 10, ["PD-OPEX1"]);
  await makeGroup("PD-G-OPEX2", "Bucket OE2", "EXPENSE", "OPERATING_EXPENSE", 20, ["PD-OPEX2"]);
  await makeGroup("PD-G-OI", "Bucket OI", "INCOME", "OTHER_INCOME", 10, ["PD-OI1"]);
  await makeGroup("PD-G-TAX", "Bucket TAX", "EXPENSE", "TAX_EXPENSE", 10, ["PD-TAX1"]);
  // PD-UINC1: no group.
  await jv(co.IS, "PD-I1", "2027-06-05", "PD-CASH", "PD-REV1", 6000);
  await jv(co.IS, "PD-I2", "2027-06-05", "PD-CASH", "PD-REV2", 4000);
  await jv(co.IS, "PD-I3", "2027-06-06", "PD-DC1", "PD-CASH", 3000);
  await jv(co.IS, "PD-I4", "2027-06-07", "PD-OPEX1", "PD-CASH", 1500);
  await jv(co.IS, "PD-I5", "2027-06-07", "PD-OPEX2", "PD-CASH", 500);
  await jv(co.IS, "PD-I6", "2027-06-08", "PD-CASH", "PD-OI1", 700);
  await jv(co.IS, "PD-I7", "2027-06-09", "PD-TAX1", "PD-CASH", 900);
  await jv(co.IS, "PD-I8", "2027-06-10", "PD-CASH", "PD-UINC1", 250);

  // ---- Balance Sheet company: structural (Feb) + one income (May) ----
  await makeAccount("PDB-CA1", "box 1", "ASSET");
  await makeAccount("PDB-CA2", "box 2", "ASSET");
  await makeAccount("PDB-NCA", "slow box", "ASSET");
  await makeAccount("PDB-CL", "owe soon", "LIABILITY");
  await makeAccount("PDB-NCL", "owe later", "LIABILITY");
  await makeAccount("PDB-EQ", "owners", "EQUITY");
  await makeAccount("PDB-UASSET", "bad section asset", "ASSET");
  await makeAccount("PDB-REV", "income", "INCOME");
  await makeGroup("PDB-G-CA1", "Cash and Cash Equivalents", "ASSET", "CURRENT_ASSET", 10, ["PDB-CA1"]);
  await makeGroup("PDB-G-CA2", "Trade Receivables", "ASSET", "CURRENT_ASSET", 20, ["PDB-CA2"]);
  await makeGroup("PDB-G-NCA", "Property and Equipment", "ASSET", "NON_CURRENT_ASSET", 10, ["PDB-NCA"]);
  await makeGroup("PDB-G-CL", "Accounts Payable", "LIABILITY", "CURRENT_LIABILITY", 10, ["PDB-CL"]);
  await makeGroup("PDB-G-NCL", "Long-term Loans", "LIABILITY", "NON_CURRENT_LIABILITY", 10, ["PDB-NCL"]);
  await makeGroup("PDB-G-EQ", "Paid-up Capital", "EQUITY", "EQUITY", 10, ["PDB-EQ"]);
  await makeGroup("PDB-G-BADSEC", "Misfiled", "ASSET", "OPERATING_EXPENSE", 15, ["PDB-UASSET"]);
  await makeGroup("PDB-G-REV", "Sales", "INCOME", "REVENUE", 10, ["PDB-REV"]);
  await jv(co.BS, "PDB-S1", "2027-02-01", "PDB-CA1", "PDB-EQ", 100000);
  await jv(co.BS, "PDB-S2", "2027-02-01", "PDB-CA2", "PDB-CL", 20000);
  await jv(co.BS, "PDB-S3", "2027-02-01", "PDB-NCA", "PDB-NCL", 50000);
  await jv(co.BS, "PDB-S4", "2027-02-01", "PDB-UASSET", "PDB-EQ", 3000);
  await jv(co.BS, "PDB-I1", "2027-05-01", "PDB-CA1", "PDB-REV", 1200);

  tok.IS = await login("pd_is", "PdPass!1");
  tok.BS = await login("pd_bs", "PdPass!2");
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'PD%-G-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'PD%-G-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'PD%-%'");
  await pool.query("DELETE FROM user_companies WHERE user_id IN (?, ?)", [usr.IS, usr.BS]);
  await pool.query("DELETE FROM users WHERE id IN (?, ?)", [usr.IS, usr.BS]);
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [co.IS, co.BS]);
  await pool.end();
});

// row helpers over serializeStatement().rows
const idx = (rows, label) => rows.findIndex((r) => (r.label || "").trim() === label);
const rowByLabel = (rows, label) => rows.find((r) => (r.label || "").trim() === label);
const numCells = (csv) =>
  csv
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((c) => c.replace(/^"|"$/g, ""))
    .filter((c) => /^-?\d/.test(c) && /\d\.\d/.test(c));

describe("serializer - Income Statement structure (real endpoint)", () => {
  let model, s, csv;
  beforeAll(async () => {
    const res = await request(app)
      .get("/api/reports/income-statement?view=structured&from=2027-06-01&to=2027-06-30")
      .set(H(tok.IS));
    expect(res.status).toBe(200);
    model = res.body;
    s = SM.serializeStatement(model);
    csv = SM.statementToCsv(model);
  });

  test("dynamic company name + title, no hard-coded sample", () => {
    expect(s.companyName).toBe(IS_CO_NAME);
    expect(s.title).toBe("INCOME STATEMENT - CONDENSED");
    expect(csv).not.toMatch(/CARGOHAUS/i);
  });

  test("subtitle lines are derived from the period labels", () => {
    expect(s.subtitleLines[0]).toBe("For the period ended June 2027");
    expect(s.subtitleLines[1]).toBe("With comparative figures for the month of May 2027");
  });

  test("condensed hierarchy matches the approved template order", () => {
    const order = [
      "REVENUE",
      "LESS: DIRECT COSTS",
      "GROSS PROFIT",
      "LESS: OPERATING EXPENSES",
      "TOTAL OPERATING EXPENSES",
      "NET OPERATING INCOME/(LOSS)",
      "ADD: OTHER INCOME",
      "INCOME/(LOSS) BEFORE TAX",
      "LESS: PROVISION FOR INCOME TAX",
      "NET INCOME/(LOSS)",
    ];
    const positions = order.map((l) => idx(s.rows, l));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("flow-section totals are hoisted onto the heading; only OPERATING EXPENSES has an explicit TOTAL row", () => {
    expect(rowByLabel(s.rows, "REVENUE").values.current).toBe(10000);
    expect(rowByLabel(s.rows, "LESS: DIRECT COSTS").values.current).toBe(-3000);
    expect(rowByLabel(s.rows, "ADD: OTHER INCOME").values.current).toBe(700);
    expect(rowByLabel(s.rows, "LESS: PROVISION FOR INCOME TAX").values.current).toBe(-900);
    expect(rowByLabel(s.rows, "TOTAL OPERATING EXPENSES").values.current).toBe(-2000);
    expect(s.rows.filter((r) => (r.label || "").startsWith("TOTAL REVENUE")).length).toBe(0);
  });

  test("computed totals come straight from the backend model", () => {
    expect(rowByLabel(s.rows, "GROSS PROFIT").values.current).toBe(model.computed.GROSS_PROFIT.current);
    expect(rowByLabel(s.rows, "NET OPERATING INCOME/(LOSS)").values.current).toBe(model.computed.NET_OPERATING_INCOME.current);
    expect(rowByLabel(s.rows, "INCOME/(LOSS) BEFORE TAX").values.current).toBe(model.computed.INCOME_BEFORE_TAX.current);
    expect(rowByLabel(s.rows, "NET INCOME/(LOSS)").values.current).toBe(model.computed.NET_INCOME.current);
    expect(rowByLabel(s.rows, "NET INCOME/(LOSS)").values.current).toBe(5050);
  });

  test("unclassified income section stays visible with its balance", () => {
    const h = idx(s.rows, "UNCLASSIFIED — INCOME");
    expect(h).toBeGreaterThan(-1);
    const sub = rowByLabel(s.rows, "TOTAL UNCLASSIFIED — INCOME");
    expect(sub.values.current).toBe(250);
  });

  test("CSV: column count/order = Description + 3 period columns", () => {
    const lines = csv.split("\n");
    const band = lines.find((l) => l.includes("FOR THE MONTH"));
    const period = lines.find((l) => l.startsWith('"Description"'));
    expect(band).toBe('"","FOR THE MONTH","FOR THE MONTH","TOTAL TO DATE"');
    expect(period).toBe('"Description","June 2027","May 2027","June 2027"');
  });

  test("CSV: current / previous(zero) / YTD values", () => {
    const revLine = csv.split("\n").find((l) => l.startsWith('"REVENUE"'));
    // Description, current, previous, ytd
    expect(revLine).toBe('"REVENUE","10000.00","0.00","10000.00"');
  });

  test("CSV: every numeric cell is 2dp, no currency symbol, no thousands separator", () => {
    for (const c of numCells(csv)) {
      expect(c).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(csv).not.toMatch(/[₱$]/);
  });

  test("CSV: signature rows present, names blank", () => {
    expect(csv).toMatch(/\n"Prepared By:"\n/);
    expect(csv).toMatch(/\n"Checked By:"\n/);
    expect(csv.trimEnd().endsWith('"Approved By:"')).toBe(true);
  });

  test("filename is deterministic", () => {
    expect(SM.statementFilename(model)).toBe("Income_Statement_2027-06-30.csv");
  });

  test("detailed mode expands account rows; condensed does not; totals identical", async () => {
    const res = await request(app)
      .get("/api/reports/income-statement?view=structured&from=2027-06-01&to=2027-06-30&mode=detailed")
      .set(H(tok.IS));
    const d = SM.serializeStatement(res.body);
    expect(d.rows.some((r) => r.type === "account")).toBe(true);
    expect(s.rows.some((r) => r.type === "account")).toBe(false);
    expect(rowByLabel(d.rows, "NET INCOME/(LOSS)").values.current).toBe(rowByLabel(s.rows, "NET INCOME/(LOSS)").values.current);
    expect(rowByLabel(d.rows, "TOTAL OPERATING EXPENSES").values.current).toBe(-2000);
    expect(SM.statementFilename(res.body)).toBe("Income_Statement_Detailed_2027-06-30.csv");
  });
});

describe("serializer - Balance Sheet structure (real endpoint)", () => {
  let model, s, csv, lines;
  beforeAll(async () => {
    const res = await request(app)
      .get("/api/reports/balance-sheet?view=structured&to=2027-06-30&compareTo=2027-03-31")
      .set(H(tok.BS));
    expect(res.status).toBe(200);
    model = res.body;
    s = SM.serializeStatement(model);
    csv = SM.statementToCsv(model);
    lines = csv.split("\n");
  });

  test("CSV column count/order = Description + current + comparative + DIFFERENCE", () => {
    const band = lines.find((l) => l.includes('"AS OF"'));
    const period = lines.find((l) => l.startsWith('"Description"'));
    expect(band).toBe('"","AS OF","AS OF","DIFFERENCE"');
    expect(period).toBe('"Description","June 30, 2027","March 31, 2027",""');
  });

  test("super-headings + section order", () => {
    const order = [
      "ASSETS",
      "CURRENT ASSETS",
      "TOTAL CURRENT ASSETS",
      "NON-CURRENT ASSETS",
      "TOTAL NON-CURRENT ASSETS",
      "TOTAL ASSETS",
      "LIABILITIES & SHAREHOLDERS' EQUITY",
      "CURRENT LIABILITIES",
      "TOTAL CURRENT LIABILITIES",
      "NON-CURRENT LIABILITIES",
      "TOTAL NON-CURRENT LIABILITIES",
      "TOTAL LIABILITIES",
      "SHAREHOLDERS' EQUITY",
      "TOTAL SHAREHOLDERS' EQUITY",
      "TOTAL LIABILITIES & SHAREHOLDERS' EQUITY",
    ];
    const pos = order.map((l) => idx(s.rows, l));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  test("section + computed totals come straight from the backend model", () => {
    expect(rowByLabel(s.rows, "TOTAL CURRENT ASSETS").values.current).toBe(model.sectionSubtotals.CURRENT_ASSET.current);
    expect(rowByLabel(s.rows, "TOTAL CURRENT ASSETS").values.current).toBe(121200);
    expect(rowByLabel(s.rows, "TOTAL NON-CURRENT ASSETS").values.current).toBe(50000);
    expect(rowByLabel(s.rows, "TOTAL ASSETS").values.current).toBe(model.computed.TOTAL_ASSETS.current);
    expect(rowByLabel(s.rows, "TOTAL ASSETS").values.current).toBe(174200);
    expect(rowByLabel(s.rows, "TOTAL LIABILITIES").values.current).toBe(70000);
    expect(rowByLabel(s.rows, "TOTAL SHAREHOLDERS' EQUITY").values.current).toBe(104200);
    expect(rowByLabel(s.rows, "TOTAL LIABILITIES & SHAREHOLDERS' EQUITY").values.current).toBe(174200);
  });

  test("NET INCOME/(LOSS) equity line appears exactly once, value from backend, not expanded", () => {
    const cye = s.rows.filter((r) => r.synthetic);
    expect(cye.length).toBe(1);
    expect(cye[0].label).toBe("NET INCOME/(LOSS)");
    expect(cye[0].values.current).toBe(model.currentYearEarnings.current);
    expect(cye[0].values.current).toBe(1200);
  });

  test("unclassified assets section stays visible in the CSV", () => {
    expect(csv).toMatch(/UNCLASSIFIED ASSETS/);
    expect(rowByLabel(s.rows, "TOTAL UNCLASSIFIED ASSETS").values.current).toBe(3000);
  });

  test("DIFFERENCE column = current - comparative, straight from the model", () => {
    expect(rowByLabel(s.rows, "TOTAL ASSETS").values.difference).toBe(model.computed.TOTAL_ASSETS.difference);
    expect(rowByLabel(s.rows, "TOTAL ASSETS").values.difference).toBe(1200);
  });

  test("filename deterministic", () => {
    expect(SM.statementFilename(model)).toBe("Balance_Sheet_2027-06-30.csv");
  });

  test("detailed expands accounts; group subtotals present; CYE still one line", async () => {
    const res = await request(app)
      .get("/api/reports/balance-sheet?view=structured&to=2027-06-30&compareTo=2027-03-31&mode=detailed")
      .set(H(tok.BS));
    const d = SM.serializeStatement(res.body);
    expect(d.rows.some((r) => r.type === "account")).toBe(true);
    expect(d.rows.filter((r) => r.synthetic).length).toBe(1);
    expect(rowByLabel(d.rows, "TOTAL ASSETS").values.current).toBe(174200);
    expect(SM.statementFilename(res.body)).toBe("Balance_Sheet_Detailed_2027-06-30.csv");
  });
});

describe("serializer - CSV escaping / numeric / determinism (pure models)", () => {
  const synthIS = () => ({
    statement: "INCOME_STATEMENT",
    mode: "condensed",
    meta: {
      companyName: "-danger & co",
      title: "INCOME STATEMENT - CONDENSED",
      periods: [{ key: "current", periodLabel: "Some Month 2027", from: "2027-06-01", to: "2027-06-30" }],
    },
    columns: [{ key: "current", label: "FOR THE MONTH", periodLabel: "Some Month 2027", from: "2027-06-01", to: "2027-06-30" }],
    nodes: [
      { kind: "section-heading", level: 1, section: "REVENUE", label: "REVENUE" },
      { kind: "group-line", level: 1, section: "REVENUE", groupCode: "G1", label: "=SUM(A1:A2)", values: { current: 1500 } },
      { kind: "group-line", level: 1, section: "REVENUE", groupCode: "G2", label: '+Bank "Main", HQ', values: { current: -400 } },
      { kind: "group-line", level: 1, section: "REVENUE", groupCode: "G3", label: "line one\nline two", values: { current: 0 } },
      { kind: "section-subtotal", level: 1, section: "REVENUE", label: "TOTAL REVENUE", values: { current: 1100 } },
      { kind: "computed-total", id: "NET_INCOME", label: "NET INCOME/(LOSS)", values: { current: 1100 } },
    ],
  });

  test("formula-lead text cells are apostrophe-guarded (through the indent); numeric negatives are NOT", () => {
    const csv = SM.statementToCsv(synthIS());
    expect(csv).toMatch(/"'-danger & co"/); // company name text cell (no indent)
    expect(csv).toMatch(/"' *=SUM\(A1:A2\)"/); // indented group label still guarded
    expect(csv).toMatch(/"' *\+Bank ""Main"", HQ"/); // + lead + embedded comma + doubled quotes
    expect(csv).toMatch(/"-400\.00"/); // numeric negative: plain, no apostrophe
    expect(csv).not.toMatch(/"'-400\.00"/);
  });

  test("commas / quotes / newlines stay intact inside quoted cells", () => {
    const csv = SM.statementToCsv(synthIS());
    expect(csv).toContain("line one\nline two"); // real newline preserved inside the quoted cell
    expect(csv).toMatch(/"  line one\nline two"/);
  });

  test("2-decimal formatting incl. zero and -0", () => {
    expect(SM.fmt2(0)).toBe("0.00");
    expect(SM.fmt2(-0)).toBe("0.00");
    expect(SM.fmt2(-0.0001)).toBe("0.00");
    expect(SM.fmt2(1500)).toBe("1500.00");
    expect(SM.fmt2(-400)).toBe("-400.00");
    expect(SM.fmt2(12.5)).toBe("12.50");
  });

  test("serializer output is deterministic for the same model", () => {
    const a = SM.serializeStatement(synthIS());
    const b = SM.serializeStatement(synthIS());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(SM.statementToCsv(synthIS())).toBe(SM.statementToCsv(synthIS()));
  });

  test("no hard-coded company / date / sample amount in the serializer source", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../pages/REPORTS/statementModel.mjs"), "utf8");
    expect(src).not.toMatch(/CARGOHAUS/i);
    expect(src).not.toMatch(/\b20(24|23)\b/);
    expect(src).not.toMatch(/39234323|51301516/);
  });

  test("BS-only column with no comparative -> Description + 1 column", () => {
    const bs = {
      statement: "BALANCE_SHEET",
      mode: "condensed",
      meta: { companyName: "X", title: "BALANCE SHEET - CONDENSED", asOf: [{ key: "current", periodLabel: "June 30, 2027", date: "2027-06-30" }] },
      columns: [{ key: "current", label: "AS OF", periodLabel: "June 30, 2027", date: "2027-06-30" }],
      nodes: [
        { kind: "section-heading", level: 0, section: null, label: "ASSETS" },
        { kind: "section-heading", level: 1, section: "CURRENT_ASSET", label: "CURRENT ASSETS" },
        { kind: "group-line", level: 1, section: "CURRENT_ASSET", groupCode: "G", label: "Cash", values: { current: 100 } },
        { kind: "section-subtotal", level: 1, section: "CURRENT_ASSET", label: "TOTAL CURRENT ASSETS", values: { current: 100 } },
        { kind: "computed-total", id: "TOTAL_ASSETS", label: "TOTAL ASSETS", values: { current: 100 } },
      ],
    };
    const period = SM.statementToCsv(bs).split("\n").find((l) => l.startsWith('"Description"'));
    expect(period).toBe('"Description","June 30, 2027"');
    expect(SM.statementFilename(bs)).toBe("Balance_Sheet_2027-06-30.csv");
  });
});

describe("legacy Reports CSV primitive is unchanged", () => {
  test("reportCsv.mjs still exports csvCell / rowsToCsv / downloadCsv with the same behaviour", async () => {
    const RC = await import("../../pages/REPORTS/reportCsv.mjs");
    expect(RC.csvCell('a,b"c')).toBe('"a,b""c"');
    expect(RC.rowsToCsv([["x", "y"], ["1", "2"]])).toBe('"x","y"\n"1","2"');
    expect(typeof RC.downloadCsv).toBe("function");
    // additive-only new exports
    expect(typeof RC.csvTextCell).toBe("function");
    expect(typeof RC.downloadCsvText).toBe("function");
    expect(RC.csvTextCell("=1+1")).toBe("\"'=1+1\"");
    expect(RC.csvTextCell("plain")).toBe('"plain"');
  });
});

describe("Phase G.1 - CSV UTF-8 BOM for Excel", () => {
  let RC;
  let SM;
  beforeAll(async () => {
    RC = await import("../../pages/REPORTS/reportCsv.mjs");
    SM = await import("../../pages/REPORTS/statementModel.mjs");
  });

  test("UTF8_BOM is exactly U+FEFF; withUtf8Bom() prepends it once and leaves the text intact", () => {
    expect(RC.UTF8_BOM).toHaveLength(1);
    expect(RC.UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
    const out = RC.withUtf8Bom("Description,Value\n1,2");
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("Description,Value\n1,2");
    expect(RC.withUtf8Bom(null)).toBe(RC.UTF8_BOM);
  });

  test("downloadCsvText prepends the BOM to the blob (serializer output stays BOM-free)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../../pages/REPORTS/reportCsv.mjs"), "utf8");
    expect(src).toMatch(/new Blob\(\[withUtf8Bom\(csvString\)\]/);
    // statementToCsv itself must NOT carry a BOM (pure serializer output)
    const csv = SM.statementToCsv({
      statement: "INCOME_STATEMENT",
      mode: "condensed",
      meta: { companyName: "X", title: "INCOME STATEMENT - CONDENSED", periods: [{ key: "current", periodLabel: "M", from: "2027-06-01", to: "2027-06-30" }] },
      columns: [{ key: "current", label: "FOR THE MONTH", periodLabel: "M", from: "2027-06-01", to: "2027-06-30" }],
      nodes: [{ kind: "section-heading", level: 1, section: "REVENUE", label: "REVENUE" }],
    });
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  test("the em dash in UNCLASSIFIED labels is real U+2014 and survives serialisation + BOM prepend", () => {
    const model = {
      statement: "INCOME_STATEMENT",
      mode: "condensed",
      meta: { companyName: "X", title: "INCOME STATEMENT - CONDENSED", periods: [{ key: "current", periodLabel: "M", from: "2027-06-01", to: "2027-06-30" }] },
      columns: [{ key: "current", label: "FOR THE MONTH", periodLabel: "M", from: "2027-06-01", to: "2027-06-30" }],
      nodes: [
        { kind: "section-heading", level: 1, section: null, label: "UNCLASSIFIED — INCOME", unclassified: true },
        { kind: "group-line", level: 1, section: null, groupCode: "G", label: "(no group code)", values: { current: 250 } },
        { kind: "section-subtotal", level: 1, section: null, label: "TOTAL UNCLASSIFIED — INCOME", unclassified: true, values: { current: 250 } },
      ],
    };
    const withBom = RC.withUtf8Bom(SM.statementToCsv(model));
    expect(withBom).toContain("UNCLASSIFIED — INCOME"); // real em dash, not "--" or mojibake
    expect(withBom).toContain("TOTAL UNCLASSIFIED — INCOME");
    expect(withBom).not.toMatch(/UNCLASSIFIED (--|â€")/); // no hyphen fallback, no â€" mojibake
  });

  test("formula-injection protection still applies after the BOM change", () => {
    expect(RC.csvTextCell("=SUM(A1:A2)")).toBe("\"'=SUM(A1:A2)\"");
    expect(RC.csvTextCell("  -danger")).toBe("\"'  -danger\"");
    expect(RC.csvCell("-400.00")).toBe('"-400.00"'); // numeric negative: NOT guarded
  });

  test("backend UNCLASSIFIED labels use a genuine U+2014 (not a hyphen, not mojibake)", () => {
    const svc = fs.readFileSync(
      path.join(__dirname, "../services/financialStatementStructureService.js"),
      "utf8"
    );
    expect(svc).toMatch(/heading: "UNCLASSIFIED — INCOME"/);
    expect(svc).toMatch(/subtotalLabel: "TOTAL UNCLASSIFIED — EXPENSE"/);
    expect(svc).not.toMatch(/UNCLASSIFIED â€/); // no â€ mojibake in source
  });
});
