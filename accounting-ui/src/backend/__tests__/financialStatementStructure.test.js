const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");
const {
  buildIncomeStatement,
  buildBalanceSheet,
  chooseGroup,
  resolveSection,
} = require("../services/financialStatementStructureService");

// Reports Phase A: focused coverage for the canonical IS/BS STRUCTURE model
// (financialStatementStructureService.js). Direct service tests - no HTTP
// route exists for this yet by design. Verifies section mapping purely from
// account_group_codes.report_section (never account names), Detailed->
// Condensed parity, the safety buckets for unclassified / ungrouped /
// invalid / multi-group accounts, the IS formula chain + cross-check, the
// BS Current Year Earnings line + A = L + E balance check, company
// isolation, and deterministic output.
//
// Fixture bookkeeping: every JV is balanced and every transaction is dated
// inside calendar year 2027, so "Current Year Earnings" (year-to-as-of)
// captures the whole net result and Assets = Liabilities + Equity holds
// exactly for both as-of columns. Group descriptions and account titles are
// deliberately misleading (e.g. a DIRECT_COST group described "Revenue
// Bucket") to prove nothing keys off names.

jest.setTimeout(120000);

const P = "FSS";
let companyAId, companyBId;
const acct = {}; // code -> id
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
  return r.insertId;
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
async function linkGroup(groupCode, description, code) {
  await pool.execute(
    "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
    [acct[code], groupCode, description]
  );
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
  return h.insertId;
}

const stripGeneratedAt = (model) => {
  const { meta, ...rest } = model;
  const { generatedAt, ...metaRest } = meta;
  return { ...rest, meta: metaRest };
};
const nodeVal = (model, predicate, col = "current") => {
  const n = model.nodes.find(predicate);
  return n ? n.values[col] : undefined;
};

