// Transaction-UI consistency pass: PCV / DM / CM must render the same
// standardized 2-column header + in-panel Currency as CV (the visual
// source of truth), not the older stacked TransactionVoucherHeader + a
// standalone full-width CurrencySummary card.
//
// jest here is testEnvironment: "node" with no jsdom (see
// taxAccountRules.test.js), so this is a source-structure test - it reads
// the layout source + the four thin module wrappers and asserts the
// composition, exactly the style used by the backend print/quotation
// source-check suites. A DOM render test is not possible in this config.

const fs = require("fs");
const path = require("path");

const TX = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(TX, f), "utf8");

const layoutSrc = read("TransactionFormLayout.jsx");
const panelSrc = read("TransactionSummaryPanel.jsx");
const cvSrc = read("CV.jsx");
const pcvSrc = read("PettyCashVoucher.jsx");
const dmSrc = read("DebitMemo.jsx");
const cmSrc = read("CreditMemo.jsx");

// The single membership set that drives the compact 2-column header.
function compactHeaderSet() {
  const m = layoutSrc.match(/COMPACT_HEADER_MODULES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!m) throw new Error("COMPACT_HEADER_MODULES set literal not found");
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("standardized transaction header - COMPACT_HEADER_MODULES", () => {
  const set = compactHeaderSet();

  test("PCV, DM and CM now use the standardized compact header", () => {
    expect(set).toEqual(expect.arrayContaining(["PCV", "DM", "CM"]));
  });

  test("CV (the reference layout) is still in the set and unchanged", () => {
    expect(set).toContain("CV");
    // CV.jsx is a thin wrapper over the shared layout - no bespoke markup.
    expect(cvSrc).toMatch(/<TransactionFormLayout/);
    expect(cvSrc).toMatch(/code="CV"/);
    expect(cvSrc).toMatch(/partyLabel="Payee"/);
  });

  test("every currency-eligible transaction module shares one compact header", () => {
    // INV/OR/APV/CV/PO/JV were already standardized; PCV/DM/CM complete it.
    expect(new Set(set)).toEqual(
      new Set(["INV", "OR", "APV", "CV", "PO", "JV", "PCV", "DM", "CM"])
    );
  });
});

describe("standardized header - single shared structure, no per-module copies", () => {
  test("the layout has exactly one compact-header branch, driven by the set", () => {
    // The ternary that picks compact vs stacked is keyed on the set only.
    expect(layoutSrc).toMatch(/\{COMPACT_HEADER_MODULES\.has\(code\)\s*\?\s*\(/);
    // Exactly one 2-column top section in the whole file, and one panel.
    expect((layoutSrc.match(/<div className="transaction-top-section">/g) || []).length).toBe(1);
    expect((layoutSrc.match(/<TransactionSummaryPanel/g) || []).length).toBe(1);
    // The compact vs stacked choice is never made per module code.
    expect(layoutSrc).not.toMatch(/code === "(PCV|DM|CM)"\s*(\?|&&)[^\n]*transaction-top-section/);
  });

  test("Currency is not a separate standalone card for compact-header modules", () => {
    // The standalone <CurrencySummary> is rendered ONLY for modules NOT in
    // the compact set. Since PCV/DM/CM are now in the set, they get Currency
    // inside TransactionSummaryPanel instead.
    expect(layoutSrc).toMatch(
      /CURRENCY_ELIGIBLE\s*&&\s*!COMPACT_HEADER_MODULES\.has\(code\)\s*&&\s*\(\s*<CurrencySummary/
    );
  });

  test("the right-side panel shows voucher no. / date / currency together", () => {
    expect(panelSrc).toMatch(/referenceLabel/);
    expect(panelSrc).toMatch(/<label className="transaction-label">Date<\/label>/);
    expect(panelSrc).toMatch(
      /currencyEligible\s*&&\s*\(\s*<div className="transaction-field">\s*<label className="transaction-label">Currency<\/label>/
    );
  });

  test("module-specific reference label is preserved (CV No. / PCV No. / DM No. / CM No.)", () => {
    const labels = panelSrc.match(/REFERENCE_LABELS\s*=\s*\{([^}]*)\}/)[1];
    expect(labels).toMatch(/CV:\s*"CV No\."/);
    expect(labels).toMatch(/PCV:\s*"PCV No\."/);
    expect(labels).toMatch(/DM:\s*"DM No\."/);
    expect(labels).toMatch(/CM:\s*"CM No\."/);
  });
});

describe("standardized header - module identity and payload untouched", () => {
  test("PCV keeps its own code / endpoint-driving props and Payee label", () => {
    expect(pcvSrc).toMatch(/<TransactionFormLayout/);
    expect(pcvSrc).toMatch(/code="PCV"/);
    expect(pcvSrc).toMatch(/partyLabel="Payee"/);
    expect(pcvSrc).toMatch(/printModuleType="pettyCash"/);
  });

  test("DM / CM keep their own code and their existing party terminology", () => {
    expect(dmSrc).toMatch(/code="DM"/);
    expect(dmSrc).toMatch(/partyLabel="Customer \/ Supplier"/);
    expect(cmSrc).toMatch(/code="CM"/);
    expect(cmSrc).toMatch(/partyLabel="Customer \/ Supplier"/);
  });

  test("COMPACT_HEADER_MODULES drives presentation only - never tax/lifecycle", () => {
    // The set is consulted in exactly two places: the compact-header
    // ternary and the standalone-CurrencySummary guard. If a future edit
    // wires it into anything else, this catches it.
    const uses = layoutSrc.match(/COMPACT_HEADER_MODULES\.has\(code\)/g) || [];
    expect(uses.length).toBe(2);
  });

  test("no tax eligibility leaks into PCV / DM / CM", () => {
    // vatType / ewtEligible / ewtOutbound / ewtInbound enumerate only
    // INV/OR/APV/CV/PO. The consistency pass must not add PCV/DM/CM here.
    for (const name of ["vatType", "ewtOutbound", "ewtInbound"]) {
      const block = layoutSrc.match(new RegExp(`const ${name} =[^;]*;`, "s"))[0];
      expect(block).not.toMatch(/"(PCV|DM|CM)"/);
    }
    // ewtEligible is derived purely from the two above.
    expect(layoutSrc).toMatch(/const ewtEligible = ewtOutbound \|\| ewtInbound;/);
  });
});

describe("standardized header - transactionModuleConfig unchanged for PCV/DM/CM", () => {
  // transactionModuleConfig.js is ESM-in-a-.js; this jest config can only
  // import() real .mjs, so assert on source text (same style as above).
  const cfgSrc = read("transactionModuleConfig.js");

  test("PCV / DM / CM endpoints, module keys and status model are intact", () => {
    expect(cfgSrc).toMatch(
      /PCV:\s*\{ endpoint: "petty-cash", printModuleType: "pettyCash", currencyEligible: true, moduleKey: "TRANSACTIONS\.PETTY_CASH", delete: true, statusModel: "DRAFT_POSTED" \}/
    );
    expect(cfgSrc).toMatch(
      /DM:\s*\{ endpoint: "debit-memos", printModuleType: "debitMemo", currencyEligible: true, moduleKey: "TRANSACTIONS\.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" \}/
    );
    expect(cfgSrc).toMatch(
      /CM:\s*\{ endpoint: "credit-memos", printModuleType: "creditMemo", currencyEligible: true, moduleKey: "TRANSACTIONS\.DEBIT_CREDIT_MEMO", delete: true, statusModel: "DRAFT_POSTED" \}/
    );
    // None of these gained a tax / cancelVoid / emailable flag.
    expect(cfgSrc).not.toMatch(/PCV:.*(cancelVoid|emailable)/);
    expect(cfgSrc).not.toMatch(/DM:.*(cancelVoid|emailable)/);
    expect(cfgSrc).not.toMatch(/CM:.*(cancelVoid|emailable)/);
  });
});
