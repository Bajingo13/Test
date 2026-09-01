// addEntryMenuBehavior.mjs is real ESM - loaded via dynamic import() in
// beforeAll (same pattern as taxAccountRules.test.js). jest here is
// testEnvironment: "node" with no jsdom, so the shared "+ Add Entry" menu's
// interaction rules are unit-tested as pure functions plus source guards that
// prove the hover trigger is gone. The one AddEntryMenu render site in
// TransactionFormLayout.jsx means every transaction module (INV/OR/APV/CV/PO/
// JV/PCV/DM/CM) inherits exactly this behavior.
const fs = require("fs");
const path = require("path");

let mod;
const DIR = path.resolve(__dirname, "..");

// Read a source file with comments stripped, so source-guard assertions test
// the actual code and not the explanatory prose (which deliberately names the
// hover handlers it is NOT using).
function readCode(file) {
  return fs
    .readFileSync(path.join(DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

beforeAll(async () => {
  mod = await import("../addEntryMenuBehavior.mjs");
});

describe("click-toggle (open/close via the button only)", () => {
  test("menu is initially closed (component default useState(false))", () => {
    // The component seeds useState(false); the first click transitions it.
    expect(mod.toggleOpen(false)).toBe(true);
  });
  test("click opens", () => {
    expect(mod.toggleOpen(false)).toBe(true);
  });
  test("second click closes", () => {
    expect(mod.toggleOpen(true)).toBe(false);
  });
});

describe("hover does nothing", () => {
  test("AddEntryMenu.jsx has no mouse-hover handlers", () => {
    const src = readCode("AddEntryMenu.jsx");
    expect(src).not.toMatch(/onMouseEnter/);
    expect(src).not.toMatch(/onMouseLeave/);
    expect(src).not.toMatch(/onMouseOver/);
    expect(src).not.toMatch(/onMouseOut/);
    expect(src).not.toMatch(/onPointerEnter/);
  });
  test("addEntryMenuBehavior.mjs has no hover concept", () => {
    const src = readCode("addEntryMenuBehavior.mjs");
    expect(src.toLowerCase()).not.toMatch(/mouseenter|mouseleave|:hover/);
  });
  test("the pure-CSS hover-open rule is removed", () => {
    const css = readCode("TransactionFormLayout.css");
    expect(css).not.toMatch(/\.print-dropdown:hover\s+\.print-dropdown-menu/);
    // Visibility is now driven by the click state the component sets.
    expect(css).toMatch(/\.add-entry-menu\[data-open="true"\]\s+\.print-dropdown-menu\s*\{\s*display:\s*block/);
  });
});

describe("outside-click closes (one shared listener)", () => {
  test("closes only when open AND the pointer landed outside the menu root", () => {
    expect(mod.shouldCloseOnOutsidePointer({ open: true, rootContainsTarget: false })).toBe(true);
  });
  test("a pointerdown inside the button or dropdown does NOT close it", () => {
    expect(mod.shouldCloseOnOutsidePointer({ open: true, rootContainsTarget: true })).toBe(false);
  });
  test("nothing to do when the menu is already closed", () => {
    expect(mod.shouldCloseOnOutsidePointer({ open: false, rootContainsTarget: false })).toBe(false);
  });
  test("mouse movement is not a pointerdown - no close path exists for it", () => {
    const src = readCode("AddEntryMenu.jsx");
    // Only pointerdown + keydown listeners, added only while open, with cleanup.
    expect(src).toMatch(/addEventListener\("pointerdown"/);
    expect(src).toMatch(/addEventListener\("keydown"/);
    expect(src).toMatch(/removeEventListener\("pointerdown"/);
    expect(src).toMatch(/removeEventListener\("keydown"/);
    expect(src).not.toMatch(/addEventListener\("mousemove"/);
  });
});

describe("Escape closes, nothing else", () => {
  test("Escape / Esc are close keys", () => {
    expect(mod.isCloseKey("Escape")).toBe(true);
    expect(mod.isCloseKey("Esc")).toBe(true);
  });
  test("other keys are not", () => {
    ["Enter", " ", "Tab", "ArrowDown", "a", "Escapee"].forEach((k) =>
      expect(mod.isCloseKey(k)).toBe(false)
    );
  });
});

describe("selecting an option: close first, then run the existing action", () => {
  test("activateOption calls close() then action(), each once, in order", () => {
    const calls = [];
    const close = jest.fn(() => calls.push("close"));
    const action = jest.fn(() => calls.push("action"));
    mod.activateOption(action, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["close", "action"]); // dropdown closes before e.g. a VAT/EWT modal opens
  });
  test("tolerates a missing action (defensive)", () => {
    const close = jest.fn();
    expect(() => mod.activateOption(undefined, close)).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("module-aware option list is preserved (no options added or removed)", () => {
  const regular = () => {};
  const outputVat = () => {};
  const inputVat = () => {};
  const ewt = () => {};

  test("INV / OR: Regular + Output VAT + EWT, in that order, same callbacks", () => {
    const opts = mod.buildMenuOptions({
      onRegular: regular,
      taxOptions: [
        { key: "output_vat", label: "Output VAT", onClick: outputVat },
        { key: "ewt", label: "EWT / Withholding Tax", onClick: ewt },
      ],
    });
    expect(opts.map((o) => o.label)).toEqual([
      "Regular Journal Entry",
      "Output VAT",
      "EWT / Withholding Tax",
    ]);
    expect(opts[0].onClick).toBe(regular);
    expect(opts[1].onClick).toBe(outputVat);
    expect(opts[2].onClick).toBe(ewt);
  });

  test("APV / CV / PO: Regular + Input VAT + EWT", () => {
    const opts = mod.buildMenuOptions({
      onRegular: regular,
      taxOptions: [
        { key: "input_vat", label: "Input VAT", onClick: inputVat },
        { key: "ewt", label: "EWT / Withholding Tax", onClick: ewt },
      ],
    });
    expect(opts.map((o) => o.label)).toEqual([
      "Regular Journal Entry",
      "Input VAT",
      "EWT / Withholding Tax",
    ]);
  });

  test("JV / PCV / DM / CM: Regular Journal Entry ONLY - no tax options added", () => {
    for (const taxOptions of [[], undefined]) {
      const opts = mod.buildMenuOptions({ onRegular: regular, taxOptions });
      expect(opts.map((o) => o.label)).toEqual(["Regular Journal Entry"]);
      expect(opts[0].onClick).toBe(regular);
    }
  });
});

describe("shared implementation - all modules inherit it", () => {
  test("AddEntryMenu is rendered from exactly one site in TransactionFormLayout.jsx", () => {
    const parent = readCode("TransactionFormLayout.jsx");
    const renders = parent.match(/<AddEntryMenu\b/g) || [];
    expect(renders.length).toBe(1);
  });
  test("no per-module file re-implements the toggle", () => {
    for (const f of ["Invoice.jsx", "OR.jsx", "APV.jsx", "CV.jsx", "PurchaseOrder.jsx", "JV.jsx", "PettyCashVoucher.jsx", "DebitMemo.jsx", "CreditMemo.jsx"]) {
      const src = fs.readFileSync(path.join(DIR, f), "utf8");
      expect(src).not.toMatch(/AddEntryMenu|print-dropdown|setOpen/);
    }
  });
});

describe("accessibility wiring present on the shared button", () => {
  test("aria-haspopup=menu and aria-expanded bound to open state", () => {
    const src = readCode("AddEntryMenu.jsx");
    expect(src).toMatch(/aria-haspopup="menu"/);
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toMatch(/role="menu"/);
    expect(src).toMatch(/role="menuitem"/);
  });
});
