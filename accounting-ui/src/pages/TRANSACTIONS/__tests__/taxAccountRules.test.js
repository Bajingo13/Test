// taxAccountRules.mjs is real ESM - loaded via dynamic import() in
// beforeAll, same pattern as transactionListFilters.test.js /
// voucherToolbarRules.test.js (jest config here is testEnvironment: node,
// no jsdom, so only pure-function logic is unit-tested).
let mod;

beforeAll(async () => {
  mod = await import("../taxAccountRules.mjs");
});

// A representative Chart of Accounts payload shaped exactly like GET
// /api/coa returns it: each row carries `validations: string[]`. Note the
// deliberately misleading titles - the rules must ignore them entirely.
const COA = [
  { id: 1, code: "110101", title: "Cash on Hand", validations: ["BANK / CASH"] },
  { id: 2, code: "110301", title: "Accounts Receivable", validations: ["AR CODE"] },
  { id: 3, code: "210101", title: "Accounts Payable", validations: ["AP CODE"] },
  { id: 4, code: "130103", title: "Input VAT", validations: ["INPUT VAT"] },
  { id: 5, code: "210401", title: "Output VAT Payable", validations: ["OUTPUT VAT"] },
  { id: 6, code: "130105", title: "Creditable Withholding Tax", validations: ["EXPANDED TAX"] },
  { id: 7, code: "210402", title: "Final Withholding Tax Payable", validations: ["FINAL TAX"] },
  { id: 8, code: "410101", title: "Service Income", validations: ["INCOME"] },
  { id: 9, code: "510101", title: "Rent Expense", validations: ["EXPENSE"] },
  { id: 10, code: "160101", title: "Office Equipment", validations: ["FIXED ASSET"] },
  { id: 11, code: "140101", title: "Prepaid Insurance", validations: ["PREPAYMENT"] },
  // Rename-proof rows: correct validation, unrelated title.
  { id: 12, code: "130199", title: "Taxes Recoverable", validations: ["INPUT VAT"] },
  { id: 13, code: "210499", title: "Sales Tax Clearing", validations: ["OUTPUT VAT"] },
  // No validations at all - an account merely named like a tax account.
  { id: 14, code: "999999", title: "Input VAT (unclassified)", validations: [] },
];

describe("structural validation detection", () => {
  test("INPUT VAT detected from the validation, not the title", () => {
    expect(mod.accountHasValidation(COA[3], "INPUT VAT")).toBe(true);
    expect(mod.accountHasValidation(COA[11], "input vat")).toBe(true); // case-insensitive, title "Taxes Recoverable"
    expect(mod.accountHasValidation(COA[13], "INPUT VAT")).toBe(false); // title looks like it, no validation
  });

  test("OUTPUT VAT detected structurally", () => {
    expect(mod.outputVatAccounts(COA).map((a) => a.id).sort((x, y) => x - y)).toEqual([5, 13]);
  });

  test("EWT primary validation is EXPANDED TAX; control set is EXPANDED TAX + FINAL TAX", () => {
    expect(mod.EWT_PRIMARY_VALIDATION).toBe("EXPANDED TAX");
    expect(mod.EWT_CONTROL_VALIDATIONS).toEqual(["EXPANDED TAX", "FINAL TAX"]);
    expect(mod.ewtControlAccounts(COA).map((a) => a.id).sort((x, y) => x - y)).toEqual([6, 7]);
  });
});

describe("isProtectedTaxAccount", () => {
  test("true only for INPUT VAT / OUTPUT VAT / EXPANDED TAX / FINAL TAX accounts", () => {
    expect(COA.filter(mod.isProtectedTaxAccount).map((a) => a.id).sort((x, y) => x - y)).toEqual([4, 5, 6, 7, 12, 13]);
  });
  test("an unclassified account merely named 'Input VAT' is NOT protected", () => {
    expect(mod.isProtectedTaxAccount(COA[13])).toBe(false);
  });
});

describe("filterSelectableRegularAccounts (Regular Journal Entry dropdown)", () => {
  test("excludes every validated tax-control account, keeps all ordinary accounts", () => {
    const ids = mod.filterSelectableRegularAccounts(COA).map((a) => a.id).sort((x, y) => x - y);
    expect(ids).toEqual([1, 2, 3, 8, 9, 10, 11, 14]); // AR, AP, Cash, Income, Expense, Fixed Asset, Prepayment, unclassified
    expect(ids).not.toContain(4); // Input VAT
    expect(ids).not.toContain(5); // Output VAT
    expect(ids).not.toContain(6); // Expanded Tax
    expect(ids).not.toContain(7); // Final Tax
    expect(ids).not.toContain(12); // "Taxes Recoverable" tagged INPUT VAT
    expect(ids).not.toContain(13); // "Sales Tax Clearing" tagged OUTPUT VAT
  });

  test("keepAccountId keeps one already-selected protected account visible for that row only", () => {
    const ids = mod.filterSelectableRegularAccounts(COA, 6).map((a) => a.id);
    expect(ids).toContain(6);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
  });
});

describe("tax modal account sourcing", () => {
  test("Input VAT modal uses INPUT VAT accounts (incl. the renamed one)", () => {
    expect(mod.inputVatAccounts(COA).map((a) => a.id).sort((x, y) => x - y)).toEqual([4, 12]);
  });
  test("Output VAT modal uses OUTPUT VAT accounts (incl. the renamed one)", () => {
    expect(mod.outputVatAccounts(COA).map((a) => a.id).sort((x, y) => x - y)).toEqual([5, 13]);
  });
  test("EWT modal uses EXPANDED TAX + FINAL TAX accounts", () => {
    expect(mod.ewtControlAccounts(COA).map((a) => a.id).sort((x, y) => x - y)).toEqual([6, 7]);
  });
});

describe("defaultTaxAccountId", () => {
  test("auto-selects when exactly one validated account exists, else forces explicit choice", () => {
    expect(mod.defaultTaxAccountId([COA[3]])).toBe("4");
    expect(mod.defaultTaxAccountId([COA[3], COA[11]])).toBe("");
    expect(mod.defaultTaxAccountId([])).toBe("");
  });
});

describe("missingTaxAccountMessage", () => {
  test("exact wording per item 10, no title-matching fallback implied", () => {
    expect(mod.missingTaxAccountMessage("OUTPUT_VAT")).toBe(
      "No Output VAT account is configured. Assign OUTPUT VAT in Chart of Accounts Validation Rules."
    );
    expect(mod.missingTaxAccountMessage("INPUT_VAT")).toBe(
      "No Input VAT account is configured. Assign INPUT VAT in Chart of Accounts Validation Rules."
    );
    expect(mod.missingTaxAccountMessage("EWT")).toContain("EXPANDED TAX");
  });
});

describe("defensive shapes", () => {
  test("account with no validations array never throws / never matches", () => {
    expect(mod.isProtectedTaxAccount({ id: 99, title: "x" })).toBe(false);
    expect(mod.accountHasAnyValidation({ id: 99 }, ["INPUT VAT"])).toBe(false);
    expect(mod.filterSelectableRegularAccounts(null)).toEqual([]);
    expect(mod.filterAccountsByValidations(undefined, ["INPUT VAT"])).toEqual([]);
  });
});