beforeAll(async () => {
  assertNotProductionDatabase();

  companyAId = await makeCompany("FSS Company A");
  companyBId = await makeCompany("FSS Company B");

  // ---- Income Statement accounts (classes INCOME / EXPENSE) ----
  await makeAccount(`${P}-REV1`, "ZZZ One", "INCOME");
  await makeAccount(`${P}-REV2`, "ZZZ Two", "INCOME");
  await makeAccount(`${P}-ZERO-REV`, "Never Used", "INCOME");
  await makeAccount(`${P}-OI1`, "Sundry", "INCOME");
  await makeAccount(`${P}-DC1`, "Machine", "EXPENSE");
  await makeAccount(`${P}-OPEX1`, "Admin A", "EXPENSE");
  await makeAccount(`${P}-OPEX2`, "Admin B", "EXPENSE");
  await makeAccount(`${P}-OX1`, "Sundry Loss", "EXPENSE");
  await makeAccount(`${P}-TAX1`, "Provision", "EXPENSE");
  await makeAccount(`${P}-UINC1`, "Grouped But Unclassified Income", "INCOME");
  await makeAccount(`${P}-UEXP1`, "Grouped But Unclassified Expense", "EXPENSE");

  // ---- Balance Sheet accounts (classes ASSET / LIABILITY / EQUITY) ----
  await makeAccount(`${P}-CA1`, "Box 1", "ASSET");
  await makeAccount(`${P}-CA2`, "Box 2", "ASSET");
  await makeAccount(`${P}-NCA1`, "Slow Box", "ASSET");
  await makeAccount(`${P}-CL1`, "Owe Soon", "LIABILITY");
  await makeAccount(`${P}-NCL1`, "Owe Later", "LIABILITY");
  await makeAccount(`${P}-EQ1`, "Owners", "EQUITY");
  await makeAccount(`${P}-UASSET1`, "Bad Section Asset", "ASSET");
  await makeAccount(`${P}-UASSET-NG`, "Ungrouped Asset", "ASSET");
  await makeAccount(`${P}-MG1`, "Multi Group Asset", "ASSET");
  await makeAccount(`${P}-UNREC1`, "Unrecognized Class Equity", "EQUITY");

  // ---- Group codes with report_section / display_order.
  // Names are deliberately unhelpful / misleading.
  await makeGroup(`${P}-G-REV`, "Bucket Alpha", "INCOME", "REVENUE", 10, [`${P}-REV1`, `${P}-REV2`, `${P}-ZERO-REV`]);
  await makeGroup(`${P}-G-OI`, "Bucket Beta", "INCOME", "OTHER_INCOME", 20, [`${P}-OI1`]);
  await makeGroup(`${P}-G-DC`, "Revenue Bucket", "EXPENSE", "DIRECT_COST", 10, [`${P}-DC1`]);
  await makeGroup(`${P}-G-OPEX1`, "Assets Bucket", "EXPENSE", "OPERATING_EXPENSE", 10, [`${P}-OPEX1`]);
  await makeGroup(`${P}-G-OPEX2`, "Zzz Bucket", "EXPENSE", "OPERATING_EXPENSE", null, [`${P}-OPEX2`]);
  await makeGroup(`${P}-G-OX`, "Bucket Gamma", "EXPENSE", "OTHER_EXPENSE", 30, [`${P}-OX1`]);
  await makeGroup(`${P}-G-TAX`, "Bucket Delta", "EXPENSE", "TAX_EXPENSE", 40, [`${P}-TAX1`]);
  await makeGroup(`${P}-G-UNCL2`, "Income No Section", "INCOME", null, null, [`${P}-UINC1`]);
  await makeGroup(`${P}-G-UNCL`, "Expense No Section", "EXPENSE", null, null, [`${P}-UEXP1`]);

  await makeGroup(`${P}-G-CA`, "Equity Bucket", "ASSET", "CURRENT_ASSET", 10, [`${P}-CA1`, `${P}-CA2`]);
  await makeGroup(`${P}-G-NCA`, "Bucket Epsilon", "ASSET", "NON_CURRENT_ASSET", 20, [`${P}-NCA1`]);
  await makeGroup(`${P}-G-CL`, "Bucket Zeta", "LIABILITY", "CURRENT_LIABILITY", 10, [`${P}-CL1`]);
  await makeGroup(`${P}-G-NCL`, "Bucket Eta", "LIABILITY", "NON_CURRENT_LIABILITY", 20, [`${P}-NCL1`]);
  await makeGroup(`${P}-G-EQ`, "Bucket Theta", "EQUITY", "EQUITY", 10, [`${P}-EQ1`]);
  // Group says ASSET + a section only valid for EXPENSE -> invalid mapping.
  await makeGroup(`${P}-G-BADSEC`, "Bucket Iota", "ASSET", "OPERATING_EXPENSE", 15, [`${P}-UASSET1`]);
  // Group whose account_class is not one of the 5 canonical classes.
  await makeGroup(`${P}-G-UNREC`, "Bucket Kappa", "XYZBOGUS", null, null, [`${P}-UNREC1`]);
  // Multi-group asset: chosen must be the lower display_order (5) -> CURRENT_ASSET.
  await makeGroup(`${P}-G-MGA`, "Bucket Lambda", "ASSET", "CURRENT_ASSET", 5, [`${P}-MG1`]);
  await makeGroup(`${P}-G-MGB`, "Bucket Mu", "ASSET", "NON_CURRENT_ASSET", 50, []);
  await linkGroup(`${P}-G-MGB`, "Bucket Mu", `${P}-MG1`);
  // FSS-UASSET-NG intentionally has NO coa_groups row.

  // ---- Structural balances, all dated 2027-02 (before the comparative
  // as-of 2027-03-31). Pure BS-to-BS postings. ----
  await jv(companyAId, `${P}-S1`, "2027-02-15", `${P}-CA1`, `${P}-EQ1`, 100000);
  await jv(companyAId, `${P}-S2`, "2027-02-15", `${P}-CA1`, `${P}-UNREC1`, 3000);
  await jv(companyAId, `${P}-S3`, "2027-02-16", `${P}-CA2`, `${P}-CL1`, 40000);
  await jv(companyAId, `${P}-S4`, "2027-02-16", `${P}-NCA1`, `${P}-NCL1`, 60000);
  await jv(companyAId, `${P}-S5`, "2027-02-17", `${P}-UASSET1`, `${P}-EQ1`, 7000);
  await jv(companyAId, `${P}-S6`, "2027-02-17", `${P}-MG1`, `${P}-CL1`, 5000);
  await jv(companyAId, `${P}-S7`, "2027-02-18", `${P}-UASSET-NG`, `${P}-EQ1`, 2000);

  // ---- Income Statement activity, dated 2027-06, counterparty CA1. ----
  await jv(companyAId, `${P}-I1`, "2027-06-10", `${P}-CA1`, `${P}-REV1`, 10000);
  await jv(companyAId, `${P}-I2`, "2027-06-10", `${P}-CA1`, `${P}-REV2`, 5000);
  await jv(companyAId, `${P}-I3`, "2027-06-10", `${P}-CA1`, `${P}-OI1`, 800);
  await jv(companyAId, `${P}-I4`, "2027-06-11", `${P}-DC1`, `${P}-CA1`, 6000);
  await jv(companyAId, `${P}-I5`, "2027-06-11", `${P}-OPEX1`, `${P}-CA1`, 2000);
  await jv(companyAId, `${P}-I6`, "2027-06-11", `${P}-CA1`, `${P}-OPEX2`, 500); // contra: credit to an expense
  await jv(companyAId, `${P}-I7`, "2027-06-12", `${P}-OX1`, `${P}-CA1`, 400);
  await jv(companyAId, `${P}-I8`, "2027-06-12", `${P}-TAX1`, `${P}-CA1`, 1200);
  await jv(companyAId, `${P}-I9`, "2027-06-13", `${P}-CA1`, `${P}-UINC1`, 900);
  await jv(companyAId, `${P}-I10`, "2027-06-13", `${P}-UEXP1`, `${P}-CA1`, 300);

  // ---- Company B: isolation only, one huge distinctive amount. ----
  await makeAccount(`${P}-B-CASH`, "B Cash", "ASSET");
  await makeAccount(`${P}-B-REV1`, "B Rev", "INCOME");
  await makeGroup(`${P}-G-BREV`, "Bucket Nu", "INCOME", "REVENUE", 10, [`${P}-B-CASH`, `${P}-B-REV1`]);
  await jv(companyBId, `${P}-B1`, "2027-06-10", `${P}-B-CASH`, `${P}-B-REV1`, 999999);
});

