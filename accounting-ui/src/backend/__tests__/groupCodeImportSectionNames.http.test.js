// Task 2 - Group Codes import: Report Section by Code OR Name.
// Reproduces the ALAS File Setup report (19 rows read, 2 ready, 17 skipped):
// accountants typed Report Section NAMES as the Report Section List shows them
// ("Operating Expenses", "Intrabranch - Out"), and only upper-cased CODES were
// accepted. Now: code or name, any case, extra spaces ignored; class, ACTIVE
// and ambiguity still enforced; every refused row has a specific reason;
// preview == confirm; one transaction; re-import never duplicates.
// Local test database only. Group codes TGCS-*, report sections TGCS_* plus
// the ALAS-style custom names (created only if absent, removed afterwards).
const request = require("supertest");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const ReportSectionService = require("../services/reportSectionService");

jest.setTimeout(180000);

const PASS = "Tgcs!Pass1";
const HEADERS = ["Group Code*", "Group Description*", "Account Class*", "Report Section", "Display Order", "Status"];
const CUSTOM = [
  // ALAS-style sections created through Report Sections (custom codes + names)
  ["TGCS_INTRABRANCH_OUT", "Intrabranch - Out", "EXPENSE", "ACTIVE"],
  ["TGCS_PLATFORM_FEE_OUT", "Platform fee - Out", "EXPENSE", "ACTIVE"],
  ["TGCS_BUDGETARY", "Budgetary Services", "INCOME", "ACTIVE"],
  ["TGCS_RETIRED", "TGCS Retired Out", "EXPENSE", "INACTIVE"],
];
let companyId, adminId, token;
const createdSectionIds = [];

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Group Codes");
  [HEADERS, ...rows].forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const preview = (buf) => request(app).post("/api/group-codes/import/preview").set("Authorization", `Bearer ${token}`).attach("file", buf, "group-codes.xlsx");
const confirm = (buf) => request(app).post("/api/group-codes/import").set("Authorization", `Bearer ${token}`).attach("file", buf, "group-codes.xlsx");
const stored = async () => (await pool.query("SELECT group_code, account_class, report_section, group_description FROM account_group_codes WHERE group_code LIKE 'TGCS-%' ORDER BY group_code"))[0];

// The reported scenario: 19 data rows (sheet rows 2-20).
const ROWS = [
  ["TGCS-01", "Cash and Cash Equivalents", "ASSET", "Current Assets"], // 2  name
  ["TGCS-02", "Receivables", "ASSET", "current assets"], // 3  name, lower case
  ["TGCS-03", "Trade Payables", "LIABILITY", "  Current   Liabilities "], // 4  name, odd spacing
  ["TGCS-04", "Capital", "EQUITY", "Equity"], // 5
  ["TGCS-05", "Service Income", "INCOME", "Revenue"], // 6
  ["TGCS-06", "Budgetary Services", "INCOME", "Budgetary Services"], // 7  custom name
  ["TGCS-07", "Salaries", "EXPENSE", "Operating Expenses"], // 8
  ["TGCS-08", "Direct Labor", "EXPENSE", "Direct Costs"], // 9
  ["TGCS-09", "Intrabranch charges", "EXPENSE", "Intrabranch - Out"], // 10 custom name
  ["TGCS-10", "Platform fees", "EXPENSE", "Platform fee - Out"], // 11 custom name
  ["TGCS-11", "Utilities", "EXPENSE", "OPERATING_EXPENSE"], // 12 code
  ["TGCS-12", "Rent", "EXPENSE", "operating_expense"], // 13 code, lower case
  ["TGCS-13", "Unclassified asset", "ASSET", ""], // 14 blank section (allowed)
  ["TGCS-14", "Penalties", "expense", "Other Expenses"], // 15 class in lower case
  // refused rows - each with a specific reason
  ["TGCS-15", "Wrong class", "ASSET", "Operating Expenses"], // 16 another class's section
  ["TGCS-16", "Unknown section", "EXPENSE", "Not A Section"], // 17 not in the list
  ["tgcs-07", "Duplicate in file", "EXPENSE", "Operating Expenses"], // 18 duplicate of row 8 (case-insensitive)
  ["TGCS-18", "Inactive section", "EXPENSE", "TGCS Retired Out"], // 19 INACTIVE section
  ["TGCS-EXISTING", "Already there", "ASSET", "Current Assets"], // 20 code already exists
];

