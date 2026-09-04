import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  filterAccounts,
  reduceKey,
  onQueryInput,
  shouldCloseOnOutsidePointer,
  resolveSelectedAccount,
  selectedDisplayLabel,
  accountLabel,
  clampIndex,
} from "./accountSearch.mjs";
import "./SearchableAccountSelect.css";

// Phase 7L: reusable searchable account combobox for transaction entry.
// Account-search UX pass: the dropdown now opens with a dedicated, always-
// visible search bar pinned to the top; the results list scrolls
// independently beneath it. Every transaction module (INV/OR/CV/JV/APV/PO/
// PCV/DM/CM) inherits this through AccountingEntriesGrid, and the VAT/EWT
// modals inherit it too - it is the one shared component, never a per-
// module implementation.
//
// CRITICAL: this component does NOT fetch the Chart of Accounts and does
// NOT decide account eligibility. It renders and searches an
// ALREADY-filtered `accounts` list handed to it by the caller (regular
// journal lines pass filterSelectableRegularAccounts(...) from
// taxAccountRules.mjs; the VAT/EWT modals pass their validation-specific
// candidate builders). A protected tax-control account that is not in
// `accounts` can never be searched or selected here - the same guarantee
// the old <select> gave, just with type-to-filter + keyboard nav on top.
//
// Historical-account safety: if `value` points at an account not present
// in `accounts` (a legacy line whose account is no longer eligible for new
// selection), it is still shown - via `selectedAccountLabel` if provided,
// else resolved from `fallbackAccounts`, else "". It is never silently
// blanked and never becomes newly selectable on other lines (because it is
// absent from every other row's candidate list). Opening the search does
// not touch the selected value.
//
// All interaction rules (filter, ArrowUp/Down/Enter/Escape/Tab, outside
// click, reopen-on-type) live in accountSearch.mjs and are unit-tested
// there - this file only wires them to DOM events, matching the
// AddEntryMenu / accountSearch pattern used across TRANSACTIONS.
const SEARCH_PLACEHOLDER = "Search account code or name...";
const EMPTY_TEXT = "No accounts found";

