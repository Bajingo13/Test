const fs = require("fs");
const path = require("path");

// System-wide Active Branch - UI rules. The repo's jest config is node-only,
// so the pure logic (utils/activeBranch.mjs, utils/activeBranchHeader.js) is
// exercised directly and the page wiring is checked at source level; the
// screens are verified in a real browser separately, and the server rules by
// activeBranchContext.http.test.js.

const SRC = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8").replace(/\r\n/g, "\n");
let AB;

beforeAll(async () => {
  AB = await import("../../utils/activeBranch.mjs");
});

const AUDIT = { id: 11, code: "AUDIT", name: "Audit", status: "ACTIVE" };
const OUT = { id: 12, code: "OUTSOURCE", name: "Outsource", status: "ACTIVE" };
const TAX = { id: 13, code: "TAX", name: "Tax", status: "ACTIVE" };
const OLD = { id: 14, code: "OLD", name: "Old", status: "INACTIVE" };

describe("selector options follow the user's ACTUAL assignments", () => {
  test("no branches -> no options (company-level work, no selector)", () => {
    expect(AB.buildOptions({ branches: [], totalBranches: 0 })).toEqual([]);
  });

  test("one branch -> only that branch, no aggregate", () => {
    const o = AB.buildOptions({ branches: [AUDIT], totalBranches: 3 });
    expect(o.map((x) => x.value)).toEqual(["11"]);
  });

  test("every company branch -> All Branches first", () => {
    const o = AB.buildOptions({ branches: [AUDIT, OUT, TAX], totalBranches: 3 });
    expect(o.map((x) => x.value)).toEqual(["ALL", "11", "12", "13"]);
    expect(o[0].label).toBe("All Branches");
  });

  test("a subset (accountant OUTSOURCE + TAX) -> All Assigned Branches, never another branch", () => {
    const o = AB.buildOptions({ branches: [OUT, TAX], totalBranches: 3 });
    expect(o.map((x) => x.value)).toEqual(["ALL", "12", "13"]);
    expect(o[0].label).toBe("All Assigned Branches");
    expect(o.some((x) => x.value === "11")).toBe(false);
  });

  test("unknown company total -> the safer 'All Assigned Branches' wording", () => {
    expect(AB.buildOptions({ branches: [AUDIT, OUT] })[0].label).toBe("All Assigned Branches");
  });

  test("inactive branches are marked", () => {
    expect(AB.buildOptions({ branches: [AUDIT, OLD], totalBranches: 2 })[2].label).toBe("Old (inactive)");
  });
});

describe("stale selections are cleared", () => {
  const opts = () => AB.buildOptions({ branches: [OUT, TAX], totalBranches: 3 });
  test("a saved branch still offered is kept", () => expect(AB.resolveValue(opts(), "13")).toBe("13"));
  test("a branch no longer assigned falls back to the aggregate", () => expect(AB.resolveValue(opts(), "11")).toBe("ALL"));
  test("garbage falls back", () => expect(AB.resolveValue(opts(), "x' OR 1=1")).toBe("ALL"));
  test("one branch -> that branch", () => expect(AB.resolveValue(AB.buildOptions({ branches: [AUDIT] }), "99")).toBe("11"));
  test("no branches -> empty", () => expect(AB.resolveValue([], "11")).toBe(""));
});

describe("header value", () => {
  test("aggregate / empty send nothing (server's own full scope)", () => {
    expect(AB.headerValue("ALL")).toBeNull();
    expect(AB.headerValue("")).toBeNull();
    expect(AB.headerValue(undefined)).toBeNull();
  });
  test("a branch id is sent as-is; junk is not sent", () => {
    expect(AB.headerValue("12")).toBe("12");
    expect(AB.headerValue("-1")).toBeNull();
    expect(AB.headerValue("1.5")).toBeNull();
    expect(AB.headerValue("abc")).toBeNull();
  });
});

describe("storage keys are per user and per company", () => {
  test("distinct users / companies never share a choice", () => {
    expect(AB.storageKey(1, 1)).not.toBe(AB.storageKey(2, 1));
    expect(AB.storageKey(1, 1)).not.toBe(AB.storageKey(1, 2));
    expect(AB.lastKey(1)).not.toBe(AB.lastKey(2));
  });
});

describe("report scope never widens", () => {
  const sub = () => AB.buildOptions({ branches: [OUT, TAX], totalBranches: 3 });
  const full = () => AB.buildOptions({ branches: [AUDIT, OUT, TAX], totalBranches: 3 });

  test("a consolidator with the aggregate -> consolidated (ALL)", () => {
    expect(AB.reportScope({ value: "ALL", options: full(), canConsolidate: true })).toEqual({ param: "ALL", label: "All Branches", note: "" });
  });
  test("a non-consolidator with the aggregate -> first assigned branch + a note", () => {
    const s = AB.reportScope({ value: "ALL", options: sub(), canConsolidate: false });
    expect(s.param).toBe("12");
    expect(s.note).toMatch(/not available for your role/);
  });
  test("a specific branch -> that branch, no note", () => {
    expect(AB.reportScope({ value: "13", options: sub(), canConsolidate: false })).toEqual({ param: "13", label: "Tax", note: "" });
  });
  test("one branch -> it, no note", () => {
    expect(AB.reportScope({ value: "11", options: AB.buildOptions({ branches: [AUDIT] }), canConsolidate: false }).note).toBe("");
  });
  test("no branches -> no branch param (company report)", () => {
    expect(AB.reportScope({ value: "", options: [], canConsolidate: true }).param).toBe("");
  });
});