beforeAll(async () => {
  assertNotProductionDatabase();
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'TGCS-%'");
  await pool.query("DELETE FROM users WHERE username = 'tgcs_admin'");
  const [co] = await pool.query("INSERT INTO companies (name, status) VALUES ('TGCS Section Names Co', 'Active')");
  companyId = co.insertId;
  const [u] = await pool.query("INSERT INTO users (username, password, role_id, status) VALUES ('tgcs_admin', ?, (SELECT id FROM roles WHERE code = 'ADMIN'), 'ACTIVE')", [await bcrypt.hash(PASS, 10)]);
  adminId = u.insertId;
  await pool.query("INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)", [adminId, companyId]);
  token = (await request(app).post("/api/login").set("X-Forwarded-For", "10.232.0.1").send({ username: "tgcs_admin", password: PASS })).body.token;
  for (const [code, name, cls, status] of CUSTOM) {
    const [[exists]] = await pool.query("SELECT COUNT(*) c FROM report_sections WHERE code = ? OR (name = ? AND account_class = ?)", [code, name, cls]);
    if (Number(exists.c) === 0) {
      const [r] = await pool.query("INSERT INTO report_sections (code, name, account_class, display_order, status) VALUES (?, ?, ?, NULL, ?)", [code, name, cls, status]);
      createdSectionIds.push(r.insertId);
    }
  }
  await pool.query("INSERT INTO account_group_codes (group_code, group_description, account_class, status) VALUES ('TGCS-EXISTING', 'Pre-existing', 'ASSET', 'ACTIVE')");
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'TGCS-%'");
    if (createdSectionIds.length) await pool.query("DELETE FROM report_sections WHERE id IN (?)", [createdSectionIds]);
    await pool.query("DELETE FROM audit_logs WHERE user_id = ?", [adminId]);
    await pool.query("DELETE FROM user_companies WHERE user_id = ?", [adminId]);
    await pool.query("DELETE FROM users WHERE id = ?", [adminId]);
    await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  } finally {
    await pool.end();
  }
});

