// Dashboard helpers (utils/dashboardModel.mjs) and source guards on the
// dashboard page. The figures themselves are tested end to end in
// backend/__tests__/dashboardSummary.http.test.js.
const fs = require("fs");
const path = require("path");

let m;
beforeAll(async () => {
  m = await import("../dashboardModel.mjs");
});

const page = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "DASHBOARD", "dashboard.jsx"), "utf8");

describe("periods", () => {
  test("todayLocal uses the local calendar, not UTC", () => {
    // 2026-11-10 07:30 in Manila is still 2026-11-09 in UTC.
    const d = new Date(2026, 10, 10, 7, 30);
    expect(m.todayLocal(d)).toBe("2026-11-10");
  });

  test.each([
    ["today", { from: "2026-11-10", to: "2026-11-10" }],
    ["week", { from: "2026-11-09", to: "2026-11-10" }], // Monday start
    ["month", { from: "2026-11-01", to: "2026-11-10" }],
    ["quarter", { from: "2026-10-01", to: "2026-11-10" }],
    ["year", { from: "2026-01-01", to: "2026-11-10" }],
  ])("preset %s ends today", (preset, range) => {
    expect(m.presetRange(preset, "2026-11-10")).toEqual(range);
  });

  test("a Sunday belongs to the week that started the Monday before", () => {
    expect(m.presetRange("week", "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });

  test("custom ranges are validated like the server does", () => {
    expect(m.validateRange({ from: "2026-01-01", to: "2026-03-31" })).toBe("");
    expect(m.validateRange({ from: "", to: "2026-03-31" })).toMatch(/both dates/);
    expect(m.validateRange({ from: "2026-02-30", to: "2026-03-31" })).toMatch(/both dates/);
    expect(m.validateRange({ from: "2026-04-01", to: "2026-03-31" })).toMatch(/on or before/);
    expect(m.validateRange({ from: "2020-01-01", to: "2026-03-31" })).toMatch(/five years/);
  });
});

describe("formatting", () => {
  test("money uses the company currency symbol and keeps the sign", () => {
    expect(m.formatMoney(1234.5, { code: "PHP", symbol: "₱" })).toBe("₱1,234.50");
    expect(m.formatMoney(-300, { code: "USD", symbol: "$" })).toBe("-$300.00");
    expect(m.formatMoney(0, { code: "PHP", symbol: "₱" })).toBe("₱0.00");
    expect(m.formatMoney(10, { code: "JPY" })).toBe("JPY 10.00");
    expect(m.formatMoney(null)).toBe("-");
  });

  test("chart labels per granularity", () => {
    expect(m.bucketLabel({ from: "2026-03-01" }, "month")).toBe("Mar 26");
    expect(m.bucketLabel({ from: "2026-08-01" }, "quarter")).toBe("Q3 2026");
    expect(m.bucketLabel({ from: "2026-03-09" }, "week")).toBe("Mar 9");
    expect(m.formatCompact(1532000)).toBe("1.5M");
  });
});

describe("section state - zero is data, a failure is not", () => {
  const ok = { status: "ready", data: { sections: { income: { status: "ok", revenue: 0 } } } };
  test("ok with a real zero", () => {
    expect(m.sectionState(ok, "income")).toEqual({ kind: "ok", data: { status: "ok", revenue: 0 }, stale: false });
  });
  test("request failure, section failure, forbidden, loading, idle", () => {
    expect(m.sectionState({ status: "error", data: null, message: "x" }, "income").kind).toBe("error");
    expect(m.sectionState({ status: "ready", data: { sections: { income: { status: "error" } } } }, "income").kind).toBe("error");
    expect(m.sectionState({ status: "ready", data: { sections: {} } }, "income").kind).toBe("error");
    expect(m.sectionState({ status: "ready", data: { sections: { income: { status: "forbidden" } } } }, "income").kind).toBe("forbidden");
    expect(m.sectionState({ status: "loading", data: null }, "income").kind).toBe("loading");
    expect(m.sectionState({ status: "idle", data: null }, "income").kind).toBe("idle");
    expect(m.sectionState({ ...ok, status: "loading" }, "income").stale).toBe(true);
    // a specific branch must be chosen first (no consolidation permission)
    expect(m.sectionState({ status: "branch", data: null, message: "x" }, "income").kind).toBe("branch");
  });
});

describe("layout", () => {
  const ids = ["a", "b", "c"];
  test("saved layouts are cleaned, never trusted", () => {
    expect(m.sanitizeLayout(["c", "x", "a", "c", 5], ids, ["a"])).toEqual(["c", "a"]);
    expect(m.sanitizeLayout(null, ids, ["a", "b"])).toEqual(["a", "b"]);
    expect(m.sanitizeLayout("oops", ids, ["a"])).toEqual(["a"]);
    expect(m.sanitizeLayout([], ids, ["a"])).toEqual([]);
  });
  test("move up / down", () => {
    expect(m.moveItem(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(m.moveItem(["a", "b", "c"], "c", "down")).toEqual(["a", "b", "c"]);
  });
});

describe("derived views use only server figures", () => {
  const sections = {
    income: { status: "ok", revenue: 1500, netIncome: 1200, netMargin: 80 },
    balance: { status: "ok", totalLiabilities: 490, totalEquity: 2000 },
    cash: { status: "ok", endingBalance: 3200, accounts: [{}] },
    receivables: { status: "ok", total: 950, overdue: 700, overdueCount: 1, dueWithin7: 700, dueWithin30: 950 },
    payables: { status: "ok", total: 490, overdue: 400, dueSoon: 0, dueWithin7: 400, dueWithin30: 490 },
  };

  test("cash outlook = balance + receivables due - payables due", () => {
    expect(m.cashOutlook(sections)).toEqual({
      current: 3200,
      horizons: [
        { days: 7, inflow: 700, outflow: 400, position: 3500 },
        { days: 30, inflow: 950, outflow: 490, position: 3660 },
      ],
    });
    expect(m.cashOutlook({ ...sections, payables: { status: "forbidden" } })).toBeNull();
  });

  test("indicators are ratios of those figures; n/a when dividing by zero", () => {
    const byId = Object.fromEntries(m.financialIndicators(sections).map((i) => [i.id, i.value]));
    expect(byId).toEqual({ netMargin: 80, debtToEquity: 24.5, arOverdue: 73.68, apOverdue: 81.63, cashCover: 653.06 });
    const zero = m.financialIndicators({ ...sections, receivables: { status: "ok", total: 0, overdue: 0 } });
    expect(zero.find((i) => i.id === "arOverdue").value).toBeNull();
    expect(m.financialIndicators({ income: { status: "forbidden" } })).toEqual([]);
  });

  test("summary lines quote the summary and nothing else", () => {
    const lines = m.summaryLines({ meta: { to: "2026-11-10", currency: { code: "PHP", symbol: "₱" } }, sections });
    expect(lines.map((l) => l.title)).toEqual(["Profit", "Cash", "Collections", "Payables"]);
    expect(lines[0].text).toBe("Revenue ₱1,500.00, net income ₱1,200.00 for the period.");
    expect(m.summaryLines({ meta: {}, sections: { income: { status: "forbidden" } } })).toEqual([]);
  });
});

describe("dashboard page", () => {
  test("no hardcoded money, percentages or invented activity", () => {
    expect(page).not.toMatch(/₱\s?\d/);
    expect(page).not.toMatch(/\b\d{2,3}%/);
    expect(page).not.toMatch(/AI confidence|Last scan: Just now|forecasted collection|ABC Trading|APV-0008/);
  });

  test("every figure comes from the summary endpoint with the selected company, branch and period", () => {
    expect(page).toMatch(/\/api\/dashboard\/summary\?\$\{qs\}/);
    expect(page).toContain("const qs = dashboardSummaryQuery({ companyId, from: period.from, to: period.to, branch: branchValue });");
    expect(page).toContain("dashboardCompanyChoice({ companies: list, current })");
    expect(page).toMatch(/guard\.current\.isCurrent\(ticket\)/);
  });

  test("quick actions route to existing pages", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "..", "App.jsx"), "utf8");
    const block = page.slice(page.indexOf("const QUICK_ACTIONS"), page.indexOf("];", page.indexOf("const QUICK_ACTIONS")));
    const paths = [...block.matchAll(/path: "([^"]+)"/g)].map((x) => x[1]);
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const p of paths) expect(app).toContain(`path="${p}"`);
  });

  test("every widget id stays, and layout / period are saved only through the per-user helpers", () => {
    for (const id of ["aiAssistant", "revenue", "profit", "cashForecast", "receivables", "payables", "bankAccounts", "financialHealth", "aiAlerts", "quickActions", "recentActivity", "systemStatus"]) {
      expect(page).toContain(`id: "${id}"`);
    }
    expect(page).toMatch(/writeUserLayout\(browserStorage\(\), userId, next\)/);
    expect(page).toMatch(/writeUserPeriod\(browserStorage\(\), userId, next\)/);
    // no unscoped key is read or written any more
    expect(page).not.toMatch(/"astrea_ai_dashboard_widgets"|"astrea_dashboard_period"/);
    expect(page).not.toMatch(/localStorage\.setItem/);
  });

  test("the signed-in user confirmed by /api/me/permissions decides whose layout is shown", () => {
    expect(page).toMatch(/const confirmedId = me\?\.user\?\.id \? String\(me\.user\.id\) : "";/);
    expect(page).toMatch(/readUserLayout\(storage, confirmedId, LIBRARY_IDS, DEFAULT_WIDGETS\)/);
  });

  test("navigation is filtered by permission (Quick Actions, summary buttons, alerts)", () => {
    expect(page).toMatch(/QUICK_ACTIONS\.filter\(\(a\) => canOpen\(access, a\.path\)\)/);
    expect(page).toMatch(/SUMMARY_LINKS\.filter\(\(l\) => canOpen\(access, l\.path\)\)/);
    expect(page).toMatch(/canOpen\(access, alert\.link\)/);
    expect(page).toMatch(/canOpen\(access, "\/reports\/account-analysis"\)/);
  });

  test("Recent Transactions and Activity say they are not limited to the period", () => {
    expect(page).toMatch(/not limited to the dashboard period/);
    expect(page).toMatch(/Latest records · not limited to the period/);
  });
});

// In-memory stand-in for one browser's localStorage, shared by two users.
function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    keys: () => [...data.keys()],
  };
}

