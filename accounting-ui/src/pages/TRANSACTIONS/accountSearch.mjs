// Phase 7L: pure interaction logic for SearchableAccountSelect.jsx - the
// reusable searchable account combobox used across transaction entry
// (AccountingEntriesGrid + the VAT/EWT modals). jest runs
// testEnvironment: "node" with no jsdom (jest.config.js), so the
// filter/keyboard rules live here as pure functions the component wires to
// real DOM events, unit-tested directly - the same pattern as
// voucherToolbarRules.mjs / addEntryMenuBehavior.mjs / taxAccountRules.mjs.
//
// This module NEVER fetches the Chart of Accounts and NEVER decides
// eligibility. Its input is an ALREADY-filtered candidate list produced by
// the caller through taxAccountRules.mjs (filterSelectableRegularAccounts
// for regular lines, filterAccountsByValidations / inputVatAccounts / ...
// for the tax modals). Search is only a view over that eligible set - it
// can never surface a protected account that was not already a candidate.

// Whitespace-normalized, case-insensitive key.
export function normalizeQuery(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// The label shown for a chosen account, everywhere (option row + closed
// control): "<code> - <title>". Kept in one place so the grid, the tax
// modals, and the historical-account fallback all render identically.
export function accountLabel(account) {
  if (!account) return "";
  const code = String(account.code == null ? "" : account.code).trim();
  const title = String(account.title == null ? "" : account.title).trim();
  if (code && title) return `${code} - ${title}`;
  return code || title || "";
}

// A candidate matches when the normalized query is a substring of the
// account CODE or the account TITLE (partial, case-insensitive,
// whitespace-normalized). An empty query matches everything (the list
// opens showing all eligible accounts). Typing "bpi" matches
// "100101 - Cash in Bank BPI - Checking"; typing "130103" matches by code;
// typing "input vat" matches the title.
export function accountMatchesQuery(account, normalizedQuery) {
  if (!normalizedQuery) return true;
  const code = normalizeQuery(account && account.code);
  const title = normalizeQuery(account && account.title);
  return code.includes(normalizedQuery) || title.includes(normalizedQuery);
}

// Filter + stable order (candidates arrive already ordered by the caller;
// this preserves that order, it does not re-sort).
export function filterAccounts(accounts, query) {
  const nq = normalizeQuery(query);
  return (Array.isArray(accounts) ? accounts : []).filter((a) => accountMatchesQuery(a, nq));
}

// Resolve the account object for a value from EITHER the live candidate
// list OR a caller-supplied fallback list (used for a historical line
// whose account is no longer an eligible candidate - it must still
// display, never blank). Returns null when nothing resolves.
export function resolveSelectedAccount(value, candidates, fallbackAccounts) {
  const v = value == null ? "" : String(value);
  if (v === "") return null;
  const inList = (Array.isArray(candidates) ? candidates : []).find((a) => String(a.id) === v);
  if (inList) return inList;
  const inFallback = (Array.isArray(fallbackAccounts) ? fallbackAccounts : []).find(
    (a) => String(a.id) === v
  );
  return inFallback || null;
}

// The display string for the (possibly closed) control: an explicit
// selectedAccountLabel prop wins (a caller that already knows the label of
// a historical account it did not pass in the list), else the resolved
// account's label, else "".
export function selectedDisplayLabel({ value, candidates, fallbackAccounts, selectedAccountLabel }) {
  if (selectedAccountLabel) return selectedAccountLabel;
  return accountLabel(resolveSelectedAccount(value, candidates, fallbackAccounts));
}

// ----- keyboard navigation (pure reducer over {open, activeIndex}) -----
//
// The component owns `query`, `open`, `activeIndex` state and the filtered
// list; it calls reduceKey(...) on each keydown and applies the returned
// patch. `select` in the result means "commit filtered[activeIndex]".

export function clampIndex(index, length) {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index > length - 1) return length - 1;
  return index;
}

export function reduceKey({ key, open, activeIndex, resultCount }) {
  switch (key) {
    case "ArrowDown":
      if (!open) return { open: true, activeIndex: clampIndex(0, resultCount), preventDefault: true };
      return {
        open: true,
        activeIndex: clampIndex(activeIndex + 1, resultCount),
        preventDefault: true,
      };
    case "ArrowUp":
      if (!open) return { open: true, activeIndex: clampIndex(0, resultCount), preventDefault: true };
      return {
        open: true,
        activeIndex: clampIndex(activeIndex - 1, resultCount),
        preventDefault: true,
      };
    case "Enter":
      if (open && activeIndex >= 0 && activeIndex < resultCount) {
        return { open: false, select: true, preventDefault: true };
      }
      return {};
    case "Escape":
    case "Esc":
      // Close WITHOUT changing the selection; restore the shown label.
      return { open: false, restore: true, preventDefault: true };
    case "Tab":
      // Close naturally, let focus move on. No selection change.
      return { open: false };
    default:
      return {};
  }
}

// Document pointerdown while open: close only when open AND the pointer
// landed outside the component root (same rule as addEntryMenuBehavior).
export function shouldCloseOnOutsidePointer({ open, rootContainsTarget }) {
  return open === true && rootContainsTarget === false;
}

// Typing in the input always (re)opens the list and resets the active row
// to the first match.
export function onQueryInput() {
  return { open: true, activeIndex: 0 };
}
