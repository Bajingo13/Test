import React, { useEffect, useId, useRef, useState } from "react";
import {
  toggleOpen,
  shouldCloseOnOutsidePointer,
  isCloseKey,
  activateOption,
  buildMenuOptions,
} from "./addEntryMenuBehavior.mjs";
import "./TransactionFormLayout.css";

// Phase 7C: "+ Add Entry" - replaces the plain "+ Add Line" button with a small
// menu. Regular Journal Entry behaves exactly like the old "+ Add Line"
// (onRegular === addLine, untouched). Tax options are module-aware - only the
// entries the caller actually supports are passed in via `taxOptions`
// (JV/PCV/DM/CM pass []), never a fixed set for every module.
//
// Interaction: CLICK-ONLY. Click "+ Add Entry" to open, click it again to
// close, click outside or press Escape to close, click an item to run its
// action (after the menu closes). No hover trigger - the previous behavior was
// a pure-CSS `.print-dropdown:hover .print-dropdown-menu { display: block }`
// rule (now removed); there is no onMouseEnter/onMouseLeave anywhere. This one
// shared component is the single render site for all nine transaction modules,
// so the behavior is defined here once. Pure logic lives in
// addEntryMenuBehavior.mjs (node-env unit tested).
export default function AddEntryMenu({ onRegular, taxOptions }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      const rootContainsTarget = Boolean(
        rootRef.current && rootRef.current.contains(event.target)
      );
      if (shouldCloseOnOutsidePointer({ open: true, rootContainsTarget })) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (isCloseKey(event.key)) {
        setOpen(false);
      }
    }

    // Capture phase + a single pair of listeners for the whole app (not one
    // per module) - added only while open, removed on close/unmount.
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  const options = buildMenuOptions({ onRegular, taxOptions });

  return (
    <div
      className="print-dropdown add-entry-menu"
      data-open={open ? "true" : "false"}
      ref={rootRef}
    >
      <button
        type="button"
        className="transaction-add-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => toggleOpen(current))}
      >
        + Add Entry
      </button>
      <div className="print-dropdown-menu" id={menuId} role="menu" hidden={!open}>
        {options.map((opt) => (
          <button
            key={opt.key}
            type="button"
            role="menuitem"
            onClick={() => activateOption(opt.onClick, () => setOpen(false))}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
