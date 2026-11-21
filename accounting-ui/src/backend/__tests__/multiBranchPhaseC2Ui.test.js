const fs = require("fs");
const path = require("path");

// Multi-Branch Phase C-2A UI - report Branch selector and Shared / branch-only
// COA and General Library records. The repo's jest config is node-only, so the
// pure logic (reportBranch.mjs, branchOwnership.mjs) is exercised directly and
// the page wiring is checked at source level; the screens are verified in a
// real browser separately, and the server rules by the *.http tests.

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");
let RB;
let OWN;

beforeAll(async () => {
  RB = await import("../../pages/REPORTS/reportBranch.mjs");
  OWN = await import("../../pages/FILESETUP/branchOwnership.mjs");
});

const A1 = { id: 11, name: "Branch A1", status: "ACTIVE" };
const A2 = { id: 12, name: "Branch A2", status: "ACTIVE" };
const A3 = { id: 13, name: "Branch A3", status: "INACTIVE" };

describe("report Branch selector options", () => {
  test("ADMIN (may consolidate) sees All Branches first - selected by default - then every company branch", () => {
    const opts = RB.branchOptions({ branches: [A1, A2, A3], canConsolidate: true });
    expect(opts.map((o) => o.value)).toEqual(["ALL", "11", "12", "13"]);
    expect(opts[0].label).toBe("All Branches");
    expect(opts[3].label).toBe("Branch A3 (inactive)");
    expect(RB.defaultBranch(opts)).toBe("ALL");
  });

  test("ACCOUNTANT sees only the branches the server returned, never All Branches", () => {
    const opts = RB.branchOptions({ branches: [A1, A2], canConsolidate: false });
    expect(opts.map((o) => o.value)).toEqual(["11", "12"]);
    expect(opts.some((o) => o.value === "ALL")).toBe(false);
  });

  test("a single-branch user defaults to that branch (even an ADMIN: All Branches would be the same report)", () => {
    for (const canConsolidate of [false, true]) {
      const opts = RB.branchOptions({ branches: [A1], canConsolidate });
      expect(opts.map((o) => o.value)).toEqual(["11"]);
      expect(RB.defaultBranch(opts)).toBe("11");
    }
  });

  test("a multi-branch accountant may pick any of their branches; no branches -> no selector", () => {
    const opts = RB.branchOptions({ branches: [A1, A2] });
    expect(RB.branchLabel(opts, "12")).toBe("Branch A2");
    expect(RB.branchOptions({ branches: [] })).toEqual([]);
    expect(RB.defaultBranch([])).toBe("");
  });

  test("the applied period carries the branch to the request and the label", () => {
    const snap = { mode: "range", fromDate: "2097-06-01", toDate: "2097-06-30", params: { dateMode: "range", from: "2097-06-01", to: "2097-06-30" } };
    const out = RB.withBranch(snap, "ALL", "All Branches");
    expect(out.params).toEqual({ ...snap.params, branch: "ALL" });
    expect(out.branchLabel).toBe("All Branches");
    expect(RB.withBranch(snap, "", "")).toBe(snap); // nothing selected -> unchanged request
  });

  test("model-rendered statements (Income Statement / Balance Sheet) print the branch line; without a branch nothing changes", async () => {
    const RP = await import("../../pages/REPORTS/reportPeriod.mjs");
    const snap = { mode: "range", from: "2097-06-01", to: "2097-06-30", params: {} };
    const plain = RP.reportPeriodLineList(snap);
    expect(plain.some((l) => l.startsWith("BRANCH:"))).toBe(false);
    expect(RP.reportPeriodLineList(RB.withBranch(snap, "ALL", "All Branches"))).toEqual([...plain, "BRANCH: ALL BRANCHES"]);
  });
});