afterAll(async () => {
  await pool.query("DELETE FROM jv_lines WHERE jv_id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM jv_headers WHERE id IN (?)", [jvIds.length ? jvIds : [0]]);
  await pool.query("DELETE FROM coa_groups WHERE group_code LIKE 'FSS-%'");
  await pool.query("DELETE FROM account_group_codes WHERE group_code LIKE 'FSS-%'");
  await pool.query("DELETE FROM chart_of_accounts WHERE code LIKE 'FSS-%'");
  await pool.query("DELETE FROM companies WHERE id IN (?, ?)", [companyAId, companyBId]);
  await pool.end();
});

const IS_PERIOD = [{ key: "current", label: "June 2027", from: "2027-06-01", to: "2027-06-30" }];
const BS_COLS = [
  { key: "current", label: "As of 2027-06-30", date: "2027-06-30" },
  { key: "comparative", label: "As of 2027-03-31", date: "2027-03-31" },
];

describe("Income Statement structure model", () => {
  let condensed;
  beforeAll(async () => {
    condensed = await buildIncomeStatement({ companyId: companyAId, mode: "condensed", periods: IS_PERIOD });
  });

  test("title + statement + columns", () => {
    expect(condensed.statement).toBe("INCOME_STATEMENT");
    expect(condensed.meta.title).toBe("INCOME STATEMENT - CONDENSED");
    expect(condensed.columns.map((c) => c.key)).toEqual(["current"]);
  });

  test("all six IS report_section subtotals map from report_section, not names", () => {
    expect(condensed.sectionSubtotals.REVENUE.current).toBe(15000); // REV1 10000 + REV2 5000 (ZERO-REV omitted)
    expect(condensed.sectionSubtotals.DIRECT_COST.current).toBe(-6000);
    expect(condensed.sectionSubtotals.OPERATING_EXPENSE.current).toBe(-1500); // -2000 + 500 contra
    expect(condensed.sectionSubtotals.OTHER_INCOME.current).toBe(800);
    expect(condensed.sectionSubtotals.OTHER_EXPENSE.current).toBe(-400);
    expect(condensed.sectionSubtotals.TAX_EXPENSE.current).toBe(-1200);
  });

  test("misleading names are ignored: 'Revenue Bucket' group is DIRECT_COST; 'Assets Bucket' is OPERATING_EXPENSE", () => {
    const dcLine = condensed.nodes.find((n) => n.kind === "group-line" && n.groupCode === "FSS-G-DC");
    expect(dcLine.section).toBe("DIRECT_COST");
    expect(dcLine.values.current).toBe(-6000);
    const revLine = condensed.nodes.find((n) => n.kind === "group-line" && n.groupCode === "FSS-G-REV");
    expect(revLine.section).toBe("REVENUE");
  });

  test("zero-balance account is omitted entirely", () => {
    expect(condensed.nodes.some((n) => n.accountCode === "FSS-ZERO-REV")).toBe(false);
  });

  test("negative section subtotals are kept signed (not abs)", () => {
    expect(condensed.sectionSubtotals.DIRECT_COST.current).toBeLessThan(0);
    expect(condensed.sectionSubtotals.OPERATING_EXPENSE.current).toBeLessThan(0);
  });

  test("computed IS chain", () => {
    expect(condensed.computed.GROSS_PROFIT.current).toBe(9000); // 15000 - 6000
    expect(condensed.computed.NET_OPERATING_INCOME.current).toBe(7500); // 9000 - 1500
    expect(condensed.computed.INCOME_BEFORE_TAX.current).toBe(7900); // 7500 + 800 - 400
    expect(condensed.computed.NET_INCOME.current).toBe(7300); // 7900 + 900 - 300 - 1200
  });

  test("Net Income cross-check: stepwise == flat signed sum of all sections + unclassified", () => {
    expect(condensed.crossCheck.ok).toBe(true);
    expect(condensed.crossCheck.stepwiseNetIncome.current).toBe(condensed.crossCheck.sectionSumNetIncome.current);
    expect(condensed.crossCheck.stepwiseNetIncome.current).toBe(7300);
  });

  test("unclassified IS pseudo-sections carry balances and feed Net Income", () => {
    expect(condensed.unclassified.INCOME.current).toBe(900); // FSS-UINC1 grouped-but-unclassified
    expect(condensed.unclassified.EXPENSE.current).toBe(-300); // FSS-UEXP1 grouped-but-unclassified
    expect(condensed.nodes.some((n) => n.kind === "section-heading" && n.label === "UNCLASSIFIED — INCOME")).toBe(true);
    expect(condensed.nodes.some((n) => n.kind === "section-heading" && n.label === "UNCLASSIFIED — EXPENSE")).toBe(true);
  });

  test("display_order ordering within OPERATING_EXPENSE: 10 before NULL", () => {
    const order = condensed.nodes
      .filter((n) => n.kind === "group-line" && n.section === "OPERATING_EXPENSE")
      .map((n) => n.groupCode);
    expect(order).toEqual(["FSS-G-OPEX1", "FSS-G-OPEX2"]);
  });

  test("account-code ordering within a group (detailed)", async () => {
    const detailed = await buildIncomeStatement({ companyId: companyAId, mode: "detailed", periods: IS_PERIOD });
    const codes = detailed.nodes
      .filter((n) => n.kind === "account-line" && n.groupCode === "FSS-G-REV")
      .map((n) => n.accountCode);
    expect(codes).toEqual(["FSS-REV1", "FSS-REV2"]);
  });

  test("Condensed is a faithful roll-up of Detailed (identical subtotals + totals)", async () => {
    const detailed = await buildIncomeStatement({ companyId: companyAId, mode: "detailed", periods: IS_PERIOD });
    expect(detailed.sectionSubtotals).toEqual(condensed.sectionSubtotals);
    expect(detailed.computed).toEqual(condensed.computed);
    expect(detailed.crossCheck.stepwiseNetIncome).toEqual(condensed.crossCheck.stepwiseNetIncome);
    expect(detailed.unclassified).toEqual(condensed.unclassified);
    // detailed exposes account lines; condensed does not
    expect(detailed.nodes.some((n) => n.kind === "account-line")).toBe(true);
    expect(condensed.nodes.some((n) => n.kind === "account-line")).toBe(false);
  });

  test("company isolation: Company A never sees Company B's 999999", async () => {
    expect(condensed.sectionSubtotals.REVENUE.current).toBe(15000);
    expect(JSON.stringify(condensed.nodes)).not.toContain("999999");
  });

  test("deterministic: two builds produce identical structure", async () => {
    const a = await buildIncomeStatement({ companyId: companyAId, mode: "condensed", periods: IS_PERIOD });
    const b = await buildIncomeStatement({ companyId: companyAId, mode: "condensed", periods: IS_PERIOD });
    expect(stripGeneratedAt(a)).toEqual(stripGeneratedAt(b));
  });
});