export default function SearchableAccountSelect({
  value,
  onChange, // (nextValue: string) => void  - "" when cleared
  accounts = [], // ALREADY eligibility-filtered candidates
  fallbackAccounts = [], // optional: resolve a historical account's label only
  selectedAccountLabel = "", // optional: explicit label for a historical account
  disabled = false,
  readOnly = false,
  placeholder = "Select account",
  id,
  ariaLabel = "Account",
  className = "",
}) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  // The dropdown is rendered position:fixed and anchored to the trigger's
  // bounding rect so it is never clipped by an `overflow` ancestor (the
  // journal grid's `.transaction-table-container` is overflow-x:auto -> a
  // scroll container on both axes - and the tax modals are overflow:auto).
  // This is the minimum fix for that clipping: no portal, same DOM. The
  // search bar lives INSIDE this fixed dropdown, so it escapes the same
  // clipping ancestors the option list does.
  const [anchorRect, setAnchorRect] = useState(null);

  const shownLabel = selectedDisplayLabel({
    value,
    candidates: accounts,
    fallbackAccounts,
    selectedAccountLabel,
  });

  const results = useMemo(
    () => (open ? filterAccounts(accounts, query) : []),
    [open, accounts, query]
  );

  // Keep the active row in range as the result set shrinks/grows.
  useEffect(() => {
    if (!open) return;
    setActiveIndex((i) => clampIndex(i < 0 ? 0 : i, results.length));
  }, [open, results.length]);

  // Auto-focus the search bar the moment the dropdown opens, so the flow is
  // exactly "click Account -> type -> pick". Focusing the freshly mounted
  // input directly is enough here (the effect runs after commit).
  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  // Outside-click / outside-tap closes and restores the shown label.
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      const rootContainsTarget = !!rootRef.current && rootRef.current.contains(e.target);
      if (shouldCloseOnOutsidePointer({ open, rootContainsTarget })) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Keep the fixed-position dropdown pinned to the trigger while open, and
  // close it if the anchor scrolls out from under a scroll ancestor
  // (matches native <select> which also dismisses on ancestor scroll).
  useEffect(() => {
    if (!open) return undefined;
    function sync() {
      const el = triggerRef.current;
      if (el) setAnchorRect(el.getBoundingClientRect());
    }
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open]);

  const isInert = disabled || readOnly;

  // View / read-only render: a plain static label, matching the old
  // viewOnly grid (AccountingEntriesGrid) and disabled tax pickers.
  if (isInert) {
    return (
      <div
        className={`searchable-account searchable-account-static ${className}`.trim()}
        id={id}
        aria-label={ariaLabel}
        aria-disabled="true"
      >
        <span className="searchable-account-static-label">
          {shownLabel || <span className="searchable-account-placeholder">{placeholder}</span>}
        </span>
      </div>
    );
  }

  function openDropdown() {
    setOpen(true);
    setQuery("");
    setActiveIndex(shownLabel ? 0 : -1);
  }

  function closeDropdown({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus && triggerRef.current) triggerRef.current.focus();
  }

  function commit(account) {
    onChange(account ? String(account.id) : "");
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  function handleKeyDown(e) {
    const patch = reduceKey({
      key: e.key,
      open,
      activeIndex,
      resultCount: results.length,
    });
    if (patch.preventDefault) e.preventDefault();
    if (patch.select) {
      commit(results[activeIndex] || null);
      return;
    }
    if (patch.restore) {
      closeDropdown({ restoreFocus: true });
      return;
    }
    if (typeof patch.open === "boolean") setOpen(patch.open);
    if (typeof patch.activeIndex === "number") setActiveIndex(patch.activeIndex);
  }

  function handleInput(e) {
    setQuery(e.target.value);
    const patch = onQueryInput();
    setOpen(patch.open);
    setActiveIndex(patch.activeIndex);
  }

  const listboxId = id ? `${id}-listbox` : undefined;
  const showList = open && results.length > 0;

  // position:fixed anchored under the trigger - escapes every `overflow`
  // clipping ancestor without a React portal. Opens upward when there is
  // more room above than below (near the bottom of a scroll container).
  const dropdownStyle = anchorRect
    ? (() => {
        const below = window.innerHeight - anchorRect.bottom;
        const openUp = below < 220 && anchorRect.top > below;
        return {
          position: "fixed",
          left: anchorRect.left,
          width: anchorRect.width,
          maxHeight: Math.max(150, Math.min(288, (openUp ? anchorRect.top : below) - 8)),
          ...(openUp
            ? { bottom: window.innerHeight - anchorRect.top + 2 }
            : { top: anchorRect.bottom + 2 }),
        };
      })()
    : undefined;

  return (
    <div
      ref={rootRef}
      className={`searchable-account ${className}`.trim()}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-owns={listboxId}
    >
      <input
        ref={triggerRef}
        id={id}
        type="text"
        className="transaction-table-input searchable-account-input"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listboxId}
        placeholder={placeholder}
        value={shownLabel}
        readOnly
        onMouseDown={(e) => {
          // toggle on click; the auto-focus effect moves focus into the
          // search bar when it opens. preventDefault so focus does not land
          // on this read-only trigger (and so Escape -> focus trigger can't
          // re-trigger an open).
          e.preventDefault();
          if (open) closeDropdown();
          else openDropdown();
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
            e.preventDefault();
            openDropdown();
          }
        }}
        autoComplete="off"
      />
      {value ? (
        <button
          type="button"
          className="searchable-account-clear"
          aria-label="Clear account"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            commit(null);
          }}
        >
          ×
        </button>
      ) : null}

      {open && (
        <div className="searchable-account-dropdown" style={dropdownStyle}>
          <div className="searchable-account-search">
            <svg
              className="searchable-account-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              className="searchable-account-search-input"
              aria-label={`${ariaLabel} search`}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={
                showList && activeIndex >= 0 && listboxId
                  ? `${listboxId}-opt-${activeIndex}`
                  : undefined
              }
              placeholder={SEARCH_PLACEHOLDER}
              value={query}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              autoComplete="off"
            />
          </div>

          <ul className="searchable-account-listbox" role="listbox" id={listboxId}>
            {showList ? (
              results.map((account, index) => (
                <li
                  key={account.id}
                  id={listboxId ? `${listboxId}-opt-${index}` : undefined}
                  role="option"
                  aria-selected={String(account.id) === String(value)}
                  className={`searchable-account-option${
                    index === activeIndex ? " is-active" : ""
                  }${String(account.id) === String(value) ? " is-selected" : ""}`}
                  onMouseDown={(e) => {
                    // mousedown, not click - fire before any blur closes the list
                    e.preventDefault();
                    commit(account);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {accountLabel(account)}
                </li>
              ))
            ) : (
              <li
                className="searchable-account-option searchable-account-option-empty"
                aria-disabled="true"
              >
                {EMPTY_TEXT}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// Re-export so callers that only need a label (print, view rows) don't
// have to reach into accountSearch.mjs directly.
export { accountLabel, resolveSelectedAccount };
