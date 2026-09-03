// accountSearch.mjs is real ESM (Vite dev-server compatibility); loaded via
// dynamic import() like voucherToolbarRules / addEntryMenuBehavior.
let M;
let TAX;

beforeAll(async () => {
  M = await import("../accountSearch.mjs");
  TAX = await import("../taxAccountRules.mjs");
});

// A small company-scoped chart. `validations` mirrors what /api/coa returns.
const COA = [
  { id: 1, code: "100101", title: "Cash in Bank BPI - Checking", validations: [] },
  { id: 2, code: "100102", title: "Cash in Bank BPI - Savings", validations: [] },
  { id: 3, code: "100200", title: "Petty Cash Fund", validations: [] },
  { id: 4, code: "120100", title: "Accounts Receivable", validations: ["AR"] },
  { id: 5, code: "130103", title: "Prepaid Rent", validations: [] },
  { id: 6, code: "205010", title: "Input VAT Receivable", validations: ["INPUT VAT"] },
  { id: 7, code: "205020", title: "Output VAT Payable", validations: ["OUTPUT VAT"] },
  { id: 8, code: "205030", title: "Withholding Tax Payable", validations: ["EXPANDED TAX"] },
  { id: 9, code: "205040", title: "Final Tax Payable", validations: ["FINAL TAX"] },
  { id: 10, code: "400100", title: "Service Income", validations: [] },
  // a non-standard title but validation-tagged INPUT VAT:
  { id: 11, code: "205011", title: "Taxes Recoverable", validations: ["INPUT VAT"] },
];

describe("accountSearch - filtering", () => {
  test("exact code match", () => {
    const r = M.filterAccounts(COA, "130103");
    expect(r.map((a) => a.id)).toEqual([5]);
  });

  test("partial code match", () => {
    const r = M.filterAccounts(COA, "1001");
    expect(r.map((a) => a.id).sort()).toEqual([1, 2]);
  });

  test("title match, case-insensitive, whitespace-normalized", () => {
    expect(M.filterAccounts(COA, "bpi").map((a) => a.id).sort()).toEqual([1, 2]);
    expect(M.filterAccounts(COA, "BPI").map((a) => a.id).sort()).toEqual([1, 2]);
    expect(M.filterAccounts(COA, "  cash   in bank ").map((a) => a.id).sort()).toEqual([1, 2]);
  });

  test("'input vat' matches by title", () => {
    expect(M.filterAccounts(COA, "input vat").map((a) => a.id)).toEqual([6]);
  });

  test("empty query returns the whole (already-eligible) list, order preserved", () => {
    expect(M.filterAccounts(COA, "").map((a) => a.id)).toEqual(COA.map((a) => a.id));
  });

  test("no match -> empty", () => {
    expect(M.filterAccounts(COA, "zzz-nothing")).toEqual([]);
  });
});