describe("per-user layout and period on one shared browser", () => {
  const LIB = ["a", "b", "c", "d"];
  const DEF = ["a", "b", "c"];

  test("two users never share arrangement, hidden widgets or period", () => {
    const storage = fakeStorage();
    // user 7 hides "b", moves "c" first, picks This Year
    m.writeUserLayout(storage, 7, ["c", "a"]);
    m.writeUserPeriod(storage, 7, { preset: "year", from: "2026-01-01", to: "2026-11-10" });
    // user 9 adds "d" and picks a custom range
    m.writeUserLayout(storage, 9, ["a", "b", "c", "d"]);
    m.writeUserPeriod(storage, 9, { preset: "custom", from: "2026-06-01", to: "2026-06-30" });

    expect(m.readUserLayout(storage, 7, LIB, DEF)).toEqual(["c", "a"]);
    expect(m.readUserLayout(storage, 9, LIB, DEF)).toEqual(["a", "b", "c", "d"]);
    expect(m.readUserPeriod(storage, 7, "2026-11-10")).toEqual({ preset: "year", from: "2026-01-01", to: "2026-11-10" });
    expect(m.readUserPeriod(storage, 9, "2026-11-10")).toEqual({ preset: "custom", from: "2026-06-01", to: "2026-06-30" });
    // a third user on the same browser starts from the defaults
    expect(m.readUserLayout(storage, 11, LIB, DEF)).toEqual(DEF);
    expect(m.readUserPeriod(storage, 11, "2026-11-10")).toEqual({ preset: "month", from: "2026-11-01", to: "2026-11-10" });
    expect(storage.keys().sort()).toEqual([
      "astrea_ai_dashboard_widgets:user:7",
      "astrea_ai_dashboard_widgets:user:9",
      "astrea_dashboard_period:user:7",
      "astrea_dashboard_period:user:9",
    ]);
  });

  test("reset for one user leaves the other user's layout alone", () => {
    const storage = fakeStorage();
    m.writeUserLayout(storage, 7, ["d"]);
    m.writeUserLayout(storage, 9, ["b"]);
    m.writeUserLayout(storage, 7, DEF);
    expect(m.readUserLayout(storage, 9, LIB, DEF)).toEqual(["b"]);
  });

  test("the old shared key is ignored, and nothing is saved without a known user", () => {
    const storage = fakeStorage();
    storage.setItem("astrea_ai_dashboard_widgets", JSON.stringify(["d"]));
    expect(m.readUserLayout(storage, 7, LIB, DEF)).toEqual(DEF);
    expect(m.writeUserLayout(storage, "", ["a"])).toBe(false);
    expect(m.writeUserLayout(storage, "abc", ["a"])).toBe(false);
    expect(m.writeUserPeriod(storage, null, { preset: "year" })).toBe(false);
    expect(m.readUserLayout(storage, "", LIB, DEF)).toEqual(DEF);
    expect(m.storageKeys("0")).toBeNull();
  });

  test("a corrupt or unavailable storage falls back to defaults", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(m.readUserLayout(broken, 7, LIB, DEF)).toEqual(DEF);
    expect(m.writeUserLayout(broken, 7, ["a"])).toBe(false);
    const garbage = fakeStorage();
    garbage.setItem("astrea_ai_dashboard_widgets:user:7", "{not json");
    expect(m.readUserLayout(garbage, 7, LIB, DEF)).toEqual(DEF);
    expect(m.readUserLayout(null, 7, LIB, DEF)).toEqual(DEF);
  });
});