describe("Balance Sheet structure model", () => {
  let condensed;
  beforeAll(async () => {
    condensed = await buildBalanceSheet({
      companyId: companyAId,
      mode: "condensed",
      columns: BS_COLS,
      withDifference: true,
    });
  });

  test("title + difference column", () => {
    expect(condensed.meta.title).toBe("BALANCE SHEET - CONDENSED");
    expect(condensed.columns.map((c) => c.key)).toEqual(["current", "comparative", "difference"]);
  });

  test("all five BS report_section subtotals (current column)", () => {
    expect(condensed.sectionSubtotals.CURRENT_ASSET.current).toBe(155300); // CA1 110300 + CA2 40000 + MG1 5000
    expect(condensed.sectionSubtotals.NON_CURRENT_ASSET.current).toBe(60000);
    expect(condensed.sectionSubtotals.CURRENT_LIABILITY.current).toBe(45000);
    expect(condensed.sectionSubtotals.NON_CURRENT_LIABILITY.current).toBe(60000);
    expect(condensed.sectionSubtotals.EQUITY.current).toBe(116300); // EQ1 109000 + CYE 7300
  });

  test("Current Year Earnings is a synthetic Equity line, per column, matching IS net income", () => {
    expect(condensed.currentYearEarnings.current).toBe(7300);
    expect(condensed.currentYearEarnings.comparative).toBe(0);
    const cye = condensed.nodes.find((n) => n.kind === "group-line" && n.synthetic);
    expect(cye.label).toBe("NET INCOME/(LOSS)");
    expect(cye.section).toBe("EQUITY");
    expect(cye.values.current).toBe(7300);
    // exactly one synthetic line, in both modes
    expect(condensed.nodes.filter((n) => n.synthetic).length).toBe(1);
  });

  test("unclassified BS buckets carry balances and feed the grand totals", () => {
    expect(condensed.unclassified.ASSET.current).toBe(9000); // UASSET1 7000 (invalid section) + UASSET-NG 2000 (ungrouped)
    expect(condensed.unclassified.EQUITY.current).toBe(3000); // UNREC1 (unrecognized class group)
    expect(condensed.unclassified.LIABILITY.current).toBe(0);
  });

  test("A = L + E balance check (both columns), delta 0", () => {
    expect(condensed.balanceCheck.balanced).toBe(true);
    expect(condensed.balanceCheck.byColumn.current.delta).toBe(0);
    expect(condensed.balanceCheck.byColumn.comparative.delta).toBe(0);
    expect(condensed.computed.TOTAL_ASSETS.current).toBe(224300);
    expect(condensed.computed.TOTAL_LIABILITIES_AND_EQUITY.current).toBe(224300);
    expect(condensed.computed.TOTAL_ASSETS.comparative).toBe(217000);
    expect(condensed.computed.TOTAL_LIABILITIES_AND_EQUITY.comparative).toBe(217000);
  });

  test("DIFFERENCE column = current - comparative", () => {
    expect(condensed.computed.TOTAL_ASSETS.difference).toBe(7300);
    expect(condensed.sectionSubtotals.CURRENT_ASSET.difference).toBe(7300);
    expect(condensed.sectionSubtotals.EQUITY.difference).toBe(7300);
  });

  test("multi-group asset is counted once (in CURRENT_ASSET, not NON_CURRENT_ASSET)", async () => {
    const detailed = await buildBalanceSheet({ companyId: companyAId, mode: "detailed", columns: BS_COLS, withDifference: true });
    const mgLines = detailed.nodes.filter((n) => n.kind === "account-line" && n.accountCode === "FSS-MG1");
    expect(mgLines.length).toBe(1);
    expect(mgLines[0].section).toBe("CURRENT_ASSET");
  });

  test("Condensed is a faithful roll-up of Detailed (identical subtotals + totals + balance check)", async () => {
    const detailed = await buildBalanceSheet({ companyId: companyAId, mode: "detailed", columns: BS_COLS, withDifference: true });
    expect(detailed.sectionSubtotals).toEqual(condensed.sectionSubtotals);
    expect(detailed.computed).toEqual(condensed.computed);
    expect(detailed.currentYearEarnings).toEqual(condensed.currentYearEarnings);
    expect(detailed.balanceCheck).toEqual(condensed.balanceCheck);
    expect(detailed.unclassified).toEqual(condensed.unclassified);
  });

  test("deterministic: two builds produce identical structure", async () => {
    const a = await buildBalanceSheet({ companyId: companyAId, mode: "condensed", columns: BS_COLS, withDifference: true });
    const b = await buildBalanceSheet({ companyId: companyAId, mode: "condensed", columns: BS_COLS, withDifference: true });
    expect(stripGeneratedAt(a)).toEqual(stripGeneratedAt(b));
  });
});