describe("report pages send the branch", () => {
  const hook = read("pages/REPORTS/useReportPeriod.js");
  const filter = read("pages/REPORTS/ReportPeriodFilter.jsx");

  test("the period hook loads the server's branch list and stamps every applied snapshot (apply and drill-down select)", () => {
    expect(hook).toContain('import useReportBranch from "./useReportBranch";');
    expect(hook).toContain("const snapshot = withBranch(current, branch.value, branch.label);");
    expect(hook).toContain("withBranch(resolvePeriod(next, { asOfStart }), branch.value, branch.label)");
    expect(read("pages/REPORTS/useReportBranch.js")).toContain("/api/branch-scope/branches");
  });

  test("the shared filter shows Branch with the server-provided options; the label shows it on screen and in print", () => {
    expect(filter).toContain('<label htmlFor={`${idPrefix}-branch`}>Branch</label>');
    expect(filter).toContain("period.branchOptions.map((o) =>");
    expect(filter).toContain("BRANCH: {period.branchLabel.toUpperCase()}");
    expect(read("pages/REPORTS/ReportPeriodFilter.css")).toContain(".rpf > .rpf-branch {");
  });

  test.each(["IncomeStatement", "BalanceSheet", "GeneralLedger", "TrialBalance", "APAging", "ARAging", "ApStatementOfAccounts", "ArStatementOfAccounts", "SubsidiaryLedger", "AccountAnalysis"])(
    "%s uses the shared period hook + filter and requests with the applied params", (page) => {
      const src = read(`pages/REPORTS/${page}.jsx`);
      expect(src).toContain("useReportPeriod(");
      expect(src).toContain("<ReportPeriodFilter");
      expect(/applied\.params|periodModeQuery\(applied\)|\.\.\.applied\.params/.test(src)).toBe(true);
    }
  );

  test("no native alert() in the new branch selector code", () => {
    for (const f of ["pages/REPORTS/reportBranch.mjs", "pages/REPORTS/useReportBranch.js", "hooks/useAuthorizedBranches.js", "pages/FILESETUP/branchOwnership.mjs"]) {
      expect([f, /\balert\(/.test(read(f))]).toEqual([f, false]);
    }
    expect(/\balert\(/.test(filter)).toBe(false);
  });
});

describe("Shared / branch-only COA and General Library records", () => {
  const branches = [A1, A2];
  test("Shared vs branch display, offered options and payload", () => {
    expect(OWN.ownershipLabel({ branchId: null }, branches)).toBe("Shared");
    expect(OWN.ownershipLabel({ branchId: 12 }, branches)).toBe("Branch A2");
    expect(OWN.ownershipOptions(branches).map((o) => o.value)).toEqual(["", "11", "12"]); // only the server's branches
    expect(OWN.ownershipValue({ branchId: 11 })).toBe("11");
    expect([OWN.branchIdPayload(""), OWN.branchIdPayload("12")]).toEqual([null, 12]);
  });

  test("two accounts with the same code in two branches stay distinguishable", () => {
    const rows = [{ code: "1100", branchId: 11 }, { code: "1100", branchId: 12 }, { code: "1000", branchId: null }];
    expect(rows.map((r) => `${r.code} - ${OWN.ownershipLabel(r, branches)}`)).toEqual(["1100 - Branch A1", "1100 - Branch A2", "1000 - Shared"]);
  });

  test.each([
    ["COA", "pages/FILESETUP/COA.jsx", "coa-branch", "FILESETUP.COA"],
    ["General Libraries", "pages/FILESETUP/GenLib.jsx", "gl-owning-branch", "FILESETUP.GENLIB"],
  ])("%s: Branch column + details, branch field only editable in add / edit, RBAC gating unchanged", (name, file, fieldId, perm) => {
    const src = read(file);
    expect(src).toContain('{ key: "branchName", label: "Branch" }');
    expect(src).toContain('{ label: "Branch", value: ownershipLabel(');
    expect(src).toContain(`id="${fieldId}"`);
    expect(src).toContain("ownershipOptions(branches).map((o) =>");
    expect(src).toMatch(new RegExp(`id="${fieldId}"\\n\\s+value=\\{ownershipValue\\(form\\)\\}\\n\\s+disabled=\\{!isEditing\\}`));
    for (const action of ["CREATE", "EDIT", "DELETE"]) expect(src).toContain(`can("${perm}", "${action}")`);
    expect(src).toContain("useAuthorizedBranches()");
  });

  test("COA sends the branch with every save (null = Shared)", () => {
    expect(read("pages/FILESETUP/COA.jsx")).toContain("branchId: branchIdPayload(ownershipValue(form)),");
    expect(read("pages/FILESETUP/GenLib.jsx")).toContain("branchId: null,");
  });
});