describe("navigation permissions", () => {
  const me = (roleCode, granted) => ({
    user: { id: 3, roleCode },
    permissions: [
      { moduleKey: "REPORTS.FINANCIAL", action: "VIEW", granted: granted.includes("REPORTS.FINANCIAL.VIEW") },
      { moduleKey: "TRANSACTIONS.INVOICE", action: "CREATE", granted: granted.includes("TRANSACTIONS.INVOICE.CREATE") },
      { moduleKey: "TRANSACTIONS.APV", action: "VIEW", granted: granted.includes("TRANSACTIONS.APV.VIEW") },
      { moduleKey: "FILESETUP.COA", action: "VIEW", granted: granted.includes("FILESETUP.COA.VIEW") },
    ],
  });

  test("only links to pages the user may open", () => {
    const a = m.accessFromMe(me("ACCOUNTANT", ["REPORTS.FINANCIAL.VIEW", "TRANSACTIONS.APV.VIEW"]));
    expect(m.canOpen(a, "/reports/trial-balance")).toBe(true);
    expect(m.canOpen(a, "/reports/account-analysis?companyId=1")).toBe(true);
    expect(m.canOpen(a, "/transactions/apv")).toBe(true);
    expect(m.canOpen(a, "/transactions/invoice")).toBe(false); // needs CREATE
    expect(m.canOpen(a, "/coa")).toBe(false);
    expect(m.canOpen(a, "/general-libraries")).toBe(false);
  });

  test("fails closed: unknown path or permissions not loaded yet -> hidden", () => {
    expect(m.canOpen({ ready: false, granted: new Set() }, "/reports/trial-balance")).toBe(false);
    expect(m.canOpen(m.accessFromMe(me("ADMIN", ["REPORTS.FINANCIAL.VIEW"])), "/somewhere-unmapped")).toBe(false);
    expect(m.canOpen(undefined, "/coa")).toBe(false);
  });

  test("Super Admin may open everything", () => {
    const a = m.accessFromMe(me("SUPER_ADMIN", []));
    expect(m.canOpen(a, "/coa")).toBe(true);
    expect(m.canOpen(a, "/transactions/invoice")).toBe(true);
  });

  test("every Quick Action and summary target has a permission rule", () => {
    const block = page.slice(page.indexOf("const QUICK_ACTIONS"), page.indexOf("];", page.indexOf("const QUICK_ACTIONS")));
    const summary = page.slice(page.indexOf("const SUMMARY_LINKS"), page.indexOf("];", page.indexOf("const SUMMARY_LINKS")));
    for (const p of [...block.matchAll(/path: "([^"]+)"/g), ...summary.matchAll(/path: "([^"]+)"/g)].map((x) => x[1])) {
      expect(m.PATH_PERMISSIONS[p]).toBeDefined();
    }
  });

  test("the permission rules match what the target pages' APIs enforce", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "server.js"), "utf8");
    const expectRoute = (route, key, action) =>
      expect(server).toMatch(new RegExp(`app\\.(get|post)\\("${route.replace(/\//g, "\\/")}", authenticateToken, authorizePermission\\("${key}", "${action}"\\)`));
    expectRoute("/api/coa", "FILESETUP.COA", "VIEW");
    expectRoute("/api/genlib", "FILESETUP.GENLIB", "VIEW");
    expectRoute("/api/report-sections", "FILESETUP.REPORT_SECTIONS", "VIEW");
    expectRoute("/api/reports/trial-balance", "REPORTS.FINANCIAL", "VIEW");
    expectRoute("/api/reports/account-analysis", "REPORTS.FINANCIAL", "VIEW");
    expectRoute("/api/invoices", "TRANSACTIONS.INVOICE", "CREATE");
  });
});