describe("readiness diagnostics in the statement model", () => {
  let is, bs;
  beforeAll(async () => {
    is = await buildIncomeStatement({ companyId: companyAId, mode: "condensed", periods: IS_PERIOD });
    bs = await buildBalanceSheet({ companyId: companyAId, mode: "condensed", columns: BS_COLS, withDifference: true });
  });

  test("base readiness fields preserved (backward compatible)", () => {
    for (const k of ["total", "classified", "unclassified", "unclassifiedGroupCodes", "invalid", "ready"]) {
      expect(is.readiness).toHaveProperty(k);
    }
  });

  test("unrecognizedGroupClass surfaces the XYZBOGUS group", () => {
    const codes = bs.readiness.unrecognizedGroupClass.map((x) => x.groupCode);
    expect(codes).toContain("FSS-G-UNREC");
  });

  test("ungroupedAccountsWithBalance surfaces the account with no coa_groups row", () => {
    const codes = bs.readiness.ungroupedAccountsWithBalance.map((x) => x.accountCode);
    expect(codes).toContain("FSS-UASSET-NG");
  });

  test("invalidSectionMappings surfaces the ASSET group carrying an EXPENSE-only section", () => {
    const hit = bs.readiness.invalidSectionMappings.find((x) => x.accountCode === "FSS-UASSET1");
    expect(hit).toBeTruthy();
    expect(hit.reason).toBe("INVALID_SECTION_FOR_CLASS");
  });

  test("multiGroupMappings records the shadowed group, deterministically chosen by display_order", () => {
    const hit = bs.readiness.multiGroupMappings.find((x) => x.accountCode === "FSS-MG1");
    expect(hit).toEqual({
      accountCode: "FSS-MG1",
      chosenGroupCode: "FSS-G-MGA",
      shadowedGroupCodes: ["FSS-G-MGB"],
    });
  });

  test("groupUnclassifiedAccounts surfaces income/expense accounts whose group has no section", () => {
    const codes = is.readiness.groupUnclassifiedAccounts.map((x) => x.accountCode);
    expect(codes).toEqual(expect.arrayContaining(["FSS-UINC1", "FSS-UEXP1"]));
  });
});