describe("the reported 19-row file", () => {
  let buf;
  beforeAll(async () => { buf = await xlsx(ROWS); });

  test("preview: 19 rows, 14 ready, 5 refused - each with a specific reason", async () => {
    const res = await preview(buf);
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(19);
    expect(res.body.readyCount).toBe(14);
    const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.row, s.reason]));
    expect(Object.keys(reasons).map(Number)).toEqual([16, 17, 18, 19, 20]);
    expect(reasons[16]).toMatch(/"Operating Expenses" \(OPERATING_EXPENSE\) belongs to account class EXPENSE, so it is not valid for account class ASSET/);
    expect(reasons[17]).toMatch(/"Not A Section" was not found in the Report Section List/);
    expect(reasons[18]).toBe("Group Code is a duplicate of an earlier row in this file.");
    expect(reasons[19]).toMatch(/"TGCS Retired Out" \(TGCS_RETIRED\) is INACTIVE/);
    expect(reasons[20]).toBe("Group Code already exists.");
  });

  test("ready rows carry the canonical section CODE (names resolved, never remapped across classes)", async () => {
    const res = await preview(buf);
    const byCode = Object.fromEntries(res.body.ready.map((r) => [r.groupCode, r.reportSection]));
    expect(byCode).toEqual({
      "TGCS-01": "CURRENT_ASSET", "TGCS-02": "CURRENT_ASSET", "TGCS-03": "CURRENT_LIABILITY", "TGCS-04": "EQUITY",
      "TGCS-05": "REVENUE", "TGCS-06": "TGCS_BUDGETARY", "TGCS-07": "OPERATING_EXPENSE", "TGCS-08": "DIRECT_COST",
      "TGCS-09": "TGCS_INTRABRANCH_OUT", "TGCS-10": "TGCS_PLATFORM_FEE_OUT", "TGCS-11": "OPERATING_EXPENSE",
      "TGCS-12": "OPERATING_EXPENSE", "TGCS-13": null, "TGCS-14": "OTHER_EXPENSE",
    });
  });

  test("preview writes nothing; confirm imports exactly the 14 previewed rows in one batch", async () => {
    expect((await stored()).map((r) => r.group_code)).toEqual(["TGCS-EXISTING"]);
    const res = await confirm(buf);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(14);
    expect(res.body.skippedCount).toBe(5);
    const rows = await stored();
    expect(rows).toHaveLength(15);
    expect(rows.find((r) => r.group_code === "TGCS-09")).toMatchObject({ account_class: "EXPENSE", report_section: "TGCS_INTRABRANCH_OUT", group_description: "Intrabranch charges" });
    expect(rows.find((r) => r.group_code === "TGCS-14").account_class).toBe("EXPENSE");
    expect(rows.find((r) => r.group_code === "TGCS-EXISTING").group_description).toBe("Pre-existing"); // never overwritten
  });

  test("confirming the same file again imports nothing and duplicates nothing", async () => {
    const res = await confirm(buf);
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skippedCount).toBe(19);
    expect(await stored()).toHaveLength(15);
  });
});

describe("the same resolution in the manual form API", () => {
  afterAll(() => pool.query("DELETE FROM account_group_codes WHERE group_code IN ('TGCS-F1', 'TGCS-F2')"));
  test("POST /api/group-codes accepts a section NAME and stores its code; another class's name is refused", async () => {
    const ok = await request(app).post("/api/group-codes").set("Authorization", `Bearer ${token}`)
      .send({ groupCode: "TGCS-F1", groupDescription: "Form", accountClass: "EXPENSE", reportSection: "intrabranch - out", status: "ACTIVE" });
    expect(ok.status).toBe(200);
    const [[row]] = await pool.query("SELECT report_section FROM account_group_codes WHERE group_code = 'TGCS-F1'");
    expect(row.report_section).toBe("TGCS_INTRABRANCH_OUT");
    const bad = await request(app).post("/api/group-codes").set("Authorization", `Bearer ${token}`)
      .send({ groupCode: "TGCS-F2", groupDescription: "Form", accountClass: "INCOME", reportSection: "Intrabranch - Out", status: "ACTIVE" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/belongs to account class EXPENSE, so it is not valid for account class INCOME/);
  });
});

describe("resolver rules (pure, with a supplied list)", () => {
  const list = [
    { code: "AMB_ONE", name: "Shared Label", accountClass: "EXPENSE", status: "ACTIVE" },
    { code: "SHARED LABEL", name: "Other", accountClass: "EXPENSE", status: "ACTIVE" },
    { code: "REV_X", name: "Shared Label", accountClass: "INCOME", status: "ACTIVE" },
  ];
  test("a value that is one section's code and another's name in the same class is ambiguous, never guessed", async () => {
    const r = await ReportSectionService.resolveReportSectionInput("shared label", "EXPENSE", list);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ambiguous for account class EXPENSE/);
  });
  test("the same name in another class resolves within the row's class only", async () => {
    expect(await ReportSectionService.resolveReportSectionInput("Shared Label", "INCOME", list)).toEqual({ ok: true, code: "REV_X" });
  });
  test("blank stays unclassified", async () => {
    expect(await ReportSectionService.resolveReportSectionInput("   ", "ASSET", list)).toEqual({ ok: true, code: null });
  });
});
