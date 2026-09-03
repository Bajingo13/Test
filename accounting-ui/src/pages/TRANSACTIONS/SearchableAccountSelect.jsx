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
// absent from every other row's candidate list).
//
// All interaction rules (filter, ArrowUp/Down/Enter/Escape/Tab, outside
// click, reopen-on-type) live in accountSearch.mjs and are unit-tested
// there - this file only wires them to DOM events, matching the
// AddEntryMenu / accountSearch pattern used across TRANSACTIONS.
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
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  // The listbox is rendered position:fixed and anchored to the input's
  // bounding rect so it is never clipped by an `overflow` ancestor (the
  // journal grid's `.transaction-table-container` is overflow-x:auto -> a
  // scroll container on both axes - and the tax modals are overflow:auto).
  // This is the minimum fix for that clipping: no portal, same DOM.
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

  // Keep the fixed-position listbox pinned to the input while open, and
  // close it if the anchor scrolls out from under a scroll ancestor
  // (matches native <select> which also dismisses on ancestor scroll).
  useEffect(() => {
    if (!open) return undefined;
    function sync() {
      const el = inputRef.current;
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
      setOpen(false);
      setQuery("");
      setActiveIndex(-1);
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
  const showEmpty = open && results.length === 0;

  // position:fixed anchored under the input - escapes every `overflow`
  // clipping ancestor without a React portal. Opens upward when there is
  // more room above than below (near the bottom of a scroll container).
  const listboxStyle = anchorRect
    ? (() => {
        const below = window.innerHeight - anchorRect.bottom;
        const openUp = below < 200 && anchorRect.top > below;
        return {
          position: "fixed",
          left: anchorRect.left,
          width: anchorRect.width,
          maxHeight: Math.max(120, Math.min(240, (openUp ? anchorRect.top : below) - 8)),
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
        ref={inputRef}
        id={id}
        type="text"
        className="transaction-table-input searchable-account-input"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={
          showList && activeIndex >= 0 && listboxId
            ? `${listboxId}-opt-${activeIndex}`
            : undefined
        }
        placeholder={placeholder}
        value={open ? query : shownLabel}
        onChange={handleInput}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActiveIndex(shownLabel ? 0 : -1);
        }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      {value ? (
        <button
          type="button"
          className="searchable-account-clear"
          aria-label="Clear account"
          tabIndex={-1}
          onClick={() => commit(null)}
        >
          ×
        </button>
      ) : null}

      {showList && (
        <ul className="searchable-account-listbox" role="listbox" id={listboxId} style={listboxStyle}>
          {results.map((account, index) => (
            <li
              key={account.id}
              id={listboxId ? `${listboxId}-opt-${index}` : undefined}
              role="option"
              aria-selected={String(account.id) === String(value)}
              className={`searchable-account-option${
                index === activeIndex ? " is-active" : ""
              }${String(account.id) === String(value) ? " is-selected" : ""}`}
              onMouseDown={(e) => {
                // mousedown, not click - fire before the input blur closes the list
                e.preventDefault();
                commit(account);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {accountLabel(account)}
            </li>
          ))}
        </ul>
      )}
      {showEmpty && (
        <ul className="searchable-account-listbox" role="listbox" id={listboxId} style={listboxStyle}>
          <li className="searchable-account-option searchable-account-option-empty" aria-disabled="true">
            No matching account
          </li>
        </ul>
      )}
    </div>
  );
}

// Re-export so callers that only need a label (print, view rows) don't
// have to reach into accountSearch.mjs directly.
export { accountLabel, resolveSelectedAccount };