describe("pure helpers", () => {
  test("chooseGroup: lowest non-null display_order wins, then group_code", () => {
    const rows = [
      { group_code: "B", agc_desc: "b", report_section: "CURRENT_ASSET", display_order: 20, group_status: "ACTIVE" },
      { group_code: "A", agc_desc: "a", report_section: "NON_CURRENT_ASSET", display_order: 10, group_status: "ACTIVE" },
      { group_code: "C", agc_desc: "c", report_section: null, display_order: null, group_status: "ACTIVE" },
    ];
    const { chosen, shadowed } = chooseGroup(rows);
    expect(chosen.groupCode).toBe("A");
    expect(shadowed.map((s) => s.groupCode)).toEqual(["B", "C"]);
  });

  test("chooseGroup: NULL display_order tie-breaks by group_code", () => {
    const rows = [
      { group_code: "Z", agc_desc: "z", report_section: null, display_order: null, group_status: "ACTIVE" },
      { group_code: "M", agc_desc: "m", report_section: "EQUITY", display_order: null, group_status: "ACTIVE" },
    ];
    expect(chooseGroup(rows).chosen.groupCode).toBe("M");
  });

  test("chooseGroup: no group rows -> null", () => {
    expect(chooseGroup([{ group_code: null }]).chosen).toBeNull();
  });

  test("resolveSection: reasons", () => {
    expect(resolveSection("ASSET", null).reason).toBe("UNGROUPED");
    expect(resolveSection("ASSET", { reportSection: null }).reason).toBe("GROUP_UNCLASSIFIED");
    expect(resolveSection("ASSET", { reportSection: "MYSTERY" }).reason).toBe("UNKNOWN_SECTION");
    expect(resolveSection("ASSET", { reportSection: "OPERATING_EXPENSE" }).reason).toBe("INVALID_SECTION_FOR_CLASS");
    expect(resolveSection("ASSET", { reportSection: "CURRENT_ASSET" }).section).toBe("CURRENT_ASSET");
  });
});
