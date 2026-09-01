// Pure interaction logic for the shared "+ Add Entry" menu (AddEntryMenu.jsx),
// used by every transaction module (INV/OR/APV/CV/PO/JV/PCV/DM/CM) through the
// single AddEntryMenu render site in TransactionFormLayout.jsx.
//
// jest here runs testEnvironment: "node" (jest.config.js) with no jsdom, so the
// click-toggle / outside-click / Escape rules live here as pure functions that
// the component wires to real DOM events - and are unit-tested directly, the
// same pattern as voucherToolbarRules.mjs / transactionListFilters.mjs /
// taxAccountRules.mjs.
//
// There is deliberately NO hover concept anywhere in this module or the
// component: opening/closing is click-only. The old behavior was a pure-CSS
// `.print-dropdown:hover .print-dropdown-menu { display: block }` rule.

// Click on the "+ Add Entry" button: toggle.
export function toggleOpen(current) {
  return !current;
}

// Document pointerdown while the menu is open. The trigger button and the
// dropdown share one root element (`.add-entry-menu`), so "inside" === the
// pointer landed anywhere within that root. Close only when open AND outside.
export function shouldCloseOnOutsidePointer({ open, rootContainsTarget }) {
  return open === true && rootContainsTarget === false;
}

// Escape (and the legacy IE "Esc" spelling) closes the menu; nothing else does.
// No journal action runs - the caller only flips open state.
export function isCloseKey(key) {
  return key === "Escape" || key === "Esc";
}

// A menu item was clicked: close the dropdown FIRST, then run the existing
// action (so e.g. a VAT/EWT modal opens with the dropdown already closed).
// `close` and `action` are both called exactly once, in that order.
export function activateOption(action, close) {
  if (typeof close === "function") close();
  if (typeof action === "function") action();
}

// The ordered option list the menu renders, built from exactly the props each
// module already passes today. `taxOptions` is already module-aware upstream
// (JV/PCV/DM/CM pass []), so this adds nothing and drops nothing - it only
// prepends the always-present "Regular Journal Entry" row.
export function buildMenuOptions({ onRegular, taxOptions }) {
  return [
    { key: "regular", label: "Regular Journal Entry", onClick: onRegular },
    ...(Array.isArray(taxOptions) ? taxOptions : []),
  ];
}