describe("new documents default to the active branch", () => {
  test("the active branch when the form offers it", () => expect(AB.defaultFormBranch("12", [AUDIT, OUT])).toBe("12"));
  test("aggregate with several branches -> the user must choose", () => expect(AB.defaultFormBranch("ALL", [AUDIT, OUT])).toBe(""));
  test("aggregate with one active branch -> it", () => expect(AB.defaultFormBranch("ALL", [AUDIT, OLD])).toBe("11"));
  test("an inactive active branch is never preset", () => expect(AB.defaultFormBranch("14", [AUDIT, OUT, OLD])).toBe(""));
  test("a branch the form does not offer is never preset", () => expect(AB.defaultFormBranch("13", [AUDIT, OUT])).toBe(""));
  test("no branches -> nothing (current workflow)", () => expect(AB.defaultFormBranch("", [])).toBe(""));
});

describe("the header only goes to this app's own API", () => {
  test("own API urls", () => {
    expect(AB.isOwnApiUrl("/api/coa")).toBe(true);
    expect(AB.isOwnApiUrl("https://app.example/api/coa", { origin: "https://app.example" })).toBe(true);
  });
  test("other origins and non-API paths never get it", () => {
    expect(AB.isOwnApiUrl("https://evil.example/api/coa", { origin: "https://app.example" })).toBe(false);
    expect(AB.isOwnApiUrl("/assets/x.js")).toBe(false);
  });

  test("addActiveBranchHeader adds, never overrides an explicit header, and sends nothing without a branch", () => {
    const [, init] = AB.addActiveBranchHeader(["/api/coa", { headers: { Authorization: "Bearer t" } }], "12");
    expect(new Headers(init.headers).get("X-Active-Branch")).toBe("12");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer t");

    const [, explicit] = AB.addActiveBranchHeader(["/api/coa", { headers: { "X-Active-Branch": "ALL" } }], "12");
    expect(new Headers(explicit.headers).get("X-Active-Branch")).toBe("ALL");

    const other = AB.addActiveBranchHeader(["https://elsewhere.example/api/x", {}], "12", { origin: "https://app.example" });
    expect(new Headers(other[1]?.headers || {}).get("X-Active-Branch")).toBeNull();

    const login = AB.addActiveBranchHeader(["/api/login", { method: "POST" }], "12");
    expect(new Headers(login[1]?.headers || {}).get("X-Active-Branch")).toBeNull();
    expect(new Headers(AB.addActiveBranchHeader(["/api/login-history", {}], "12")[1].headers).get("X-Active-Branch")).toBe("12");

    const none = AB.addActiveBranchHeader(["/api/coa", {}], null);
    expect(new Headers(none[1]?.headers || {}).get("X-Active-Branch")).toBeNull();
  });
});

describe("wiring (source level)", () => {
  test("the header is bound to the session token it was chosen under (never rides into another session)", () => {
    const src = read("utils/activeBranchHeader.js");
    expect(src).toContain("owner = current ? tokenNow() : null;");
    expect(src).toContain("return current && owner && owner === tokenNow() ? current : null;");
    expect(src).toContain("addActiveBranchHeader(args, getActiveBranchHeader()");
  });

  test("the global fetch wrapper adds the header", () => {
    expect(read("utils/installAuthFetchGuard.js")).toMatch(/withActiveBranchHeader\(rawArgs\)/);
  });
  test("one provider wraps the app; pages remount on a branch change (not the Dashboard)", () => {
    const app = read("App.jsx");
    expect(app).toMatch(/<ActiveBranchProvider>/);
    expect(app).toMatch(/activeBranch\.renderKey/);
  });
  test("the sidebar shows the global control", () => {
    expect(read("components/sidebar/sidebar.jsx")).toMatch(/<ActiveBranchSelector variant="sidebar"/);
  });
  test("the Dashboard and the reports drive the shared selection (no local branch state)", () => {
    const dash = read("pages/DASHBOARD/dashboard.jsx");
    expect(dash).toMatch(/activeBranch\.requestChange/);
    expect(read("pages/REPORTS/useReportBranch.js")).toMatch(/ab\.requestChange/);
  });
  test("new documents default to the active branch", () => {
    for (const f of ["pages/TRANSACTIONS/TransactionFormLayout.jsx", "pages/TRANSACTIONS/Quotation.jsx", "pages/FILESETUP/ARAPBeginningBalance.jsx", "pages/FILESETUP/BeginningBalanceGL.jsx"]) {
      expect(read(f)).toMatch(/defaultFormBranch\(activeBranch\.value/);
    }
  });
  test("form pickers load every authorized record and filter per document branch", () => {
    for (const f of ["pages/TRANSACTIONS/TransactionFormLayout.jsx", "pages/TRANSACTIONS/Quotation.jsx", "pages/FILESETUP/ARAPBeginningBalance.jsx"]) {
      expect(read(f)).toMatch(/"X-Active-Branch": "ALL"/);
    }
  });
  test("unsaved edits guard a branch switch", () => {
    for (const f of ["pages/TRANSACTIONS/TransactionFormLayout.jsx", "pages/FILESETUP/COA.jsx", "pages/FILESETUP/GenLib.jsx"]) {
      expect(read(f)).toMatch(/useActiveBranchDirtyGuard\(/);
    }
  });
  test("no client hardcodes a company, branch code or user", () => {
    for (const f of ["utils/activeBranch.mjs", "context/ActiveBranchContext.jsx", "components/ActiveBranchSelector.jsx"]) {
      expect(read(f)).not.toMatch(/ALAS|OPLAS|\bAUDIT\b|OUTSOURCE|\bTAX\b/);
    }
  });
});
