// Account-search UX pass: SearchableAccountSelect's open dropdown must
// carry a dedicated, auto-focused search bar pinned above an independently
// scrolling result list, and every transaction module must reach it
// through the ONE shared component (AccountingEntriesGrid) - never a
// per-module selector.
//
// jest here is testEnvironment: "node" with no jsdom (see
// jest.config.js / taxAccountRules.test.js), so the interaction LOGIC is
// unit-tested as pure functions in accountSearch.test.js; this suite
// asserts the component composition + cross-module wiring from source,
// the same style as transactionHeaderLayout.test.js.

const fs = require("fs");
const path = require("path");

const TX = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(TX, f), "utf8");

const selSrc = read("SearchableAccountSelect.jsx");
const cssSrc = read("SearchableAccountSelect.css");
const gridSrc = read("AccountingEntriesGrid.jsx");
const layoutSrc = read("TransactionFormLayout.jsx");

describe("SearchableAccountSelect - dedicated search bar in the dropdown", () => {
  test("open dropdown renders a distinct search input with the required placeholder", () => {
    expect(selSrc).toMatch(/SEARCH_PLACEHOLDER\s*=\s*"Search account code or name\.\.\."/);
    // a separate <input> bound to the search ref, not the trigger
    expect(selSrc).toMatch(/ref=\{searchRef\}/);
    expect(selSrc).toMatch(/className="searchable-account-search-input"/);
    expect(selSrc).toMatch(/placeholder=\{SEARCH_PLACEHOLDER\}/);
    // the search bar is only in the tree while the dropdown is open
    expect(selSrc).toMatch(/\{open && \(\s*<div className="searchable-account-dropdown"/);
  });

  test("search bar auto-focuses when the dropdown opens", () => {
    expect(selSrc).toMatch(
      /useEffect\(\(\) => \{\s*if \(open && searchRef\.current\) searchRef\.current\.focus\(\);\s*\},\s*\[open\]\)/
    );
  });

  test("search bar is pinned; the option list scrolls independently", () => {
    // dropdown shell is a flex column; search header does not shrink; list scrolls
    expect(cssSrc).toMatch(/\.searchable-account-dropdown\s*\{[^}]*flex-direction:\s*column/s);
    expect(cssSrc).toMatch(/\.searchable-account-search\s*\{[^}]*flex-shrink:\s*0/s);
    expect(cssSrc).toMatch(/\.searchable-account-listbox\s*\{[^}]*overflow-y:\s*auto/s);
    // the listbox is nested inside the dropdown, not itself position:fixed
    expect(cssSrc).not.toMatch(/\.searchable-account-listbox\s*\{[^}]*position:\s*fixed/s);
  });

  test("no-result state shows 'No accounts found' (search bar stays visible)", () => {
    expect(selSrc).toMatch(/EMPTY_TEXT\s*=\s*"No accounts found"/);
    expect(selSrc).toMatch(/searchable-account-option-empty[\s\S]*\{EMPTY_TEXT\}/);
  });

  test("keyboard + selection wiring routes through the shared accountSearch reducer", () => {
    expect(selSrc).toMatch(/import \{[\s\S]*reduceKey[\s\S]*\} from "\.\/accountSearch\.mjs"/);
    // search input drives keyboard nav; ArrowUp/Down/Enter/Escape/Tab all via reduceKey
    expect(selSrc).toMatch(/onKeyDown=\{handleKeyDown\}/);
    expect(selSrc).toMatch(/const patch = reduceKey\(\{\s*key: e\.key/);
    expect(selSrc).toMatch(/if \(patch\.select\) \{\s*commit\(results\[activeIndex\]/);
    expect(selSrc).toMatch(/if \(patch\.restore\) \{\s*closeDropdown\(\{ restoreFocus: true \}\)/);
  });

  test("dropdown keeps the Phase 7L fixed-position / anti-clip anchoring", () => {
    expect(selSrc).toMatch(/position: "fixed"/);
    expect(selSrc).toMatch(/getBoundingClientRect\(\)/);
    expect(selSrc).toMatch(/const openUp = below < 220 && anchorRect\.top > below/);
    // the search bar is INSIDE the fixed shell, so it escapes the same
    // overflow-clipping ancestors the list does
    expect(selSrc).toMatch(
      /<div className="searchable-account-dropdown" style=\{dropdownStyle\}>[\s\S]*searchable-account-search[\s\S]*searchable-account-listbox/
    );
  });

  test("styling stays compact/neutral - white field, thin border, small radius, subtle icon", () => {
    expect(cssSrc).toMatch(/\.searchable-account-search-input\s*\{[^}]*background:\s*#ffffff/s);
    expect(cssSrc).toMatch(/\.searchable-account-search-input\s*\{[^}]*border:\s*1px solid/s);
    expect(cssSrc).toMatch(/\.searchable-account-search-input\s*\{[^}]*border-radius:\s*6px/s);
    expect(cssSrc).toMatch(/\.searchable-account-search-input\s*\{[^}]*height:\s*28px/s);
    expect(selSrc).toMatch(/searchable-account-search-icon/);
  });
});

describe("SearchableAccountSelect - selection & eligibility safety unchanged", () => {
  test("component still never fetches COA and never decides eligibility", () => {
    expect(selSrc).not.toMatch(/fetch\(|axios|\/api\/coa/);
    // it renders the caller's already-filtered `accounts` prop as-is
    expect(selSrc).toMatch(/filterAccounts\(accounts, query\)/);
  });

  test("historical selected account is preserved when the dropdown opens", () => {
    // opening never calls onChange; the shown label comes from selectedDisplayLabel
    expect(selSrc).toMatch(/function openDropdown\(\) \{\s*setOpen\(true\);\s*setQuery\(""\);/);
    expect(selSrc).toMatch(/const shownLabel = selectedDisplayLabel\(\{/);
    expect(selSrc).toMatch(/value=\{shownLabel\}\s*\n\s*readOnly/);
    // onChange is only ever called from commit(...)
    const onChangeCalls = selSrc.match(/onChange\(/g) || [];
    expect(onChangeCalls.length).toBe(1);
    expect(selSrc).toMatch(/function commit\(account\) \{\s*onChange\(account \? String\(account\.id\) : ""\);/);
  });

  test("regular journal grid still passes the protected-account-filtered list", () => {
    expect(gridSrc).toMatch(/filterSelectableRegularAccounts\(\s*accountOptions,\s*line\.accountId\s*\)/);
    expect(gridSrc).toMatch(/<SearchableAccountSelect[\s\S]*accounts=\{selectableAccounts\}/);
    expect(gridSrc).toMatch(/fallbackAccounts=\{accountOptions\}/);
  });
});

describe("SearchableAccountSelect - shared across ALL 9 transaction modules", () => {
  const MODULE_FILES = {
    INV: "Invoice.jsx",
    OR: "OR.jsx",
    CV: "CV.jsx",
    JV: "JV.jsx",
    APV: "APV.jsx",
    PO: "PurchaseOrder.jsx",
    PCV: "PettyCashVoucher.jsx",
    DM: "DebitMemo.jsx",
    CM: "CreditMemo.jsx",
  };

  test("every module renders the shared TransactionFormLayout (no bespoke journal grid)", () => {
    for (const [code, file] of Object.entries(MODULE_FILES)) {
      const src = read(file);
      expect(src).toMatch(/import TransactionFormLayout from "\.\/TransactionFormLayout"/);
      expect(src).toMatch(/<TransactionFormLayout/);
      expect(src).toMatch(new RegExp(`code="${code}"`));
      // no module-local account <select> or selector
      expect(src).not.toMatch(/SearchableAccountSelect/);
      expect(src).not.toMatch(/AccountingEntriesGrid/);
    }
  });

  test("TransactionFormLayout renders AccountingEntriesGrid on one unconditional path", () => {
    expect(layoutSrc).toMatch(/import AccountingEntriesGrid from "\.\/AccountingEntriesGrid"/);
    expect((layoutSrc.match(/<AccountingEntriesGrid/g) || []).length).toBe(1);
    // the grid render is not forked on module code
    expect(layoutSrc).not.toMatch(/code === "(PCV|DM|CM)"[^\n]*<AccountingEntriesGrid/);
  });

  test("AccountingEntriesGrid is the single journal-line account selector", () => {
    expect(gridSrc).toMatch(/import SearchableAccountSelect from "\.\/SearchableAccountSelect"/);
    expect((gridSrc.match(/<SearchableAccountSelect/g) || []).length).toBe(1);
  });

  // Regression guard: fails loudly if PCV / DM / CM ever stop routing
  // through the shared layout -> shared grid -> shared searchable selector.
  test("PCV, DM and CM keep using the shared searchable selector", () => {
    for (const file of ["PettyCashVoucher.jsx", "DebitMemo.jsx", "CreditMemo.jsx"]) {
      const src = read(file);
      expect(src).toMatch(/<TransactionFormLayout/);
      expect(src).not.toMatch(/<select|SearchableAccountSelect|AccountingEntriesGrid/);
    }
    // and the layout/grid chain that those three depend on is intact
    expect(layoutSrc).toMatch(/<AccountingEntriesGrid/);
    expect(gridSrc).toMatch(/<SearchableAccountSelect/);
  });
});
