const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const {
  buildIncomeStatement,
  buildBalanceSheet,
} = require("../services/financialStatementStructureService");
const { getCurrentYearEarnings } = require("../services/financialStatementService");

// Reports Phase A.1: the structured Balance Sheet's "Current Year Earnings"
// equity line must equal the structured Income Statement's Net Income for
// [calendar-year start .. as-of], INCLUDING income/expense accounts that
// have no coa_groups mapping. The legacy financialStatementService
// .getCurrentYearEarnings() (still used by the legacy flat report) INNER
// JOINs coa_groups and silently drops such accounts - reusing it here would
// make the structured Balance Sheet fail Assets = Liabilities + Equity.
// This suite reproduces that exact risk and pins the fixed behaviour.
//
// Self-contained fixture (own company, own accounts, all dated 2027) so it
// does not perturb financialStatementStructure.test.js.

jest.setTimeout(120000);

const P = "FSSC";
let companyId;
const acct = {};
const jvIds = [];

async function makeCompany(name) {
  const [r] = await pool.execute("INSERT INTO companies (name, status) VALUES (?, 'Active')", [name]);
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
  for (const code of codes) {
    await pool.execute(
      "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
      [acct[code], groupCode, description]
    );
  }
}
async function jv(voucherNo, date, drCode, crCode, amount) {
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

beforeAll(async () => {
  assertNotProductionDatabase();
  companyId = await makeCompany("FSSC Company");

  await makeAccount(`${P}-REV1`, "aaa", "INCOME");
  await makeAccount(`${P}-EXP1`, "bbb", "EXPENSE");
  await makeAccount(`${P}-UNG-INC`, "ungrouped income", "INCOME"); // NO group - the risk repro
  await makeAccount(`${P}-UNG-EXP`, "ungrouped expense", "EXPENSE"); // NO group
  await makeAccount(`${P}-GNULL-INC`, "grouped, section null", "INCOME");
  await makeAccount(`${P}-CASH`, "ccc", "ASSET");
  await makeAccount(`${P}-EQ`, "ddd", "EQUITY");

  await makeGroup(`${P}-G-REV`, "Rev Bucket", "INCOME", "REVENUE", 10, [`${P}-REV1`]);
  await makeGroup(`${P}-G-EXP`, "Opex Bucket", "EXPENSE", "OPERATING_EXPENSE", 10, [`${P}-EXP1`]);
  await makeGroup(`${P}-G-NULL`, "Null Section Bucket", "INCOME", null, null, [`${P}-GNULL-INC`]);
  await makeGroup(`${P}-G-CA`, "CA Bucket", "ASSET", "CURRENT_ASSET", 10, [`${P}-CASH`]);
  await makeGroup(`${P}-G-EQ`, "EQ Bucket", "EQUITY", "EQUITY", 10, [`${P}-EQ`]);

  // Structural (2027-02): pure BS-to-BS.
  await jv(`${P}-S1`, "2027-02-01", `${P}-CASH`, `${P}-EQ`, 100000);

  // IS activity (2027-05), counterparty CASH.
  await jv(`${P}-I1`, "2027-05-10", `${P}-CASH`, `${P}-REV1`, 20000); // classified revenue
  await jv(`${P}-I2`, "2027-05-10", `${P}-EXP1`, `${P}-CASH`, 5000); // classified opex
  await jv(`${P}-I3`, "2027-05-10", `${P}-CASH`, `${P}-UNG-INC`, 1500); // UNGROUPED income
  await jv(`${P}-I4`, "2027-05-10", `${P}-UNG-EXP`, `${P}-CASH`, 700); // UNGROUPED expense
  await jv(`${P}-I5`, "2027-05-10", `${P}-CASH`, `${P}-GNULL-INC`, 300); // grouped, report_section NULL
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'FSSC-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'FSSC-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'FSSC-%'");
  await pool.query("DELETE FROM companies WHERE id = ?", [companyId]);
  await pool.end();
});

const AS_OF = "2027-06-30";
const YTD_PERIOD = [{ key: "ytd", label: "YTD", from: "2027-01-01", to: AS_OF }];
const BS_COLS = [{ key: "current", label: "As of 2027-06-30", date: AS_OF }];

describe("Phase A.1 - structured BS Current Year Earnings == structured IS Net Income (ungrouped-safe)", () => {
  let is, bs, bsDetailed;
  beforeAll(async () => {
    is = await buildIncomeStatement({ companyId, mode: "condensed", periods: YTD_PERIOD });
    bs = await buildBalanceSheet({ companyId, mode: "condensed", columns: BS_COLS });
    bsDetailed = await buildBalanceSheet({ companyId, mode: "detailed", columns: BS_COLS });
  });

  test("structured IS Net Income folds in classified + unclassified + ungrouped", () => {
    expect(is.sectionSubtotals.REVENUE.ytd).toBe(20000);
    expect(is.sectionSubtotals.OPERATING_EXPENSE.ytd).toBe(-5000);
    expect(is.unclassified.INCOME.ytd).toBe(1800); // 1500 ungrouped + 300 group-section-null
    expect(is.unclassified.EXPENSE.ytd).toBe(-700); // ungrouped
    expect(is.computed.NET_INCOME.ytd).toBe(16100); // 20000 - 5000 + 1800 - 700
    expect(is.crossCheck.ok).toBe(true);
  });

  test("the ungrouped income/expense accounts are surfaced in IS readiness", () => {
    const ungrouped = is.readiness.ungroupedAccountsWithBalance.map((x) => x.accountCode);
    expect(ungrouped).toEqual(expect.arrayContaining(["FSSC-UNG-INC", "FSSC-UNG-EXP"]));
    const groupNull = is.readiness.groupUnclassifiedAccounts.map((x) => x.accountCode);
    expect(groupNull).toContain("FSSC-GNULL-INC");
  });

  test("structured BS Current Year Earnings equals structured IS Net Income for the same as-of date", () => {
    expect(bs.currentYearEarnings.current).toBe(16100);
    expect(bs.currentYearEarnings.current).toBe(is.computed.NET_INCOME.ytd);
  });

  test("Assets = Liabilities + Equity for the fixture (delta 0)", () => {
    expect(bs.balanceCheck.balanced).toBe(true);
    expect(bs.balanceCheck.byColumn.current.delta).toBe(0);
    expect(bs.computed.TOTAL_ASSETS.current).toBe(116100);
    expect(bs.computed.TOTAL_LIABILITIES_AND_EQUITY.current).toBe(116100);
  });

  test("regression proof: the legacy getCurrentYearEarnings would NOT balance here (it drops the ungrouped accounts)", async () => {
    const legacy = Number((await getCurrentYearEarnings({ companyId, to: AS_OF })) || 0);
    // legacy keeps REV1 (+20000), EXP1 (-5000), GNULL-INC (+300) - it has a
    // coa_groups row - but drops UNG-INC (+1500) and UNG-EXP (-700).
    expect(legacy).toBe(15300);
    expect(legacy).not.toBe(bs.currentYearEarnings.current);
    expect(bs.currentYearEarnings.current - legacy).toBe(800); // 1500 - 700
  });

  test("Condensed / Detailed parity is preserved (same CYE, subtotals, totals, balance check)", () => {
    expect(bsDetailed.currentYearEarnings).toEqual(bs.currentYearEarnings);
    expect(bsDetailed.sectionSubtotals).toEqual(bs.sectionSubtotals);
    expect(bsDetailed.computed).toEqual(bs.computed);
    expect(bsDetailed.balanceCheck).toEqual(bs.balanceCheck);
    // exactly one synthetic CYE line in both modes
    expect(bs.nodes.filter((n) => n.synthetic).length).toBe(1);
    expect(bsDetailed.nodes.filter((n) => n.synthetic).length).toBe(1);
  });

  test("legacy getCurrentYearEarnings itself is behaviourally unchanged (still the INNER-JOIN value)", async () => {
    const a = Number((await getCurrentYearEarnings({ companyId, to: AS_OF })) || 0);
    const b = Number((await getCurrentYearEarnings({ companyId, to: AS_OF })) || 0);
    expect(a).toBe(15300);
    expect(b).toBe(15300);
  });
});
