// R8.4-C Bank Statement History: pure helpers (bankStatementHistory.mjs,
// real ESM via dynamic import like the other utils tests) plus source checks
// that Bank Reconciliation no longer uses the browser's alert / confirm /
// prompt and that the history page filters on the server.
const fs = require("fs");
const path = require("path");

let h;
beforeAll(async () => {
  h = await import("../bankStatementHistory.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");

describe("history query", () => {
  test("only non-empty filters are sent; ALL defaults are left out", () => {
    const q = h.historyQuery({ companyId: 3, bankAccountId: 9 }, { ...h.emptyFilters(), status: "EXCEPTION", q: " 0001001 ", type: "ALL" }, 2);
    expect(Object.fromEntries(new URLSearchParams(q))).toEqual({ companyId: "3", bankAccountId: "9", status: "EXCEPTION", q: "0001001", page: "2" });
    expect(h.historyQuery({ bankAccountId: 9 }, h.emptyFilters())).toBe("bankAccountId=9");
  });

  test("filters round-trip through the page URL", () => {
    const f = { ...h.emptyFilters(), from: "2097-01-01", to: "2097-01-31", status: "CARRIED_FORWARD", amountMin: "10", batchId: "7" };
    const back = h.filtersFromSearch(`?${h.historyQuery({ companyId: 1, bankAccountId: 2 }, f)}`);
    expect(back).toEqual(f);
    expect(h.activeFilterCount(f)).toBe(5);
    expect(h.activeFilterCount(h.emptyFilters())).toBe(0);
  });

  test("every status filter the server accepts is offered", () => {
    expect(h.STATUS_FILTERS.map((o) => o.value)).toEqual(["ALL", "MATCHED", "UNMATCHED", "NEEDS_REVIEW", "EXCEPTION", "CARRIED_FORWARD", "IGNORED", "POSSIBLE_DUPLICATE"]);
  });

  test("status is always text (never colour alone), with its flags", () => {
    expect(h.statusText({ status: "UNMATCHED", carriedForward: true, possibleDuplicate: true })).toBe("Unmatched · Carried forward · Possible duplicate");
    expect(h.statusText({ status: "NEEDS_REVIEW", highConfidence: true })).toBe("Needs review · High confidence");
    for (const s of ["MATCHED", "UNMATCHED", "NEEDS_REVIEW", "EXCEPTION", "IGNORED"]) expect(h.STATUS_DISPLAY[s].label).toBeTruthy();
    expect(h.formatPeso(15000)).toBe("₱ 15,000.00");
  });
});

describe("Bank Reconciliation source checks", () => {
  const files = [
    ["pages", "REPORTS", "BankReconciliation.jsx"],
    ["pages", "REPORTS", "BankReconciliationWorkspace.jsx"],
    ["pages", "REPORTS", "BankStatementHistory.jsx"],
    ["components", "BankReconQueuePanel.jsx"],
    ["components", "BankReconMatchModal.jsx"],
    ["components", "DepositGroupCandidate.jsx"],
    ["components", "BankStatementPreview.jsx"],
    ["components", "BankReconDialogs.jsx"],
  ];

  test.each(files)("%s/%s/%s uses no native alert(), confirm() or prompt()", (...p) => {
    // code only - comments may name the functions they replace
    const src = read(...p.filter(Boolean)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src.match(/(^|[^.\w])(alert|confirm|prompt)\s*\(/gm)).toBeNull();
    expect(src).not.toMatch(/window\.(alert|confirm|prompt)/);
  });

  test("destructive workspace actions still ask for explicit confirmation (in-app)", () => {
    const src = read("pages", "REPORTS", "BankReconciliationWorkspace.jsx");
    for (const title of ["Unmatch", "Delete import batch", "Post adjustment", "Reject adjustment", "Finalize session", "Reopen session"]) {
      expect(src).toContain(title);
    }
    expect((src.match(/await confirmAction\(/g) || []).length).toBeGreaterThanOrEqual(6);
    expect((src.match(/await askText\(/g) || []).length).toBe(2);
  });

  test("the history page asks the server for every filter and never loads all rows to filter them itself", () => {
    const src = read("pages", "REPORTS", "BankStatementHistory.jsx");
    expect(src).toContain("/api/bank-recon/statement-history?");
    expect(src).toContain("historyQuery(scope, filters, page)");
    expect(src).not.toMatch(/\/statement-lines/);
    expect(src).not.toMatch(/rows\.filter\(/);
    // read-only: no confirm / unmatch / ignore / import calls
    expect(src).not.toMatch(/\/confirm|method: "DELETE"|\/ignore|\/import"/);
  });

  test("the route is registered before the session route", () => {
    const app = read("App.jsx");
    expect(app.indexOf('"/reports/bank-reconciliation/history"')).toBeGreaterThan(0);
    expect(app.indexOf('"/reports/bank-reconciliation/history"')).toBeLessThan(app.indexOf('"/reports/bank-reconciliation/:id"'));
  });
});