describe("Bank & Cash Accounts search", () => {
  const acct = (over) => ({
    id: 1, name: "Cash in Bank", bankName: "BDO Unibank", bankCode: "BDO-01", accountNoLast4: "4321",
    coaCode: "1010", coaTitle: "Cash in Bank - BDO", accountType: "ASSET", status: "ACTIVE", balance: 0, recon: null, ...over,
  });
  const list = [
    acct({ id: 1 }),
    acct({ id: 2, name: "Payroll Account", bankName: "Metrobank", bankCode: "MBTC", accountNoLast4: "7788", coaCode: "1020", coaTitle: "Cash in Bank - Metrobank" }),
    acct({ id: 3, name: "Petty Cash Fund", bankName: null, bankCode: "PCF", accountNoLast4: null, coaCode: "1001", coaTitle: "Petty Cash" }),
  ];
  const ids = (rows) => rows.map((r) => r.id);

  test("the search box appears only above six accounts", () => {
    expect(m.BANK_SEARCH_THRESHOLD).toBe(6);
    expect(m.bankAccountsSearchable([])).toBe(false);
    expect(m.bankAccountsSearchable(Array.from({ length: 6 }, (_, i) => acct({ id: i })))).toBe(false);
    expect(m.bankAccountsSearchable(Array.from({ length: 7 }, (_, i) => acct({ id: i })))).toBe(true);
    expect(m.bankAccountsSearchable(null)).toBe(false);
  });

  test("a blank query returns the list unchanged", () => {
    expect(m.filterBankAccounts(list, "")).toBe(list);
    expect(m.filterBankAccounts(list, "   ")).toBe(list);
    expect(m.filterBankAccounts(list, undefined)).toBe(list);
    expect(m.filterBankAccounts(null, "x")).toEqual([]);
  });

  test("matches each of the six fields", () => {
    expect(ids(m.filterBankAccounts(list, "payroll"))).toEqual([2]); // account name
    expect(ids(m.filterBankAccounts(list, "unibank"))).toEqual([1]); // bank name
    expect(ids(m.filterBankAccounts(list, "mbtc"))).toEqual([2]); // bank code
    expect(ids(m.filterBankAccounts(list, "7788"))).toEqual([2]); // last 4 digits
    expect(ids(m.filterBankAccounts(list, "1001"))).toEqual([3]); // GL code
    expect(ids(m.filterBankAccounts(list, "petty cash"))).toEqual([3]); // GL title (and name)
    expect(ids(m.filterBankAccounts([acct({ id: 9, name: "X" })], "cash in bank - bdo"))).toEqual([9]); // GL title only
  });

  test("is case-insensitive, trims, keeps order and ignores missing fields", () => {
    expect(ids(m.filterBankAccounts(list, "  METROBANK "))).toEqual([2]);
    expect(ids(m.filterBankAccounts(list, "cAsH"))).toEqual([1, 2, 3]);
    expect(ids(m.filterBankAccounts(list, "null"))).toEqual([]);
    expect(m.filterBankAccounts(list, "no such account")).toEqual([]);
  });

  test("does not search the balance or other fields", () => {
    expect(m.filterBankAccounts([acct({ balance: 98765 })], "98765")).toEqual([]);
    expect(m.filterBankAccounts([acct({ accountType: "ASSET" })], "asset")).toEqual([]);
  });
});