describe("accountSearch - keyboard reducer", () => {
  test("ArrowDown opens then moves the active row, clamped to the last", () => {
    expect(M.reduceKey({ key: "ArrowDown", open: false, activeIndex: -1, resultCount: 3 }))
      .toMatchObject({ open: true, activeIndex: 0, preventDefault: true });
    expect(M.reduceKey({ key: "ArrowDown", open: true, activeIndex: 0, resultCount: 3 }))
      .toMatchObject({ activeIndex: 1 });
    expect(M.reduceKey({ key: "ArrowDown", open: true, activeIndex: 2, resultCount: 3 }))
      .toMatchObject({ activeIndex: 2 });
  });

  test("ArrowUp moves up, clamped to the first", () => {
    expect(M.reduceKey({ key: "ArrowUp", open: true, activeIndex: 2, resultCount: 3 }))
      .toMatchObject({ activeIndex: 1 });
    expect(M.reduceKey({ key: "ArrowUp", open: true, activeIndex: 0, resultCount: 3 }))
      .toMatchObject({ activeIndex: 0 });
  });

  test("Enter on a valid active row commits (select:true)", () => {
    expect(M.reduceKey({ key: "Enter", open: true, activeIndex: 1, resultCount: 3 }))
      .toMatchObject({ select: true, open: false });
  });

  test("Enter with nothing active does nothing", () => {
    expect(M.reduceKey({ key: "Enter", open: true, activeIndex: -1, resultCount: 3 })).toEqual({});
  });

  test("Escape closes and restores, no selection change", () => {
    const r = M.reduceKey({ key: "Escape", open: true, activeIndex: 2, resultCount: 3 });
    expect(r).toMatchObject({ open: false, restore: true });
    expect(r.select).toBeUndefined();
  });

  test("Tab closes naturally without selecting", () => {
    expect(M.reduceKey({ key: "Tab", open: true, activeIndex: 1, resultCount: 3 })).toEqual({ open: false });
  });

  test("typing reopens the list", () => {
    expect(M.onQueryInput()).toEqual({ open: true, activeIndex: 0 });
  });

  test("outside pointer closes only when open", () => {
    expect(M.shouldCloseOnOutsidePointer({ open: true, rootContainsTarget: false })).toBe(true);
    expect(M.shouldCloseOnOutsidePointer({ open: true, rootContainsTarget: true })).toBe(false);
    expect(M.shouldCloseOnOutsidePointer({ open: false, rootContainsTarget: false })).toBe(false);
  });
});

describe("accountSearch - selected + historical account display", () => {
  test("selected account persists and renders '<code> - <title>'", () => {
    expect(M.selectedDisplayLabel({ value: "5", candidates: COA })).toBe("130103 - Prepaid Rent");
  });

  test("historical account NOT in candidates still displays via fallback list", () => {
    const eligible = TAX.filterSelectableRegularAccounts(COA); // strips protected tax accounts
    expect(eligible.some((a) => a.id === 6)).toBe(false); // Input VAT not selectable
    // but a line already on account 6 must still show its label:
    expect(
      M.selectedDisplayLabel({ value: "6", candidates: eligible, fallbackAccounts: COA })
    ).toBe("205010 - Input VAT Receivable");
  });

  test("explicit selectedAccountLabel wins", () => {
    expect(
      M.selectedDisplayLabel({ value: "999", candidates: COA, selectedAccountLabel: "999 - Legacy Ghost" })
    ).toBe("999 - Legacy Ghost");
  });

  test("no value -> empty label", () => {
    expect(M.selectedDisplayLabel({ value: "", candidates: COA })).toBe("");
  });
});

describe("accountSearch - protected accounts never enter the candidate list", () => {
  test("regular-line candidates exclude INPUT VAT / OUTPUT VAT / EXPANDED TAX / FINAL TAX", () => {
    const eligible = TAX.filterSelectableRegularAccounts(COA);
    const ids = eligible.map((a) => a.id);
    for (const blocked of [6, 7, 8, 9, 11]) expect(ids).not.toContain(blocked);
    // searching within that list can never surface them:
    expect(M.filterAccounts(eligible, "input vat")).toEqual([]);
    expect(M.filterAccounts(eligible, "withholding")).toEqual([]);
    expect(M.filterAccounts(eligible, "taxes recoverable")).toEqual([]);
  });

  test("keepAccountId still lets a historical protected account through for its own row only", () => {
    const eligible = TAX.filterSelectableRegularAccounts(COA, 6);
    expect(eligible.some((a) => a.id === 6)).toBe(true);
    expect(eligible.some((a) => a.id === 7)).toBe(false); // others stay blocked
  });

  test("tax-modal candidates: an eligible validated account remains searchable", () => {
    const inputVat = TAX.filterAccountsByValidations(COA, ["INPUT VAT"]);
    expect(inputVat.map((a) => a.id).sort((a, b) => a - b)).toEqual([6, 11]);
    expect(M.filterAccounts(inputVat, "taxes").map((a) => a.id)).toEqual([11]);
    expect(M.filterAccounts(inputVat, "205010").map((a) => a.id)).toEqual([6]);
  });
});
