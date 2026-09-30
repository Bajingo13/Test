import { useEffect, useId, useRef, useState } from "react";
import "./ReportExportMenu.css";

// Generic Print/Export dropdown, built for BIR Form 2307's toolbar
// consolidation ([Print (Browser View)] + [Export PDF (Official Template)]
// + [Export Excel (Official Template)] -> one "Print v" menu). Deliberately
// a SEPARATE small component rather than a change to ReportExportMenu.jsx
// (used unchanged by BalanceSheet/BookReport/IncomeStatement, each with its
// own fixed 3-item shape - Print Report/Save as PDF/Export CSV - that does
// not match what this page needs): Form2307 needs a different, arbitrary
// set of menu items (Print/PDF/Excel, no CSV - CSV stays its own separate
// button here since it's a data export, not a printing/official-form
// action), so this component takes a generic `items` array instead.
//
// Reuses ReportExportMenu.css AS-IS (.rem/.rem-trigger/.rem-caret/
// .rem-menu/.rem-item are generic class names, not specific to that one
// component) so this control looks and behaves identically to the
// existing Print/Export menus elsewhere in Reports, without touching that
// file or any of its existing callers.
//
// No `disabled` handling here, unlike ReportExportMenu: each of Form2307's
// three actions already has its own internal guard (an alert-and-return
// when no report/payee is selected yet - see downloadPdf/downloadXlsx in
// Form2307.jsx), matching the previous three always-clickable buttons
// exactly - disabling the whole trigger would be a functional change.
export default function PrintExportMenu({ label = "Print", items }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const btnId = useId();
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (fn) => () => {
    setOpen(false);
    if (typeof fn === "function") fn();
  };

  return (
    <div className="rem" ref={rootRef}>
      <button
        type="button"
        id={btnId}
        className="dark rem-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span aria-hidden="true" className="rem-caret">
          ▾
        </span>
      </button>

      {open ? (
        <ul className="rem-menu" id={menuId} role="menu" aria-labelledby={btnId}>
          {items.map((item) => (
            <li role="none" key={item.label}>
              <button type="button" role="menuitem" className="rem-item" onClick={choose(item.onClick)}>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