describe("Multi-Branch: company + branch context", () => {
  const ALAS = { id: 7, name: "ALAS, OPLAS & CO., CPA'S" };
  let rb;
  beforeAll(async () => {
    rb = await import("../../pages/REPORTS/reportBranch.mjs");
  });
  const B = (id, name) => ({ id, name, code: name.toUpperCase().replace(/ /g, ""), status: "ACTIVE" });

  test("DBR-UI-01/02 exactly one accessible company is chosen automatically for every role (no Select a company)", () => {
    expect(m.dashboardCompanyChoice({ companies: [ALAS] })).toBe("7");
    expect(m.dashboardCompanyLocked({ companies: [ALAS] })).toBe(true);
    const two = [ALAS, { id: 8, name: "Other" }];
    expect(m.dashboardCompanyChoice({ companies: two })).toBe("");
    expect(m.dashboardCompanyLocked({ companies: two })).toBe(false);
    expect(m.dashboardCompanyChoice({ companies: two, current: "8" })).toBe("8");
    expect(m.dashboardCompanyChoice({ companies: [ALAS], current: "99" })).toBe("7");
    expect(m.dashboardCompanyChoice({ companies: [] })).toBe("");
  });

  test("the page shows the company name when locked and a Company / Branch context line", () => {
    expect(page).toContain('<strong id="dash-company">{company?.name || ""}</strong>');
    expect(page).toContain('const locked = companyState.status === "ready" && dashboardCompanyLocked(companyState);');
    expect(page).toContain("`Company: ${company.name}`");
    expect(page).toContain("`Branch: ${branch.label}`");
  });

  test("DBR-UI-03/04 ADMIN / SUPER_ADMIN (canConsolidate): All Branches first, then each branch", () => {
    const opts = rb.branchOptions({ branches: [B(1, "Branch 1"), B(2, "Branch 2"), B(3, "Branch 3")], canConsolidate: true });
    expect(opts.map((o) => o.label)).toEqual(["All Branches", "Branch 1", "Branch 2", "Branch 3"]);
    expect(m.dashboardBranchChoice(opts)).toBe("ALL");
    expect(m.dashboardBranchChoice(opts, "2")).toBe("2");
  });

  test("DBR-UI-05 accountant with Branch 1 only: that branch, no All Branches", () => {
    const opts = rb.branchOptions({ branches: [B(1, "Branch 1")], canConsolidate: false });
    expect(opts).toEqual([{ value: "1", label: "Branch 1" }]);
    expect(m.dashboardBranchChoice(opts)).toBe("1");
  });

  test("DBR-UI-06/07/09 accountant with Branch 1 + 2: exactly those two, switchable, never Branch 3 or All Branches", () => {
    const opts = rb.branchOptions({ branches: [B(1, "Branch 1"), B(2, "Branch 2")], canConsolidate: false });
    expect(opts.map((o) => o.label)).toEqual(["Branch 1", "Branch 2"]);
    expect(m.dashboardBranchChoice(opts)).toBe("1");
    expect(m.dashboardBranchChoice(opts, "2")).toBe("2");
    expect(m.dashboardBranchChoice(opts, "3")).toBe("1");
    expect(m.dashboardBranchChoice(opts, "ALL")).toBe("1");
  });

  test("the summary query carries the selected branch (nothing when there is no branch context)", () => {
    expect(m.dashboardSummaryQuery({ companyId: 7, from: "2026-11-01", to: "2026-11-30", branch: "2" })).toBe("companyId=7&from=2026-11-01&to=2026-11-30&branch=2");
    expect(m.dashboardSummaryQuery({ companyId: 7, from: "2026-11-01", to: "2026-11-30", branch: "" })).toBe("companyId=7&from=2026-11-01&to=2026-11-30");
  });

  test("the page reuses the server's branch list and the report selector rules (no second authorization)", () => {
    expect(page).toContain('import { branchOptions } from "../REPORTS/reportBranch.mjs";');
    // System-wide Active Branch: the branch list is the shared context's
    // (one GET /api/branch-scope/branches for the chosen company), not a
    // second Dashboard-only request.
    expect(page).toContain("activeBranch.setCompanyId");
    expect(page).toContain("branchOptions({ branches: activeBranch.branches, canConsolidate: activeBranch.canConsolidate })");
    expect(page).toContain("const setBranchValue = (value) => activeBranch.requestChange(value);");
    expect(page).toMatch(/branchOpts\.length > 1 \? \(\s*<select id="dash-branch"/);
    expect(page).toContain('<strong id="dash-branch">{branchOpts[0].label}</strong>');
    expect(page).toContain('(r.data.meta.requestedBranch || "") === branchValue');
  });

  test("the Branch field wraps and its selector may shrink (no page overflow next to the sidebar at 390px)", () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "..", "pages", "DASHBOARD", "Dashboard.css"), "utf8");
    expect(css).toMatch(/\.dash-branch \{\s*flex-wrap: wrap;[\s\S]*?min-width: 0;\s*max-width: 100%;\s*\}/);
    expect(css).toMatch(/\.dash-branch select \{\s*min-width: 0;\s*max-width: 100%;\s*\}/);
  });

  test("server: the dashboard gets the SAME branch-scope middleware as the reports, before its routes", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "server.js"), "utf8");
    const mw = server.indexOf('app.use("/api/dashboard", require("./lib/reportBranchContext").middleware);');
    const routes = server.indexOf('app.use("/api/dashboard", require("./routes/dashboard.routes"));');
    expect(mw).toBeGreaterThan(-1);
    expect(routes).toBeGreaterThan(mw);
  });
});
